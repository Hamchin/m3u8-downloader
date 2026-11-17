// ページ上に表示するダウンロード進捗カード（コンテンツスクリプト）。
// ダウンロード開始時にサービスワーカーが chrome.scripting で対象タブへ注入する。
// 進捗はサービスワーカーから tabs.sendMessage で中継されてくる。
(function () {
  'use strict';
  if (window.__m3u8DownloaderOverlay) return;
  window.__m3u8DownloaderOverlay = true;

  var CSS = [
    ':host { all: initial; }',
    '.stack {',
    '  position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;',
    '  display: flex; flex-direction: column; gap: 10px;',
    '  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;',
    '}',
    '.card {',
    '  width: 330px; background: #ffffff; color: #1c1b26;',
    '  border-radius: 12px; box-shadow: 0 10px 34px rgba(0, 0, 0, 0.45);',
    '  overflow: hidden; font-size: 12.5px; line-height: 1.5;',
    '}',
    '.bar-top { height: 4px; background: linear-gradient(90deg, #4f46e5, #7c3aed); }',
    '.inner { padding: 11px 13px 12px; }',
    '.fname { font-weight: 700; font-size: 13px; margin-bottom: 2px; word-break: break-all; }',
    '.status { color: #6f6c85; margin-bottom: 8px; word-break: break-all; }',
    '.status.done { color: #16a34a; font-weight: 700; }',
    '.status.error { color: #c62828; font-weight: 700; }',
    '.track { height: 8px; background: #ececf1; border-radius: 99px; overflow: hidden; margin-bottom: 9px; }',
    '.fill { height: 100%; background: linear-gradient(90deg, #4f46e5, #7c3aed); border-radius: 99px; transition: width 0.3s ease; }',
    '.row { display: flex; justify-content: space-between; align-items: center; }',
    '.pct { font-weight: 700; color: #4f46e5; }',
    'button {',
    '  border: 1px solid #ddd6fe; background: #f5f3ff; color: #4f46e5;',
    '  font-weight: 600; border-radius: 8px; padding: 4px 12px;',
    '  cursor: pointer; font-size: 12px; font-family: inherit;',
    '}',
    'button:hover { background: #ede9fe; }',
    '@media (prefers-color-scheme: dark) {',
    '  .card { background: #1f1f2a; color: #eceaf6; }',
    '  .status { color: #a3a0b8; }',
    '  .status.done { color: #4ade80; }',
    '  .status.error { color: #ff9a92; }',
    '  .track { background: #33334a; }',
    '  .pct { color: #a78bfa; }',
    '  button { border-color: #4c1d95; background: rgba(124, 58, 237, 0.20); color: #c4b5fd; }',
    '  button:hover { background: rgba(124, 58, 237, 0.32); }',
    '}'
  ].join('\n');

  var host = document.createElement('div');
  var shadow = host.attachShadow({ mode: 'closed' });
  var style = document.createElement('style');
  style.textContent = CSS;
  shadow.appendChild(style);
  var stack = document.createElement('div');
  stack.className = 'stack';
  shadow.appendChild(stack);
  (document.body || document.documentElement).appendChild(host);

  var cards = {}; // jobId -> {root, fname, status, fill, pct, button, state}

  function buildCard(jobId) {
    var card = document.createElement('div');
    card.className = 'card';
    var barTop = document.createElement('div');
    barTop.className = 'bar-top';
    var inner = document.createElement('div');
    inner.className = 'inner';
    var fname = document.createElement('div');
    fname.className = 'fname';
    var status = document.createElement('div');
    status.className = 'status';
    var track = document.createElement('div');
    track.className = 'track';
    var fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = '0%';
    track.appendChild(fill);
    var row = document.createElement('div');
    row.className = 'row';
    var pct = document.createElement('span');
    pct.className = 'pct';
    pct.textContent = '0%';
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'キャンセル';
    row.appendChild(pct);
    row.appendChild(button);
    inner.appendChild(fname);
    inner.appendChild(status);
    inner.appendChild(track);
    inner.appendChild(row);
    card.appendChild(barTop);
    card.appendChild(inner);
    stack.appendChild(card);

    var entry = {
      root: card, fname: fname, status: status,
      fill: fill, pct: pct, button: button, state: 'running'
    };
    button.addEventListener('click', function () {
      if (entry.state === 'running') {
        chrome.runtime.sendMessage({ type: 'cancelJob', jobId: jobId }).catch(function () {});
      } else {
        card.remove();
        delete cards[jobId];
      }
    });
    cards[jobId] = entry;
    return entry;
  }

  function render(job) {
    var entry = cards[job.jobId] || buildCard(job.jobId);
    entry.state = job.state;
    entry.fname.textContent = job.filename || '';
    var mb = ((job.bytes || 0) / (1024 * 1024)).toFixed(1);
    var pct = job.total > 0 ? Math.floor((job.done / job.total) * 100) : 0;
    entry.status.className = 'status';
    if (job.state === 'running') {
      if (job.total > 0) {
        entry.status.textContent = '取得中 ' + job.done + ' / ' + job.total + ' セグメント（' + mb + ' MB）';
      } else {
        entry.status.textContent = '開始しています…';
      }
      entry.button.textContent = 'キャンセル';
      entry.button.hidden = false;
    } else if (job.state === 'done') {
      pct = 100;
      entry.status.textContent = '✓ 完了しました（' + mb + ' MB）';
      entry.status.classList.add('done');
      entry.button.textContent = '閉じる';
      entry.button.hidden = false;
    } else if (job.state === 'cancelled') {
      entry.status.textContent = 'キャンセルしました';
      entry.button.textContent = '閉じる';
      entry.button.hidden = false;
    } else if (job.state === 'error') {
      entry.status.textContent = 'エラー: ' + (job.error || '不明');
      entry.status.classList.add('error');
      entry.button.textContent = '閉じる';
      entry.button.hidden = false;
    }
    entry.fill.style.width = pct + '%';
    entry.pct.textContent = pct + '%';
  }

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.target !== 'overlay' || msg.type !== 'jobProgress' || !msg.job) return;
    render(msg.job);
  });
})();
