'use strict';
/* ============================================================================
 * app.js —— 绘图 / 量化 / 渲染 / 交互 / 导入导出
 * ==========================================================================*/

/* --------------------------------------------------------------------- 音阶 */
const SCALES = {
  pentatonic: { name: '大调五声', iv: [0, 2, 4, 7, 9] },
  minor:      { name: '小调五声', iv: [0, 3, 5, 7, 10] },
  major:      { name: '大调',     iv: [0, 2, 4, 5, 7, 9, 11] },
  natural:    { name: '自然小调', iv: [0, 2, 3, 5, 7, 8, 10] },
  harmonic:   { name: '和声小调', iv: [0, 2, 3, 5, 7, 8, 11] },
  dorian:     { name: '多利亚',   iv: [0, 2, 3, 5, 7, 9, 10] },
  phrygian:   { name: '弗里吉亚', iv: [0, 1, 3, 5, 7, 8, 10] },
  lydian:     { name: '利底亚',   iv: [0, 2, 4, 6, 7, 9, 11] },
  mixolydian: { name: '混合利底亚', iv: [0, 2, 4, 5, 7, 9, 10] },
  blues:      { name: '布鲁斯',   iv: [0, 3, 5, 6, 7, 10] },
  chromatic:  { name: '半音阶',   iv: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }
};
const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
/* 画布左侧的音名要按调来拼，不能一张表走天下：
     Eb 混合利底亚第 7 级是 Db 不是 C#；C 混合利底亚第 7 级是 Bb 不是 A#。
   做法是七声音阶走「音级 → 字母」的正式拼法（第 i 级固定用主音往上第 i 个字母，
   再用升降号补足音高），其余音阶退回按调性偏好选升/降号。 */
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const FLAT_KEYS = [1, 3, 5, 8, 10];
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const ACC = { '-2': 'bb', '-1': 'b', '0': '', '1': '#', '2': '##' };
let noteTable = SHARP_NAMES;
function buildNoteTable() {
  const key = ((piece.key % 12) + 12) % 12;
  const iv = (SCALES[piece.scale] || SCALES.pentatonic).iv;
  const tbl = new Array(12).fill(null);
  if (iv.length === 7) {
    const tonic = LETTERS.indexOf(NOTE_NAMES[key][0]);
    for (let i = 0; i < 7; i++) {
      const pc = (key + iv[i]) % 12;
      const li = (tonic + i) % 7;
      let d = (((pc - LETTER_PC[li]) % 12) + 12) % 12;
      if (d > 6) d -= 12;
      const acc = ACC[String(d)];
      if (acc !== undefined && !tbl[pc]) tbl[pc] = LETTERS[li] + acc;
    }
  }
  const flatPref = FLAT_KEYS.indexOf(key) >= 0 ||
                   iv.some((x) => x === 3 || x === 8 || x === 10);
  const fallback = flatPref ? FLAT_NAMES : SHARP_NAMES;
  for (let pc = 0; pc < 12; pc++) if (!tbl[pc]) tbl[pc] = fallback[pc];
  noteTable = tbl;
}
function noteName(midi) { return noteTable[(((midi % 12) + 12) % 12)]; }
const BASE_MIDI = 48;   // C3

/* --------------------------------------------------------------------- 状态 */
let piece = normalizePiece({ pages: [[]] });
let pageIndex = 0;
let cur = null, tool = 'draw', colorIdx = 0, playing = false, undoStack = [], redoStack = [];
let W = 0, H = 0, dpr = 1, rowMidi = [], lastStep = -1;
let headFrac = 0, headAt = 0, lastLoopStep = -1, loopFlash = 0;
let showGrid = true, showRows = true;   // 网格默认开（画的时候能看清自己的线落在哪些格子上）

const $ = (id) => document.getElementById(id);
const cv = $('cv'), ctx = cv.getContext('2d');

function strokes() { return piece.pages[pageIndex]; }
function steps() { return Math.max(1, Math.min(256, piece.stepsPerBeat * piece.beats)); }

/* ---------------------------------------------------------------- 音高映射 */
function rebuildRows() {
  buildNoteTable();
  const iv = (SCALES[piece.scale] || SCALES.pentatonic).iv;
  const src = [];
  for (let oct = 0; src.length < piece.rows; oct++)
    for (const i of iv) { if (src.length < piece.rows) src.push(BASE_MIDI + oct * 12 + i + piece.key); }
  const n = Math.max(1, Math.min(piece.rows, src.length));
  rowMidi = [];
  for (let r = 0; r < piece.rows; r++) rowMidi.push(src[Math.floor(r * n / piece.rows)]);
}

/* ------------------------------------------------------------ 网格量化 (BigInt) */
/* 掩码用 32 位整数（行数固定 32），比 BigInt 快约 4.6 倍，且不产生临时对象 */
let maskBuf = new Uint32Array(64);
function rowMasks(pts, nSteps, nRows, masks) {
  if (!masks || masks.length < nSteps) masks = new Uint32Array(nSteps);
  masks.fill(0, 0, nSteps);
  if (W <= 0 || H <= 0) return masks;
  const edge = 1 / nSteps * 0.75;
  let prev = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], px = p[0], py = p[1];
    if (px < -edge || px > 1 + edge) { prev = null; continue; }
    const st = Math.min(Math.max(Math.floor(px * nSteps), 0), nSteps - 1);
    const t = 1 - Math.min(Math.max(py, 0), 1);
    const row = Math.round(t * (nRows - 1));
    let b = 1 << row;
    masks[st] |= b;
    if (px <= edge) masks[0] |= b;
    if (px >= 1 - edge) masks[nSteps - 1] |= b;
    if (prev && Math.abs(st - prev.st) > 1) {
      const lo = Math.min(prev.st, st), hi = Math.max(prev.st, st);
      for (let s = lo + 1; s < hi; s++) {
        const tt = (s - prev.st) / (st - prev.st);
        const r = Math.round(prev.row + tt * (row - prev.row));
        masks[s] |= 1 << Math.max(0, Math.min(nRows - 1, r));
      }
    }
    prev = { st, row };
  }
  return masks;
}
function clusters(mask, max) {
  const out = [];
  let rem = mask >>> 0;
  while (rem !== 0 && out.length < max) {
    let a = 0; while (((rem >>> a) & 1) === 0) a++;
    let b = a; while (b + 1 < 32 && ((rem >>> (b + 1)) & 1) === 1) b++;
    out.push((a + b) >> 1);
    const len = b - a + 1;
    if (len >= 32) break;
    rem &= ~(((1 << len) - 1) << a);
  }
  return out;
}

