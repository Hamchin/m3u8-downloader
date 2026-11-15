// HLS (m3u8) プレイリストの簡易パーサ。
// ポップアップ・オフスクリーン・Node テストから共通で使う。
(function (global) {
  'use strict';

  // EXT-X-STREAM-INF などの属性リスト "KEY=VALUE,KEY2=\"VALUE2\"" をオブジェクトにする
  function parseAttributes(str) {
    var attrs = {};
    var re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
    var m;
    while ((m = re.exec(str)) !== null) {
      var v = m[2];
      if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1);
      attrs[m[1].toUpperCase()] = v;
    }
    return attrs;
  }

  function resolveUrl(base, ref) {
    try {
      return new URL(ref, base).toString();
    } catch (e) {
      return ref;
    }
  }

  // "length@offset" 形式のバイトレンジ。offset 省略時は null（直前の終端から）
  function parseByteRange(str) {
    if (!str) return null;
    var parts = str.split('@');
    return {
      length: parseInt(parts[0], 10),
      offset: parts.length > 1 && parts[1] !== '' ? parseInt(parts[1], 10) : null
    };
  }

  // 16進文字列の IV を Uint8Array(16) にする
  function parseIV(str) {
    if (!str) return null;
    var hex = str.replace(/^0x/i, '');
    var out = new Uint8Array(16);
    for (var i = 0; i < 16; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2) || '0', 16);
    }
    return out;
  }

  // IV が指定されていない場合の、メディアシーケンス番号から作る IV
  function ivFromSequence(seq) {
    var out = new Uint8Array(16);
    var n = BigInt(seq);
    for (var i = 15; i >= 0 && n > 0n; i--) {
      out[i] = Number(n & 0xffn);
      n >>= 8n;
    }
    return out;
  }

  function parsePlaylist(text, baseUrl) {
    var lines = String(text).split(/\r?\n/);
    var result = {
      isMaster: false,
      variants: [],
      isLive: true,
      mediaSequence: 0,
      targetDuration: null,
      map: null,
      segments: []
    };
    var currentKey = null; // {method, uri, iv}
    var pendingVariant = null;
    var pendingSegment = null;
    var nextByteRange = null;
    var prevByteRangeEnd = {}; // uri -> 終端オフセット（EXT-X-BYTERANGE の offset 省略時用）

    function flushSegment(uriLine) {
      if (!pendingSegment) return;
      var abs = resolveUrl(baseUrl, uriLine);
      var seg = {
        uri: abs,
        duration: pendingSegment.duration || 0,
        byterange: pendingSegment.byterange || null,
        key: currentKey,
        sequence: result.mediaSequence + result.segments.length
      };
      if (seg.byterange) {
        if (seg.byterange.offset === null) {
          seg.byterange.offset = prevByteRangeEnd[abs] || 0;
        }
        prevByteRangeEnd[abs] = seg.byterange.offset + seg.byterange.length;
      }
      result.segments.push(seg);
      pendingSegment = null;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line[0] !== '#') {
        if (pendingVariant) {
          pendingVariant.uri = resolveUrl(baseUrl, line);
          result.variants.push(pendingVariant);
          pendingVariant = null;
        } else {
          flushSegment(line);
        }
        continue;
      }
      if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
        result.isMaster = true;
        var vattrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
        var res = null;
        if (vattrs.RESOLUTION) {
          var rp = vattrs.RESOLUTION.split('x');
          res = { width: parseInt(rp[0], 10), height: parseInt(rp[1], 10) };
        }
        pendingVariant = {
          uri: null,
          bandwidth: vattrs.BANDWIDTH ? parseInt(vattrs.BANDWIDTH, 10) : null,
          averageBandwidth: vattrs['AVERAGE-BANDWIDTH'] ? parseInt(vattrs['AVERAGE-BANDWIDTH'], 10) : null,
          resolution: res,
          codecs: vattrs.CODECS || null,
          name: vattrs.NAME || null
        };
      } else if (line.indexOf('#EXT-X-MEDIA-SEQUENCE:') === 0) {
        result.mediaSequence = parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10) || 0;
      } else if (line.indexOf('#EXT-X-TARGETDURATION:') === 0) {
        result.targetDuration = parseFloat(line.slice('#EXT-X-TARGETDURATION:'.length));
      } else if (line.indexOf('#EXT-X-KEY:') === 0) {
        var kattrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
        if (!kattrs.METHOD || kattrs.METHOD === 'NONE') {
          currentKey = null;
        } else {
          currentKey = {
            method: kattrs.METHOD,
            uri: kattrs.URI ? resolveUrl(baseUrl, kattrs.URI) : null,
            iv: kattrs.IV ? parseIV(kattrs.IV) : null
          };
        }
      } else if (line.indexOf('#EXT-X-MAP:') === 0) {
        var mattrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
        result.map = {
          uri: mattrs.URI ? resolveUrl(baseUrl, mattrs.URI) : null,
          byterange: parseByteRange(mattrs.BYTERANGE)
        };
      } else if (line.indexOf('#EXT-X-BYTERANGE:') === 0) {
        nextByteRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length));
      } else if (line.indexOf('#EXTINF:') === 0) {
        var dur = parseFloat(line.slice('#EXTINF:'.length).split(',')[0]);
        pendingSegment = { duration: isNaN(dur) ? 0 : dur, byterange: nextByteRange };
        nextByteRange = null;
      } else if (line === '#EXT-X-ENDLIST') {
        result.isLive = false;
      }
    }
    // isLive は #EXT-X-ENDLIST が無いメディアプレイリストの場合に true のまま残る
    return result;
  }

  var api = {
    parseAttributes: parseAttributes,
    parsePlaylist: parsePlaylist,
    parseIV: parseIV,
    ivFromSequence: ivFromSequence,
    resolveUrl: resolveUrl
  };

  global.HLS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
