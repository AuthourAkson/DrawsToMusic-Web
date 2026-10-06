'use strict';
/* ============================================================================
 * audio.js —— 合成器（AudioWorklet，带 ScriptProcessor 回退）
 * ----------------------------------------------------------------------------
 * 与原站的关键区别：
 *   原站给每条笔迹分配固定的「槽位」，总共只有 128-10=118 个，
 *   画超过 118 条就有一部分永远不出声。
 *   这里改成「事件驱动 + 动态声部池」：
 *   把同一时刻相同 (音高, 音色) 的音符合并，按下/抬起两个事件驱动声部，
 *   声部池 192 个，不够时按「最旧 + 最轻」抢占。200 条笔迹全部能响。
 * ==========================================================================*/

const PALETTE = [
  { name: 'keys',    hex: '#1D9E75', wave: 0, cutoff: 4200, gain: 1.30, atk: 0.008, dec: 1.6, rel: 0.55 },
  { name: 'pluck',   hex: '#D85A30', wave: 1, cutoff: 1800, gain: 1.20, atk: 0.006, dec: 0.9, rel: 0.30 },
  { name: 'bell',    hex: '#7F77DD', wave: 2, cutoff: 3800, gain: 1.00, atk: 0.008, dec: 2.6, rel: 0.90 },
  { name: 'marimba', hex: '#EF9F27', wave: 3, cutoff: 3200, gain: 1.35, atk: 0.006, dec: 0.55, rel: 0.22 },
  { name: 'flute',   hex: '#3E5EC6', wave: 4, cutoff: 3000, gain: 1.25, atk: 0.070, dec: 0,    rel: 0.25 },
  { name: 'strings', hex: '#DE7BAE', wave: 5, cutoff: 2200, gain: 1.15, atk: 0.130, dec: 0,    rel: 0.40 },
  { name: 'chime',   hex: '#85BEE8', wave: 6, cutoff: 5000, gain: 0.85, atk: 0.008, dec: 1.9, rel: 0.80 },
  { name: 'bass',    hex: '#33312B', wave: 7, cutoff: 1200, gain: 1.10, atk: 0.030, dec: 0,    rel: 0.18 },
  { name: '8bit',    hex: '#F4BE82', wave: 8, cutoff: 950,  gain: 0.50, atk: 0.020, dec: 0,    rel: 0.10 }
];

