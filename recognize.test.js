const test = require('node:test');
const assert = require('node:assert');
const R = require('./recognize.js');

/**
 * 試験用の盤の絵を作る。白地に暗い格子線を引くだけ。
 * 実物の写真の代わりに、格子検出の当たり外れをここで確かめる。
 */
function drawBoard(opts) {
  const o = Object.assign({
    width: 400, height: 400, x0: 20, y0: 30, cell: 38,
    bg: 235, line: 60, lineWidth: 1, noise: 0
  }, opts);
  const { width: w, height: h } = o;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let v = o.bg;
    if (o.noise) v += (Math.random() * 2 - 1) * o.noise;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = Math.max(0, Math.min(255, v));
    data[i * 4 + 3] = 255;
  }
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = (y * w + x) * 4;
    data[p] = data[p + 1] = data[p + 2] = o.line;
  };
  for (let k = 0; k < 10; k++) {
    const x = Math.round(o.x0 + k * o.cell);
    const y = Math.round(o.y0 + k * o.cell);
    for (let t = 0; t < o.lineWidth; t++) {
      for (let j = 0; j <= o.cell * 9; j++) put(x + t, o.y0 + j);
      for (let i = 0; i <= o.cell * 9; i++) put(o.x0 + i, y + t);
    }
  }
  return { width: w, height: h, data, spec: o };
}

/** マスの真ん中に黒い四角を置く (駒のかわり)。 */
function putBlock(image, spec, file, rank, size) {
  const f = 9 - file;               // 画面左が9筋
  const r = rank - 1;
  const cx = spec.x0 + (f + 0.5) * spec.cell;
  const cy = spec.y0 + (r + 0.5) * spec.cell;
  const half = (size || spec.cell * 0.3) / 2;
  for (let y = Math.round(cy - half); y <= Math.round(cy + half); y++) {
    for (let x = Math.round(cx - half); x <= Math.round(cx + half); x++) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const p = (y * image.width + x) * 4;
      image.data[p] = image.data[p + 1] = image.data[p + 2] = 20;
    }
  }
}

// ---- 格子の検出 -------------------------------------------------------------

test('格子検出: きれいな盤の位置と大きさを当てられる', () => {
  const img = drawBoard({ x0: 20, y0: 30, cell: 38 });
  const grid = R.detectGrid(img);
  assert.ok(Math.abs(grid.x0 - 20) <= 1, `左端 (見つけた ${grid.x0} / 正解 20)`);
  assert.ok(Math.abs(grid.y0 - 30) <= 1, `上端 (見つけた ${grid.y0} / 正解 30)`);
  assert.ok(Math.abs(grid.cell - 38) <= 1, `マスの大きさ (見つけた ${grid.cell} / 正解 38)`);
});

test('格子検出: 盤が画像の端に寄っていても当てられる', () => {
  const img = drawBoard({ width: 380, height: 380, x0: 2, y0: 2, cell: 41 });
  const grid = R.detectGrid(img);
  assert.ok(Math.abs(grid.x0 - 2) <= 1, `左端 (${grid.x0})`);
  assert.ok(Math.abs(grid.cell - 41) <= 1, `マスの大きさ (${grid.cell})`);
});

test('格子検出: 駒 (黒い塊) が乗っていても格子を見失わない', () => {
  const img = drawBoard({ x0: 20, y0: 30, cell: 38 });
  for (const [f, r] of [[1, 1], [5, 5], [9, 9], [2, 3], [7, 2], [4, 8]]) {
    putBlock(img, img.spec, f, r, 22);
  }
  const grid = R.detectGrid(img);
  assert.ok(Math.abs(grid.x0 - 20) <= 2, `左端 (${grid.x0})`);
  assert.ok(Math.abs(grid.y0 - 30) <= 2, `上端 (${grid.y0})`);
  assert.ok(Math.abs(grid.cell - 38) <= 1, `マスの大きさ (${grid.cell})`);
});

