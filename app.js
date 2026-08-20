/*!
 * app.js — 画面まわり。盤の編集・駒台の編集・詰みチェックの呼び出し。
 *
 * 駒の置き方は「駒台の駒をタップして選ぶ → 盤 (または反対側の駒台) を
 * タップして置く」の1通りだけ。置いたあとの向き・成りは、盤の駒を
 * タップして 攻め → 守り → 成った攻め → 成った守り と回して決める。
 * 駒台がそのまま駒の置き場になっているので、別に駒パレットを持たない。
 */
(function () {
  'use strict';

  const C = window.Core;
  const R = window.Recognize;

  // 駒台に並べる順 (強い駒から。SFEN の持ち駒の並びと同じ)
  const STAND_ORDER = ['R', 'B', 'G', 'S', 'N', 'L', 'P'];
  const NAMES = { P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉' };

  // 将棋の駒一式 (玉を除く38枚)。詰将棋の決めごとどおり、盤に出していない駒は
  // すべて玉方の持ち駒として扱うので、最初はぜんぶ玉方の駒台に入れておく。
  const STANDARD_SET = { P: 18, L: 4, N: 4, S: 4, G: 4, B: 2, R: 2 };

  const els = {
    board: document.getElementById('board'),
    fileLabels: document.getElementById('fileLabels'),
    rankLabels: document.getElementById('rankLabels'),
    standWhiteLabel: document.getElementById('standWhiteLabel'),
    standBlackLabel: document.getElementById('standBlackLabel'),
    standWhiteChips: document.getElementById('standWhiteChips'),
    standBlackChips: document.getElementById('standBlackChips'),
    pickStatus: document.getElementById('pickStatus'),
    boxKing: document.getElementById('boxKing'),
    toolErase: document.getElementById('toolErase'),
    turnSelect: document.getElementById('turnSelect'),
    btnCheck: document.getElementById('btnCheck'),
    btnCancel: document.getElementById('btnCancel'),
    btnClear: document.getElementById('btnClear'),
    btnSample: document.getElementById('btnSample'),
    resultHeadline: document.getElementById('resultHeadline'),
    resultWarnings: document.getElementById('resultWarnings'),
    resultMoves: document.getElementById('resultMoves'),
    resultNote: document.getElementById('resultNote'),
    sfenText: document.getElementById('sfenText'),
    btnLoadSfen: document.getElementById('btnLoadSfen'),
    btnExportSfen: document.getElementById('btnExportSfen'),
    btnHelp: document.getElementById('btnHelp'),
    btnImage: document.getElementById('btnImage'),
    helpPanel: document.getElementById('helpPanel'),
    imageSection: document.getElementById('imageSection'),
    btnPickImage: document.getElementById('btnPickImage'),
    imageInput: document.getElementById('imageInput'),
    dropZone: document.getElementById('dropZone'),
    imagePreviewWrap: document.getElementById('imagePreviewWrap'),
    imagePreview: document.getElementById('imagePreview'),
    imageNote: document.getElementById('imageNote')
  };

  /** 最初の局面: 玉方の玉を5一に置き、残りの駒はすべて玉方の駒台へ。 */
  function initialPosition() {
    const pos = C.emptyState();
    Object.assign(pos.hands.w, STANDARD_SET);
    pos.board[C.idx(5, 1)] = 'k';
    pos.turn = 'b';
    return pos;
  }

  const state = {
    pos: initialPosition(),
    pick: null,      // { type: 'P', from: 'w' | 'b' | 'box' } — 駒台から持っている駒
    selected: null,  // 盤で選んでいるマスの番号 (動かす元 / 回す対象)
    erasing: false,
    solving: false,
    worker: null,
    requestId: 0,
    lastSnapshot: null
  };

  const KANJI_NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

  // ---- 盤 ---------------------------------------------------------------

  function buildBoardSkeleton() {
    els.fileLabels.innerHTML = '';
    for (let file = 9; file >= 1; file--) {
      const span = document.createElement('span');
      span.textContent = String(file);
      els.fileLabels.appendChild(span);
    }
    els.rankLabels.innerHTML = '';
    for (let rank = 1; rank <= 9; rank++) {
      const span = document.createElement('span');
      span.textContent = KANJI_NUM[rank];
      els.rankLabels.appendChild(span);
    }
    els.board.innerHTML = '';
    for (let rank = 1; rank <= 9; rank++) {
      for (let file = 9; file >= 1; file--) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'cell';
        cell.dataset.file = String(file);
        cell.dataset.rank = String(rank);
        cell.setAttribute('aria-label', `${file}${KANJI_NUM[rank]}`);
        cell.addEventListener('click', onCellClick);
        els.board.appendChild(cell);
      }
    }
  }

  function renderBoard() {
    for (const cell of els.board.children) {
      const file = Number(cell.dataset.file);
      const rank = Number(cell.dataset.rank);
      const i = C.idx(file, rank);
      const piece = state.pos.board[i];
      cell.classList.toggle('selected', state.selected === i);
      cell.innerHTML = '';
      if (piece) {
        const span = document.createElement('span');
        const color = C.colorOf(piece);
        span.className = 'piece' + (color === 'w' ? ' gote' : '') +
          (C.isPromoted(piece) ? ' promoted' : '');
        span.textContent = C.pieceDisplayName(piece);
        cell.appendChild(span);
      }
    }
  }

  /**
   * 盤の駒を 攻め → 守り → 成った攻め → 成った守り → 攻め … と回す。
   * 金と玉は成れないので 攻め ↔ 守り の2つだけ。
   */
  function cyclePiece(piece) {
    const type = C.baseType(piece).toUpperCase();
    const promotable = type !== 'G' && type !== 'K';
    const order = promotable
      ? [type, type.toLowerCase(), '+' + type, '+' + type.toLowerCase()]
      : [type, type.toLowerCase()];
    return order[(order.indexOf(piece) + 1) % order.length];
  }

  /**
   * 盤のマスをタップしたとき。
   *
   *   駒のあるマス            → その駒を選ぶ
   *   選んでいる駒をもう一度   → 攻め → 守り → 成った攻め → 成った守り と回す
   *   選んだあと空いたマス     → そこへ動かす
   *   何も選んでいない空マス   → 駒台から持っている駒を置く
   */
  function onCellClick(ev) {
    const file = Number(ev.currentTarget.dataset.file);
    const rank = Number(ev.currentTarget.dataset.rank);
    const i = C.idx(file, rank);
    const piece = state.pos.board[i];

    if (state.erasing) {
      if (!piece) return;
      returnToStand(piece);
      state.pos.board[i] = null;
      state.selected = null;
    } else if (state.selected === i && piece) {
      state.pos.board[i] = cyclePiece(piece);          // 2回目以降のタップで回す
    } else if (state.selected !== null && !piece) {
      state.pos.board[i] = state.pos.board[state.selected];   // 空いたマスへ動かす
      state.pos.board[state.selected] = null;
      state.selected = i;
    } else if (piece) {
      state.selected = i;                              // 盤の駒を選ぶ
      state.pick = null;
    } else if (state.pick) {
      if (!takeFromSource(state.pick)) return;         // 駒台に在庫が無ければ何もしない
      state.pos.board[i] = state.pick.type;            // まずは攻め (先手・不成) で置く
      clearPickIfEmpty();
    } else {
      return;
    }
    renderAll();
    clearResult();
  }

  // ---- 駒台 ---------------------------------------------------------------

  /** 持っている駒を、その出どころから1枚減らす。減らせたら true。 */
  function takeFromSource(pick) {
    if (pick.from === 'box') return true;        // 玉は枚数を数えない
    const left = state.pos.hands[pick.from][pick.type] || 0;
    if (left <= 0) return false;
    state.pos.hands[pick.from][pick.type] = left - 1;
    return true;
  }

  /** 盤から取り除いた駒を玉方の駒台に戻す (詰将棋では余り駒は玉方のもの)。 */
  function returnToStand(piece) {
    const type = C.baseType(piece).toUpperCase();
    if (type === 'K') return;                    // 玉は駒台では数えない
    state.pos.hands.w[type] = Math.min(18, (state.pos.hands.w[type] || 0) + 1);
  }

  /** 在庫が尽きた駒を持ったままにしない。 */
  function clearPickIfEmpty() {
    const p = state.pick;
    if (!p || p.from === 'box') return;
    if ((state.pos.hands[p.from][p.type] || 0) <= 0) state.pick = null;
  }

  function standLabel(color) {
    const side = color === 'b' ? '先手' : '後手';
    return state.pos.turn === color
      ? `攻方 (${side}) の持ち駒`
      : `玉方 (${side}) の駒台 — 残りの駒`;
  }

  function renderStands() {
    els.standWhiteLabel.textContent = standLabel('w');
    els.standBlackLabel.textContent = standLabel('b');
    renderStandChips('w', els.standWhiteChips);
    renderStandChips('b', els.standBlackChips);
  }

  function renderStandChips(color, container) {
    container.innerHTML = '';
    let any = false;
    for (const t of STAND_ORDER) {
      const n = state.pos.hands[color][t] || 0;
      if (n <= 0) continue;
      any = true;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.color = color;
      chip.dataset.type = t;
      const picked = !!state.pick && state.pick.from === color && state.pick.type === t;
      chip.setAttribute('aria-pressed', picked ? 'true' : 'false');
      chip.setAttribute('aria-label', `${NAMES[t]} ${n}枚`);

      const label = document.createElement('span');
      label.textContent = NAMES[t];
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(n);
      chip.appendChild(label);
      chip.appendChild(count);

      chip.addEventListener('click', () => {
        state.erasing = false;
        state.selected = null;
        state.pick = picked ? null : { type: t, from: color };
        renderAll();
      });
      container.appendChild(chip);
    }
    if (!any) {
      const empty = document.createElement('span');
      empty.className = 'stand-empty';
      empty.textContent = 'なし';
      container.appendChild(empty);
    }

    // 反対側の駒台へ渡すための置き場。持っていないときは押せない状態で出しておく
    // (出したり消したりすると駒台の高さが変わり、盤がずれてしまうため)。
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'stand-drop';
    drop.dataset.color = color;
    const canDrop = !!state.pick && state.pick.type !== 'K' && state.pick.from !== color;
    drop.disabled = !canDrop;
    drop.textContent = canDrop ? `${NAMES[state.pick.type]}をここへ` : 'ここへ置く';
    drop.addEventListener('click', () => {
      if (!canDrop) return;
      if (!takeFromSource(state.pick)) return;
      const t = state.pick.type;
      state.pos.hands[color][t] = Math.min(18, (state.pos.hands[color][t] || 0) + 1);
      state.pick = { type: t, from: color };   // 置いた先から続けて持ち直す
      renderAll();
      clearResult();
    });
    container.appendChild(drop);
  }

  function renderTools() {
    const kingPicked = !!state.pick && state.pick.type === 'K';
    els.boxKing.setAttribute('aria-pressed', kingPicked ? 'true' : 'false');
    els.toolErase.setAttribute('aria-pressed', state.erasing ? 'true' : 'false');

    if (state.erasing) {
      els.pickStatus.textContent = '「消す」を選んでいます。盤の駒をタップすると駒台に戻ります。';
    } else if (state.selected !== null) {
      const piece = state.pos.board[state.selected];
      const where = `${C.fileOf(state.selected)}${KANJI_NUM[C.rankOf(state.selected)]}`;
      els.pickStatus.textContent = piece
        ? `${where}の「${C.pieceDisplayName(piece)}」を選んでいます。空いたマスをタップで移動、もう一度タップで向きが変わります。`
        : '駒台の駒をタップして選び、盤をタップすると置けます。';
    } else if (state.pick) {
      els.pickStatus.textContent =
        `「${NAMES[state.pick.type]}」を持っています。盤をタップすると置けます。`;
    } else {
      els.pickStatus.textContent = '駒台の駒をタップして選び、盤をタップすると置けます。';
    }
  }

  function renderAll() {
    renderBoard();
    renderStands();
    renderTools();
  }

  // ---- 詰みチェック ---------------------------------------------------------

  function clearResult() {
    els.resultHeadline.className = 'result-headline';
    els.resultHeadline.textContent = '局面を作ってから「詰みチェック」を押す';
    els.resultWarnings.innerHTML = '';
    els.resultMoves.innerHTML = '';
    els.resultNote.textContent = '';
  }

  function ensureWorker() {
    if (!state.worker) {
      state.worker = new Worker('./solver-worker.js');
      state.worker.onmessage = onWorkerMessage;
      state.worker.onerror = (e) => {
        finishSolving();
        els.resultHeadline.className = 'result-headline nomate';
        els.resultHeadline.textContent = '探索でエラーが起きました: ' + e.message;
      };
    }
    return state.worker;
  }

  function startCheck() {
    state.pos.turn = els.turnSelect.value;
    const v = C.validatePosition(state.pos);
    els.resultWarnings.innerHTML = '';
    if (v.errors.length > 0) {
      els.resultHeadline.className = 'result-headline nomate';
      els.resultHeadline.textContent = '盤面が不完全です';
      for (const e of v.errors) {
        const li = document.createElement('li');
        li.textContent = e;
        els.resultWarnings.appendChild(li);
      }
      return;
    }
    for (const w of v.warnings) {
      const li = document.createElement('li');
      li.textContent = w;
      els.resultWarnings.appendChild(li);
    }

    state.lastSnapshot = C.cloneState(state.pos);
    state.requestId++;
    const myId = state.requestId;
    state.solving = true;
    els.btnCheck.disabled = true;
    els.btnCancel.hidden = false;
    els.resultHeadline.className = 'result-headline';
    els.resultHeadline.textContent = '考え中… (盤面が複雑だと時間がかかります)';
    els.resultMoves.innerHTML = '';
    els.resultNote.textContent = '';

    ensureWorker().postMessage({
      type: 'solve',
      requestId: myId,
      state: state.lastSnapshot,
      opts: { maxPlies: 41, nodeBudget: 2000000, altNodeBudget: 300000 }
    });
  }

  function finishSolving() {
    state.solving = false;
    els.btnCheck.disabled = false;
    els.btnCancel.hidden = true;
  }

  function cancelCheck() {
    if (state.worker) { state.worker.terminate(); state.worker = null; }
    finishSolving();
    els.resultHeadline.className = 'result-headline';
    els.resultHeadline.textContent = '中止しました';
  }

  function onWorkerMessage(ev) {
    const msg = ev.data;
    if (msg.type !== 'result' || msg.requestId !== state.requestId) return;
    finishSolving();
    const mate = msg.mate;
    if (mate.mate) {
      els.resultHeadline.className = 'result-headline mate';
      els.resultHeadline.textContent = `詰み — ${mate.plies}手詰め`;
      els.resultMoves.innerHTML = '';
      C.describePv(state.lastSnapshot, mate.pv).forEach((line) => {
        const li = document.createElement('li');
        li.textContent = line;
        els.resultMoves.appendChild(li);
      });
      if (msg.alternates && msg.alternates.length > 0) {
        const li = document.createElement('li');
        const attackerColor = state.lastSnapshot.turn;
        const squares = msg.alternates.map((m) => C.formatMove(m, attackerColor)).join(' / ');
        li.textContent = `同じ手数で詰む初手が他にもあります (余詰めの疑い): ${squares}`;
        els.resultWarnings.appendChild(li);
      }
      els.resultNote.textContent = `調べた局面数: ${mate.nodes.toLocaleString('ja-JP')}`;
    } else if (mate.aborted) {
      els.resultHeadline.className = 'result-headline nomate';
      els.resultHeadline.textContent = '手数が長すぎて調べきれませんでした';
      els.resultNote.textContent = `調べた局面数: ${mate.nodes.toLocaleString('ja-JP')} (打ち切り)`;
    } else if (mate.error === 'no-king') {
      els.resultHeadline.className = 'result-headline nomate';
      els.resultHeadline.textContent = '玉方の玉が置かれていません';
    } else {
      els.resultHeadline.className = 'result-headline nomate';
      els.resultHeadline.textContent = '不詰み (詰みません)';
      els.resultNote.textContent = `調べた局面数: ${mate.nodes.toLocaleString('ja-JP')} (最大41手まで確認)`;
    }
  }

  // ---- 画像から読み取る -------------------------------------------------------
  //
  // 手本の字はアプリ自身が持っている埋め込みフォントで描く。外から何も
  // 取ってこないので、Artifact でもオフラインでも同じように動く。

  const GLYPHS = [
    ['歩', 'P'], ['香', 'L'], ['桂', 'N'], ['銀', 'S'], ['金', 'G'], ['角', 'B'], ['飛', 'R'],
    ['玉', 'K'], ['王', 'K'],
    ['と', '+P'], ['杏', '+L'], ['圭', '+N'], ['全', '+S'], ['馬', '+B'], ['龍', '+R'], ['竜', '+R']
  ];
  // 相手のアプリがどの書体で描いているか分からないので、何通りかの手本を持つ
  const TEMPLATE_FONTS = [
    '"Koma", serif',
    '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif',
    '"Hiragino Kaku Gothic ProN", "Noto Sans JP", system-ui, sans-serif'
  ];

  let templatesCache = null;

  function buildTemplates() {
    if (templatesCache) return templatesCache;
    const size = 64;
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const out = [];
    for (const font of TEMPLATE_FONTS) {
      for (const [ch, code] of GLYPHS) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#000';
        ctx.font = `700 ${Math.round(size * 0.80)}px ${font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ch, size / 2, size / 2 + size * 0.02);
        const ink = R.inkMaskOf(R.toGray(ctx.getImageData(0, 0, size, size)), size, size);
        if (ink) out.push({ code, char: ch, font, mask: ink.mask });
      }
    }
    templatesCache = out;
    return out;
  }

  function loadImageBitmap(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('画像を読み込めませんでした'));
      if (typeof src === 'string') img.src = src;
      else img.src = URL.createObjectURL(src);
    });
  }

  /** 画像を canvas に描いて画素を取り出す。大きすぎるものは縮める。 */
  function imageDataOf(img, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  /** 見つけた格子を小さな絵にして出す。合っているか目で確かめてもらうため。 */
  function drawPreview(img, grid) {
    const cv = els.imagePreview;
    const maxW = 420;
    const scale = Math.min(1, maxW / img.naturalWidth);
    cv.width = Math.round(img.naturalWidth * scale);
    cv.height = Math.round(img.naturalHeight * scale);
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    if (!grid) return;
    const k = cv.width / grid.imageWidth;
    ctx.strokeStyle = '#e0628a';
    ctx.lineWidth = 1.5;
    for (let i = 0; i <= 9; i++) {
      const x = (grid.x0 + i * grid.cellX) * k;
      const y = (grid.y0 + i * grid.cellY) * k;
      ctx.beginPath();
      ctx.moveTo(x, grid.y0 * k);
      ctx.lineTo(x, (grid.y0 + 9 * grid.cellY) * k);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(grid.x0 * k, y);
      ctx.lineTo((grid.x0 + 9 * grid.cellX) * k, y);
      ctx.stroke();
    }
  }

  /**
   * 読み取った盤面を反映する。
   * 盤に出ていない駒は、詰将棋の決めごとどおり玉方の駒台に入れる。
   */
  function applyRecognized(board) {
    const pos = C.emptyState();
    for (let i = 0; i < 81; i++) pos.board[i] = board[i] || null;
    const used = { P: 0, L: 0, N: 0, S: 0, G: 0, B: 0, R: 0 };
    for (const p of pos.board) {
      if (!p) continue;
      const t = C.baseType(p).toUpperCase();
      if (t !== 'K') used[t]++;
    }
    for (const t of Object.keys(STANDARD_SET)) {
      pos.hands.w[t] = Math.max(0, STANDARD_SET[t] - used[t]);
    }
    pos.turn = els.turnSelect.value;
    state.pos = pos;
    state.pick = null;
    state.selected = null;
    state.erasing = false;
  }

  /** 読み取りに自信がないマスか。目で確かめてほしいところに印を出す。 */
  function isUnsure(c) {
    if (!c || c.empty) return false;
    return c.score < 0.60 || c.margin < 0.04 || !c.orientationSure;
  }

  function markUnsure(cells) {
    for (const cell of els.board.children) {
      const i = C.idx(Number(cell.dataset.file), Number(cell.dataset.rank));
      cell.classList.toggle('unsure', isUnsure(cells[i]));
    }
  }

  async function handleImage(src) {
    els.imageNote.textContent = '読み取っています…';
    els.imagePreviewWrap.hidden = false;
    try {
      const img = await loadImageBitmap(src);
      const data = imageDataOf(img, 1400);
      const grid = R.detectGrid(data);
      grid.imageWidth = data.width;

      const tooSmall = grid.cell < 12;
      const outside = grid.x0 + 9 * grid.cellX > data.width + 2 ||
        grid.y0 + 9 * grid.cellY > data.height + 2;
      if (tooSmall || outside || grid.squareness < 0.80) {
        drawPreview(img, null);
        els.imageNote.textContent =
          '盤の枠を見つけられませんでした。盤のまわりだけを切り取った画像だと読み取れることがあります。';
        return;
      }

      const result = R.recognizeBoard(data, buildTemplates(), { grid });
      applyRecognized(result.board);
      renderAll();
      markUnsure(result.cells);
      clearResult();
      drawPreview(img, grid);

      const found = result.board.filter(Boolean).length;
      const unsure = result.cells.filter(isUnsure).length;
      els.imageNote.textContent =
        `${found}枚の駒を読み取りました` +
        (unsure ? `（うち${unsure}枚は自信がありません。赤い点の付いたマスを確かめてください）` : '') +
        '。持ち駒は読み取らないので、攻方の持ち駒は駒台から渡してください。';
    } catch (e) {
      els.imageNote.textContent = '読み取れませんでした: ' + e.message;
    }
  }

  /**
   * 上のボタンで開け閉めする枠。普段は畳んでおいて、画面を短く保つ。
   * 開いたときはその枠まで送る (ボタンは上、枠は盤の下にあるため)。
   */
  function togglePanel(panel, button, force) {
    const open = force === undefined ? panel.hidden : force;
    panel.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    button.classList.toggle('btn-on', open);
    if (open) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function setupPanels() {
    els.btnHelp.addEventListener('click', () => togglePanel(els.helpPanel, els.btnHelp));
    els.btnImage.addEventListener('click', () => togglePanel(els.imageSection, els.btnImage));
  }

  function setupImageInput() {
    els.btnPickImage.addEventListener('click', () => els.imageInput.click());
    els.imageInput.addEventListener('change', () => {
      if (els.imageInput.files && els.imageInput.files[0]) handleImage(els.imageInput.files[0]);
    });

    const zone = els.dropZone;
    zone.addEventListener('click', () => els.imageInput.click());
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handleImage(file);
    });

    document.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.type && item.type.indexOf('image') === 0) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            togglePanel(els.imageSection, els.btnImage, true);   // 結果が見えるように開く
            handleImage(file);
          }
          return;
        }
      }
    });
  }

  // ---- SFEN ---------------------------------------------------------------

  function loadSfen() {
    try {
      state.pos = C.parseSfen(els.sfenText.value);
      state.pick = null;
      state.selected = null;
      state.erasing = false;
      els.turnSelect.value = state.pos.turn;
      renderAll();
      clearResult();
    } catch (e) {
      els.resultHeadline.className = 'result-headline nomate';
      els.resultHeadline.textContent = 'SFEN を読み取れませんでした: ' + e.message;
    }
  }

  function exportSfen() {
    state.pos.turn = els.turnSelect.value;
    els.sfenText.value = C.toSfen(state.pos);
  }

  // ---- サンプル・最初から ----------------------------------------------------

  // 攻方の玉は詰将棋の図面では省くのが普通なので、お試し局面にも置かない。
  const SAMPLES = [
    { name: '1手詰め', sfen: '8k/9/7G1/9/9/9/9/9/9 b R 1' },
    { name: '3手詰め', sfen: '8k/9/6G2/9/9/9/9/9/9 b LS 1' }
  ];
  let sampleIndex = 0;

  function loadSample() {
    const sample = SAMPLES[sampleIndex % SAMPLES.length];
    sampleIndex++;
    state.pos = C.parseSfen(sample.sfen);
    state.pick = null;
    state.selected = null;
    state.erasing = false;
    els.turnSelect.value = state.pos.turn;
    renderAll();
    clearResult();
  }

  function resetBoard() {
    state.pos = initialPosition();
    state.pos.turn = els.turnSelect.value;
    state.pick = null;
    state.selected = null;
    state.erasing = false;
    renderAll();
    clearResult();
  }

  // ---- 起動 -----------------------------------------------------------------

  function main() {
    buildBoardSkeleton();
    renderAll();
    clearResult();

    els.boxKing.addEventListener('click', () => {
      state.erasing = false;
      state.selected = null;
      state.pick = (state.pick && state.pick.type === 'K') ? null : { type: 'K', from: 'box' };
      renderAll();
    });
    els.toolErase.addEventListener('click', () => {
      state.erasing = !state.erasing;
      if (state.erasing) { state.pick = null; state.selected = null; }
      renderAll();
    });

    els.btnCheck.addEventListener('click', startCheck);
    els.btnCancel.addEventListener('click', cancelCheck);
    els.btnClear.addEventListener('click', resetBoard);
    els.btnSample.addEventListener('click', loadSample);
    setupPanels();
    setupImageInput();
    els.btnLoadSfen.addEventListener('click', loadSfen);
    els.btnExportSfen.addEventListener('click', exportSfen);
    els.turnSelect.addEventListener('change', () => {
      state.pos.turn = els.turnSelect.value;
      renderStands();          // 攻方・玉方の呼び名が入れ替わる
      clearResult();
    });

    // 自動テストから中身をのぞくための入口
    window.__app = {
      state: () => state,
      renderAll,
      renderBoard,
      renderStands,
      cyclePiece,
      startCheck,
      loadSample,
      resetBoard,
      loadSfen,
      exportSfen,
      handleImage,
      togglePanel: (which, open) => togglePanel(
        which === 'help' ? els.helpPanel : els.imageSection,
        which === 'help' ? els.btnHelp : els.btnImage, open),
      buildTemplates,
      applyRecognized
    };
  }

  main();
})();
