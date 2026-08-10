/*!
 * app.js — 画面まわり。盤の編集・持ち駒の編集・詰みチェックの呼び出し。
 */
(function () {
  'use strict';

  const C = window.Core;
  const PALETTE_TYPES = ['P', 'L', 'N', 'S', 'G', 'B', 'R', 'K'];
  const HAND_ORDER = ['P', 'L', 'N', 'S', 'G', 'B', 'R'];
  const NAMES = { P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉' };

  const els = {
    board: document.getElementById('board'),
    fileLabels: document.getElementById('fileLabels'),
    rankLabels: document.getElementById('rankLabels'),
    handWhitePieces: document.getElementById('handWhitePieces'),
    handBlackPieces: document.getElementById('handBlackPieces'),
    paletteWhite: document.getElementById('paletteWhite'),
    paletteBlack: document.getElementById('paletteBlack'),
    toolErase: document.getElementById('toolErase'),
    promoteToggle: document.getElementById('promoteToggle'),
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

  const state = {
    pos: C.emptyState(),
    tool: null, // { color, type, promote } | 'erase' | null
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
    const cells = els.board.children;
    for (const cell of cells) {
      const file = Number(cell.dataset.file);
      const rank = Number(cell.dataset.rank);
      const piece = state.pos.board[C.idx(file, rank)];
      cell.innerHTML = '';
      if (piece) {
        const span = document.createElement('span');
        const color = C.colorOf(piece);
        const promoted = C.isPromoted(piece);
        span.className = 'piece' + (color === 'w' ? ' gote' : '') + (promoted ? ' promoted' : '');
        span.textContent = C.pieceDisplayName(piece);
        cell.appendChild(span);
      }
    }
  }

  function onCellClick(ev) {
    const file = Number(ev.currentTarget.dataset.file);
    const rank = Number(ev.currentTarget.dataset.rank);
    const i = C.idx(file, rank);
    if (state.tool === 'erase') {
      state.pos.board[i] = null;
    } else if (state.tool) {
      const t = state.tool;
      let code = t.type;
      if (t.type !== 'K' && t.promote) code = '+' + t.type;
      if (t.color === 'w') code = code.toLowerCase();
      state.pos.board[i] = state.pos.board[i] === code ? null : code;
    } else {
      return;
    }
    renderBoard();
    clearResult();
  }

  // ---- 持ち駒 -------------------------------------------------------------

  function renderHands() {
    renderHandSide('b', els.handBlackPieces);
    renderHandSide('w', els.handWhitePieces);
  }

  function renderHandSide(color, container) {
    container.innerHTML = '';
    for (const t of HAND_ORDER) {
      const wrap = document.createElement('span');
      wrap.className = 'hand-piece';

      const minus = document.createElement('button');
      minus.type = 'button';
      minus.textContent = '−';
      minus.setAttribute('aria-label', NAMES[t] + 'を減らす');
      minus.addEventListener('click', () => {
        state.pos.hands[color][t] = Math.max(0, (state.pos.hands[color][t] || 0) - 1);
        renderHands();
        clearResult();
      });

      const label = document.createElement('span');
      label.textContent = NAMES[t];

      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(state.pos.hands[color][t] || 0);

      const plus = document.createElement('button');
      plus.type = 'button';
      plus.textContent = '＋';
      plus.setAttribute('aria-label', NAMES[t] + 'を増やす');
      plus.addEventListener('click', () => {
        state.pos.hands[color][t] = Math.min(18, (state.pos.hands[color][t] || 0) + 1);
        renderHands();
        clearResult();
      });

      wrap.appendChild(minus);
      wrap.appendChild(label);
      wrap.appendChild(count);
      wrap.appendChild(plus);
      container.appendChild(wrap);
    }
  }

  // ---- パレット -----------------------------------------------------------

  function buildPalette() {
    buildPaletteRow(els.paletteBlack, 'b');
    buildPaletteRow(els.paletteWhite, 'w');
    els.toolErase.addEventListener('click', () => {
      state.tool = state.tool === 'erase' ? null : 'erase';
      refreshPaletteSelection();
    });
    els.promoteToggle.addEventListener('change', () => {
      if (state.tool && state.tool !== 'erase') state.tool.promote = els.promoteToggle.checked;
    });
  }

  function buildPaletteRow(container, color) {
    container.innerHTML = '';
    for (const t of PALETTE_TYPES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'palette-piece';
      btn.dataset.color = color;
      btn.dataset.type = t;
      btn.textContent = NAMES[t];
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => {
        state.tool = { color, type: t, promote: t !== 'K' && els.promoteToggle.checked };
        refreshPaletteSelection();
      });
      container.appendChild(btn);
    }
  }

  function refreshPaletteSelection() {
    const buttons = els.paletteBlack.querySelectorAll('.palette-piece').length
      ? [...els.paletteBlack.children, ...els.paletteWhite.children] : [];
    for (const btn of buttons) {
      const match = state.tool && state.tool !== 'erase' &&
        state.tool.color === btn.dataset.color && state.tool.type === btn.dataset.type;
      btn.setAttribute('aria-pressed', match ? 'true' : 'false');
    }
    els.toolErase.setAttribute('aria-pressed', state.tool === 'erase' ? 'true' : 'false');
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

    const worker = ensureWorker();
    worker.postMessage({
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
      const lines = C.describePv(state.lastSnapshot, mate.pv);
      els.resultMoves.innerHTML = '';
      lines.forEach((line) => {
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
      els.resultHeadline.textContent = '玉が置かれていません';
    } else {
      els.resultHeadline.className = 'result-headline nomate';
      els.resultHeadline.textContent = '不詰み (詰みません)';
      els.resultNote.textContent = `調べた局面数: ${mate.nodes.toLocaleString('ja-JP')} (最大${41}手まで確認)`;
    }
  }

  // ---- SFEN ---------------------------------------------------------------

  function loadSfen() {
    try {
      const parsed = C.parseSfen(els.sfenText.value);
      state.pos = parsed;
      els.turnSelect.value = state.pos.turn;
      renderBoard();
      renderHands();
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

  // ---- サンプル・クリア -----------------------------------------------------

  const SAMPLES = [
    {
      name: '1手詰め',
      sfen: '8k/9/7G1/9/9/9/9/9/K8 b R 1'
    },
    {
      name: '3手詰め',
      sfen: '8k/9/6G2/9/9/9/9/9/K8 b LS 1'
    }
  ];
  let sampleIndex = 0;

  function loadSample() {
    const sample = SAMPLES[sampleIndex % SAMPLES.length];
    sampleIndex++;
    state.pos = C.parseSfen(sample.sfen);
    els.turnSelect.value = state.pos.turn;
    renderBoard();
    renderHands();
    clearResult();
  }

  function clearBoard() {
    state.pos = C.emptyState();
    state.pos.turn = els.turnSelect.value;
    renderBoard();
    renderHands();
    clearResult();
  }

  // ---- 起動 -----------------------------------------------------------------

  function main() {
    buildBoardSkeleton();
    buildPalette();
    renderBoard();
    renderHands();
    clearResult();

    els.btnCheck.addEventListener('click', startCheck);
    els.btnCancel.addEventListener('click', cancelCheck);
    els.btnClear.addEventListener('click', clearBoard);
    els.btnSample.addEventListener('click', loadSample);
    els.btnLoadSfen.addEventListener('click', loadSfen);
    els.btnExportSfen.addEventListener('click', exportSfen);
    els.turnSelect.addEventListener('change', clearResult);

    window.__app = {
      state: () => state,
      renderBoard,
      renderHands,
      startCheck,
      loadSample,
      clearBoard,
      loadSfen,
      exportSfen
    };
  }

  main();
})();