/* ------------------------------------------------- 网格 → 音符事件（无上限） */
/* 把「同一时刻相同 (音高, 音色)」合并成一个音，用起止事件驱动声部。
   所有缓冲区都预分配复用，重建一次的耗时和笔迹数量的增长接近线性、无 GC 压力。 */
const GRID_STRIDE = 9 * 128;
let gridBuf = new Uint8Array(GRID_STRIDE * 64);
let keySeen = new Uint8Array(GRID_STRIDE);
let touchedKeys = [];
let quads = [];

function buildNoteData() {
  const nSteps = steps(), nRows = Math.min(32, piece.rows), LANES = 3;
  const need = GRID_STRIDE * nSteps;
  if (gridBuf.length < need) gridBuf = new Uint8Array(need);
  gridBuf.fill(0, 0, need);
  keySeen.fill(0);
  touchedKeys.length = 0;
  if (maskBuf.length < nSteps) maskBuf = new Uint32Array(nSteps);
  const masks = maskBuf;

  const list = strokes();
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    rowMasks(s.pts, nSteps, nRows, masks);
    const cbase = s.color * 128;
    for (let st = 0; st < nSteps; st++) {
      const m = masks[st]; if (m === 0) continue;
      const cs = clusters(m, LANES);
      for (let k = 0; k < cs.length; k++) {
        const midi = rowMidi[Math.min(nRows - 1, cs[k])];
        if (midi == null) continue;
        const key = cbase + midi;
        gridBuf[st * GRID_STRIDE + key] = 1;
        if (!keySeen[key]) { keySeen[key] = 1; touchedKeys.push(key); }
      }
    }
  }
  quads.length = 0;
  for (let ti = 0; ti < touchedKeys.length; ti++) {
    const key = touchedKeys[ti], col = (key / 128) | 0, midi = key % 128;
    let start = -1;
    for (let st = 0; st < nSteps; st++) if (!gridBuf[st * GRID_STRIDE + key]) { start = st; break; }
    if (start < 0) { quads.push(0, nSteps, midi, col); continue; }   // 整圈都有
    let st = 0;
    while (st < nSteps) {
      const i = (start + st) % nSteps;
      if (!gridBuf[i * GRID_STRIDE + key]) { st++; continue; }
      let len = 0;
      while (len < nSteps && gridBuf[((start + st + len) % nSteps) * GRID_STRIDE + key]) len++;
      const s0 = (start + st) % nSteps;
      quads.push(s0, s0 + len, midi, col);
      st += len;
    }
  }
  const data = new Int32Array(quads.length);
  for (let i = 0; i < quads.length; i++) data[i] = quads[i];
  return { data, count: quads.length / 4 };
}

/* ------------------------------------------------------------- 撤销 / 重做
   命令式撤销：画一笔只记「加了一条」，不做 4 万个点的深拷贝。
   只有橡皮/清空这种结构性改动才真的存快照。 */
const cloneStrokes = (list) => list.map((s) => ({ color: s.color, pts: s.pts.map((p) => [p[0], p[1]]) }));
function pushUndo(cmd) { undoStack.push(cmd); if (undoStack.length > 120) undoStack.shift(); redoStack.length = 0; updateStats(); }
function snapAdd() { pushUndo({ t: 'add', pg: pageIndex }); }
function snapReplace() { pushUndo({ t: 'rep', pg: pageIndex, data: cloneStrokes(strokes()) }); }
function undo() {
  const c = undoStack.pop(); if (!c) return;
  const pg = piece.pages[c.pg]; if (!pg) return;
  if (c.t === 'add') { redoStack.push({ t: 'addback', pg: c.pg, s: pg.pop() }); }
  else { redoStack.push({ t: 'rep', pg: c.pg, data: cloneStrokes(pg) }); piece.pages[c.pg] = c.data; }
  pageIndex = c.pg; syncAll(); buildPages();
}
function redo() {
  const c = redoStack.pop(); if (!c) return;
  const pg = piece.pages[c.pg]; if (!pg) return;
  if (c.t === 'addback') { undoStack.push({ t: 'add', pg: c.pg }); pg.push(c.s); }
  else { undoStack.push({ t: 'rep', pg: c.pg, data: cloneStrokes(pg) }); piece.pages[c.pg] = c.data; }
  pageIndex = c.pg; syncAll(); buildPages();
}

/* ------------------------------------------------------------------ 绘制 */
const MINDIST_PX = 7;
/* 橡皮半径，单位是【屏幕像素】。
   注意：判定必须在像素空间做 —— 之前拿归一化坐标直接算距离，
   而 x 除以 W、y 除以 H 之后两个方向的尺度不一样，
   画布不是正方形时擦除范围会变成椭圆，和光圈对不上。 */
