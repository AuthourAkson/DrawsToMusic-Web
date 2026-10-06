/* 把 DefaultDraw.txt 编译成 default-piece.js
   ------------------------------------------------------------
   为什么不用 fetch('DefaultDraw.txt')？
   因为直接双击 index.html 时页面是 file:// 协议，fetch 会被 CORS 拦掉。
   包成 .js 用 <script src> 加载，file:// 和 http(s):// 都能用。

   改了 DefaultDraw.txt 或下面的 PRESET 之后，跑一次：
       node build-default.js
------------------------------------------------------------ */
const fs = require('fs'), path = require('path');
const D = __dirname;

/* 画布高/宽。原数据里的 a=117 是错的 —— 那是保存时浏览器窗口的比例
   （当时开着 DevTools，窗口被压窄了）。0.62 是拿牌子上字母的字形纵横比量出来的。 */
const AR = 0.62;

/* 默认音乐设置（会覆盖 play_music_theory 数据里自带的 t=120 / 无音阶）*/
const PRESET = { bpm: 60, scale: 'mixolydian', key: 3, beats: 8 };

const raw = fs.readFileSync(path.join(D, 'DefaultDraw.txt'), 'utf8').trim();
if (!/^[jd][A-Za-z0-9_\-]+$/.test(raw)) throw new Error('DefaultDraw.txt 看着不像 play_music_theory 的作品串');

let n = 0;
try {
  const b = Buffer.from(raw.slice(1).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const json = raw[0] === 'd'
    ? require('zlib').inflateRawSync(b).toString('utf8')
    : b.toString('utf8');
  n = JSON.parse(json).s.length;
} catch (e) { throw new Error('DefaultDraw.txt 解码失败: ' + e.message); }

const NL = String.fromCharCode(10);
const out = [
  '/* 由 build-default.js 自动生成，请不要手改 —— 改 DefaultDraw.txt 后重新运行即可 */',
  'window.DEFAULT_PIECE = {',
  '  ar: ' + AR + ',',
  '  strokes: ' + n + ',',
  '  bpm: ' + PRESET.bpm + ',',
  '  scale: ' + JSON.stringify(PRESET.scale) + ',',
  '  key: ' + PRESET.key + ',',
  '  beats: ' + PRESET.beats + ',',
  '  packed: ' + JSON.stringify(raw),
  '};',
  ''
].join(NL);

fs.writeFileSync(path.join(D, 'default-piece.js'), out, 'utf8');
console.log('OK  default-piece.js');
console.log('    ' + n + ' 条笔迹 · 画布比例 ' + AR);
console.log('    默认音乐设置: ' + PRESET.bpm + ' BPM / ' + PRESET.scale + ' / key=' + PRESET.key + ' / ' + PRESET.beats + ' 拍');
console.log('    ' + out.length + ' 字节');
