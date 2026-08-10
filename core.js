/*!
 * core.js — 将棋のルールと詰み探索。DOM を触らないので node でテストできる。
 *
 * 盤は 81 マスのフラット配列。file(筋) 1〜9, rank(段) 1〜9。
 * 先手 (b) は rank が減る方向に進む (1 段目が先手の成りゾーン)。
 * 後手 (w) は rank が増える方向に進む (9 段目が後手の成りゾーン)。
 * これは SFEN の並び順と一致する。
 *
 * 駒は 'P','L','N','S','G','B','R','K' (先手=大文字) / 小文字(後手)。
 * 成り駒は先頭に '+' を付ける ('+P' 「と」など)。王だけは成らない。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.Core = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FILES = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const HAND_TYPES = ['R', 'B', 'G', 'S', 'N', 'L', 'P'];
  const MAX_IN_SET = { P: 18, L: 4, N: 4, S: 4, G: 4, B: 2, R: 2, K: 1 };

  function idx(file, rank) { return (rank - 1) * 9 + (file - 1); }
  function fileOf(i) { return (i % 9) + 1; }
  function rankOf(i) { return Math.floor(i / 9) + 1; }
  function inBoard(file, rank) { return file >= 1 && file <= 9 && rank >= 1 && rank <= 9; }

  function otherColor(c) { return c === 'b' ? 'w' : 'b'; }

  function baseType(piece) { return piece[0] === '+' ? piece.slice(1) : piece; }
  function isPromoted(piece) { return piece[0] === '+'; }
  function colorOf(piece) {
    const letter = isPromoted(piece) ? piece[1] : piece[0];
    return letter === letter.toUpperCase() ? 'b' : 'w';
  }

  // ---- 状態 -----------------------------------------------------------

  function emptyState() {
    return {
      board: new Array(81).fill(null),
      hands: { b: { P: 0, L: 0, N: 0, S: 0, G: 0, B: 0, R: 0 }, w: { P: 0, L: 0, N: 0, S: 0, G: 0, B: 0, R: 0 } },
      turn: 'b'
    };
  }

  function cloneState(state) {
    return {
      board: state.board.slice(),
      hands: { b: Object.assign({}, state.hands.b), w: Object.assign({}, state.hands.w) },
      turn: state.turn
    };
  }

  // ---- SFEN -------------------------------------------------------------

  function parseSfen(sfen) {
    const parts = sfen.trim().split(/\s+/);
    const boardPart = parts[0];
    const turnPart = parts[1] || 'b';
    const handPart = parts[2] || '-';
    const state = emptyState();
    state.turn = turnPart === 'w' ? 'w' : 'b';

    const rows = boardPart.split('/');
    if (rows.length !== 9) throw new Error('SFEN の盤面は9段必要です');
    for (let r = 0; r < 9; r++) {
      const rank = r + 1;
      let file = 9;
      const row = rows[r];
      let i = 0;
      while (i < row.length) {
        const ch = row[i];
        if (/\d/.test(ch)) {
          let numStr = ch;
          if (i + 1 < row.length && /\d/.test(row[i + 1])) { numStr += row[i + 1]; i++; }
          file -= Number(numStr);
          i++;
          continue;
        }
        let piece;
        if (ch === '+') {
          piece = '+' + row[i + 1];
          i += 2;
        } else {
          piece = ch;
          i++;
        }
        state.board[idx(file, rank)] = piece;
        file -= 1;
      }
    }

    if (handPart !== '-') {
      let i = 0;
      while (i < handPart.length) {
        let numStr = '';
        while (i < handPart.length && /\d/.test(handPart[i])) { numStr += handPart[i]; i++; }
        const count = numStr === '' ? 1 : Number(numStr);
        const letter = handPart[i]; i++;
        const color = letter === letter.toUpperCase() ? 'b' : 'w';
        state.hands[color][letter.toUpperCase()] = count;
      }
    }
    return state;
  }

  function toSfen(state) {
    const rows = [];
    for (let rank = 1; rank <= 9; rank++) {
      let row = '';
      let empties = 0;
      for (let file = 9; file >= 1; file--) {
        const p = state.board[idx(file, rank)];
        if (!p) { empties++; continue; }
        if (empties > 0) { row += String(empties); empties = 0; }
        row += p;
      }
      if (empties > 0) row += String(empties);
      rows.push(row);
    }
    let hand = '';
    for (const color of ['b', 'w']) {
      for (const t of HAND_TYPES) {
        const n = state.hands[color][t] || 0;
        if (n <= 0) continue;
        const letter = color === 'b' ? t : t.toLowerCase();
        hand += (n > 1 ? String(n) : '') + letter;
      }
    }
    if (hand === '') hand = '-';
    return rows.join('/') + ' ' + state.turn + ' ' + hand + ' 1';
  }

  // ---- 移動生成のための方向テーブル --------------------------------------
  // すべて「先手が前」の向きで定義する。後手のときは rank の符号を反転する。

  const STEP_FORWARD_DEP = {
    P: [[0, -1]],
    S: [[0, -1], [-1, -1], [1, -1], [-1, 1], [1, 1]],
    G: [[0, -1], [-1, -1], [1, -1], [-1, 0], [1, 0], [0, 1]]
  };
  const KNIGHT_FORWARD_DEP = [[-1, -2], [1, -2]];
  const KING_STEPS = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [-1, 1], [1, -1], [1, 1]];
  const SLIDE_LANCE_DEP = [[0, -1]];
  const SLIDE_BISHOP = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const SLIDE_ROOK = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  const HORSE_EXTRA_STEPS = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  const DRAGON_EXTRA_STEPS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

  function goldLikeSteps(color) {
    const dep = STEP_FORWARD_DEP.G;
    return color === 'b' ? dep : dep.map(([df, dr]) => [df, -dr]);
  }

  /** そのマスの駒が「動ける」行き先 idx の一覧 (盤上の移動のみ、駒を打つ手は別)。 */
  function pieceTargets(state, fromIdx) {
    const piece = state.board[fromIdx];
    const color = colorOf(piece);
    const bt = baseType(piece).toUpperCase();
    const file = fileOf(fromIdx), rank = rankOf(fromIdx);
    const targets = [];

    function tryStep(df, dr) {
      const f = file + df, r = rank + dr;
      if (!inBoard(f, r)) return;
      const t = idx(f, r);
      const occ = state.board[t];
      if (!occ || colorOf(occ) !== color) targets.push(t);
    }
    function trySlide(df, dr) {
      let f = file + df, r = rank + dr;
      while (inBoard(f, r)) {
        const t = idx(f, r);
        const occ = state.board[t];
        if (!occ) { targets.push(t); f += df; r += dr; continue; }
        if (colorOf(occ) !== color) targets.push(t);
        break;
      }
    }

    if (isPromoted(piece)) {
      if (bt === 'B') { SLIDE_BISHOP.forEach(([df, dr]) => trySlide(df, dr)); HORSE_EXTRA_STEPS.forEach(([df, dr]) => tryStep(df, dr)); return targets; }
      if (bt === 'R') { SLIDE_ROOK.forEach(([df, dr]) => trySlide(df, dr)); DRAGON_EXTRA_STEPS.forEach(([df, dr]) => tryStep(df, dr)); return targets; }
      // +P,+L,+N,+S はすべて金と同じ動き
      goldLikeSteps(color).forEach(([df, dr]) => tryStep(df, dr));
      return targets;
    }

    switch (bt) {
      case 'P': {
        const dep = color === 'b' ? STEP_FORWARD_DEP.P : STEP_FORWARD_DEP.P.map(([df, dr]) => [df, -dr]);
        dep.forEach(([df, dr]) => tryStep(df, dr));
        break;
      }
      case 'S': {
        const dep = color === 'b' ? STEP_FORWARD_DEP.S : STEP_FORWARD_DEP.S.map(([df, dr]) => [df, -dr]);
        dep.forEach(([df, dr]) => tryStep(df, dr));
        break;
      }
      case 'G': goldLikeSteps(color).forEach(([df, dr]) => tryStep(df, dr)); break;
      case 'N': {
        const dep = color === 'b' ? KNIGHT_FORWARD_DEP : KNIGHT_FORWARD_DEP.map(([df, dr]) => [df, -dr]);
        dep.forEach(([df, dr]) => tryStep(df, dr));
        break;
      }
      case 'K': KING_STEPS.forEach(([df, dr]) => tryStep(df, dr)); break;
      case 'L': {
        const dep = color === 'b' ? SLIDE_LANCE_DEP : SLIDE_LANCE_DEP.map(([df, dr]) => [df, -dr]);
        dep.forEach(([df, dr]) => trySlide(df, dr));
        break;
      }
      case 'B': SLIDE_BISHOP.forEach(([df, dr]) => trySlide(df, dr)); break;
      case 'R': SLIDE_ROOK.forEach(([df, dr]) => trySlide(df, dr)); break;
      default: break;
    }
    return targets;
  }

  function promotionZone(color) { return color === 'b' ? [1, 2, 3] : [7, 8, 9]; }

  function canPromote(bt, color, fromRank, toRank) {
    if (bt === 'G' || bt === 'K') return false;
    const zone = promotionZone(color);
    return zone.indexOf(fromRank) >= 0 || zone.indexOf(toRank) >= 0;
  }

  function mustPromote(bt, color, toRank) {
    if (bt === 'P' || bt === 'L') return toRank === (color === 'b' ? 1 : 9);
    if (bt === 'N') return color === 'b' ? toRank <= 2 : toRank >= 8;
    return false;
  }

  function findKing(state, color) {
    const target = color === 'b' ? 'K' : 'k';
    return state.board.indexOf(target);
  }

  function isSquareAttacked(state, targetIdx, byColor) {
    for (let i = 0; i < 81; i++) {
      const p = state.board[i];
      if (!p || colorOf(p) !== byColor) continue;
      const targets = pieceTargets(state, i);
      if (targets.indexOf(targetIdx) >= 0) return true;
    }
    return false;
  }

  function isKingInCheck(state, color) {
    const k = findKing(state, color);
    if (k < 0) return false;
    return isSquareAttacked(state, k, otherColor(color));
  }

  // ---- 疑似合法手の生成 (王手放置チェック前) ------------------------------

  function pseudoLegalMoves(state, color) {
    const moves = [];
    for (let from = 0; from < 81; from++) {
      const piece = state.board[from];
      if (!piece || colorOf(piece) !== color) continue;
      const bt = baseType(piece).toUpperCase();
      const fromRank = rankOf(from);
      const promoted = isPromoted(piece);
      const targets = pieceTargets(state, from);
      for (const to of targets) {
        const toRank = rankOf(to);
        const capture = state.board[to];
        if (!promoted && canPromote(bt, color, fromRank, toRank)) {
          if (!mustPromote(bt, color, toRank)) {
            moves.push({ from, to, piece, promote: false, capture });
          }
          moves.push({ from, to, piece, promote: true, capture });
        } else {
          moves.push({ from, to, piece, promote: false, capture });
        }
      }
    }
    // 駒打ち
    const hand = state.hands[color];
    for (const t of HAND_TYPES) {
      if (!hand[t]) continue;
      for (let to = 0; to < 81; to++) {
        if (state.board[to]) continue;
        const toRank = rankOf(to);
        if ((t === 'P' || t === 'L') && toRank === (color === 'b' ? 1 : 9)) continue;
        if (t === 'N' && (color === 'b' ? toRank <= 2 : toRank >= 8)) continue;
        if (t === 'P') {
          // 二歩チェック: 同じ筋に不成の歩がすでにあるか
          const file = fileOf(to);
          let nifu = false;
          for (let r = 1; r <= 9; r++) {
            const p = state.board[idx(file, r)];
            if (p === (color === 'b' ? 'P' : 'p')) { nifu = true; break; }
          }
          if (nifu) continue;
        }
        moves.push({ from: null, to, piece: color === 'b' ? t : t.toLowerCase(), promote: false, capture: null, drop: t });
      }
    }
    return moves;
  }

  // ---- 手の適用/取り消し (探索用に破壊的、undo で戻す) --------------------

  function makeMove(state, move) {
    const undo = { move, prevTurn: state.turn };
    if (move.drop) {
      state.board[move.to] = move.piece;
      state.hands[state.turn][move.drop] -= 1;
    } else {
      undo.capturedPiece = state.board[move.to];
      state.board[move.from] = null;
      // baseType() は大文字/小文字 (= 色) をそのまま保つので、'+' を付けるだけでよい
      state.board[move.to] = move.promote ? '+' + baseType(move.piece) : move.piece;
      if (undo.capturedPiece) {
        const capColor = colorOf(undo.capturedPiece);
        const capType = baseType(undo.capturedPiece).toUpperCase();
        state.hands[otherColor(capColor)][capType] += 1;
      }
    }
    state.turn = otherColor(state.turn);
    return undo;
  }

  function unmakeMove(state, undo) {
    const move = undo.move;
    state.turn = undo.prevTurn;
    if (move.drop) {
      state.board[move.to] = null;
      state.hands[state.turn][move.drop] += 1;
    } else {
      state.board[move.from] = move.piece;
      state.board[move.to] = undo.capturedPiece || null;
      if (undo.capturedPiece) {
        const capColor = colorOf(undo.capturedPiece);
        const capType = baseType(undo.capturedPiece).toUpperCase();
        state.hands[otherColor(capColor)][capType] -= 1;
      }
    }
  }

  /** 完全合法手 (自玉が王手のままにならない・打ち歩詰めでない)。 */
  function legalMoves(state, color, opts) {
    opts = opts || {};
    const pseudo = pseudoLegalMoves(state, color);
    const result = [];
    for (const m of pseudo) {
      const undo = makeMove(state, m);
      let ok = !isKingInCheck(state, color);
      if (ok && !opts.skipUchifuzume && m.drop === 'P') {
        const opp = otherColor(color);
        if (isKingInCheck(state, opp) && !hasAnyLegalMove(state, opp)) ok = false;
      }
      unmakeMove(state, undo);
      if (ok) result.push(m);
    }
    return result;
  }

  function hasAnyLegalMove(state, color) {
    // 打ち歩詰め判定の内側で使う簡易版 (無限再帰を避けるため打ち歩詰めチェックは省略)
    const pseudo = pseudoLegalMoves(state, color);
    for (const m of pseudo) {
      const undo = makeMove(state, m);
      const ok = !isKingInCheck(state, color);
      unmakeMove(state, undo);
      if (ok) return true;
    }
    return false;
  }

  // ---- 局面キー (千日手検出・置換表用) -----------------------------------

  function stateKey(state) {
    let s = state.turn;
    for (let i = 0; i < 81; i++) s += state.board[i] || '.';
    for (const c of ['b', 'w']) {
      for (const t of HAND_TYPES) s += ',' + (state.hands[c][t] || 0);
    }
    return s;
  }

  // ---- 詰み探索 ----------------------------------------------------------
  // 攻方 (attacker) は王手になる手しか指せない (OR ノード: 1つでも詰みに
  // 導ければ良い)。玉方 (defender) はどんな合法手でも良い (AND ノード:
  // 全ての応手が詰みに繋がって初めて成功)。

  const DEFAULT_MAX_PLIES = 41; // 41手詰めまで (plies はそのまま手数)
  const DEFAULT_NODE_BUDGET = 3000000;

  function findMate(state, opts) {
    opts = opts || {};
    const maxPlies = opts.maxPlies || DEFAULT_MAX_PLIES;
    const nodeBudget = opts.nodeBudget || DEFAULT_NODE_BUDGET;
    const attacker = state.turn;
    const defender = otherColor(attacker);

    // 攻方の玉は無くてもよい (詰将棋の diagram では省略されるのが普通)。
    // 詰ませる対象である玉方の玉だけは必須。
    if (findKing(state, defender) < 0) {
      return { mate: false, error: 'no-king' };
    }

    let nodes = 0;
    let aborted = false;

    function existsMate(st, remaining, path, pvOut) {
      if (aborted) return false;
      nodes++;
      if (nodes > nodeBudget) { aborted = true; return false; }
      if (remaining <= 0) return false;
      const key = stateKey(st) + '|A';
      if (path.has(key)) return false; // 同一局面の繰り返し = 攻方の失敗
      path.add(key);
      const moves = legalMoves(st, attacker);
      let found = false;
      for (const m of moves) {
        const undo = makeMove(st, m);
        if (isKingInCheck(st, defender)) {
          const subPv = [];
          if (existsMateDefender(st, remaining - 1, path, subPv)) {
            pvOut.length = 0;
            pvOut.push(m);
            for (const x of subPv) pvOut.push(x);
            found = true;
          }
        }
        unmakeMove(st, undo);
        if (found || aborted) break;
      }
      path.delete(key);
      return found;
    }

    function existsMateDefender(st, remaining, path, pvOut) {
      if (aborted) return false;
      nodes++;
      if (nodes > nodeBudget) { aborted = true; return false; }
      const moves = legalMoves(st, defender);
      if (moves.length === 0) return true; // 詰み
      if (remaining <= 0) return false;
      const key = stateKey(st) + '|D';
      if (path.has(key)) return false;
      path.add(key);
      let longest = null;
      for (const m of moves) {
        const undo = makeMove(st, m);
        const subPv = [];
        const ok = existsMate(st, remaining - 1, path, subPv);
        unmakeMove(st, undo);
        if (!ok) { path.delete(key); return false; }
        const candidate = [m].concat(subPv);
        if (!longest || candidate.length > longest.length) longest = candidate;
        if (aborted) { path.delete(key); return false; }
      }
      path.delete(key);
      pvOut.length = 0;
      for (const x of longest) pvOut.push(x);
      return true;
    }

    for (let plies = 1; plies <= maxPlies; plies += 2) {
      const path = new Set();
      const pv = [];
      const ok = existsMate(state, plies, path, pv);
      if (aborted) return { mate: false, aborted: true, nodes: nodes };
      if (ok) return { mate: true, plies: plies, pv: pv, nodes: nodes };
    }
    return { mate: false, nodes: nodes };
  }

  /**
   * 最短手数と同じ手数で詰む「初手」が2つ以上あるかを調べる (余詰めの疑い)。
   * mate.pv[0] 以外に、同じ plies で詰む初手があれば返す。
   */
  function findAlternateFirstMoves(state, mateResult, opts) {
    if (!mateResult || !mateResult.mate) return [];
    opts = opts || {};
    const nodeBudget = opts.nodeBudget || DEFAULT_NODE_BUDGET;
    const attacker = state.turn;
    const defender = otherColor(attacker);
    const plies = mateResult.plies;
    const firstMoveKey = moveKey(mateResult.pv[0]);
    let nodes = 0;
    let aborted = false;
    const alternates = [];

    function existsMateDefender(st, remaining, path) {
      nodes++;
      if (nodes > nodeBudget) { aborted = true; return false; }
      const moves = legalMoves(st, defender);
      if (moves.length === 0) return true;
      if (remaining <= 0) return false;
      const key = stateKey(st) + '|D';
      if (path.has(key)) return false;
      path.add(key);
      for (const m of moves) {
        const undo = makeMove(st, m);
        const ok = existsMate(st, remaining - 1, path);
        unmakeMove(st, undo);
        if (!ok || aborted) { path.delete(key); return false; }
      }
      path.delete(key);
      return true;
    }
    function existsMate(st, remaining, path) {
      nodes++;
      if (nodes > nodeBudget) { aborted = true; return false; }
      if (remaining <= 0) return false;
      const key = stateKey(st) + '|A';
      if (path.has(key)) return false;
      path.add(key);
      const moves = legalMoves(st, attacker);
      let found = false;
      for (const m of moves) {
        const undo = makeMove(st, m);
        if (isKingInCheck(st, defender) && existsMateDefender(st, remaining - 1, path)) found = true;
        unmakeMove(st, undo);
        if (found || aborted) break;
      }
      path.delete(key);
      return found;
    }

    const topMoves = legalMoves(state, attacker);
    for (const m of topMoves) {
      if (moveKey(m) === firstMoveKey) continue;
      const undo = makeMove(state, m);
      let ok = false;
      if (isKingInCheck(state, defender)) {
        ok = existsMateDefender(state, plies - 1, new Set());
      }
      unmakeMove(state, undo);
      if (aborted) break;
      if (ok) alternates.push(m);
    }
    return alternates;
  }

  function moveKey(m) {
    return (m.drop ? 'D' + m.drop : 'M' + m.from) + '-' + m.to + (m.promote ? '+' : '');
  }

  // ---- 表記 ---------------------------------------------------------------

  const KANJI_NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

  // 盤に描く駒札の字。成り駒は本物の駒と同じ一文字略称 (杏・圭・全)。
  // 埋め込みフォント (kakugawari/kifu と共通, Shippori Mincho Bold から
  // 切り出した14文字) が「成」を含まないので、盤の上ではこの略称を使う。
  const PIECE_NAME = {
    P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
    '+P': 'と', '+L': '杏', '+N': '圭', '+S': '全', '+B': '馬', '+R': '龍'
  };

  // 棋譜に書くときの呼び名。読み下しの決まりどおり「成香・成桂・成銀」と書く
  // (と・馬・龍はそのまま)。駒札の略称とは別に持つ。
  const KIFU_NAME = {
    P: '歩', L: '香', N: '桂', S: '銀', G: '金', B: '角', R: '飛', K: '玉',
    '+P': 'と', '+L': '成香', '+N': '成桂', '+S': '成銀', '+B': '馬', '+R': '龍'
  };

  function pieceKey(piece) {
    return isPromoted(piece) ? '+' + baseType(piece).toUpperCase() : baseType(piece).toUpperCase();
  }

  /** 盤に描く一文字 (駒札の字)。 */
  function pieceDisplayName(piece) {
    const key = pieceKey(piece);
    return PIECE_NAME[key] || key;
  }

  /** 棋譜に書く呼び名 (成銀・成桂・成香)。 */
  function pieceKifuName(piece) {
    const key = pieceKey(piece);
    return KIFU_NAME[key] || key;
  }

  function formatMove(move, color) {
    const mark = color === 'b' ? '▲' : '△';
    const file = fileOf(move.to);
    const rank = rankOf(move.to);
    const pos = String(file) + KANJI_NUM[rank];
    // 成る手は「成る前の駒名 + 成」(例: ▲2二飛成)
    const name = pieceKifuName(move.piece) + (move.promote ? '成' : '');
    const suffix = move.drop ? '打' : '';
    return mark + pos + name + suffix;
  }

  /** PV を再生して、王手・詰みの注記付きの文字列配列にする。state は変更しない。 */
  function describePv(state, pv) {
    const st = cloneState(state);
    const lines = [];
    for (let i = 0; i < pv.length; i++) {
      const m = pv[i];
      const mover = st.turn;
      const undo = makeMove(st, m);
      let text = formatMove(m, mover);
      const opp = otherColor(mover);
      if (isKingInCheck(st, opp)) {
        const remain = legalMoves(st, opp);
        text += remain.length === 0 ? '（王手・詰み）' : '（王手）';
      }
      lines.push(text);
      unmakeMove(st, undo);
      makeMove(st, m); // 実際に進める (undo は使い捨て)
    }
    return lines;
  }

  function pieceCounts(state) {
    const counts = { b: {}, w: {} };
    for (const c of ['b', 'w']) for (const t of HAND_TYPES.concat(['K'])) counts[c][t] = state.hands[c] && state.hands[c][t] || 0;
    for (let i = 0; i < 81; i++) {
      const p = state.board[i];
      if (!p) continue;
      const c = colorOf(p);
      const t = baseType(p).toUpperCase();
      counts[c][t] = (counts[c][t] || 0) + 1;
    }
    return counts;
  }

  function validatePosition(state) {
    const errors = [];
    const warnings = [];
    const attacker = state.turn, defender = otherColor(attacker);
    // 玉方 (詰ませる対象) の玉は必須。攻方の玉は無くてもよい
    // (詰将棋の diagram では省略されるのが普通なので)。
    if (findKing(state, defender) < 0) {
      errors.push(`${defender === 'b' ? '先手' : '後手'}の玉がありません`);
    }
    if (state.board.filter((p) => p === 'K').length > 1) errors.push('先手の玉が2枚以上あります');
    if (state.board.filter((p) => p === 'k').length > 1) errors.push('後手の玉が2枚以上あります');
    const counts = pieceCounts(state);
    for (const c of ['b', 'w']) {
      for (const t of ['P', 'L', 'N', 'S', 'G', 'B', 'R']) {
        if (counts[c][t] > MAX_IN_SET[t]) {
          warnings.push(`${c === 'b' ? '先手' : '後手'}の${PIECE_NAME[t]}が標準より多いです (${counts[c][t]}枚)`);
        }
      }
    }
    if (errors.length === 0 && isKingInCheck(state, attacker)) {
      warnings.push('手番側の玉がすでに王手されています');
    }
    return { errors, warnings };
  }

  return {
    FILES, RANKS, HAND_TYPES,
    idx, fileOf, rankOf, otherColor, baseType, isPromoted, colorOf,
    emptyState, cloneState,
    parseSfen, toSfen,
    pieceTargets, legalMoves, isKingInCheck, isSquareAttacked, findKing,
    makeMove, unmakeMove, hasAnyLegalMove,
    findMate, findAlternateFirstMoves,
    formatMove, describePv, pieceDisplayName, pieceKifuName,
    pieceCounts, validatePosition,
    stateKey
  };
});