let eraseR = 22;
function evPt(e) {
  const r = cv.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
}
let drawing = false, lastErase = null;

/* 只有画面要更新（拖笔）：不动静态层、不重建音符 —— 这是 0 延迟的关键 */
function touch() { needsDraw = true; notesDirty = true; }
/* 结构变了（橡皮/撤销/换页/换音阶）：静态层和音符都要重建 */
function invalidate() { inkDirty = true; needsDraw = true; notesDirty = true; }
function syncAll() { invalidate(); updateStats(true); autoSave(); }

function pointerDown(x, y) {
  if (tool === 'erase') { snapReplace(); lastErase = [x, y]; eraseAt(x, y); return; }
  snapAdd();
  cur = { color: colorIdx, pts: [[x, y]] };
  strokes().push(cur);
  touch(); updateStats();
}
function pointerMove(x, y) {
  if (tool === 'erase') {
    const l = lastErase || [x, y];
    const dx = (x - l[0]) * W, dy = (y - l[1]) * H;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (eraseR * 0.5)));
    for (let i = 1; i <= n; i++) eraseAt(l[0] + (x - l[0]) * i / n, l[1] + (y - l[1]) * i / n);
    lastErase = [x, y];
    return;
  }
  if (!cur) return;
  const last = cur.pts[cur.pts.length - 1];
  const dx = (x - last[0]) * W, dy = (y - last[1]) * H;
  const d = Math.hypot(dx, dy);
  const n = Math.max(1, Math.floor(d / MINDIST_PX));
  for (let i = 1; i <= n; i++) cur.pts.push([last[0] + (x - last[0]) * i / n, last[1] + (y - last[1]) * i / n]);
  touch();
}
function pointerUp() {
  if (cur) { const list = strokes(); const i = list.indexOf(cur); if (i >= 0) bakeStroke(cur, i); }
  cur = null; lastErase = null;
  needsDraw = true; notesDirty = true; updateStats(true); autoSave();
}
function eraseAt(x, y) {
  const out = [];
  let changed = false;
  const r2 = eraseR * eraseR;                 // 像素空间比较，用平方省掉开方
  const list = strokes();
  for (let si = 0; si < list.length; si++) {
    const s = list[si];
    let seg = [];
    for (let i = 0; i < s.pts.length; i++) {
      const p = s.pts[i];
      const dx = (p[0] - x) * W, dy = (p[1] - y) * H;
      if (dx * dx + dy * dy < r2) { changed = true; if (seg.length) out.push({ color: s.color, pts: seg }); seg = []; }
      else seg.push(p);
    }
    if (seg.length) out.push({ color: s.color, pts: seg });
  }
  if (changed) { piece.pages[pageIndex] = out; invalidate(); updateStats(); }
}

/* ---------------------------------------------------------------- 橡皮光圈 */
const ringEl = document.getElementById('ring');
function sizeRing() { if (ringEl) { ringEl.style.width = ringEl.style.height = (eraseR * 2) + 'px'; } }
function placeRing(clientX, clientY) {
  if (!ringEl || tool !== 'erase') return;
  const r = cv.getBoundingClientRect();
  ringEl.style.left = (clientX - r.left) + 'px';
  ringEl.style.top = (clientY - r.top) + 'px';
  ringEl.classList.add('on');
}
function hideRing() { if (ringEl) ringEl.classList.remove('on'); }
function setTool(t) {
  tool = t;
  if (t !== 'erase') hideRing();
  document.body.classList.toggle('erasing', t === 'erase');
  syncUI();
}

cv.addEventListener('pointerdown', (e) => { e.preventDefault(); cv.setPointerCapture(e.pointerId); drawing = true; const p = evPt(e); pointerDown(p[0], p[1]); SilentTrack.arm(); AudioEngine.ensure(); });
cv.addEventListener('pointermove', (e) => {
  if (tool === 'erase') placeRing(e.clientX, e.clientY);
  if (!drawing) return;
  const p = evPt(e);
  pointerMove(p[0], p[1]);
});
cv.addEventListener('pointerenter', (e) => { if (tool === 'erase') placeRing(e.clientX, e.clientY); });
cv.addEventListener('pointerleave', () => { if (!drawing) hideRing(); });
cv.addEventListener('pointerdown', (e) => { if (tool === 'erase') placeRing(e.clientX, e.clientY); }, true);
const up = () => { drawing = false; pointerUp(); };
cv.addEventListener('pointerup', up);
cv.addEventListener('pointercancel', up);
cv.addEventListener('pointerleave', up);

/* ------------------------------------------------------------------ 渲染 */
function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r); g.closePath();
}
/* ---------------------------------------------------------------- 渲染管线
   静态图层（网格 + 已完成笔迹）缓存在离屏 canvas，只有内容变了才重画；
   正在画的那一条每帧实时叠在上面 —— 所以拖笔画是真正的 0 延迟，
   不会因为笔迹变多而越来越卡。 */
const inkCv = document.createElement('canvas');
const inkCtx = inkCv.getContext('2d');
let inkDirty = true, needsDraw = true, notesDirty = true;
let inkBW = -1, inkBH = -1;

function inkScale() { return Math.min(1.35, Math.max(0.85, W / 460)); }