test('格子検出: ざらつき (ノイズ) があっても当てられる', () => {
  const img = drawBoard({ x0: 15, y0: 15, cell: 36, noise: 18 });
  const grid = R.detectGrid(img);
  assert.ok(Math.abs(grid.x0 - 15) <= 2, `左端 (${grid.x0})`);
  assert.ok(Math.abs(grid.cell - 36) <= 1, `マスの大きさ (${grid.cell})`);
});

test('格子検出: 線が太くても当てられる', () => {
  const img = drawBoard({ x0: 24, y0: 24, cell: 34, lineWidth: 2 });
  const grid = R.detectGrid(img);
  assert.ok(Math.abs(grid.cell - 34) <= 1, `マスの大きさ (${grid.cell})`);
  assert.ok(grid.squareness > 0.85, `縦横のマスの大きさがそろっている (${grid.squareness.toFixed(2)})`);
});

// ---- インクの取り出し --------------------------------------------------------

test('空きマスからは字を拾わない', () => {
  const flat = new Float32Array(30 * 30).fill(220);
  assert.strictEqual(R.inkMaskOf(flat, 30, 30), null);
});

test('字のあるマスからは型を取り出せる', () => {
  const cell = new Float32Array(30 * 30).fill(230);
  for (let y = 8; y < 22; y++) for (let x = 10; x < 20; x++) cell[y * 30 + x] = 30;
  const ink = R.inkMaskOf(cell, 30, 30);
  assert.ok(ink, '字が見つかるはず');
  assert.strictEqual(ink.mask.length, R.NORM * R.NORM);
  assert.ok(ink.inkFraction > 0.1 && ink.inkFraction < 0.3, `インクの割合 (${ink.inkFraction.toFixed(2)})`);
});

// ---- 型どうしの比べ方 --------------------------------------------------------

test('同じ型どうしは 1.0 に近い', () => {
  const a = new Uint8Array(R.NORM * R.NORM);
  for (let i = 0; i < a.length; i += 3) a[i] = 1;
  assert.ok(R.similarity(a, a) > 0.99, `同じ型 (${R.similarity(a, a)})`);
});

test('重ならない型どうしは 0 に近い', () => {
  const a = new Uint8Array(R.NORM * R.NORM);
  const b = new Uint8Array(R.NORM * R.NORM);
  for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) a[j * R.NORM + i] = 1;
  for (let j = 22; j < R.NORM; j++) for (let i = 22; i < R.NORM; i++) b[j * R.NORM + i] = 1;
  assert.ok(R.similarity(a, b) < 0.1, `離れた型 (${R.similarity(a, b)})`);
});

test('180度回すと元に戻せる', () => {
  const a = new Uint8Array(R.NORM * R.NORM);
  for (let i = 0; i < 40; i++) a[i] = 1;
  assert.deepStrictEqual(R.rotate180(R.rotate180(a)), a);
});

// ---- 駒コードの向き ----------------------------------------------------------

test('逆さに写った駒は後手の駒コードになる', () => {
  assert.strictEqual(R.toGote('S'), 's');
  assert.strictEqual(R.toGote('+S'), '+s');
  assert.strictEqual(R.toGote('K'), 'k');
});

// ---- 照合 -------------------------------------------------------------------

test('照合: 正立で当たれば flipped=false、逆さなら true', () => {
  const mask = new Uint8Array(R.NORM * R.NORM);
  for (let j = 0; j < 12; j++) for (let i = 0; i < R.NORM; i++) mask[j * R.NORM + i] = 1;
  const templates = [{ code: 'P', mask }];

  const upright = R.classify(mask, templates);
  assert.strictEqual(upright.code, 'P');
  assert.strictEqual(upright.flipped, false);

  const flipped = R.classify(R.rotate180(mask), templates);
  assert.strictEqual(flipped.code, 'P');
  assert.strictEqual(flipped.flipped, true);
});