/* ---------------------------------------------------------------- 合成器内核 */
/* 这个字符串会被塞进 AudioWorklet（或回退时在主线程 eval） */
const KERNEL = `
class MT extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sr = sampleRate; this.inv = 1 / sampleRate;
    this.MAXV = 192;
    this.vOn   = new Uint8Array(this.MAXV);
    this.vNote = new Int32Array(this.MAXV);
    this.vCol  = new Int32Array(this.MAXV);
    this.vPh   = new Float64Array(this.MAXV);
    this.vPh2  = new Float64Array(this.MAXV);
    this.vF    = new Float32Array(this.MAXV);
    this.vTf   = new Float32Array(this.MAXV);
    this.vEnv  = new Float32Array(this.MAXV);
    this.vSt   = new Uint8Array(this.MAXV);   // 1 attack 2 hold/decay 3 release
    this.vZ1   = new Float32Array(this.MAXV);
    this.vZ2   = new Float32Array(this.MAXV);
    this.vB0 = new Float32Array(this.MAXV); this.vB1 = new Float32Array(this.MAXV);
    this.vB2 = new Float32Array(this.MAXV); this.vA1 = new Float32Array(this.MAXV);
    this.vA2 = new Float32Array(this.MAXV); this.vCut = new Float32Array(this.MAXV).fill(-1);
    this.vAge  = new Float64Array(this.MAXV);
    this.seq = 0;

    this.wave = new Int32Array(9); this.cut = new Float32Array(9);
    this.gain = new Float32Array(9); this.atkK = new Float32Array(9);
    this.decK = new Float32Array(9); this.relK = new Float32Array(9);

    this.steps = 32; this.spb = 4; this.bpm = 120;
    this.onAt = []; this.offAt = [];
    this.voiceOfNote = new Int32Array(0);

    this.playing = false; this.t = 0; this.anchor = 0; this.pause = 0; this.lastStep = -1; this.lastFrac = -1e9;
    this.stepN = 1000;
    this.vol = 0.7; this.m = 0; this.kM = 1 - Math.exp(-1 / (0.010 * this.sr));
    this.outGain = 0; this.kOut = 1 - Math.exp(-1 / (0.025 * this.sr));
    this.kA = 1 - Math.exp(-1 / (0.006 * this.sr));
    this.fk = 1 - Math.exp(-1 / (0.012 * this.sr));

    // 总线：延迟 + 软削波
    this.dl = new Float32Array(Math.floor(0.32 * this.sr)); this.dw = 0;
    this.hpZ = 0; this.kHp = 1 - Math.exp(-2 * Math.PI * 240 / this.sr);
    this.damp = 0; this.kD = 1 - Math.exp(-2 * Math.PI * 3200 / this.sr);
    this.bus = 1; this.kBus = 1 - Math.exp(-1 / (0.06 * this.sr));

    // 鼓机
    this.drums = false;
    this.kEnv=0; this.kPh=0; this.kF=120; this.kDk=Math.exp(-1/(0.10*this.sr)); this.kPk=1-Math.exp(-1/(0.018*this.sr));
    this.sEnv=0; this.sPh=0; this.sDk=Math.exp(-1/(0.05*this.sr));
    this.hEnv=0; this.hDk=Math.exp(-1/(0.012*this.sr)); this.noise=0x2545F491>>>0; this.pn=0;
    this.click = false; this.clkEnv=0; this.clkPh=0; this.clkF=1500; this.kClk=Math.exp(-1/(0.008*this.sr));

    this.port.onmessage = (e) => this.msg(e.data);
  }

  msg(d) {
    if (d.type === 'colors') {
      for (let i = 0; i < 9; i++) {
        const c = d.colors[i];
        this.wave[i] = c.wave; this.cut[i] = c.cutoff; this.gain[i] = c.gain;
        this.atkK[i] = 1 - Math.exp(-1 / (Math.max(c.atk, 0.001) * this.sr));
        this.decK[i] = c.dec > 0 ? Math.exp(-1 / (c.dec * this.sr)) : 1;
        this.relK[i] = 1 - Math.exp(-1 / (Math.max(c.rel, 0.02) * this.sr));
      }
    } else if (d.type === 'notes') {
      this.setNotes(d.data, d.count);
    } else if (d.type === 'config') {
      const newStepN = Math.max(1, Math.round(60 / d.bpm / d.spb * this.sr));
      if (this.playing && this.stepN > 0) {
        // 播放中改速度：保持当前进度不跳（否则每拖一下滑块音乐就跳一次）
        const oldN = this.stepN * this.steps;
        let pos = (this.t - this.anchor) % oldN; if (pos < 0) pos += oldN;
        const frac = pos / oldN;
        this.steps = d.steps; this.spb = d.spb; this.bpm = d.bpm; this.stepN = newStepN;
        this.anchor = this.t - Math.round(frac * newStepN * d.steps);
      } else {
        this.steps = d.steps; this.spb = d.spb; this.bpm = d.bpm; this.stepN = newStepN;
      }
      this.lastStep = -1;
    } else if (d.type === 'play') {
      if (d.on && !this.playing) { this.anchor = this.t - this.pause * this.sr; this.playing = true; this.lastStep = -1; }
      else if (!d.on && this.playing) {
        // 不硬切：让输出在 ~25ms 内淡出，之后再回收声部（硬切会「咔」一声）
        this.pause = (this.t - this.anchor) / this.sr; this.playing = false;
      }
    } else if (d.type === 'restart') {
      this.pause = 0; this.anchor = this.t; this.lastStep = -1;
    } else if (d.type === 'vol') {
      this.vol = d.v;
    } else if (d.type === 'drums') {
      this.drums = !!d.v;
    } else if (d.type === 'click') {
      this.click = !!d.v;
    }
  }

  setNotes(data, count) {
    this.notes = data; this.nCount = count;
    this.onAt = []; this.offAt = [];
    for (let i = 0; i < count; i++) {
      const s = data[i * 4], e = data[i * 4 + 1];
      if (!this.onAt[s]) this.onAt[s] = [];
      this.onAt[s].push(i);
      if (!this.offAt[e]) this.offAt[e] = [];
      this.offAt[e].push(i);
    }
    this.voiceOfNote = new Int32Array(count).fill(-1);
    // 换歌时把所有声部放掉，避免残留
    for (let v = 0; v < this.MAXV; v++) if (this.vOn[v]) this.vSt[v] = 3;
  }

  blep(t, dt) {
    if (dt <= 0) return 0;
    if (t < dt) { const x = t / dt; return x + x - x * x - 1; }
    if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; }
    return 0;
  }

  biquad(v, cut) {
    const q = Math.pow(10, 0.7 / 20);
    const c = Math.min(Math.max(cut, 10), this.sr * 0.45);
    const w = 2 * Math.PI * c / this.sr, sn = Math.sin(w), cs = Math.cos(w), al = sn / (2 * q), a0 = 1 + al;
    this.vB0[v] = ((1 - cs) / 2) / a0;
    this.vB1[v] = (1 - cs) / a0;
    this.vB2[v] = ((1 - cs) / 2) / a0;
    this.vA1[v] = (-2 * cs) / a0;
    this.vA2[v] = (1 - al) / a0;
  }

  /* 找一个声部：先找空闲的，再抢「正在释放」的，最后抢最旧的 */
  alloc() {
    for (let k = 0; k < this.MAXV; k++) if (!this.vOn[k]) return k;
    let v = -1;
    for (let k = 0; k < this.MAXV; k++) if (this.vSt[k] === 3 && (v < 0 || this.vAge[k] < this.vAge[v])) v = k;
    if (v >= 0) return v;
    v = 0;
    for (let k = 1; k < this.MAXV; k++) if (this.vAge[k] < this.vAge[v]) v = k;
    return v;
  }

  startVoice(noteIdx, midi, col) {
    const v = this.alloc();
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    this.vOn[v] = 1; this.vNote[v] = noteIdx; this.vCol[v] = col;
    this.vF[v] = f; this.vTf[v] = f; this.vEnv[v] = 0; this.vSt[v] = 1;
    this.vPh[v] = 0; this.vPh2[v] = 0; this.vZ1[v] = 0; this.vZ2[v] = 0;
    this.vAge[v] = ++this.seq;
    if (this.vCut[v] !== this.cut[col]) { this.biquad(v, this.cut[col]); this.vCut[v] = this.cut[col]; }
    this.voiceOfNote[noteIdx] = v;
  }

  fireStep(st) {
    const on = this.onAt[st];
    if (on) for (let k = 0; k < on.length; k++) {
      const i = on[k];
      this.startVoice(i, this.notes[i * 4 + 2], this.notes[i * 4 + 3]);
    }
    const off = this.offAt[st];
    if (off) for (let k = 0; k < off.length; k++) {
      const i = off[k], v = this.voiceOfNote[i];
      if (v >= 0 && this.vSt[v] !== 3) this.vSt[v] = 3;
      this.voiceOfNote[i] = -1;
    }
    const onPulse = (st % this.spb === 0);
    if (this.click && onPulse) { this.clkEnv = 1; this.clkPh = 0; this.clkF = (st === 0) ? 1900 : 1250; }
    if (this.drums) {
      const beat = Math.floor(st / this.spb);
      if (onPulse) { if (beat % 2 === 0) { this.kEnv = 1; this.kPh = 0; } else { this.sEnv = 1; this.sPh = 0; } }
      if (st % Math.max(1, Math.round(this.spb / 2)) === 0) this.hEnv = 1;
    }
    this.port.postMessage({ step: st });
  }

  render(out, off, n) {
    // 预分配，别在音频线程里每块都 new Float32Array（375 次/秒会造成 GC 抖动）
    if (!this.scratch || this.scratch.length < n) this.scratch = new Float32Array(Math.max(n, 512));
    const sc = this.scratch; sc.fill(0, 0, n);
    const twoPi = 2 * Math.PI;
    // 同时发声的音越多，总线越收一点：密的时候不糊、不削爆
    let nActive = 0;
    for (let v = 0; v < this.MAXV; v++) if (this.vOn[v]) nActive++;
    const busT = 1.35 / Math.sqrt(Math.max(1, nActive * 0.55));
    for (let v = 0; v < this.MAXV; v++) {
      if (!this.vOn[v]) continue;
      const col = this.vCol[v], wv = this.wave[col];
      let ph = this.vPh[v], ph2 = this.vPh2[v], env = this.vEnv[v], st = this.vSt[v];
      let f = this.vF[v]; const tf = this.vTf[v];
      const g = this.gain[col], kA = this.atkK[col], kD = this.decK[col], kR = this.relK[col];
      const b0 = this.vB0[v], b1 = this.vB1[v], b2 = this.vB2[v], a1 = this.vA1[v], a2 = this.vA2[v];
      let z1 = this.vZ1[v], z2 = this.vZ2[v];
      const struck = kD < 1;
      for (let i = 0; i < n; i++) {
        if (st === 1) { env += (1.06 - env) * kA; if (env >= 1) { env = 1; st = 2; } }
        else if (st === 2) { if (struck) env *= kD; }
        else env *= kR;
        if (env < 1e-4 && (st === 3 || struck)) { env = 0; break; }
        f += (tf - f) * this.fk;
        let inc = f * this.inv;
        const w1 = ph * twoPi;
        let x;
        switch (wv) {
          case 1: inc = f * this.inv; x = 2 * ph - 1; x -= this.blep(ph, inc); break;
          case 2: ph2 += inc * 2; if (ph2 >= 1) ph2 -= 1; x = Math.sin(w1 + (0.10 + 0.6 * env) * Math.sin(ph2 * twoPi)); break;
          case 3: x = Math.sin(w1) + 0.35 * env * Math.sin(4 * w1); break;
          case 4: ph2 += 5 * this.inv; if (ph2 >= 1) ph2 -= 1; x = Math.sin(w1 + 0.004 * Math.sin(ph2 * twoPi)); break;
          case 5: ph2 += inc * 1.007; if (ph2 >= 1) ph2 -= 1;
                  x = ((2 * ph - 1 - this.blep(ph, inc)) + (2 * ph2 - 1 - this.blep(ph2, inc))) * 0.5; break;
          case 6: ph2 += inc * 3.98; if (ph2 >= 1) ph2 -= 1; x = Math.sin(w1) + 0.22 * env * Math.sin(ph2 * twoPi); break;
          case 7: x = Math.sin(w1) + 0.22 * Math.sin(2 * w1); break;
          case 8: { x = ph < 0.5 ? 1 : -1; x += this.blep(ph, inc);
                    let t2 = ph + 0.5; if (t2 >= 1) t2 -= 1; x -= this.blep(t2, inc); break; }
          default: x = Math.sin(w1) + (0.38 * Math.sin(2 * w1) + 0.14 * Math.sin(3 * w1)) * env;
        }
        ph += inc; if (ph >= 1) ph -= 1;
        const xn = x + 1e-12;
        const yv = b0 * xn + z1; z1 = b1 * xn - a1 * yv + z2; z2 = b2 * xn - a2 * yv;
        sc[i] += yv * env * g * 0.26;
      }
      this.vPh[v] = ph; this.vPh2[v] = ph2; this.vEnv[v] = env; this.vSt[v] = st;
      this.vF[v] = f; this.vZ1[v] = z1; this.vZ2[v] = z2;
      if (env <= 0) { this.vOn[v] = 0; this.vNote[v] = -1; }
    }
    // ---- 总线 ----
    let m = this.m; const tgt = this.vol;
    let wr = this.dw, damp = this.damp; const dl = this.dl, dN = dl.length;
    const kBus = this.kBus;
    let bus = this.bus;
    const wantGain = this.playing ? 1 : 0;
    let outGain = this.outGain;
    for (let i = 0; i < n; i++) {
      bus += (busT - bus) * this.kBus;
      m += (tgt - m) * this.kM;
      const dry = sc[i] * m * bus;
      const ech = dl[wr];
      const fb = dry + ech * 0.32;
      this.hpZ += (fb - this.hpZ) * this.kHp;
      const hp = fb - this.hpZ;
      damp += (hp - damp) * this.kD;
      dl[wr] = damp + 1e-12; wr++; if (wr === dN) wr = 0;
      let y = dry + ech * 0.20, d = 0;
      if (this.kEnv > 1e-4) { this.kPh += this.kF * this.inv; if (this.kPh >= 1) this.kPh -= 1;
        this.kF += (52 - this.kF) * this.kPk; const w = this.kPh * twoPi; d += Math.sin(w) * this.kEnv * 0.85; this.kEnv *= this.kDk; }
      if (this.clkEnv > 1e-4) { this.clkPh += this.clkF * this.inv; if (this.clkPh >= 1) this.clkPh -= 1;
        d += Math.sin(this.clkPh * twoPi) * this.clkEnv * 0.30; this.clkEnv *= this.kClk; }
      if (this.sEnv > 1e-4 || this.hEnv > 1e-4) {
        this.noise = (Math.imul(this.noise, 1664525) + 1013904223) >>> 0;
        const nz = ((this.noise >>> 8) * (2 / 16777216)) - 1;
        if (this.sEnv > 1e-4) { this.sPh += 190 * this.inv; if (this.sPh >= 1) this.sPh -= 1;
          d += (nz * 0.20 + Math.sin(this.sPh * twoPi) * 0.16) * this.sEnv; this.sEnv *= this.sDk; }
        if (this.hEnv > 1e-4) { d += (nz - this.pn) * this.hEnv * 0.15; this.hEnv *= this.hDk; }
        this.pn = nz;
      }
      y += d * m;
      outGain += (wantGain - outGain) * this.kOut;
      y *= outGain;
      if (y > 3) y = 3; else if (y < -3) y = -3;
      out[off + i] = y * (27 + y * y) / (27 + 9 * y * y);
    }
    this.dw = wr; this.damp = damp; this.m = m; this.bus = bus; this.outGain = outGain;
    // 淡出干净之后再把声部回收，避免「咔」的一声
    if (!this.playing && outGain < 0.01) {
      for (let v = 0; v < this.MAXV; v++) { this.vOn[v] = 0; this.vEnv[v] = 0; this.vSt[v] = 0; }
      this.kEnv = this.sEnv = this.hEnv = 0;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const n = out.length, loopN = this.stepN * this.steps;
    let done = 0;
    while (done < n) {
      let chunk = n - done;
      if (this.playing) {
        let pos = ((this.t + done) - this.anchor) % loopN;
        if (pos < 0) pos += loopN;
        const st = Math.floor(pos / this.stepN);
        if (st !== this.lastStep) { this.lastStep = st; this.fireStep(st); }
        chunk = Math.min(chunk, this.stepN - (pos % this.stepN));
      }
      if (chunk < 1) chunk = 1;
      this.render(out, done, chunk);
      done += chunk;
    }
    this.t += n;
    // 播放头位置回报限流到 ~30Hz：跨线程 postMessage 很便宜但也不是免费的
    if (this.playing && this.t - this.lastFrac > this.sr / 30) {
      this.lastFrac = this.t;
      let pos = (this.t - this.anchor) % loopN;
      if (pos < 0) pos += loopN;
      this.port.postMessage({ frac: pos / loopN });
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}
registerProcessor('mt', MT);
`;