/* 一条笔迹的三层笔刷：实心芯 + 两层随机虚线（种子由序号决定，所以每帧都一样） */
function paintOneStroke(g, s, idx, w, h, kk) {
  if (!s.pts.length) return;
  let seed = (Math.imul(idx + 1, 2654435761) + 97) >>> 0;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const col = PALETTE[Math.max(0, Math.min(8, s.color))].hex;
  const path = new Path2D();
  const p0 = s.pts[0];
  path.moveTo(p0[0] * w, p0[1] * h);
  for (let i = 1; i < s.pts.length; i++) { const p = s.pts[i]; path.lineTo(p[0] * w, p[1] * h); }
  const core = (2.1 + rnd() * 0.7) * kk;
  g.strokeStyle = col; g.fillStyle = col;
  g.globalAlpha = 1; g.setLineDash([]); g.lineWidth = core;
  if (s.pts.length === 1) { g.beginPath(); g.arc(p0[0] * w, p0[1] * h, core * 0.62, 0, 7); g.fill(); }
  else g.stroke(path);
  g.globalAlpha = 0.34 + rnd() * 0.18; g.lineWidth = core + (1.2 + rnd() * 0.7) * kk;
  g.setLineDash([(0.6 + rnd() * 0.5) * kk, (2.6 + rnd() * 1.6) * kk]); g.lineDashOffset = rnd() * 10; g.stroke(path);
  g.globalAlpha = 0.16 + rnd() * 0.14; g.lineWidth = core + (2.2 + rnd() * 0.9) * kk;
  g.setLineDash([(0.5 + rnd() * 0.4) * kk, (5.5 + rnd() * 4) * kk]); g.lineDashOffset = rnd() * 10; g.stroke(path);
  g.globalAlpha = 1; g.setLineDash([]);
}

function renderInk() {
  const bw = Math.round(W * dpr), bh = Math.round(H * dpr);
  // 只在尺寸真的变了才重设 —— 设 width 会重新分配整块位图，绝不能每帧做
  if (bw !== inkBW || bh !== inkBH) { inkCv.width = bw; inkCv.height = bh; inkBW = bw; inkBH = bh; }
  const g = inkCtx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.globalAlpha = 1; g.setLineDash([]);
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#fffefb'; g.fillRect(0, 0, W, H);
  const nS = steps(), nR = piece.rows, rowH = H / nR, colW = W / nS;

  if (showGrid) {
    g.lineWidth = 1;
    const kroot = ((piece.key % 12) + 12) % 12;
    for (let r = 0; r < nR; r++) {
      const y = Math.round(H - r * rowH) + 0.5;
      const root = ((rowMidi[r] % 12) + 12) % 12 === kroot;
      g.strokeStyle = root ? 'rgba(138,135,126,.30)' : 'rgba(138,135,126,.10)';
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    }
    const per = piece.stepsPerBeat;
    for (let i = 1; i < nS; i++) {
      const x = Math.round(i * colW) + 0.5;
      const beat = i % per === 0, bar = i % (per * 4) === 0;
      g.strokeStyle = bar ? 'rgba(138,135,126,.40)' : (beat ? 'rgba(138,135,126,.20)' : 'rgba(138,135,126,.07)');
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    }
    if (showRows) {
      g.font = '10px ui-monospace,Menlo,Consolas,monospace';
      g.textBaseline = 'middle'; g.textAlign = 'left';
      let r0 = 0;
      for (let r = 1; r <= nR; r++) {
        if (r < nR && rowMidi[r] === rowMidi[r0]) continue;
        if ((r - r0) * rowH >= 9) {
          const midi = rowMidi[r0];
          g.fillStyle = ((midi % 12) + 12) % 12 === kroot ? 'rgba(26,25,22,.55)' : 'rgba(138,135,126,.65)';
          g.fillText(noteName(midi), 5, H - (r0 + (r - r0) / 2) * rowH);
        }
        r0 = r;
      }
    }
  }

  g.lineCap = 'round'; g.lineJoin = 'round';
  const kk = inkScale();
  const list = strokes();
  for (let i = 0; i < list.length; i++) {
    if (list[i] === cur) continue;      // 正在画的那条走实时通道
    paintOneStroke(g, list[i], i, W, H, kk);
  }
}

/* 把刚画完的那条直接烤进静态层，避免松手时整幅重绘造成卡顿 */
function bakeStroke(s, idx) {
  const g = inkCtx;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.lineCap = 'round'; g.lineJoin = 'round';
  paintOneStroke(g, s, idx, W, H, inkScale());
}

