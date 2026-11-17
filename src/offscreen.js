// オフスクリーンドキュメント：プレイリスト取得・セグメント取得・復号・mp4 化・保存。
'use strict';

var jobs = {}; // jobId -> {abort: AbortController, state: ...}
var DNR_RULE_ID = 1001;

// ---------- 汎用 fetch ----------

function fetchBytes(url, opts) {
  opts = opts || {};
  var init = { credentials: 'include', signal: opts.signal };
  if (opts.range) init.headers = { Range: opts.range };
  return fetch(url, init).then(function (res) {
    if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status + ': ' + url);
    return res.arrayBuffer();
  });
}

function fetchText(url, opts) {
  opts = opts || {};
  return fetch(url, { credentials: 'include', signal: opts.signal }).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + url);
    return res.text();
  });
}

// ---------- ヘッダー再現（declarativeNetRequest） ----------
// fetch では付けられない Referer / User-Agent を、対象ホスト宛てのリクエストに付ける。
async function setHeaderRule(playlistUrl, headers, pageUrl) {
  try {
    var host = new URL(playlistUrl).hostname;
    var modify = [];
    var referer = (headers && headers.referer) || pageUrl;
    if (referer) modify.push({ header: 'referer', operation: 'set', value: referer });
    if (headers && headers.userAgent) {
      modify.push({ header: 'user-agent', operation: 'set', value: headers.userAgent });
    }
    if (modify.length === 0) return;
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [DNR_RULE_ID],
      addRules: [{
        id: DNR_RULE_ID,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: modify },
        condition: { urlFilter: '||' + host + '/', resourceTypes: ['xmlhttprequest', 'other'] }
      }]
    });
  } catch (e) {
    // ヘッダー再現はベストエフォート。失敗しても取得自体は続ける。
    console.warn('DNR rule failed', e);
  }
}

async function clearHeaderRule() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [DNR_RULE_ID] });
  } catch (e) { /* noop */ }
}

// ---------- 進捗通知 ----------

function report(job) {
  var snapshot = {
    jobId: job.id,
    state: job.state, // running | done | error | cancelled
    paused: !!job.paused,
    done: job.done || 0,
    total: job.total || 0,
    bytes: job.bytes || 0,
    filename: job.filename,
    error: job.error || null
  };
  var data = { ['job_' + job.id]: snapshot };
  // ポップアップを開き直したときに進行中ジョブを復元できるよう、最新ジョブも記録する
  data.latest_job = snapshot;
  try {
    // 直接の書き込みも試みるが、本命は jobProgress メッセージを受けた
    // サービスワーカー側の書き込み（そちらが確実に反映される）
    var p = chrome.storage.session.set(data);
    if (p && p.catch) p.catch(function () {});
  } catch (e) { /* サービスワーカー経由の書き込みに任せる */ }
  chrome.runtime.sendMessage({ type: 'jobProgress', job: snapshot }).catch(function () {});
}

// ---------- AES-128 復号 ----------

var keyCache = {}; // keyUri -> Promise<CryptoKey>

function getKey(keyInfo, signal) {
  if (!keyCache[keyInfo.uri]) {
    keyCache[keyInfo.uri] = fetchBytes(keyInfo.uri, { signal: signal }).then(function (buf) {
      return crypto.subtle.importKey('raw', buf, { name: 'AES-CBC' }, false, ['decrypt']);
    });
  }
  return keyCache[keyInfo.uri];
}

async function decryptSegment(data, seg, signal) {
  if (!seg.key) return data;
  if (seg.key.method !== 'AES-128') {
    throw new Error('未対応の暗号化方式です: ' + seg.key.method);
  }
  var key = await getKey(seg.key, signal);
  var iv = seg.key.iv || HLS.ivFromSequence(seg.sequence);
  var plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, key, data);
  return new Uint8Array(plain);
}

// ---------- 一時停止 ----------

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

