// ポップアップ：一覧 → 詳細（画質・ファイル名）→ 進捗。
'use strict';

var state = {
  tabId: null,
  detections: [],
  selected: null,     // 選択中の検出エントリ
  inspect: null,      // inspect 結果
  currentJobId: null,
  jobPaused: false,
  jobMisses: 0
};

function $(id) { return document.getElementById(id); }

function show(view) {
  ['view-list', 'view-detail', 'view-progress'].forEach(function (v) {
    $(v).hidden = v !== view;
  });
}

function sanitizeFilename(name) {
  var s = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  if (!s) s = 'video';
  if (!/\.mp4$/i.test(s)) s += '.mp4';
  return s;
}

function formatDuration(sec) {
  if (!sec || !isFinite(sec)) return '';
  sec = Math.round(sec);
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  var mm = (h > 0 && m < 10) ? '0' + m : String(m);
  var ss = s < 10 ? '0' + s : String(s);
  return (h > 0 ? h + ':' : '') + mm + ':' + ss;
}

function formatTime(ts) {
  var d = new Date(ts);
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ---------- 一覧 ----------

async function loadList() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tabs[0] ? tabs[0].id : -1;
  var list = await chrome.runtime.sendMessage({ target: 'sw', type: 'getDetections', tabId: state.tabId });
  state.detections = list || [];
  var ul = $('list');
  ul.innerHTML = '';
  $('list-empty').hidden = state.detections.length > 0;
  state.detections.forEach(function (entry, idx) {
    var li = document.createElement('li');
    var title = document.createElement('div');
    title.className = 'page-title';
    title.textContent = entry.pageTitle || '(タイトルなし)';
    var u = document.createElement('div');
    u.className = 'u';
    u.textContent = entry.url;
    var t = document.createElement('div');
    t.className = 't';
    t.textContent = '検出 ' + formatTime(entry.time);
    li.appendChild(title);
    li.appendChild(u);
    li.appendChild(t);
    li.addEventListener('click', function () { openDetail(idx); });
    ul.appendChild(li);
  });
  show('view-list');
}

// ---------- 詳細 ----------

async function openDetail(idx) {
  state.selected = state.detections[idx];
  state.inspect = null;
  show('view-detail');
  $('detail-url').textContent = state.selected.url;
  $('detail-info').textContent = 'プレイリストを確認中…';
  $('detail-error').hidden = true;
  $('variant-box').hidden = true;
  $('btn-start').disabled = true;
  $('filename').value = sanitizeFilename(state.selected.pageTitle || 'video');

  // オフスクリーンの準備ができていないとメッセージが届かないことがあるため、
  // 応答が返るまで少し待って再送する
  var res = null;
  for (var attempt = 0; attempt < 10; attempt++) {
    await chrome.runtime.sendMessage({ target: 'sw', type: 'ensureOffscreen' }).catch(function () {});
    res = await chrome.runtime.sendMessage({
      type: 'inspect',
      url: state.selected.url,
      headers: state.selected.headers,
      pageUrl: state.selected.pageUrl
    }).catch(function () { return null; });
    if (res) break;
    await new Promise(function (r) { setTimeout(r, 300); });
  }
  if (!res || !res.ok) {
    $('detail-info').textContent = '';
    $('detail-error').hidden = false;
    $('detail-error').textContent = 'プレイリストの取得に失敗しました: ' + (res ? res.error : '応答なし');
    return;
  }
  state.inspect = res;
  if (res.isMaster) {
    renderVariants(res.variants);
    $('detail-info').textContent = 'マスタープレイリスト（画質を選択してください）';
  } else {
    var dur = formatDuration(res.totalDuration);
    $('detail-info').textContent =
      'セグメント ' + res.segmentCount + ' 個' + (dur ? ' / 長さ ' + dur : '') +
      (res.isLive ? ' / ライブ配信は対象外です' : '');
    if (res.isLive) {
      $('detail-error').hidden = false;
      $('detail-error').textContent = 'ライブ配信（ENDLIST なし）はこの拡張機能の対象外です。';
      return;
    }
  }
  $('btn-start').disabled = false;
}

function renderVariants(variants) {
  var box = $('variants');
  box.innerHTML = '';
  var sorted = variants.slice().sort(function (a, b) {
    return (b.bandwidth || 0) - (a.bandwidth || 0);
  });
  sorted.forEach(function (v, i) {
    var label = document.createElement('label');
    var radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'variant';
    radio.value = v.uri;
    if (i === 0) radio.checked = true;
    var text = '';
    if (v.resolution) text += v.resolution.width + 'x' + v.resolution.height + ' ';
    if (v.bandwidth) text += (v.bandwidth / 1000000).toFixed(2) + ' Mbps ';
    if (v.name) text += v.name + ' ';
    if (v.codecs) text += '(' + v.codecs + ')';
    label.appendChild(radio);
    label.appendChild(document.createTextNode(text || v.uri));
    box.appendChild(label);
  });
  $('variant-box').hidden = sorted.length === 0;
}

function chosenPlaylistUrl() {
  if (state.inspect && state.inspect.isMaster) {
    var checked = document.querySelector('input[name="variant"]:checked');
    return checked ? checked.value : state.selected.url;
  }
  return state.selected.url;
}

// ---------- ジョブ ----------