function draw() {
  if (W <= 0 || H <= 0) return;
  if (inkDirty) { inkDirty = false; renderInk(); }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(inkCv, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (cur) {                                  // 实时笔触：立刻上屏
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    paintOneStroke(ctx, cur, strokes().length - 1, W, H, inkScale());
    ctx.globalAlpha = 1; ctx.setLineDash([]);
  }
  if (!playing) return;
  const nS = steps();
  const f = headFraction(); if (f < 0) return;
  const x = ((f + 0.5 / nS) % 1) * W;
  ctx.strokeStyle = 'rgba(26,25,22,.65)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  ctx.fillStyle = '#1a1916';
  for (const s of strokes()) {
    for (let i = 1; i < s.pts.length; i++) {
      const a = s.pts[i - 1], b = s.pts[i];
      if ((a[0] - f) * (b[0] - f) <= 0 && a[0] !== b[0]) {
        const t = (f - a[0]) / (b[0] - a[0]);
        ctx.beginPath(); ctx.arc(x, (a[1] + (b[1] - a[1]) * t) * H, 4.2, 0, 7); ctx.fill();
      }
    }
  }
}
function headFraction() {
  if (!playing) return -1;
  const dt = (performance.now() - headAt) / 1000 - AudioEngine.latency();
  const loopSec = 60 / piece.bpm * piece.beats;
  return (((headFrac + dt / loopSec) % 1) + 1) % 1;
}

/* --------------------------------------------------------- 尺寸（按画作比例） */
/* 关键改进：画作有固定高宽比 piece.ar，窗口怎么缩都不会拉伸变形 */
function resize() {
  const st = $('stage').getBoundingClientRect();
  const PAD = 24;                       // 给纸留一点边距
  const availW = st.width - PAD, availH = st.height - PAD;
  if (availW < 40 || availH < 40) return;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const ar = Math.max(0.22, Math.min(2.6, piece.ar));
  let w = availW, h = availW * ar;
  if (h > availH) { h = availH; w = availH / ar; }
  W = Math.max(60, Math.floor(w)); H = Math.max(60, Math.floor(h));
  // 关键：canvas 的 CSS 尺寸必须显式设成 W×H。
  // 只设 width/height 属性的话，在高 DPI 屏（Windows 125%/150% 缩放）上
  // 元素会按 W×dpr 的物理尺寸显示，被 #paper 的 overflow:hidden 裁掉右下角。
  $('paper').style.width = W + 'px'; $('paper').style.height = H + 'px';
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sizeRing();
  draw();
}

/* ------------------------------------------------------------- 播放与同步 */
let pendingNotes = null, cfgKey = '', noteCount = 0;
let notesAt = 0, statsAt = 0;
function pushNotes() {
  rebuildRows();
  const r = buildNoteData();
  noteCount = r.count;
  const k = steps() + '/' + piece.stepsPerBeat + '/' + piece.bpm;
  if (k !== cfgKey) { AudioEngine.setConfig({ steps: steps(), spb: piece.stepsPerBeat, bpm: piece.bpm }); cfgKey = k; }
  if (playing) pendingNotes = r;
  else { AudioEngine.setNotes(r.data, r.count); pendingNotes = null; }
}
function markInk() { inkDirty = true; needsDraw = true; }
function tick() {
  const now = performance.now();
  // 拖笔时音符重建限流到 ~14Hz（听觉上完全无感），松手立刻补一次
  if (notesDirty && (!drawing || now - notesAt > 70)) { notesDirty = false; notesAt = now; pushNotes(); }
  if (needsDraw || playing) { needsDraw = false; draw(); }
  requestAnimationFrame(tick);
}
AudioEngine.onFrac((f) => { headFrac = f; headAt = performance.now(); });
AudioEngine.onStep((st) => {
  lastLoopStep = st;
  if (st === 0 && pendingNotes) { AudioEngine.setNotes(pendingNotes.data, pendingNotes.count); pendingNotes = null; }
});

async function setPlaying(on) {
  await AudioEngine.ensure();
  if (on && pendingNotes) { AudioEngine.setNotes(pendingNotes.data, pendingNotes.count); pendingNotes = null; }
  // 第一次播放时 tick 可能还没来得及 pushNotes，这里兜一下底
  if (on && !noteCount) { cfgKey = ''; pushNotes(); }
  playing = on;
  if (on) SilentTrack.arm();
  AudioEngine.play(on);
  $('play').textContent = on ? '⏸ 暂停' : '▶ 播放';
  $('play').classList.toggle('on', on);
  if (on) { headFrac = 0; headAt = performance.now(); }
  draw();
}
function restart() { AudioEngine.restart(); headFrac = 0; headAt = performance.now(); draw(); }

/* ------------------------------------------------------------------ 调色板 */
function buildPalette() {
  const el = $('palette'); el.innerHTML = '';
  PALETTE.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'sw' + (i === colorIdx ? ' on' : '');
    b.style.background = c.hex;
    b.title = c.name;
    b.onclick = () => { colorIdx = i; tool = 'draw'; syncUI(); };
    el.appendChild(b);
  });
}
/* -------------------------------------------------------------------- 页面 */
function buildPages() {
  const el = $('pages'); el.innerHTML = '';
  piece.pages.forEach((pg, i) => {
    const b = document.createElement('button');
    b.className = 'pg' + (i === pageIndex ? ' on' : '');
    b.textContent = (i + 1) + (pg.length ? '・' + pg.length : '');
    b.onclick = () => { pageIndex = i; undoStack.length = 0; redoStack.length = 0; syncAll(); buildPages(); };
    el.appendChild(b);
  });
  const add = document.createElement('button');
  add.className = 'pg add'; add.textContent = '＋';
  add.title = '新建一页';
  add.onclick = () => { piece.pages.splice(pageIndex + 1, 0, []); pageIndex++; undoStack.length = 0; redoStack.length = 0; syncAll(); buildPages(); };
  el.appendChild(add);
  if (piece.pages.length > 1) {
    const del = document.createElement('button');
    del.className = 'pg del'; del.textContent = '−'; del.title = '删除这一页';
    del.onclick = () => { if (piece.pages.length < 2) return; piece.pages.splice(pageIndex, 1); pageIndex = Math.max(0, pageIndex - 1); undoStack.length = 0; redoStack.length = 0; syncAll(); buildPages(); };
    el.appendChild(del);
  }
}

/* -------------------------------------------------------------------- 统计 */
function updateStats(force) {
  const now = performance.now();
  if (!force && now - statsAt < 300) return;   // 拖笔时没必要每帧统计全部采样点
  statsAt = now;
  const st = pieceStats(piece);
  $('stats').textContent = st.strokes + ' 笔 · ' + st.points + ' 点 · ' + st.pages + ' 页 · 音符 ' + noteCount
    + ' · ' + steps() + ' 格 × ' + piece.rows + ' 行';
  $('undo').disabled = !undoStack.length;
  $('redo').disabled = !redoStack.length;
  $('erase').classList.toggle('on', tool === 'erase');
}
function syncUI() {
  const kids = $('palette').children;
  for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('on', i === colorIdx);
  updateStats();
}

