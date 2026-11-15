// パイプライン検証：公開テスト配信を使い、
// parse → セグメント取得 → mux.js で mp4 化 → ファイル出力までを通す。
// 実行: node test/pipeline-test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HLS = require('../src/lib/hls.js');

// mux.js (UMD) を vm 上で読み込む（window/self を自分自身に向ける）
function loadMux() {
  const code = fs.readFileSync(path.join(__dirname, '../src/lib/mux.min.js'), 'utf8');
  const sandbox = { console, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array, DataView, ArrayBuffer, Math, JSON, Date, RegExp, Error, TypeError, Object, Array, String, Number, Boolean, Promise, Symbol, Map, Set, WeakMap, isNaN, isFinite, parseInt, parseFloat, NaN, Infinity, undefined };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  if (!sandbox.muxjs) throw new Error('muxjs が読み込めませんでした');
  return sandbox.muxjs;
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + url);
  return res.text();
}
async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + url);
  return new Uint8Array(await res.arrayBuffer());
}

async function main() {
  const masterUrl = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
  console.log('master:', masterUrl);
  const master = HLS.parsePlaylist(await fetchText(masterUrl), masterUrl);
  console.log('isMaster:', master.isMaster, 'variants:', master.variants.length);
  master.variants.forEach(v => console.log('  variant:', v.resolution && (v.resolution.width + 'x' + v.resolution.height), v.bandwidth, v.uri));
  if (!master.isMaster || master.variants.length === 0) throw new Error('マスター解析に失敗');

  // 最も低い帯域のバリアントで検証する（速く終わらせるため）
  const variant = master.variants.slice().sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0))[0];
  const media = HLS.parsePlaylist(await fetchText(variant.uri), variant.uri);
  console.log('media: segments =', media.segments.length, 'isLive =', media.isLive, 'map =', !!media.map);
  if (media.segments.length === 0) throw new Error('セグメントがありません');

  const LIMIT = Math.min(12, media.segments.length);
  const segmentsData = [];
  for (let i = 0; i < LIMIT; i++) {
    segmentsData.push(await fetchBytes(media.segments[i].uri));
  }
  console.log('fetched segments:', segmentsData.length, 'total bytes:', segmentsData.reduce((a, b) => a + b.byteLength, 0));

  const muxjs = loadMux();
  const parts = [];
  await new Promise((resolve, reject) => {
    const transmuxer = new muxjs.mp4.Transmuxer({ remux: true });
    let initAppended = false;
    transmuxer.on('data', (segment) => {
      if (!initAppended && segment.initSegment) {
        parts.push(Buffer.from(segment.initSegment));
        initAppended = true;
      }
      if (segment.data) parts.push(Buffer.from(segment.data));
    });
    transmuxer.on('done', resolve);
    try {
      segmentsData.forEach(d => { transmuxer.push(d); transmuxer.flush(); });
    } catch (e) { reject(e); }
  });
  const out = Buffer.concat(parts);
  const outPath = path.join(__dirname, 'out.mp4');
  fs.writeFileSync(outPath, out);
  console.log('wrote', outPath, out.length, 'bytes');
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
