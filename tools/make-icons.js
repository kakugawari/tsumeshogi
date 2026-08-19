/* アイコンを作りなおすスクリプト。
   駒の形（五角形）に「詰」を書いたものを PNG で書き出す。
   姉妹アプリの kakugawari/kifu (棋譜ノート) と同じ作り・同じ色で、
   字だけ「棋」→「詰」に変えてある。字は盤の駒と同じ Shippori Mincho Bold、
   字の下げ幅も盤と同じ。
   canvas で描いて撮るので Playwright が要る:
     npm i -D playwright && node tools/make-icons.js
   ブラウザの実行ファイルを指定したいときは CHROME_PATH を渡す。       */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const OUT = path.join(__dirname, "..");
const FONT = "ShipporiMincho-Bold.ttf";
const FONT_URL = "https://raw.githubusercontent.com/google/fonts/main/ofl/shipporimincho/" + FONT;
const CHAR = "詰";

const SIZES = [
  { file: "icon-192.png", size: 192, koma: 0.72 },
  { file: "icon-512.png", size: 512, koma: 0.72 },
  { file: "apple-touch-icon.png", size: 180, koma: 0.72 },
  // maskable は四隅を切られるので、駒を中央の安全圏（中心80%の円）に収める
  { file: "icon-512-maskable.png", size: 512, koma: 0.54 }
];

const html = (size, koma) => `<!doctype html><meta charset="utf-8">
<style>
@font-face{font-family:Koma;src:url(${FONT}) format("truetype");font-weight:700}
html,body{margin:0;padding:0}canvas{display:block}
</style>
<canvas id="c" width="${size}" height="${size}"></canvas>
<script>
const S=${size}, K=${koma};
const g=document.getElementById("c").getContext("2d");
// フォントが届いてから描く。届く前に描くと別の書体で焼き込まれてしまう。
document.fonts.load(Math.round(S*0.5)+"px Koma","${CHAR}").then(paint).catch(paint);
function paint(){
// 和紙の地
g.fillStyle="#EFE7D6"; g.fillRect(0,0,S,S);
let bg=g.createRadialGradient(S*0.2,S*0.12,0,S*0.2,S*0.12,S*0.9);
bg.addColorStop(0,"rgba(255,255,255,.55)"); bg.addColorStop(1,"rgba(255,255,255,0)");
g.fillStyle=bg; g.fillRect(0,0,S,S);
bg=g.createRadialGradient(S*0.85,S*0.92,0,S*0.85,S*0.92,S*0.7);
bg.addColorStop(0,"rgba(150,120,80,.14)"); bg.addColorStop(1,"rgba(150,120,80,0)");
g.fillStyle=bg; g.fillRect(0,0,S,S);

// 駒（kifu の pentagon と同じ形）
const w=S*K, h=w*1.0476, cx=S/2, cy=S/2, hw=w/2, hh=h/2;
function shape(){
  g.beginPath();
  g.moveTo(cx,cy-hh);
  g.lineTo(cx+hw*0.72,cy-hh*0.62);
  g.lineTo(cx+hw,cy+hh);
  g.lineTo(cx-hw,cy+hh);
  g.lineTo(cx-hw*0.72,cy-hh*0.62);
  g.closePath();
}
g.save();
g.shadowColor="rgba(70,50,25,.30)"; g.shadowBlur=S*0.035; g.shadowOffsetY=S*0.018;
shape();
const gr=g.createLinearGradient(cx,cy-hh,cx,cy+hh);
gr.addColorStop(0,"#F7E8BE"); gr.addColorStop(1,"#E6CE94");
g.fillStyle=gr; g.fill();
g.restore();
shape();
g.strokeStyle="rgba(120,90,45,.9)"; g.lineWidth=Math.max(1,w*0.026); g.stroke();

// 字（盤の駒と同じ大きさ・同じ下げ幅）
g.fillStyle="#241C12";
g.font=Math.round(h*0.60)+"px Koma";
g.textAlign="center"; g.textBaseline="middle";
g.fillText("${CHAR}",cx,cy+h*0.085);
  document.title="ready";
}
</script>`;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsume-icons-"));
  const font = path.join(dir, FONT);
  if (fs.existsSync(path.join(OUT, FONT))) fs.copyFileSync(path.join(OUT, FONT), font);
  else {
    process.stdout.write("フォントを取得中… ");
    const r = await fetch(FONT_URL);
    if (!r.ok) throw new Error("フォントを取れませんでした: " + r.status);
    fs.writeFileSync(font, Buffer.from(await r.arrayBuffer()));
    console.log("完了");
  }
  const exe = process.env.CHROME_PATH;
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  for (const s of SIZES) {
    const page = path.join(dir, "i.html");
    fs.writeFileSync(page, html(s.size, s.koma));
    const ctx = await b.newContext({ viewport: { width: s.size, height: s.size }, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    await p.goto("file://" + page);
    await p.waitForFunction(() => document.title === "ready", { timeout: 20000 });
    if (!await p.evaluate((ch) => document.fonts.check(Math.round(S * 0.5) + "px Koma", ch), CHAR))
      throw new Error("フォントを読み込めませんでした: " + FONT);
    await p.locator("#c").screenshot({ path: path.join(OUT, s.file) });
    await ctx.close();
    console.log(s.file, s.size + "x" + s.size);
  }
  await b.close();
  fs.rmSync(dir, { recursive: true, force: true });
})();