/* --------------------------------------------------------------- 导出工具 */
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
function paintInk(g, list, w, h, kScale) {
  g.lineCap = 'round'; g.lineJoin = 'round';
  const k = Math.min(1.5, Math.max(0.6, kScale == null ? w / 460 : kScale));
  list.forEach((s, idx) => {
    if (!s.pts.length) return;
    let seed = (Math.imul(idx + 1, 2654435761) + 97) >>> 0;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const col = PALETTE[Math.max(0, Math.min(8, s.color))].hex;
    const path = new Path2D();
    if (s.pts.length === 1) path.moveTo(s.pts[0][0] * w, s.pts[0][1] * h);
    else s.pts.forEach((p, i) => { i ? path.lineTo(p[0] * w, p[1] * h) : path.moveTo(p[0] * w, p[1] * h); });
    const core = (2.1 + rnd() * 0.7) * k;
    g.strokeStyle = col; g.fillStyle = col;
    g.globalAlpha = 1; g.setLineDash([]); g.lineWidth = core;
    if (s.pts.length === 1) { g.beginPath(); g.arc(s.pts[0][0] * w, s.pts[0][1] * h, core * 0.62, 0, 7); g.fill(); }
    else g.stroke(path);
    g.globalAlpha = 0.34 + rnd() * 0.18; g.lineWidth = core + (1.2 + rnd() * 0.7) * k;
    g.setLineDash([(0.6 + rnd() * 0.5) * k, (2.6 + rnd() * 1.6) * k]); g.lineDashOffset = rnd() * 10; g.stroke(path);
    g.globalAlpha = 1; g.setLineDash([]);
  });
}
function exportPNG(width) {
  const w = width || 2400, h = Math.round(w * piece.ar);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#fffefb'; g.fillRect(0, 0, w, h);
  paintInk(g, strokes(), w, h, Math.max(1.0, w / 900));
  c.toBlob((b) => download(b, 'drawmusic-' + w + 'x' + h + '.png'), 'image/png');
}
function exportWAV() {
  const { data, count } = buildNoteData();
  const buf = renderLoopOffline({ steps: steps(), spb: piece.stepsPerBeat, bpm: piece.bpm, drums: $('drumsChk').checked, click: $('clickChk').checked }, data, count, 44100);
  const n = buf.length, dv = new DataView(new ArrayBuffer(44 + n * 2));
  const w4 = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w4(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w4(8, 'WAVE'); w4(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 44100, true); dv.setUint32(28, 44100 * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w4(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { let v = Math.max(-1, Math.min(1, buf[i])); dv.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true); }
  download(new Blob([dv.buffer], { type: 'audio/wav' }), 'drawmusic.wav');
}

/* ---------------------------------------------------------------- 导入面板 */
let impPiece = null, impAr = 0.62;
function renderImpPreview() {
  const c = $('impPreview');
  const box = c.parentElement.getBoundingClientRect();
  const availW = Math.max(80, box.width - 8), availH = 260;
  let w = availW, h = availW * impAr;
  if (h > availH) { h = availH; w = availH / impAr; }
  const d = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.round(w * d); c.height = Math.round(h * d);
  c.style.width = w + 'px'; c.style.height = h + 'px';
  const g = c.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0);
  g.fillStyle = '#fffefb'; g.fillRect(0, 0, w, h);
  if (impPiece) paintInk(g, impPiece.pages[0], w, h, Math.max(0.55, w / 520));
}
function buildAspectList() {
  const el = $('aspectList'); el.innerHTML = '';
  const opts = [[0.45, '16:9 宽屏'], [0.5625, '16:9 精确'], [0.625, '16:10'], [0.75, '4:3'], [1.0, '正方形'], [1.333, '3:4 竖'], [1.777, '9:16 竖']];
  const all = opts.concat(impPiece && impPiece.srcAspect ? [[impPiece.srcAspect / 100, '原数据自带的 a']] : []);
  all.forEach(([v, label]) => {
    const b = document.createElement('button');
    b.className = 'ar' + (Math.abs(v - impAr) < 0.01 ? ' on' : '');
    b.innerHTML = label + '<i>' + v.toFixed(3) + '</i>';
    b.onclick = () => { impAr = v; buildAspectList(); renderImpPreview(); };
    el.appendChild(b);
  });
  const custom = document.createElement('label');
  custom.className = 'arcustom';
  custom.innerHTML = '<span>自定义高/宽</span>';
  const inp = document.createElement('input');
  inp.type = 'number'; inp.step = '0.01'; inp.min = '0.22'; inp.max = '2.6'; inp.value = impAr.toFixed(3);
  inp.oninput = () => { const v = parseFloat(inp.value); if (v > 0.2 && v < 2.7) { impAr = v; renderImpPreview(); } };
  custom.appendChild(inp);
  el.appendChild(custom);
}
async function doImport() {
  const msg = $('impMsg'); msg.className = '';
  msg.textContent = '解析中…';
  try {
    const r = await importText($('impText').value);
    impPiece = r.piece;
    impAr = impPiece.ar;
    const st = pieceStats(impPiece);
    if (!st.strokes) {
      impPiece = null;
      msg.className = 'bad';
      msg.textContent = '✗ 格式认出来了，但里面一条笔迹都没有 —— 换一份数据试试';
      $('impConfirm').disabled = true;
      return;
    }
    msg.className = 'ok';
    msg.textContent = '✓ 读出来了：' + st.strokes + ' 条笔迹 · ' + st.points + ' 个采样点 · ' + st.pages + ' 页'
      + ' · ' + impPiece.bpm + ' BPM · 来源 ' + (r.source === 'play_music_theory' ? 'play_music_theory（a=' + r.meta.a + '）' : 'DrawMusic JSON');
    buildAspectList(); renderImpPreview();
    $('impConfirm').disabled = false;
  } catch (e) {
    impPiece = null; msg.className = 'bad'; msg.textContent = '✗ ' + e.message;
    $('impConfirm').disabled = true;
  }
}
function confirmImport() {
  if (!impPiece) return;
  impPiece.ar = impAr;
  piece = normalizePiece(impPiece);
  pageIndex = 0; undoStack.length = 0; redoStack.length = 0;
  $('modal').hidden = true;
  buildPages(); resize(); syncAll();
}

/* --------------------------------------------------------------- 界面接线 */
/* 循环一圈要多少秒 —— 直接显示出来，省得心算。
   参考原站：桌面画布装 16 拍，120 BPM 时循环 8 秒。 */
function loopSecondsNow() { return 60 / piece.bpm * steps() / piece.stepsPerBeat; }
function updateLenLabel() {
  const el = $('loopLen');
  if (el) el.textContent = '≈ ' + loopSecondsNow().toFixed(1) + ' 秒';
}
function opt(sel, list, val, fmt) {
  const el = $(sel); el.innerHTML = '';
  list.forEach(([v, label]) => { const o = document.createElement('option'); o.value = v; o.textContent = label || (fmt ? fmt(v) : v); el.appendChild(o); });
  if (val != null) el.value = val;
}
function wire() {
  $('play').onclick = () => setPlaying(!playing);
  $('restart').onclick = restart;
  $('undo').onclick = undo;
  $('redo').onclick = redo;
  $('erase').onclick = () => setTool(tool === 'erase' ? 'draw' : 'erase');
  $('clear').onclick = () => { if (!strokes().length) return; snapshot(); piece.pages[pageIndex] = []; syncAll(); };

  let bpmTimer = 0;
  $('bpmR').oninput = (e) => {
    piece.bpm = +e.target.value;
    $('bpmV').textContent = e.target.value;
    updateLenLabel();
    // 拖动时滑块每像素触发一次，如果每次都重发 config + 重建音符，
    // 音频线程会被反复打断 —— 听感就是「卡住」。等它停下来再发。
    clearTimeout(bpmTimer);
    bpmTimer = setTimeout(() => { cfgKey = ''; syncAll(); }, 130);
  };
  $('vol').oninput = (e) => AudioEngine.setVolume(e.target.value / 100);
  $('eraseR').oninput = (e) => {
    eraseR = +e.target.value;
    $('eraseRV').textContent = e.target.value;
    sizeRing();
    if (ringEl && ringEl.classList.contains('on')) { /* 位置不变，尺寸已更新 */ }
  };
  sizeRing();
  $('gridChk').onchange = (e) => { showGrid = e.target.checked; markInk(); draw(); };
  $('rowChk').onchange = (e) => { showRows = e.target.checked; markInk(); draw(); };
  $('drumsChk').onchange = (e) => AudioEngine.setDrums(e.target.checked);
  $('clickChk').onchange = (e) => AudioEngine.setClick(e.target.checked);

  opt('scaleSel', Object.keys(SCALES).map((k) => [k, SCALES[k].name]), piece.scale);
  $('scaleSel').onchange = (e) => { piece.scale = e.target.value; syncAll(); };
  opt('keySel', NOTE_NAMES.map((n, i) => [i, n]), piece.key);
  $('keySel').onchange = (e) => { piece.key = +e.target.value; syncAll(); };
  opt('spbSel', [[2, '2 格/拍'], [3, '3 格/拍'], [4, '4 格/拍（16分）'], [6, '6 格/拍'], [8, '8 格/拍']], piece.stepsPerBeat);
  $('spbSel').onchange = (e) => { piece.stepsPerBeat = +e.target.value; syncAll(); };
  opt('beatsSel', [[4, '4 拍'], [8, '8 拍'], [16, '16 拍'], [32, '32 拍'], [64, '64 拍']], piece.beats);
  $('beatsSel').onchange = (e) => { piece.beats = +e.target.value; updateLenLabel(); syncAll(); };
  updateLenLabel();
  opt('arSel', [[0.45, '2.22:1 超宽'], [0.5, '2:1'], [0.5625, '16:9'], [0.625, '16:10'], [0.6667, '3:2'], [0.75, '4:3'], [1, '1:1 方'], [1.3333, '3:4'], [1.7778, '9:16 竖']], null);
  $('arSel').value = String(piece.ar);
  $('arSel').onchange = (e) => { piece.ar = +e.target.value; resize(); autoSave(); };
  $('arNum').oninput = (e) => { const v = parseFloat(e.target.value); if (v > 0.2 && v < 2.7) { piece.ar = v; resize(); autoSave(); } };

  $('saveJson').onclick = () => download(new Blob([pieceToJSON(piece)], { type: 'application/json' }), 'drawmusic.json');
  $('savePng').onclick = () => exportPNG(2400);
  $('saveWav').onclick = () => exportWAV();
  $('savePmt').onclick = () => { navigator.clipboard.writeText(pieceToPMT(piece, piece.ar)).then(() => alert('已复制一份 play_music_theory 格式的备份到剪贴板。\n（注意：在那边打开仍然只会显示前 64 条，那是它的 bug。）'), () => alert('复制失败，请改用「存 JSON」。')); };
  $('gear').onclick = () => {
    const open = document.body.classList.toggle('drawer-open');
    $('gear').classList.toggle('on', open);
    requestAnimationFrame(resize);
  };
  $('openImport').onclick = () => { $('modal').hidden = false; $('impText').focus(); };
  $('impCancel').onclick = () => { $('modal').hidden = true; };
  $('impOk').onclick = doImport;
  $('impConfirm').onclick = confirmImport;
  $('impFile').onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { $('impText').value = rd.result; doImport(); };
    rd.readAsText(f);
  };
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) $('modal').hidden = true; });
  $('impText').addEventListener('input', () => { $('impConfirm').disabled = true; $('impMsg').textContent = ''; });

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (e.ctrlKey || e.metaKey) return;
    if (e.key === 'e') { setTool(tool === 'erase' ? 'draw' : 'erase'); }
    else if (e.key === 'd') { setTool('draw'); }
    else if (e.key === 'g') { $('gridChk').checked = !showGrid; showGrid = $('gridChk').checked; draw(); }
    else if (e.key >= '1' && e.key <= '9') { colorIdx = +e.key - 1; syncUI(); }
  });
}


