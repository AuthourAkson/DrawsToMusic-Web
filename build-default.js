/* 把 DefaultDraw.txt 编译成 default-piece.js
   ------------------------------------------------------------
   为什么不用 fetch('DefaultDraw.txt')？
   因为直接双击 index.html 时页面是 file:// 协议，fetch 会被 CORS 拦掉。
   包成 .js 用 <script src> 加载，file:// 和 http(s):// 都能用。

   改了 DefaultDraw.txt 之后，跑一次：  node build-default.js
------------------------------------------------------------ */
const fs = require('fs'), path = require('path');
const D = __dirname;
const AR = 0.62;   // 画布高/宽。原数据里的 a=117 是错的（那是开着 DevTools 时的窗口比例）

const raw = fs.readFileSync(path.join(D, 'DefaultDraw.txt'), 'utf8').trim();
if (!/^[jd][A-Za-z0-9_\-]+$/.test(raw)) throw new Error('DefaultDraw.txt 看着不像 play_music_theory 的作品串');

let n = 0;
try {
  const b = Buffer.from(raw.slice(1).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (raw[0] === 'd') {
    const zlib = require('zlib');
    n = JSON.parse(zlib.inflateRawSync(b).toString('utf8')).s.length;
  } else {
    n = JSON.parse(b.toString('utf8')).s.length;
  }
} catch (e) { throw new Error('DefaultDraw.txt 解码失败: ' + e.message); }

const out = '/* 由 build-default.js 自动生成，请不要手改 —— 改 DefaultDraw.txt 后重新运行即可 */'
  + '\nwindow.DEFAULT_PIECE = { ar: ' + AR + ', strokes: ' + n + ', packed: ' + JSON.stringify(raw) + ' };\n';
fs.writeFileSync(path.join(D, 'default-piece.js'), out, 'utf8');
console.log('OK  default-piece.js  (' + n + ' 条笔迹, ar=' + AR + ', ' + out.length + ' 字节)');
