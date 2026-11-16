// サービスワーカー：m3u8 リクエストの検出と、オフスクリーンドキュメントの管理。
'use strict';

var M3U8_FILTER = { urls: ['*://*/*.m3u8*'] };

// ---------- 検出結果の保存（タブ単位、セッションストレージ） ----------

function storageKey(tabId) {
  return 'det_' + tabId;
}

async function getDetections(tabId) {
  var key = storageKey(tabId);
  var obj = await chrome.storage.session.get(key);
  return obj[key] || [];
}

async function addDetection(tabId, entry) {
  var list = await getDetections(tabId);
  for (var i = 0; i < list.length; i++) {
    if (list[i].url === entry.url) {
      // 同じ URL はヘッダー情報だけ更新する
      list[i].headers = entry.headers;
      list[i].time = entry.time;
      await chrome.storage.session.set({ [storageKey(tabId)]: list });
      return;
    }
  }
  list.push(entry);
  await chrome.storage.session.set({ [storageKey(tabId)]: list });
  updateBadge(tabId, list.length);
}

async function clearDetections(tabId) {
  await chrome.storage.session.remove(storageKey(tabId));
  updateBadge(tabId, 0);
}

function updateBadge(tabId, count) {
  if (tabId < 0) return;
  chrome.action.setBadgeText({ tabId: tabId, text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#2e7d32' });
}

// ---------- リクエストの監視 ----------

// 再生側が使ったヘッダー（Referer / User-Agent / Origin）を控える。
// Cookie ヘッダー自体は読まない（取得時はブラウザの Cookie Jar から自動付与される）。
chrome.webRequest.onBeforeSendHeaders.addListener(
  function (details) {
    if (details.tabId < 0) return;
    var headers = {};
    (details.requestHeaders || []).forEach(function (h) {
      var name = h.name.toLowerCase();
      if (name === 'referer') headers.referer = h.value;
      else if (name === 'user-agent') headers.userAgent = h.value;
      else if (name === 'origin') headers.origin = h.value;
    });
    var entry = {
      url: details.url,
      pageUrl: details.documentUrl || details.initiator || null,
      time: Date.now(),
      headers: headers
    };
    // ページのタイトルは tabs API から補う
    chrome.tabs.get(details.tabId).then(function (tab) {
      entry.pageTitle = tab && tab.title ? tab.title : null;
      entry.pageUrl = entry.pageUrl || (tab ? tab.url : null);
      addDetection(details.tabId, entry);
    }).catch(function () {
      addDetection(details.tabId, entry);
    });
  },
  M3U8_FILTER,
  ['requestHeaders', 'extraHeaders']
);

chrome.tabs.onRemoved.addListener(function (tabId) {
  clearDetections(tabId);
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  // ページ遷移が始まったら前ページの検出結果を消す
  if (changeInfo.status === 'loading' && changeInfo.url) {
    clearDetections(tabId);
  }
});

// ---------- オフスクリーンドキュメントの管理 ----------

var creatingOffscreen = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'src/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'm3u8 の取得と mp4 への変換を行うため'
    }).finally(function () { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

// ---------- ポップアップからのメッセージ ----------

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  // ジョブの進捗はオフスクリーンから受け取り、サービスワーカーがストレージに記録する
  // （オフスクリーンからの storage.session 書き込みが反映されない環境があるための経路）
  if (msg && msg.type === 'jobProgress' && msg.job) {
    var data = {};
    data['job_' + msg.job.jobId] = msg.job;
    data.latest_job = msg.job;
    chrome.storage.session.set(data);
    return;
  }
  if (!msg || msg.target !== 'sw') return;
  if (msg.type === 'getDetections') {
    getDetections(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.type === 'ensureOffscreen') {
    ensureOffscreen().then(function () { sendResponse({ ok: true }); })
      .catch(function (e) { sendResponse({ ok: false, error: String(e) }); });
    return true;
  }
  // ダウンロードの開始と状態確認（chrome.downloads はオフスクリーンでは使えないため SW が担当）
  if (msg.type === 'downloadBlob') {
    chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false })
      .then(function (downloadId) { sendResponse({ ok: true, downloadId: downloadId }); })
      .catch(function (e) { sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }); });
    return true;
  }
  if (msg.type === 'downloadState') {
    chrome.downloads.search({ id: msg.downloadId })
      .then(function (items) {
        if (!items || items.length === 0) {
          sendResponse({ state: 'interrupted', error: 'not_found' });
          return;
        }
        sendResponse({ state: items[0].state, error: items[0].error || null });
      })
      .catch(function (e) { sendResponse({ state: 'interrupted', error: String(e && e.message ? e.message : e) }); });
    return true;
  }
  if (msg.type === 'cancelDownload') {
    chrome.downloads.cancel(msg.downloadId).catch(function () {});
    sendResponse({ ok: true });
    return;
  }
});