/* ---------------------------------------------------------------- iOS 音频路由
   iOS 会把 Web Audio 走「铃声」通道，侧边静音开关一拨就彻底没声。
   放一条循环的静音音轨能把页面切到「媒体播放」通道 —— 和原站同样的做法。 */
const SilentTrack = (() => {
  let el = null, url = null;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function build() {
    const sr = 8000, n = sr;                    // 1 秒静音，8 位单声道
    const buf = new ArrayBuffer(44 + n), dv = new DataView(buf);
    const w4 = (o, s) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w4(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w4(8, 'WAVE'); w4(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sr, true); dv.setUint32(28, sr, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
    w4(36, 'data'); dv.setUint32(40, n, true);
    new Uint8Array(buf, 44).fill(128);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  return {
    arm() {
      if (!isIOS || el) return;
      try { if (!url) url = build(); el = new Audio(url); el.loop = true; el.volume = 0.001; el.play().catch(() => {}); }
      catch (e) {}
    },
    pause() { try { if (el) el.pause(); } catch (e) {} },
    resume() { try { if (el) el.play().catch(() => {}); } catch (e) {} }
  };
})();
document.addEventListener('visibilitychange', () => { if (document.hidden) SilentTrack.pause(); else SilentTrack.resume(); });

/* ------------------------------------------------------------------ 提示条 */
let toastTimer = 0;
function toast(msg, ms) {
  let el = $('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms || 4200);
}

/* ------------------------------------------------------------------- 启动 */
let saveTimer = 0;
function autoSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem('drawmusic.piece', JSON.stringify(piece)); } catch (e) {} }, 700);
}
function loadAutoSave() {
  try {
    const d = localStorage.getItem('drawmusic.piece');
    if (!d) return false;
    const o = normalizePiece(JSON.parse(d));
    if (!pieceStats(o).strokes) return false;
    piece = o; return true;
  } catch (e) { return false; }
}
function syncControls() {
  $('bpmR').value = piece.bpm; $('bpmV').textContent = piece.bpm;
  $('scaleSel').value = piece.scale;
  $('keySel').value = String(piece.key);
  $('spbSel').value = String(piece.stepsPerBeat);
  $('beatsSel').value = String(piece.beats);
  const arStr = String(piece.ar);
  $('arSel').value = Array.prototype.some.call($('arSel').options, (o) => o.value === arStr) ? arStr : '';
  $('arNum').value = piece.ar.toFixed(3);
}
/* 默认作品：由 build-default.js 从 DefaultDraw.txt 生成，包成 .js 加载，
   这样双击 file:// 打开也能用（fetch 会被 CORS 拦掉） */