/* ------------------------------------------------------------------ 主线程宿主 */
const AudioEngine = (() => {
  let AC = null, node = null, master = null, ready = false, starting = null, fallback = false;
  let hFrac = null, hStep = null;
  // 记住所有要发给内核的状态。节点是在第一次点击播放时才建出来的，
  // 在那之前发出去的消息全都会丢 —— 内核就会用默认 stepN=1000（循环只有 0.73 秒），
  // 表现就是「进度线高速循环 + 没声音」。所以建好节点后必须整体重放一遍。
  let stCfg = null, stNotes = null, stVol = 0.7, stDrums = false, stClick = false;

  function dispatch(d) {
    if (!d) return;
    if (d.frac !== undefined) { if (hFrac) hFrac(d.frac); }
    else if (d.step !== undefined) { if (hStep) hStep(d.step); }
  }
  function colorMsg() {
    return { type: 'colors', colors: PALETTE.map((c) => ({ wave: c.wave, cutoff: c.cutoff, gain: c.gain, atk: c.atk, dec: c.dec, rel: c.rel })) };
  }
  function makeFallback() {
    fallback = true;
    const reg = {};
    const shim = {
      sampleRate: AC.sampleRate,
      registerProcessor: (n, c) => { reg[n] = c; },
      AudioWorkletProcessor: class { constructor() { this.port = { onmessage: null, postMessage: (m) => dispatch(m) }; } },
      currentTime: 0
    };
    new Function('sampleRate', 'registerProcessor', 'AudioWorkletProcessor', 'currentTime', KERNEL)(
      shim.sampleRate, shim.registerProcessor, shim.AudioWorkletProcessor, 0);
    const k = new reg.mt();
    const sp = AC.createScriptProcessor(2048, 0, 2);
    sp.onaudioprocess = (ev) => {
      const l = ev.outputBuffer.getChannelData(0), r = ev.outputBuffer.getChannelData(1);
      k.process([], [[l, r]]);
    };
    node = { port: { postMessage: (d) => k.msg(d), onmessage: null }, connect: (dest) => sp.connect(dest) };
  }

  async function ensure() {
    if (AC) { if (AC.state !== 'running') AC.resume().catch(() => {}); return starting || Promise.resolve(); }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('这个浏览器不支持 Web Audio');
    AC = new Ctx({ latencyHint: 'interactive' });
    AC.addEventListener('statechange', () => { if (AC.state !== 'running') resumeSoon(); });
    starting = (async () => {
      if (AC.audioWorklet) {
        try {
          const url = URL.createObjectURL(new Blob([KERNEL], { type: 'application/javascript' }));
          await AC.audioWorklet.addModule(url);
          URL.revokeObjectURL(url);
          node = new AudioWorkletNode(AC, 'mt', { outputChannelCount: [2] });
          node.port.onmessage = (e) => dispatch(e.data);
        } catch (err) { console.warn('AudioWorklet 不可用，改用主线程合成：', err); makeFallback(); }
      } else makeFallback();
      master = AC.createGain();
      node.connect(master); master.connect(AC.destination);
      node.port.postMessage(colorMsg());
      if (stCfg) node.port.postMessage({ type: 'config', steps: stCfg.steps, spb: stCfg.spb, bpm: stCfg.bpm });
      node.port.postMessage({ type: 'vol', v: stVol });
      node.port.postMessage({ type: 'drums', v: stDrums });
      node.port.postMessage({ type: 'click', v: stClick });
      if (stNotes) node.port.postMessage({ type: 'notes', data: stNotes.data, count: stNotes.count });
      ready = true;
    })();
    return starting;
  }
  /* iOS 的中断恢复脾气很怪：一次 resume 常常被忽略，要追着敲几下 */
  let nudgeTimer = 0, nudgeUntil = 0;
  function resumeSoon() {
    nudgeUntil = performance.now() + 3000; if (nudgeTimer) return;
    const tick = () => {
      nudgeTimer = 0;
      if (!AC) return;
      if (AC.state !== 'running') AC.resume().catch(() => {});
      if (performance.now() < nudgeUntil) nudgeTimer = setTimeout(tick, 250);
    };
    nudgeTimer = setTimeout(tick, 200);
  }
  function send(d) { if (node) node.port.postMessage(d); }

  return {
    ensure, resumeSoon,
    get ctx() { return AC; },
    get ready() { return ready; },
    get fallback() { return fallback; },
    setConfig(cfg) { stCfg = cfg; send({ type: 'config', steps: cfg.steps, spb: cfg.spb, bpm: cfg.bpm }); },
    setNotes(data, count) { stNotes = { data, count }; send({ type: 'notes', data, count }); },
    play(on) { send({ type: 'play', on }); },
    restart() { send({ type: 'restart' }); },
    setVolume(v) { stVol = v; send({ type: 'vol', v }); },
    setDrums(v) { stDrums = !!v; send({ type: 'drums', v: !!v }); },
    setClick(v) { stClick = !!v; send({ type: 'click', v: !!v }); },
    onFrac(fn) { hFrac = fn; },
    onStep(fn) { hStep = fn; },
    latency() { if (!AC) return 0; return (AC.baseLatency || 0) + (AC.outputLatency || 0) + (fallback ? 2048 / AC.sampleRate : 0); }
  };
})();

