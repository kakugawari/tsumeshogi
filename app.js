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
    btnExportSfen: document.getElementById('btnExportSfen')
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
    pick: null,      // { type: 'P', from: 'w' | 'b' | 'box' } — いま持っている駒
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
      const piece = state.pos.board[C.idx(file, rank)];
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

  function onCellClick(ev) {
    const file = Number(ev.currentTarget.dataset.file);
    const rank = Number(ev.currentTarget.dataset.rank);
    const i = C.idx(file, rank);
    const piece = state.pos.board[i];

    if (state.erasing) {
      if (!piece) return;
      returnToStand(piece);
      state.pos.board[i] = null;
    } else if (piece) {
      state.pos.board[i] = cyclePiece(piece);
    } else if (state.pick) {
      if (!takeFromSource(state.pick)) return;   // 駒台に在庫が無ければ何もしない
      state.pos.board[i] = state.pick.type;      // まずは攻め (先手・不成) で置く
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

  // ---- SFEN ---------------------------------------------------------------

  function loadSfen() {
    try {
      state.pos = C.parseSfen(els.sfenText.value);
      state.pick = null;
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
    state.erasing = false;
    els.turnSelect.value = state.pos.turn;
    renderAll();
    clearResult();
  }

  function resetBoard() {
    state.pos = initialPosition();
    state.pos.turn = els.turnSelect.value;
    state.pick = null;
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
      state.pick = (state.pick && state.pick.type === 'K') ? null : { type: 'K', from: 'box' };
      renderAll();
    });
    els.toolErase.addEventListener('click', () => {
      state.erasing = !state.erasing;
      if (state.erasing) state.pick = null;
      renderAll();
    });

    els.btnCheck.addEventListener('click', startCheck);
    els.btnCancel.addEventListener('click', cancelCheck);
    els.btnClear.addEventListener('click', resetBoard);
    els.btnSample.addEventListener('click', loadSample);
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
      exportSfen
    };
  }

  main();
})();