async function loadDefaultPiece() {
  const D = window.DEFAULT_PIECE;
  if (!D || !D.packed) return false;
  try {
    const r = await importText(D.packed);
    const p = r.piece;
    if (D.ar) p.ar = D.ar;
    // 默认作品的音乐设置（会覆盖数据里自带的 120 BPM / 无音阶）
    if (D.bpm) p.bpm = D.bpm;
    if (D.scale) p.scale = D.scale;
    if (D.key != null) p.key = D.key;
    if (D.beats) p.beats = D.beats;
    piece = normalizePiece(p);
    return true;
  } catch (e) { console.warn('默认作品载入失败：', e); return false; }
}

function init() {
  // ?reset —— 清掉本地草稿，重新展示默认作品（改完默认值后自己看效果用）
  if (/[?&]reset/.test(location.search)) {
    try { localStorage.removeItem('drawmusic.piece'); } catch (e) {}
  }
  const hadDraft = loadAutoSave();
  rebuildRows();
  wire();
  buildPalette();
  buildPages();
  syncControls();
  updateLenLabel();
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => { setTimeout(resize, 120); setTimeout(resize, 400); });
  if (window.ResizeObserver) new ResizeObserver(() => resize()).observe($('stage'));
  AudioEngine.setVolume($('vol').value / 100);
  AudioEngine.setDrums($('drumsChk').checked);
  AudioEngine.setClick($('clickChk').checked);
  resize();
  syncAll();
  tick();
  // 没有草稿、也没有 #p= 链接 → 展示默认作品
  if (!hadDraft && !/^#p=/.test(location.hash)) {
    loadDefaultPiece().then((ok) => {
      if (!ok) return;
      pageIndex = 0; undoStack.length = 0; redoStack.length = 0;
      syncControls(); buildPages(); updateLenLabel(); resize(); syncAll();
      const portraitPhone = window.innerWidth < window.innerHeight && window.innerWidth < 860;
      toast('这是默认作品（' + pieceStats(piece).strokes + ' 条笔迹）—— '
        + (portraitPhone && piece.ar < 1 ? '把手机横过来能画得更大；' : '')
        + '直接在它上面画，或点「⬇ 导入」换成你自己的', 6500);
    });
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
