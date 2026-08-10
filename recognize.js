/*!
 * recognize.js — 詰将棋の盤面のスクリーンショットを読み取る。
 *
 * DOM を触らないので node でテストできる。画像は
 * { width, height, data: Uint8ClampedArray (RGBA) } の形で渡す
 * (ブラウザの ImageData と同じ形)。
 *
 * 駒の字の「手本」だけは canvas で描く必要があるので外から渡してもらう
 * (app.js の buildTemplates が作る)。ここは照合するだけ。
 *
 * 考え方:
 *   1. 盤の格子を見つける。将棋盤の線は「等間隔に10本」並ぶので、
 *      その並びを一番よく説明する 間隔 と 位置 を総当たりで探す。
 *      駒や周りの飾りが作る線に惑わされにくい。
 *   2. 81マスに切り分け、マスごとに「字のインク」だけを取り出す。
 *   3. インクの形を32x32に正規化して、手本と重ね合わせて一番近い字を選ぶ。
 *      手本は180度回したものも用意してあり、どちらで当たったかで
 *      先手(攻め)・後手(守り)を決める。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.Recognize = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const NORM = 32;            // 正規化したときの一辺 (画素)
  const LINES = 10;           // 9x9 の盤を仕切る線の本数

  // ---- 下ごしらえ ---------------------------------------------------------

  /** RGBA からグレースケール (0..255 の Float32Array) を作る。 */
  function toGray(image) {
    const { width: w, height: h, data } = image;
    const gray = new Float32Array(w * h);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }
    return gray;
  }

  /**
   * 線らしさの横顔 (プロファイル) を作る。
   * axis='x' なら列ごと、'y' なら行ごとに、「まわりより暗い」度合いを集める。
   * 盤の格子線は細くて長いので、この値が周期的に高くなる。
   */
  function lineProfile(gray, w, h, axis) {
    const n = axis === 'x' ? w : h;
    const m = axis === 'x' ? h : w;
    const prof = new Float32Array(n);
    const at = axis === 'x'
      ? (i, j) => gray[j * w + i]
      : (i, j) => gray[i * w + j];

    for (let i = 1; i < n - 1; i++) {
      let sum = 0;
      for (let j = 0; j < m; j++) {
        // 左右 (or 上下) の平均より暗ければ線らしい
        const here = at(i, j);
        const around = (at(i - 1, j) + at(i + 1, j)) / 2;
        const d = around - here;
        if (d > 0) sum += d;
      }
      prof[i] = sum / m;
    }
    return prof;
  }

  /**
   * 等間隔に LINES 本並ぶ線を探す (櫛あて)。
   * 間隔 s と開始位置 o を総当たりし、その位置のプロファイルの合計が
   * 最大になる組を選ぶ。線が1本かすれていても他で取り返せる。
   */
  function findComb(prof, n, opts) {
    opts = opts || {};
    const minSpacing = Math.max(4, opts.minSpacing || Math.floor(n / 60));
    const maxSpacing = opts.maxSpacing || Math.floor(n / (LINES - 1));
    let best = { score: -1, offset: 0, spacing: 0 };

    for (let s = minSpacing; s <= maxSpacing; s++) {
      const span = s * (LINES - 1);
      if (span >= n) break;
      for (let o = 0; o + span < n; o++) {
        let sum = 0;
        for (let k = 0; k < LINES; k++) {
          const x = o + k * s;
          // 線が1画素ずれていても拾えるように、前後1画素の最大を取る
          const a = prof[x] || 0;
          const b = prof[x - 1] || 0;
          const c = prof[x + 1] || 0;
          sum += Math.max(a, b, c);
        }
        // 同じ得点なら間隔の大きい (= 盤が大きい) ほうを選ぶ
        if (sum > best.score || (sum === best.score && s > best.spacing)) {
          best = { score: sum, offset: o, spacing: s };
        }
      }
    }
    return best;
  }

  /**
   * 盤の格子を見つける。返り値は左上の座標と1マスの大きさ。
   * 縦と横で間隔が食い違うときは、得点の高いほうに合わせて正方形に均す。
   */
  function detectGrid(image, opts) {
    const { width: w, height: h } = image;
    const gray = opts && opts.gray ? opts.gray : toGray(image);
    const vx = findComb(lineProfile(gray, w, h, 'x'), w, opts);
    const vy = findComb(lineProfile(gray, w, h, 'y'), h, opts);

    // マスは正方形のはず。間隔が大きく違えば、確からしいほうを採る
    let spacing = (vx.spacing + vy.spacing) / 2;
    const gap = Math.abs(vx.spacing - vy.spacing) / Math.max(vx.spacing, vy.spacing);
    if (gap > 0.12) spacing = vx.score >= vy.score ? vx.spacing : vy.spacing;

    return {
      x0: vx.offset,
      y0: vy.offset,
      cell: spacing,
      cellX: vx.spacing,
      cellY: vy.spacing,
      scoreX: vx.score,
      scoreY: vy.score,
      squareness: 1 - gap
    };
  }

  // ---- マスの切り出しと正規化 ----------------------------------------------

  /** 画像から矩形を切り出してグレースケールの小さな配列にする。 */
  function cropGray(gray, w, h, x, y, cw, ch) {
    const out = new Float32Array(cw * ch);
    for (let j = 0; j < ch; j++) {
      const sy = Math.min(h - 1, Math.max(0, y + j));
      for (let i = 0; i < cw; i++) {
        const sx = Math.min(w - 1, Math.max(0, x + i));
        out[j * cw + i] = gray[sy * w + sx];
      }
    }
    return out;
  }

  /** 大津の方法で明暗を分ける閾値を求める。 */
  function otsu(values) {
    const hist = new Float64Array(256);
    for (let i = 0; i < values.length; i++) hist[Math.max(0, Math.min(255, values[i] | 0))]++;
    const total = values.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, bestVar = -1;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > bestVar) { bestVar = between; best = t; }
    }
    return best;
  }

  /** 明るさの分位点を返す (0..1)。外れ値に強い代表値がほしいときに使う。 */
  function percentile(values, q) {
    const sorted = Float32Array.from(values).sort();
    const i = Math.round(q * (sorted.length - 1));
    return sorted[Math.max(0, Math.min(sorted.length - 1, i))];
  }

  /**
   * マスの縁につながったインクを消す。
   * 字はマスの真ん中に浮いているが、駒札の縁・盤の格子線・影は必ず縁に届く。
   * これを消すだけで「枠ごと字と見なして形が潰れる」失敗がなくなる。
   */
  function dropBorderTouching(mask, cw, ch) {
    const out = Uint8Array.from(mask);
    const stack = [];
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= cw || y >= ch) return;
      const p = y * cw + x;
      if (out[p]) { out[p] = 0; stack.push(p); }
    };
    for (let x = 0; x < cw; x++) { push(x, 0); push(x, ch - 1); }
    for (let y = 0; y < ch; y++) { push(0, y); push(cw - 1, y); }
    while (stack.length) {
      const p = stack.pop();
      const x = p % cw, y = (p / cw) | 0;
      push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
    }
    return out;
  }

  /** 型の面積・囲み枠・詰まり具合を測る。 */
  function maskStats(mask, cw, ch) {
    let ink = 0, minX = cw, minY = ch, maxX = -1, maxY = -1;
    for (let j = 0; j < ch; j++) {
      for (let i = 0; i < cw; i++) {
        if (!mask[j * cw + i]) continue;
        ink++;
        if (i < minX) minX = i;
        if (i > maxX) maxX = i;
        if (j < minY) minY = j;
        if (j > maxY) maxY = j;
      }
    }
    if (maxX < minX) return null;
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    return {
      ink, minX, minY, maxX, maxY, bw, bh,
      fraction: ink / (cw * ch),
      density: ink / (bw * bh)          // 枠の中がどれだけ埋まっているか
    };
  }

  /**
   * マスの中から「字のインク」を取り出し、字の周りを切り詰めて
   * NORM x NORM に伸ばした白黒の型にする。
   * 字が見当たらなければ null (空きマス)。
   *
   * 閾値は1つに決め打ちせず何通りか試す。駒札の地・盤の地・字の3色が
   * 混ざるマスでは、大津の方法が「字」ではなく「札と盤」の境で切れて
   * しまうことがあるため。
   */
  function inkMaskOf(cellGray, cw, ch) {
    const dark = percentile(cellGray, 0.02);
    const bright = percentile(cellGray, 0.80);
    const spread = bright - dark;
    if (spread < 35) return null;                 // のっぺりしている = 空きマス

    const candidates = [otsu(cellGray), dark + spread * 0.28, dark + spread * 0.45];
    let best = null;
    for (const th of candidates) {
      const raw = new Uint8Array(cw * ch);
      for (let i = 0; i < raw.length; i++) if (cellGray[i] <= th) raw[i] = 1;
      const mask = dropBorderTouching(raw, cw, ch);
      const st = maskStats(mask, cw, ch);
      if (!st) continue;
      if (st.fraction < 0.015 || st.fraction > 0.45) continue;
      if (st.bw > cw * 0.96 || st.bh > ch * 0.96) continue;
      // 枠だけ (輪郭のような形) は density が低い。字らしいものを選ぶ
      if (!best || st.density > best.st.density) best = { th, mask, st };
    }
    if (!best) return null;

    const st = best.st;
    return {
      mask: normalizeBox(best.mask, cw, st.minX, st.minY, st.maxX, st.maxY),
      inkFraction: st.fraction,
      density: st.density,
      contrast: spread
    };
  }

  /** 字を囲む枠を切り出し、縦横の比を保ったまま NORM x NORM の真ん中に置く。 */
  function normalizeBox(mask, cw, minX, minY, maxX, maxY) {
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const scale = Math.min(NORM / bw, NORM / bh);
    const dw = Math.max(1, Math.round(bw * scale));
    const dh = Math.max(1, Math.round(bh * scale));
    const ox = ((NORM - dw) / 2) | 0;
    const oy = ((NORM - dh) / 2) | 0;
    const out = new Uint8Array(NORM * NORM);
    for (let j = 0; j < dh; j++) {
      const sy = minY + Math.min(bh - 1, Math.floor(j / scale));
      for (let i = 0; i < dw; i++) {
        const sx = minX + Math.min(bw - 1, Math.floor(i / scale));
        out[(oy + j) * NORM + (ox + i)] = mask[sy * cw + sx];
      }
    }
    return out;
  }

  /** 型を180度回す。 */
  function rotate180(mask) {
    const out = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) out[i] = mask[mask.length - 1 - i];
    return out;
  }

  /**
   * 2つの型の近さ。共通部分 / 合わせた面積 (Jaccard)。
   * 縦横に1画素ずらした中で一番良い値を採り、少しの位置ずれを許す。
   */
  function similarity(a, b) {
    let best = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        let inter = 0, union = 0;
        for (let j = 0; j < NORM; j++) {
          const sj = j + dy;
          for (let i = 0; i < NORM; i++) {
            const si = i + dx;
            const av = a[j * NORM + i];
            const bv = (si >= 0 && si < NORM && sj >= 0 && sj < NORM) ? b[sj * NORM + si] : 0;
            if (av || bv) union++;
            if (av && bv) inter++;
          }
        }
        if (union > 0) best = Math.max(best, inter / union);
      }
    }
    return best;
  }

  /** 並びの中央値。 */
  function median(values) {
    const a = Float32Array.from(values).sort();
    return a[(a.length / 2) | 0];
  }

  /**
   * 駒札の向きを、五角形の形から見分ける。
   *
   * 将棋の駒は相手のほうへ尖っている。字は「王」のように180度回しても
   * ほとんど同じ形のものがあり、字だけでは向きを決められない。札の形なら
   * どの駒でも同じ理屈で決まるので、こちらを先に使う。
   *
   * @returns {number} 1=上向き(攻め), -1=下向き(守り), 0=分からない
   */
  function komaDirection(cellGray, cw, ch) {
    // 盤の格子線はマスのふちを通る。線を札と見間違えないよう、少し内側だけ見る
    const m = Math.max(1, Math.round(Math.min(cw, ch) * 0.07));
    const x1 = m, x2 = cw - m, y1 = m, y2 = ch - m;
    const iw = x2 - x1, ih = y2 - y1;
    if (iw < 6 || ih < 6) return 0;

    // 盤の地の明るさ。四隅は札の外側なので、そこから拾う
    const s = Math.max(2, Math.round(Math.min(iw, ih) * 0.14));
    const corners = [];
    for (const [ox, oy] of [[x1, y1], [x2 - s, y1], [x1, y2 - s], [x2 - s, y2 - s]]) {
      for (let y = oy; y < oy + s; y++) {
        for (let x = ox; x < ox + s; x++) corners.push(cellGray[y * cw + x]);
      }
    }
    const bg = median(corners);

    // 札らしい画素 = 盤の地とはっきり違う明るさのところ (字も札の内側なので含める)
    const spread = percentile(cellGray, 0.98) - percentile(cellGray, 0.02);
    const tol = Math.max(12, spread * 0.15);
    const rowWidth = new Float32Array(ih);
    let total = 0;
    for (let y = 0; y < ih; y++) {
      let n = 0;
      for (let x = 0; x < iw; x++) {
        if (Math.abs(cellGray[(y1 + y) * cw + (x1 + x)] - bg) > tol) n++;
      }
      rowWidth[y] = n;
      total += n;
    }
    const fill = total / (iw * ih);
    // 札を描かず字だけを置く盤 (このアプリ自身がそう) では、ここが小さくなる。
    // その場合は札の形では決められないので「分からない」を返し、字の向きに任せる
    if (fill < 0.28 || fill > 0.95) return 0;

    const band = Math.max(1, Math.round(ih * 0.22));
    let top = 0, bottom = 0;
    for (let y = 0; y < band; y++) top += rowWidth[y];
    for (let y = ih - band; y < ih; y++) bottom += rowWidth[y];
    top /= band;
    bottom /= band;
    if (top <= 0 && bottom <= 0) return 0;

    const diff = (bottom - top) / Math.max(top, bottom);
    if (Math.abs(diff) < 0.12) return 0;          // どちらとも言えない
    return diff > 0 ? 1 : -1;                     // 上が細ければ上向き
  }

  // ---- 照合 ---------------------------------------------------------------

  /**
   * 1マスの型を手本と突き合わせる。
   * templates は [{ code: '+S', mask: Uint8Array, upright: Uint8Array... }] 形式で
   * app.js 側が作る。ここでは mask (正立) だけ受け取り、回転はここで作る。
   */
  /**
   * 1マスの型を手本と突き合わせて、どの駒かを決める。
   *
   * margin は「一番あてはまる駒」と「それとは別の駒のうち一番あてはまるもの」の差。
   * 同じ駒の手本を書体ちがいで何枚も持っているので、単純な2番手と比べると
   * 常に差が0になってしまう。別の駒と比べて初めて「迷っているか」が分かる。
   */
  function classify(cellMask, templates, forcedFlip) {
    let best = { code: null, score: -1, flipped: false, up: 0, down: 0 };
    let bestOther = -1;
    for (const t of templates) {
      const rotated = t.rotated || (t.rotated = rotate180(t.mask));
      let up = -1, down = -1;
      if (forcedFlip !== true) up = similarity(cellMask, t.mask);
      if (forcedFlip !== false) down = similarity(cellMask, rotated);
      const flipped = down > up;
      const score = Math.max(up, down);
      if (score > best.score) {
        if (best.code !== null && best.code !== t.code) bestOther = Math.max(bestOther, best.score);
        best = { code: t.code, score, flipped, up, down };
      } else if (t.code !== best.code) {
        bestOther = Math.max(bestOther, score);
      }
    }
    best.margin = bestOther < 0 ? best.score : best.score - bestOther;
    // 正立と逆さの差。小さいと向きに自信がない
    best.orientationMargin = Math.abs(best.up - best.down);
    return best;
  }

  /**
   * 画像から盤面を読み取る。
   *
   * @param {{width,height,data}} image
   * @param {Array} templates  app.js が作る駒の字の手本
   * @param {object} [opts]    grid を渡すと格子検出を省ける
   * @returns {{board: (string|null)[], grid, cells}} board は 81 マスの駒コード
   */
  function recognizeBoard(image, templates, opts) {
    opts = opts || {};
    const { width: w, height: h } = image;
    const gray = toGray(image);
    const grid = opts.grid || detectGrid(image, { gray });

    const board = new Array(81).fill(null);
    const cells = new Array(81).fill(null);
    const inset = Math.max(1, Math.round(grid.cell * 0.10));   // 格子線を巻き込まない

    for (let r = 0; r < 9; r++) {
      for (let f = 0; f < 9; f++) {
        // マス全体 (駒札の向きを見るのに、盤の地まで入っていてほしい)
        const fx = Math.round(grid.x0 + f * grid.cellX);
        const fy = Math.round(grid.y0 + r * grid.cellY);
        const fw = Math.max(4, Math.round(grid.cellX));
        const fh = Math.max(4, Math.round(grid.cellY));
        const fullGray = cropGray(gray, w, h, fx, fy, fw, fh);

        // 字を読むのは内側だけ (格子線を巻き込まないように)
        const cw = Math.max(4, fw - inset * 2);
        const ch = Math.max(4, fh - inset * 2);
        const cellGray = cropGray(gray, w, h, fx + inset, fy + inset, cw, ch);
        const ink = inkMaskOf(cellGray, cw, ch);

        // 画面の左上が9筋一段目。board の並び (SFEN と同じ) に直す
        const file = 9 - f;
        const rank = r + 1;
        const idx = (rank - 1) * 9 + (file - 1);

        if (!ink) { cells[idx] = { empty: true }; continue; }

        // 札の形から向きが決まるなら、その向きに限って字を読む。
        // 「王」のように180度回してもほぼ同じ字でも、これなら間違えない。
        const dir = komaDirection(fullGray, fw, fh);
        const forced = dir === 0 ? undefined : (dir < 0);
        const hit = classify(ink.mask, templates, forced);

        // 札の形で向きが決まったならそれを信じる。字だけで決めたときは、
        // 正立と逆さの差が小さいほど向きに自信がない
        const orientationSure = dir !== 0 || hit.orientationMargin >= 0.05;

        cells[idx] = {
          empty: false,
          score: hit.score,
          margin: hit.margin,
          orientationMargin: hit.orientationMargin,
          orientationSure,
          inkFraction: ink.inkFraction,
          density: ink.density,
          contrast: ink.contrast,
          code: hit.code,
          flipped: hit.flipped,
          direction: dir
        };
        if (hit.code && hit.score >= (opts.minScore || 0.45)) {
          // 逆さに写っていた = 後手 (玉方) の駒
          board[idx] = hit.flipped ? toGote(hit.code) : hit.code;
        }
      }
    }
    return { board, grid, cells };
  }

  /** 'S' や '+S' を後手の駒コードにする。 */
  function toGote(code) {
    return code[0] === '+' ? '+' + code[1].toLowerCase() : code.toLowerCase();
  }

  return {
    NORM, LINES,
    toGray, lineProfile, findComb, detectGrid,
    cropGray, otsu, percentile, median, dropBorderTouching, maskStats,
    inkMaskOf, normalizeBox, rotate180, similarity, komaDirection,
    classify, recognizeBoard, toGote
  };
});