// 一時停止中はここで待つ。キャンセルされたら抜ける。
// 停止中も数秒ごとに進捗を送り直し、表示の維持とオフスクリーンの延命を兼ねる。
async function waitWhilePaused(job) {
  var lastReport = 0;
  while (job.paused && !job.abort.signal.aborted) {
    await sleep(300);
    var now = Date.now();
    if (now - lastReport > 5000) {
      lastReport = now;
      report(job);
    }
  }
}

// ---------- セグメント取得 ----------

async function fetchSegment(seg, signal) {
  var opts = { signal: signal };
  if (seg.byterange) {
    var start = seg.byterange.offset;
    var end = seg.byterange.offset + seg.byterange.length - 1;
    opts.range = 'bytes=' + start + '-' + end;
  }
  var buf = await fetchBytes(seg.uri, opts);
  return decryptSegment(new Uint8Array(buf), seg, signal);
}

// 並行度つきで順序を保って全セグメントを取得する
async function fetchAllSegments(segments, job, onChunk) {
  var results = new Array(segments.length);
  var next = 0;
  var CONCURRENCY = 4;
  async function worker() {
    while (next < segments.length) {
      await waitWhilePaused(job);
      if (job.abort.signal.aborted) throw new Error('cancelled');
      var idx = next++;
      var data = await fetchSegment(segments[idx], job.abort.signal);
      results[idx] = data;
      job.done++;
      job.bytes += data.byteLength;
      report(job);
      if (onChunk) onChunk(idx, data);
    }
  }
  var workers = [];
  for (var i = 0; i < Math.min(CONCURRENCY, segments.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// ---------- mp4 化 ----------

// TS セグメント群を mux.js で mp4 に再多重化する
function transmuxToMp4(segmentsData) {
  return new Promise(function (resolve, reject) {
    var transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
    var parts = [];
    var initAppended = false;
    transmuxer.on('data', function (segment) {
      if (!initAppended && segment.initSegment) {
        parts.push(new Uint8Array(segment.initSegment));
        initAppended = true;
      }
      if (segment.data) parts.push(new Uint8Array(segment.data));
    });
    transmuxer.on('done', function () {
      resolve(new Blob(parts, { type: 'video/mp4' }));
    });
    try {
      segmentsData.forEach(function (data) {
        transmuxer.push(data);
        transmuxer.flush();
      });
    } catch (e) {
      reject(e);
    }
  });
}

// fMP4 (EXT-X-MAP) の場合は初期化セグメント + セグメントの単純結合がそのまま mp4 になる
async function concatFmp4(playlist, job) {
  var parts = [];
  if (playlist.map && playlist.map.uri) {
    var mapOpts = { signal: job.abort.signal };
    if (playlist.map.byterange) {
      mapOpts.range = 'bytes=' + playlist.map.byterange.offset + '-' +
        (playlist.map.byterange.offset + playlist.map.byterange.length - 1);
    }
    parts.push(new Uint8Array(await fetchBytes(playlist.map.uri, mapOpts)));
  }
  var segmentsData = await fetchAllSegments(playlist.segments, job, null);
  segmentsData.forEach(function (d) { parts.push(d); });
  return new Blob(parts, { type: 'video/mp4' });
}

// ---------- ダウンロード保存 ----------

// 保存はサービスワーカーに依頼する（オフスクリーンでは chrome.downloads が使えないため）。
// Blob の URL を渡し、完了はダウンロード状態のポーリングで待つ。
async function saveBlob(blob, filename, job) {
  var url = URL.createObjectURL(blob);
  try {
    var resp = await chrome.runtime.sendMessage({
      target: 'sw', type: 'downloadBlob', url: url, filename: filename, jobId: job.id
    });
    if (!resp || !resp.ok) {
      throw new Error('ダウンロードを開始できませんでした' + (resp && resp.error ? ': ' + resp.error : ''));
    }
    var downloadId = resp.downloadId;
    for (;;) {
      if (job.abort.signal.aborted) {
        chrome.runtime.sendMessage({ target: 'sw', type: 'cancelDownload', downloadId: downloadId }).catch(function () {});
        throw new Error('cancelled');
      }
      await new Promise(function (r) { setTimeout(r, 1500); });
      var st = await chrome.runtime.sendMessage({
        target: 'sw', type: 'downloadState', downloadId: downloadId
      }).catch(function () { return null; });
      if (st && st.state === 'complete') return;
      if (st && st.state === 'interrupted') {
        throw new Error('ダウンロードが中断されました' + (st.error ? ': ' + st.error : ''));
      }
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- ジョブ実行 ----------

// セグメントを順番に処理する（次の1つを先読みして待ち時間を減らす）。
// 全セグメントをメモリに抱えないため、長尺でも一定のメモリ使用量で済む。
async function forEachSegment(segments, job, fn) {
  if (segments.length === 0) return;
  var i = 0;
  var pending = fetchSegment(segments[0], job.abort.signal);
  while (i < segments.length) {
    // 先読み済みの1セグメントは保持したまま、処理の前に一時停止を待つ
    await waitWhilePaused(job);
    var data = await pending;
    var nextP = null;
    if (i + 1 < segments.length) {
      nextP = fetchSegment(segments[i + 1], job.abort.signal);
      nextP.catch(function () {});
    }
    job.done++;
    job.bytes += data.byteLength;
    report(job);
    await fn(data, i);
    if (job.abort.signal.aborted) throw new Error('cancelled');
    pending = nextP;
    i++;
  }
}

// TS セグメントを変換しながら書き出し先へ流す
async function streamTransmuxToWriter(segments, job, writable) {
  var transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
  var initAppended = false;
  var writeChain = Promise.resolve();
  transmuxer.on('data', function (segment) {
    if (!initAppended && segment.initSegment) {
      var init = new Uint8Array(segment.initSegment);
      writeChain = writeChain.then(function () { return writable.write(init); });
      initAppended = true;
    }
    if (segment.data) {
      var chunk = new Uint8Array(segment.data);
      writeChain = writeChain.then(function () { return writable.write(chunk); });
    }
  });
  await forEachSegment(segments, job, function (data) {
    transmuxer.push(data);
    transmuxer.flush();
  });
  await writeChain;
}

// fMP4 セグメントをそのまま書き出し先へ流す
async function streamFmp4ToWriter(playlist, job, writable) {
  if (playlist.map && playlist.map.uri) {
    var mapOpts = { signal: job.abort.signal };
    if (playlist.map.byterange) {
      mapOpts.range = 'bytes=' + playlist.map.byterange.offset + '-' +
        (playlist.map.byterange.offset + playlist.map.byterange.length - 1);
    }
    await writable.write(new Uint8Array(await fetchBytes(playlist.map.uri, mapOpts)));
  }
  await forEachSegment(playlist.segments, job, function (data) {
    return writable.write(data);
  });
}

async function runJob(job) {
  var opfsRoot = null;
  var opfsName = null;
  try {
    job.state = 'running';
    report(job);
    await setHeaderRule(job.playlistUrl, job.headers, job.pageUrl);

    var text = await fetchText(job.playlistUrl, { signal: job.abort.signal });
    var playlist = HLS.parsePlaylist(text, job.playlistUrl);
    if (playlist.isMaster) throw new Error('マスタープレイリストです。画質を選択してから開始してください');
    if (playlist.segments.length === 0) throw new Error('セグメントが見つかりませんでした');
    if (playlist.isLive) throw new Error('ライブ配信（ENDLIST なし）は対象外です');
    job.total = playlist.segments.length;
    report(job);

    var file = null;
    // 本命：OPFS（ブラウザ内の一時ファイル領域）へ逐次書き出し、メモリに全量を抱えない
    try {
      opfsRoot = await navigator.storage.getDirectory();
      opfsName = 'jobfile_' + job.id + '.mp4';
      var fh = await opfsRoot.getFileHandle(opfsName, { create: true });
      var writable = await fh.createWritable();
      try {
        if (playlist.map) await streamFmp4ToWriter(playlist, job, writable);
        else await streamTransmuxToWriter(playlist.segments, job, writable);
        await writable.close();
      } catch (streamErr) {
        try { await writable.abort(); } catch (ignored) {}
        throw streamErr;
      }
      file = await fh.getFile();
    } catch (opfsErr) {
      if (job.abort.signal.aborted) throw opfsErr;
      // OPFS が使えない・失敗した場合はメモリ方式にフォールバックする（短尺向け）
      job.done = 0;
      job.bytes = 0;
      report(job);
      if (playlist.map) {
        file = await concatFmp4(playlist, job);
      } else {
        var segmentsData = await fetchAllSegments(playlist.segments, job, null);
        file = await transmuxToMp4(segmentsData);
      }
    }
    if (job.abort.signal.aborted) throw new Error('cancelled');

    await saveBlob(file, job.filename, job);
    job.state = 'done';
    report(job);
  } catch (e) {
    if (job.abort.signal.aborted || (e && e.message === 'cancelled')) {
      job.state = 'cancelled';
    } else {
      job.state = 'error';
      job.error = String(e && e.message ? e.message : e);
    }
    report(job);
  } finally {
    await clearHeaderRule();
    if (opfsRoot && opfsName) {
      try { await opfsRoot.removeEntry(opfsName); } catch (ignored) {}
    }
    delete jobs[job.id];
  }
}

// ---------- メッセージ ----------

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;

  if (msg.type === 'inspect') {
    // プレイリストを取得して構造（マスターか、画質一覧、セグメント数など）を返す
    (async function () {
      try {
        await setHeaderRule(msg.url, msg.headers, msg.pageUrl);
        var text = await fetchText(msg.url, {});
        var playlist = HLS.parsePlaylist(text, msg.url);
        var totalDuration = playlist.segments.reduce(function (a, s) { return a + (s.duration || 0); }, 0);
        sendResponse({
          ok: true,
          isMaster: playlist.isMaster,
          isLive: playlist.isLive,
          variants: playlist.variants,
          segmentCount: playlist.segments.length,
          totalDuration: totalDuration,
          hasMap: !!playlist.map
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      } finally {
        clearHeaderRule();
      }
    })();
    return true;
  }

  if (msg.type === 'startJob') {
    if (jobs[msg.job.id]) {
      // 再送による二重開始を防ぐ
      sendResponse({ ok: true, duplicate: true });
      return;
    }
    var job = {
      id: msg.job.id,
      playlistUrl: msg.job.playlistUrl,
      filename: msg.job.filename,
      headers: msg.job.headers || {},
      pageUrl: msg.job.pageUrl || null,
      abort: new AbortController(),
      state: 'running',
      paused: false,
      done: 0,
      total: 0,
      bytes: 0,
      error: null
    };
    jobs[job.id] = job;
    runJob(job).catch(function (e) {
      // runJob 内で処理しきれなかった例外の最終受け皿
      try {
        job.state = 'error';
        job.error = String(e && e.message ? e.message : e);
        report(job);
      } catch (ignored) { /* noop */ }
      delete jobs[job.id];
    });
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'cancelJob') {
    var j = jobs[msg.jobId];
    if (j) j.abort.abort();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'pauseJob') {
    var pj = jobs[msg.jobId];
    if (pj && pj.state === 'running') {
      pj.paused = true;
      report(pj);
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'resumeJob') {
    var rj = jobs[msg.jobId];
    if (rj && rj.state === 'running') {
      rj.paused = false;
      report(rj);
    }
    sendResponse({ ok: true });
    return;
  }
});
