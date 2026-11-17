// ページ上に表示するダウンロード進捗カード（コンテンツスクリプト）。
// ダウンロード開始時にサービスワーカーが chrome.scripting で対象タブへ注入する。
// 進捗はサービスワーカーから tabs.sendMessage で中継されてくる。
(function () {
  'use strict';
  if (window.__m3u8DownloaderOverlay) return;
  window.__m3u8DownloaderOverlay = true;

  var ICON_PAUSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2" width="4" height="12" rx="1"/><rect x="9.5" y="2" width="4" height="12" rx="1"/></svg>';
  var ICON_PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.3c0-.8.9-1.3 1.6-.9l8 5.4c.6.4.6 1.3 0 1.7l-8 5.4c-.7.4-1.6-.1-1.6-.9z"/></svg>';
  var ICON_CLOSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 3.1 8 6.9l3.8-3.8 1.1 1.1L9.1 8l3.8 3.8-1.1 1.1L8 9.1l-3.8 3.8-1.1-1.1L6.9 8 3.1 4.2z"/></svg>';

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
    '.status.paused { color: #b45309; font-weight: 700; }',
    '.track { height: 8px; background: #ececf1; border-radius: 99px; overflow: hidden; margin-bottom: 9px; }',
    '.fill { height: 100%; background: linear-gradient(90deg, #4f46e5, #7c3aed); border-radius: 99px; transition: width 0.3s ease; }',
    '.row { display: flex; justify-content: space-between; align-items: center; }',
    '.pct { font-weight: 700; color: #4f46e5; }',
    '.btns { display: flex; gap: 6px; }',
    '.icon-btn {',
    '  width: 30px; height: 30px; border-radius: 50%; padding: 0;',
    '  border: 1px solid #ddd6fe; background: #f5f3ff; color: #4f46e5;',
    '  display: flex; align-items: center; justify-content: center;',
    '  cursor: pointer; font-family: inherit;',
    '}',
    '.icon-btn:hover { background: #ede9fe; }',
    '.icon-btn svg { width: 14px; height: 14px; fill: currentColor; display: block; }',
    '@media (prefers-color-scheme: dark) {',
    '  .card { background: #1f1f2a; color: #eceaf6; }',
    '  .status { color: #a3a0b8; }',
    '  .status.done { color: #4ade80; }',
    '  .status.error { color: #ff9a92; }',
    '  .status.paused { color: #fbbf24; }',
    '  .track { background: #33334a; }',
    '  .pct { color: #a78bfa; }',
    '  .icon-btn { border-color: #4c1d95; background: rgba(124, 58, 237, 0.20); color: #c4b5fd; }',
    '  .icon-btn:hover { background: rgba(124, 58, 237, 0.32); }',
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

  var cards = {}; // jobId -> {root, fname, status, fill, pct, toggleBtn, closeBtn, state, paused}

  function makeIconButton(icon, title) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn';
    b.innerHTML = icon; // 固定文字列の SVG のみ。外部データは入れない
    b.title = title;
    b.setAttribute('aria-label', title);
    return b;
  }

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
    var btns = document.createElement('span');
    btns.className = 'btns';
    var toggleBtn = makeIconButton(ICON_PAUSE, '一時停止');
    var closeBtn = makeIconButton(ICON_CLOSE, 'キャンセル');
    btns.appendChild(toggleBtn);
    btns.appendChild(closeBtn);
    row.appendChild(pct);
    row.appendChild(btns);
    inner.appendChild(fname);
    inner.appendChild(status);
    inner.appendChild(track);
    inner.appendChild(row);
    card.appendChild(barTop);
    card.appendChild(inner);
    stack.appendChild(card);

    var entry = {
      root: card, fname: fname, status: status, fill: fill, pct: pct,
      toggleBtn: toggleBtn, closeBtn: closeBtn, state: 'running', paused: false
    };
    toggleBtn.addEventListener('click', function () {
      if (entry.state !== 'running') return;
      chrome.runtime.sendMessage({
        type: entry.paused ? 'resumeJob' : 'pauseJob', jobId: jobId
      }).catch(function () {});
    });
    closeBtn.addEventListener('click', function () {
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

  function setToggle(entry, icon, title) {
    entry.toggleBtn.innerHTML = icon;
    entry.toggleBtn.title = title;
    entry.toggleBtn.setAttribute('aria-label', title);
  }

  function render(job) {
    var entry = cards[job.jobId] || buildCard(job.jobId);
    entry.state = job.state;
    entry.paused = !!job.paused;
    entry.fname.textContent = job.filename || '';
    var mb = ((job.bytes || 0) / (1024 * 1024)).toFixed(1);
    var pct = job.total > 0 ? Math.floor((job.done / job.total) * 100) : 0;
    entry.status.className = 'status';
    if (job.state === 'running') {
      entry.toggleBtn.hidden = false;
      entry.closeBtn.title = 'キャンセル';
      entry.closeBtn.setAttribute('aria-label', 'キャンセル');
      if (entry.paused) {
        entry.status.textContent = '一時停止中 ' + job.done + ' / ' + job.total + ' セグメント（' + mb + ' MB）';
        entry.status.classList.add('paused');
        setToggle(entry, ICON_PLAY, '再開');
      } else {
        if (job.total > 0) {
          entry.status.textContent = '取得中 ' + job.done + ' / ' + job.total + ' セグメント（' + mb + ' MB）';
        } else {
          entry.status.textContent = '開始しています…';
        }
        setToggle(entry, ICON_PAUSE, '一時停止');
      }
    } else if (job.state === 'done') {
      pct = 100;
      entry.status.textContent = '✓ 完了しました（' + mb + ' MB）';
      entry.status.classList.add('done');
      entry.toggleBtn.hidden = true;
      entry.closeBtn.title = '閉じる';
      entry.closeBtn.setAttribute('aria-label', '閉じる');
    } else if (job.state === 'cancelled') {
      entry.status.textContent = 'キャンセルしました';
      entry.toggleBtn.hidden = true;
      entry.closeBtn.title = '閉じる';
      entry.closeBtn.setAttribute('aria-label', '閉じる');
    } else if (job.state === 'error') {
      entry.status.textContent = 'エラー: ' + (job.error || '不明');
      entry.status.classList.add('error');
      entry.toggleBtn.hidden = true;
      entry.closeBtn.title = '閉じる';
      entry.closeBtn.setAttribute('aria-label', '閉じる');
    }
    entry.fill.style.width = pct + '%';
    entry.pct.textContent = pct + '%';
  }

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.target !== 'overlay' || msg.type !== 'jobProgress' || !msg.job) return;
    render(msg.job);
  });
})();