async function startJob() {
  var filename = sanitizeFilename($('filename').value);
  var jobId = 'job_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  state.currentJobId = jobId;
  state.jobMisses = 0;
  $('progress-file').textContent = filename;
  setProgress(0);
  $('progress-text').textContent = '開始しています…';
  $('progress-text').classList.remove('paused');
  state.jobPaused = false;
  $('btn-pause').hidden = false;
  $('btn-pause').textContent = '一時停止';
  $('btn-pause').className = 'ghost';
  $('btn-cancel').hidden = false;
  $('btn-close').hidden = true;
  show('view-progress');
  pollJob();

  // オフスクリーンのリスナーがまだ登録されていないと startJob が届かず、
  // 応答も返らないままになることがある。{ ok: true } が返るまで再送する。
  var jobMessage = {
    type: 'startJob',
    job: {
      id: jobId,
      playlistUrl: chosenPlaylistUrl(),
      filename: filename,
      headers: state.selected.headers,
      pageUrl: state.selected.pageUrl
    }
  };
  var started = false;
  for (var i = 0; i < 20 && !started; i++) {
    await chrome.runtime.sendMessage({ target: 'sw', type: 'ensureOffscreen' }).catch(function () {});
    var resp = await chrome.runtime.sendMessage(jobMessage).catch(function () { return null; });
    if (resp && resp.ok) started = true;
    else await new Promise(function (r) { setTimeout(r, 300); });
  }
  if (started && state.currentJobId === jobId) {
    // ページ上に進捗カードを出せたらポップアップは閉じる。
    // 出せないページ（chrome:// など）では従来の進捗画面のままにする。
    var attach = await chrome.runtime.sendMessage({
      target: 'sw', type: 'attachOverlay', tabId: state.tabId, jobId: jobId
    }).catch(function () { return null; });
    if (attach && attach.ok) {
      state.currentJobId = null;
      window.close();
      return;
    }
  }
  if (!started && state.currentJobId === jobId) {
    $('progress-text').textContent = 'エラー: ジョブを開始できませんでした。拡張機能を再読み込みして、もう一度お試しください';
    $('btn-pause').hidden = true;
    $('btn-cancel').hidden = true;
    $('btn-close').hidden = false;
    state.currentJobId = null;
  }
}

async function pollJob() {
  if (!state.currentJobId) return;
  var key = 'job_' + state.currentJobId;
  var obj = await chrome.storage.session.get(key);
  var job = obj[key];
  if (job) {
    state.jobMisses = 0;
    renderJob(job);
  } else {
    state.jobMisses = (state.jobMisses || 0) + 1;
    // 30回（約15秒）待ってもジョブの記録が現れなければ開始失敗として打ち切る
    if (state.jobMisses > 30) {
      $('progress-text').textContent = 'エラー: ジョブが開始されませんでした。拡張機能を再読み込みして、もう一度お試しください';
      $('btn-pause').hidden = true;
      $('btn-cancel').hidden = true;
      $('btn-close').hidden = false;
      state.currentJobId = null;
      return;
    }
  }
  if (!job || job.state === 'running') {
    setTimeout(pollJob, 500);
  }
}

function setProgress(pct) {
  $('progress-bar').style.width = pct + '%';
  $('progress-pct').textContent = pct + '%';
}

function renderJob(job) {
  state.jobPaused = !!job.paused;
  var pct = job.total > 0 ? Math.floor((job.done / job.total) * 100) : 0;
  setProgress(pct);
  var mb = (job.bytes / (1024 * 1024)).toFixed(1);
  $('progress-text').classList.toggle('paused', job.state === 'running' && !!job.paused);
  $('btn-pause').hidden = job.state !== 'running';
  if (job.state === 'running') {
    $('progress-text').textContent = job.paused
      ? '一時停止中 ' + job.done + ' / ' + job.total + ' セグメント（' + mb + ' MB）'
      : '取得中 ' + job.done + ' / ' + job.total + ' セグメント（' + mb + ' MB）';
    $('btn-pause').textContent = job.paused ? '再開' : '一時停止';
    $('btn-pause').className = job.paused ? 'primary' : 'ghost';
  } else if (job.state === 'done') {
    $('progress-text').textContent = '完了しました（' + mb + ' MB）';
    $('btn-cancel').hidden = true;
    $('btn-close').hidden = false;
  } else if (job.state === 'cancelled') {
    $('progress-text').textContent = 'キャンセルしました';
    $('btn-cancel').hidden = true;
    $('btn-close').hidden = false;
  } else if (job.state === 'error') {
    $('progress-text').textContent = 'エラー: ' + (job.error || '不明');
    $('btn-cancel').hidden = true;
    $('btn-close').hidden = false;
  }
}

chrome.runtime.onMessage.addListener(function (msg) {
  if (msg && msg.type === 'jobProgress' && state.currentJobId === msg.job.jobId) {
    renderJob(msg.job);
  }
});

// ---------- イベント ----------

$('btn-back').addEventListener('click', loadList);
$('btn-start').addEventListener('click', startJob);
$('btn-cancel').addEventListener('click', async function () {
  if (state.currentJobId) {
    await chrome.runtime.sendMessage({ type: 'cancelJob', jobId: state.currentJobId });
  }
});
$('btn-pause').addEventListener('click', async function () {
  if (state.currentJobId) {
    await chrome.runtime.sendMessage({
      type: state.jobPaused ? 'resumeJob' : 'pauseJob', jobId: state.currentJobId
    });
  }
});
$('btn-close').addEventListener('click', function () { window.close(); });

// 開き直したとき、進行中のジョブがあれば進捗画面を復元する
async function init() {
  var obj = await chrome.storage.session.get('latest_job');
  var job = obj.latest_job;
  if (job && job.state === 'running') {
    state.currentJobId = job.jobId;
    $('progress-file').textContent = job.filename || '';
    $('btn-pause').hidden = false;
    $('btn-cancel').hidden = false;
    $('btn-close').hidden = true;
    renderJob(job);
    show('view-progress');
    pollJob();
    return;
  }
  loadList();
}

document.addEventListener('DOMContentLoaded', init);
