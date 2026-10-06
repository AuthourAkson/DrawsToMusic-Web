/* 音频引擎自检：node test-audio.js
   不依赖浏览器，直接跑合成器内核。 */
const fs = require('fs'), path = require('path');
const mod = new Function(
  fs.readFileSync(path.join(__dirname, 'audio.js'), 'utf8').replace(/^'use strict';/, '')
  + ';return { KERNEL: KERNEL, PALETTE: PALETTE };')();
const KERNEL = mod.KERNEL, PALETTE = mod.PALETTE;

const sr = 44100, steps = 64, spb = 4, bpm = 120;
function makeGrid(rows) {
  const q = [];
  for (const r of rows) q.push(0, steps, 48 + r, r % 9);
  for (let s = 0; s < steps; s += 4) q.push(s, s + 4, 48 + 3 + (s % 12), 3);
  return { data: new Int32Array(q), count: q.length / 4 };
}
function newKernel(cfg) {
  const reg = {};
  class P { constructor() { this.port = { onmessage: null, postMessage: () => {} }; } }
  new Function('sampleRate', 'registerProcessor', 'AudioWorkletProcessor', 'currentTime', KERNEL)(sr, (n, c) => { reg[n] = c; }, P, 0);
  const k = new reg.mt();
  k.msg({ type: 'colors', colors: PALETTE.map((c) => ({ wave: c.wave, cutoff: c.cutoff, gain: c.gain, atk: c.atk, dec: c.dec, rel: c.rel })) });
  if (cfg) k.msg(Object.assign({ type: 'config' }, cfg));
  return k;
}
function run(k, seconds) {
  const block = new Float32Array(128);
  const n = Math.round(seconds * sr / 128) * 128;
  const out = new Float32Array(n);
  let w = 0;
  for (let i = 0; i < n; i += 128) { k.process([], [[block]]); if (w + 128 <= n) { out.set(block, w); w += 128; } }
  return out;
}
function stats(a) { let p = 0, s = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > p) p = v; s += a[i] * a[i]; } return { peak: p, rms: Math.sqrt(s / a.length) }; }
/* 最大相邻采样跳变：用来判断「咔」的一声 */
function maxJump(a) { let m = 0; for (let i = 1; i < a.length; i++) { const d = Math.abs(a[i] - a[i - 1]); if (d > m) m = d; } return m; }

const R = [];
const ok = (n, c, x) => R.push((c ? '✅ ' : '❌ ') + n + (x ? '  — ' + x : ''));

/* ---------- 1 & 2: 稀疏 / 极密 ---------- */
{
  const g = makeGrid([7, 12, 19]);
  const k = newKernel({ steps, spb, bpm }); k.msg({ type: 'drums', v: true }); k.msg({ type: 'notes', data: g.data, count: g.count }); k.msg({ type: 'play', on: true });
  const s = stats(run(k, 5));
  ok('稀疏：有声音、不削爆', s.peak > 0.05 && s.peak <= 1 && s.rms > 0.01, '峰值 ' + s.peak.toFixed(3) + '  RMS ' + s.rms.toFixed(3));
}
{
  const q = [];
  for (let s = 0; s < steps; s++) for (let r = 0; r < 30; r++) q.push(s, s + 1, 48 + r, r % 9);
  const k = newKernel({ steps, spb, bpm }); k.msg({ type: 'drums', v: true }); k.msg({ type: 'click', v: true });
  k.msg({ type: 'notes', data: new Int32Array(q), count: q.length / 4 }); k.msg({ type: 'play', on: true });
  const s = stats(run(k, 5));
  ok('极密（30 声部同时）：软削波兜住了', s.peak <= 1.0 && s.rms > 0.02 && s.rms < 0.75, '峰值 ' + s.peak.toFixed(3) + '  RMS ' + s.rms.toFixed(3));
}
/* ---------- 3: 变速时不能跳位置（原 bug：拖滑块音乐乱跳）---------- */
{
  const g = makeGrid([7, 12, 19]);
  const k = newKernel({ steps, spb, bpm });
  k.msg({ type: 'notes', data: g.data, count: g.count }); k.msg({ type: 'play', on: true });
  run(k, 3);
  const frac = (kk) => { let p = (kk.t - kk.anchor) % (kk.stepN * kk.steps); if (p < 0) p += kk.stepN * kk.steps; return p / (kk.stepN * kk.steps); };
  const before = frac(k);
  k.msg({ type: 'config', steps, spb, bpm: 180 });
  const after = frac(k);
  let d = Math.abs(after - before); if (d > 0.5) d = 1 - d;
  ok('播放中改速度时循环位置不跳', d < 0.02, '改之前 ' + before.toFixed(3) + ' → 改之后 ' + after.toFixed(3) + '（偏移 ' + d.toFixed(4) + '）');
}
/* ---------- 4: 暂停/继续不能「咔」的一声 ---------- */
{
  const g = makeGrid([7, 12, 19]);
  const k = newKernel({ steps, spb, bpm });
  k.msg({ type: 'notes', data: g.data, count: g.count }); k.msg({ type: 'play', on: true });
  run(k, 1.5);
  k.msg({ type: 'play', on: false });          // 暂停，应淡出
  const fade = run(k, 0.5);
  const jFade = maxJump(fade);
  run(k, 0.5);
  k.msg({ type: 'play', on: true });           // 继续，应淡入
  const back = run(k, 1.0);
  const jBack = maxJump(back);
  // 稳态下正常波形的相邻跳变（作参照）
  const steady = run(k, 1.0);
  const jRef = maxJump(steady.slice(4410));    // 跳过起始段
  ok('暂停淡出无爆音', jFade < jRef * 1.6, '跳变 ' + jFade.toFixed(4) + ' vs 稳态 ' + jRef.toFixed(4));
  ok('继续淡入无爆音', jBack < jRef * 1.6, '跳变 ' + jBack.toFixed(4) + ' vs 稳态 ' + jRef.toFixed(4));
}

console.log(R.join('\n'));
const bad = R.filter((x) => x.startsWith('❌')).length;
console.log(bad ? '\n' + bad + ' 项失败' : '\n全部通过');
process.exit(bad ? 1 : 0);