/* ------------------------------------------------------ 离线渲染（导出 WAV 用） */
function renderLoopOffline(cfg, data, count, sr) {
  sr = sr || 44100;
  const reg = {};
  class P { constructor() { this.port = { onmessage: null, postMessage: () => {} }; } }
  new Function('sampleRate', 'registerProcessor', 'AudioWorkletProcessor', 'currentTime', KERNEL)(sr, (n, c) => { reg[n] = c; }, P, 0);
  const k = new reg.mt();
  k.msg({ type: 'colors', colors: PALETTE.map((c) => ({ wave: c.wave, cutoff: c.cutoff, gain: c.gain, atk: c.atk, dec: c.dec, rel: c.rel })) });
  k.msg({ type: 'config', steps: cfg.steps, spb: cfg.spb, bpm: cfg.bpm });
  k.msg({ type: 'drums', v: !!cfg.drums });
  k.msg({ type: 'click', v: !!cfg.click });
  k.msg({ type: 'notes', data, count });
  k.msg({ type: 'play', on: true });
  const stepN = Math.max(1, Math.round(60 / cfg.bpm / cfg.spb * sr));
  const loopN = stepN * cfg.steps;
  const tail = Math.floor(sr * 1.6);
  const buf = new Float32Array(loopN + tail);
  const q = 128, tmp = new Float32Array(q);
  // 第一遍预热延迟线和总线，第二遍才是干净的一圈
  for (let pass = 0; pass < 2; pass++) {
    k.msg({ type: 'restart' });
    for (let i = 0; i < loopN + (pass === 0 ? 0 : tail); i += q) {
      const n = Math.min(q, loopN + (pass === 0 ? 0 : tail) - i);
      const o = n === q ? tmp : new Float32Array(n);
      k.process([], [[o]]);
      if (pass === 1) buf.set(o.subarray(0, n), i);
    }
  }
  return buf;
}
