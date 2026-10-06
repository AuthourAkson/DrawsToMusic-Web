'use strict';
/* ============================================================================
 * piece.js —— 数据格式 / 导入 / 导出
 * ----------------------------------------------------------------------------
 * 内部格式（v1，坐标用 [0,1] 浮点，无损）：
 * {
 *   v: 1, name: '',
 *   bpm: 120, scale: 'pentatonic', key: 0,
 *   stepsPerBeat: 4, beats: 8, rows: 32,
 *   pages: [ [ {color, pts:[[x,y],...] } , ... ], ... ]   // 至少一页
 * }
 *
 * 能导入：
 *   - play_music_theory 的分享链接 / j... / d... 串 / localStorage 草稿
 *   - 本程序导出的 .json
 * ==========================================================================*/

/* ------------------------------------------------------------------ 编码工具 */
function b64uDec(t) {
  t = String(t).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function b64uEnc(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 4096) s += String.fromCharCode.apply(null, u8.subarray(i, i + 4096));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function inflateRaw(u8) {
  const ds = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(ds).arrayBuffer());
}
async function deflateRaw(u8) {
  const cs = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(cs).arrayBuffer());
}

/* -------------------------------------------- 从任意文本里抠出 PMT 的载荷串 */
function extractPMT(text) {
  const t = String(text).trim();
  const m = t.match(/[#?&]p=([A-Za-z0-9_\-]{20,})/) || t.match(/([jd][A-Za-z0-9_\-]{20,})/);
  return m ? m[1] : null;
}

/* ------------------------------------------------ 解码 play_music_theory 数据 */
async function decodePMT(packed) {
  if (!packed) throw new Error('没找到可识别的数据');
  const k = packed[0];
  if (k !== 'j' && k !== 'd') throw new Error('数据应以 j 或 d 开头');
  let bytes = b64uDec(packed.slice(1));
  if (k === 'd') bytes = await inflateRaw(bytes);
  const o = JSON.parse(new TextDecoder().decode(bytes));
  if (!o || o.v !== 1 || !Array.isArray(o.s)) throw new Error('版本不识别（v=' + (o && o.v) + '）');
  return o;
}

/* -------------------------------------------- PMT 笔画 → 我们的笔画（0..1 浮点） */
function pmtStrokes(list) {
  const out = [];
  for (const arr of (list || [])) {
    if (!Array.isArray(arr) || arr.length < 3) continue;
    const color = Math.max(0, Math.min(8, arr[0] | 0));
    const raw = [];
    for (let i = 1; i + 1 < arr.length; i += 2) raw.push([arr[i] / 999, arr[i + 1] / 999]);
    // 去掉「连续重复点」：PMT 用一个点的两次重复表示「点一下」
    const pts = [];
    for (const p of raw) {
      const q = pts[pts.length - 1];
      if (!q || Math.abs(q[0] - p[0]) > 1e-6 || Math.abs(q[1] - p[1]) > 1e-6) pts.push(p);
    }
    if (pts.length) out.push({ color, pts });
  }
  return out;
}

/* ------------------------------------------------ PMT 对象 → 内部 Piece 对象 */
function pmtToPiece(o, opts) {
  opts = opts || {};
  const pages = [pmtStrokes(o.s)];
  for (const pg of (o.pg || [])) {
    const st = pmtStrokes(pg);
    if (st.length) pages.push(st);
  }
  const SC = { pentatonic:1, minor:1, major:1, natural:1, harmonic:1, dorian:1, phrygian:1, lydian:1, mixolydian:1, blues:1, chromatic:1 };
  return {
    v: 1,
    name: opts.name || '',
    srcAspect: o.a || 60,                       // 原始 a 值（可能不准，仅作参考）
    bpm: Math.max(30, Math.min(300, o.t || 120)),
    scale: SC[o.sc] ? o.sc : (o.n === 1 ? 'minor' : 'pentatonic'),
    key: (o.k >= 0 && o.k <= 11) ? o.k : 0,
    stepsPerBeat: 4, beats: 16, rows: 32,
    ar: Math.max(0.22, Math.min(2.6, (o.a || 62) / 100)),
    pages
  };
}

/* ------------------------------------------------------- 规范化：补齐缺省字段 */
function normalizePiece(p) {
  p = p || {};
  // 容错：直接喂 play_music_theory 形状的对象（有 .s 数组、没有 .pages/.strokes）
  if (!Array.isArray(p.pages) && !Array.isArray(p.strokes) && Array.isArray(p.s)) {
    p = pmtToPiece(p, { name: p.name || '' });
  }
  const q = Object.assign({
    v: 1, name: '', bpm: 120, scale: 'pentatonic', key: 0,
    stepsPerBeat: 4, beats: 16, rows: 32, ar: 0.62, pages: []
  }, p || {});
  q.ar = Math.max(0.22, Math.min(2.6, Number(q.ar) || 0.62));
  if (!Array.isArray(q.pages)) {
    q.pages = [Array.isArray(p && p.strokes) ? p.strokes : []];
  }
  q.pages = q.pages.map((pg) => (pg || []).map((s) => ({
    color: Math.max(0, Math.min(8, (s && s.color) | 0)),
    pts: (s && Array.isArray(s.pts) ? s.pts : [])
      .map((pt) => (Array.isArray(pt) ? [Number(pt[0]) || 0, Number(pt[1]) || 0] : [0, 0]))
  })).filter((s) => s.pts.length >= 1));
  if (!q.pages.length) q.pages = [[]];
  q.bpm = Math.max(30, Math.min(300, Number(q.bpm) || 120));
  q.stepsPerBeat = Math.max(1, Math.min(8, Number(q.stepsPerBeat) || 4));
  q.beats = Math.max(1, Math.min(32, Number(q.beats) || 8));
  q.rows = Math.max(8, Math.min(64, Number(q.rows) || 32));
  q.key = Math.max(0, Math.min(11, Number(q.key) || 0));
  return q;
}

/* -------------------------------------------------- 万能导入：认出这是什么东西 */
async function importText(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('内容为空');

  // 1) play_music_theory 的串 / 链接 / 草稿
  const packed = extractPMT(raw);
  if (packed) {
    const o = await decodePMT(packed);
    const piece = normalizePiece(pmtToPiece(o, { name: '' }));
    return { piece, source: 'play_music_theory', meta: { a: o.a, bpm: o.t, beats: o.b, packedLen: packed.length, packed } };
  }

  // 2) 我们自己的 JSON（或裸对象）
  let obj = null;
  try { obj = JSON.parse(raw); } catch (e) {}
  if (obj && typeof obj === 'object') {
    const piece = normalizePiece(obj);
    return { piece, source: 'drawmusic', meta: {} };
  }
  throw new Error('认不出来。请粘贴 play_music_theory 的分享链接 / j… d… 串，或本程序导出的 .json 内容。');
}

/* ------------------------------------------------------------ 导出：我们的 JSON */
function pieceToJSON(piece) { return JSON.stringify(normalizePiece(piece), null, 2); }

/* --------------------------------------------- 导出：写回 play_music_theory 格式 */
/* 不是必须，但可以让你留一份能被原站读的备份 */
function pieceToPMT(piece, ratio) {
  const p = normalizePiece(piece);
  const put = (strokes) => strokes.map((s) => {
    const out = [s.color];
    for (const pt of s.pts) {
      out.push(Math.max(0, Math.min(999, Math.round(pt[0] * 999))),
               Math.max(0, Math.min(999, Math.round(pt[1] * 999))));
    }
    return out;
  }).filter((a) => a.length >= 3);
  const o = {
    v: 1, a: Math.max(50, Math.min(200, Math.round((ratio || 0.62) * 100))),
    m: 1, b: 0, t: p.bpm, g: 0, s: put(p.pages[0])
  };
  const rest = p.pages.slice(1).map(put).filter((x) => x.length);
  if (rest.length) o.pg = rest;
  if (p.scale !== 'pentatonic') o.sc = p.scale;
  if (p.key) o.k = p.key;
  return 'j' + b64uEnc(new TextEncoder().encode(JSON.stringify(o)));
}

/* ------------------------------------------------------------------ 统计信息 */
function pieceStats(piece) {
  const p = normalizePiece(piece);
  let nStrokes = 0, nPts = 0;
  const colors = new Set();
  for (const pg of p.pages) for (const s of pg) { nStrokes++; nPts += s.pts.length; colors.add(s.color); }
  return { pages: p.pages.length, strokes: nStrokes, points: nPts, colors: [...colors].sort((a, b) => a - b) };
}
