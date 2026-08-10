const test = require('node:test');
const assert = require('node:assert');
const Core = require('./core.js');

function stateFrom(placements, hands, turn) {
  const st = Core.emptyState();
  for (const [file, rank, piece] of placements) {
    st.board[Core.idx(file, rank)] = piece;
  }
  if (hands) {
    for (const color of ['b', 'w']) {
      if (hands[color]) Object.assign(st.hands[color], hands[color]);
    }
  }
  st.turn = turn || 'b';
  return st;
}

/**
 * 見つかった手順が本当に詰みまで進むかを、局面を実際に再生して確かめる。
 * (どの手が見つかるかという探索の内部順序には依存しない、頑丈な検査。)
 */
function assertGenuineMate(state, result, expectedPlies) {
  assert.strictEqual(result.mate, true, '詰みと判定されるはず');
  if (expectedPlies !== undefined) assert.strictEqual(result.plies, expectedPlies);
  assert.strictEqual(result.pv.length, result.plies);
  const st = Core.cloneState(state);
  const attacker = state.turn;
  const defender = Core.otherColor(attacker);
  for (let i = 0; i < result.pv.length; i++) {
    const mover = st.turn;
    const before = Core.legalMoves(st, mover);
    assert.ok(before.some((m) => JSON.stringify(m) === JSON.stringify(result.pv[i])),
      `${i}手目 (${JSON.stringify(result.pv[i])}) はその局面での合法手のはず`);
    Core.makeMove(st, result.pv[i]);
    if (mover === attacker) {
      assert.strictEqual(Core.isKingInCheck(st, defender), true, `攻方の${i}手目は王手のはず`);
    }
  }
  assert.strictEqual(Core.legalMoves(st, defender).length, 0, '最後は玉方に合法手が無いはず (詰み)');
}

// ---- SFEN --------------------------------------------------------------

test('SFEN: 初形を読み書きできる', () => {
  const sfen = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';
  const st = Core.parseSfen(sfen);
  assert.strictEqual(st.board[Core.idx(5, 1)], 'k');
  assert.strictEqual(st.board[Core.idx(5, 9)], 'K');
  assert.strictEqual(st.board[Core.idx(8, 8)], 'B');
  assert.strictEqual(st.board[Core.idx(2, 8)], 'R');
  assert.strictEqual(Core.toSfen(st), sfen);
});

test('SFEN: 持ち駒を読み書きできる', () => {
  const sfen = '9/9/9/9/4k4/9/9/9/4K4 b 2P3n 1';
  const st = Core.parseSfen(sfen);
  assert.strictEqual(st.hands.b.P, 2);
  assert.strictEqual(st.hands.w.N, 3);
  assert.strictEqual(Core.toSfen(st), sfen);
});

// ---- 1手詰め (手で確認済みの局面) ----------------------------------------
//
// 後手玉 1一の一手詰み。盤上の金 (2三) が1二・2二を塞いでおり、
// 持ち駒の飛車を1筋のどこかに打てば (捕られない距離から) 王手がかかり、
// 3方向すべて塞がれて詰む。

function oneMoveMatePosition() {
  return stateFrom(
    [[9, 9, 'K'], [1, 1, 'k'], [2, 3, 'G']],
    { b: { R: 1 } },
    'b'
  );
}

test('1手詰め: 飛車打ちで詰む', () => {
  const st = oneMoveMatePosition();
  assert.deepStrictEqual(Core.validatePosition(st).errors, []);
  const result = Core.findMate(st, { maxPlies: 5 });
  assertGenuineMate(st, result, 1);
});

// ---- 3手詰め -------------------------------------------------------------
//
// 後手玉 1一。先手: 3三に金 (王手していない)。持ち駒: 香・銀。
// 1筋に香を打つと王手になり、玉は2一にしか動けない (3三の金が2二を
// 塞いでいる)。そこへ2二に銀を打つと (3三の金に守られていて捕れず、
// 3一にも利いているので) 詰み。
// (金ではなく銀にしているのは、金だと2二打ちだけで — 香を打たずに —
//  いきなり詰んでしまう "近道" が生じてしまうため。銀は2二から1二に
//  利かないので、その近道が生まれない。)

function threeMoveMatePosition() {
  return stateFrom(
    [[9, 9, 'K'], [1, 1, 'k'], [3, 3, 'G']],
    { b: { L: 1, S: 1 } },
    'b'
  );
}

test('3手詰め: 香打ち→玉の強制移動→金打ちで詰む', () => {
  const st = threeMoveMatePosition();
  const result = Core.findMate(st, { maxPlies: 7 });
  assertGenuineMate(st, result, 3);
});

test('3手詰め: describePv が手順を文字にできる', () => {
  const st = threeMoveMatePosition();
  const result = Core.findMate(st, { maxPlies: 7 });
  const lines = Core.describePv(st, result.pv);
  assert.strictEqual(lines.length, 3);
  assert.ok(lines.every((l) => l.startsWith('▲') || l.startsWith('△')));
  assert.ok(lines[2].includes('詰み'));
});

// ---- 詰まない局面 ---------------------------------------------------------

test('玉2枚だけでは絶対に詰まない', () => {
  const st = stateFrom([[9, 9, 'K'], [1, 1, 'k']], null, 'b');
  const result = Core.findMate(st, { maxPlies: 9 });
  assert.strictEqual(result.mate, false);
});

// ---- 打ち歩詰め -----------------------------------------------------------
//
// 後手玉 1一。先手: 2三に金、3二に銀 (どちらも王手していない)。
// このとき 1二 に歩を打つと王手になり、1二(歩自体, 2三の金が守る)・
// 2一(3二の銀が利く)・2二(2三の金が利く) すべて塞がれ、詰んでしまう
// ので、この歩打ちは打ち歩詰めとして非合法。

test('打ち歩詰め: 詰ませてしまう歩打ちは非合法', () => {
  const st = stateFrom(
    [[9, 9, 'K'], [1, 1, 'k'], [2, 3, 'G'], [3, 2, 'S']],
    { b: { P: 1 } },
    'b'
  );
  const moves = Core.legalMoves(st, 'b');
  const illegalDrop = moves.find((m) => m.drop === 'P' && m.to === Core.idx(1, 2));
  assert.strictEqual(illegalDrop, undefined, '打ち歩詰めの歩打ちが合法手に含まれてはいけない');
  // 打った場合、実際に詰んでしまうことも裏取りしておく
  const undo = Core.makeMove(st, { from: null, to: Core.idx(1, 2), piece: 'P', promote: false, capture: null, drop: 'P' });
  assert.strictEqual(Core.isKingInCheck(st, 'w'), true);
  assert.strictEqual(Core.hasAnyLegalMove(st, 'w'), false);
  Core.unmakeMove(st, undo);
});

test('打ち歩詰めでない歩打ちはふつうに合法', () => {
  const st = stateFrom([[9, 9, 'K'], [5, 5, 'k']], { b: { P: 1 } }, 'b');
  const moves = Core.legalMoves(st, 'b');
  const drop = moves.find((m) => m.drop === 'P' && m.to === Core.idx(5, 6));
  assert.ok(drop, '玉に逃げ場がある歩打ちは合法のはず');
});

// ---- 二歩 -----------------------------------------------------------------

test('二歩は禁止される', () => {
  const st = stateFrom([[9, 9, 'K'], [1, 1, 'k'], [5, 6, 'P']], { b: { P: 1 } }, 'b');
  const moves = Core.legalMoves(st, 'b');
  const nifu = moves.find((m) => m.drop === 'P' && Core.fileOf(m.to) === 5);
  assert.strictEqual(nifu, undefined, '5筋にはすでに先手の歩があるので打てないはず');
  const otherFile = moves.find((m) => m.drop === 'P' && Core.fileOf(m.to) === 4);
  assert.ok(otherFile, '4筋には歩が無いので打てるはず');
});

// ---- 行き所のない駒 (強制成り) ----------------------------------------------

test('歩・香は最終段で必ず成る', () => {
  const st = stateFrom([[9, 9, 'K'], [1, 1, 'k'], [5, 2, 'P']], null, 'b');
  const moves = Core.legalMoves(st, 'b').filter((m) => m.from === Core.idx(5, 2));
  const toLastRank = moves.filter((m) => m.to === Core.idx(5, 1));
  assert.strictEqual(toLastRank.length, 1, '1段目への移動は成り一択のはず');
  assert.strictEqual(toLastRank[0].promote, true);
});

test('後手の歩は9段目で必ず成る (色による向きの反転)', () => {
  const st = stateFrom([[9, 9, 'K'], [1, 1, 'k'], [5, 8, 'p']], null, 'w');
  const moves = Core.legalMoves(st, 'w').filter((m) => m.from === Core.idx(5, 8));
  const toLastRank = moves.filter((m) => m.to === Core.idx(5, 9));
  assert.strictEqual(toLastRank.length, 1, '9段目への移動は成り一択のはず');
  assert.strictEqual(toLastRank[0].promote, true);
});

test('桂は最終段の1つ手前でも必ず成る', () => {
  const st = stateFrom([[9, 9, 'K'], [1, 1, 'k'], [5, 3, 'N']], null, 'b');
  const moves = Core.legalMoves(st, 'b').filter((m) => m.from === Core.idx(5, 3));
  for (const m of moves) {
    assert.strictEqual(m.promote, true, '2段目への桂の移動は成り一択のはず');
  }
});

test('行き所のない駒は打てない', () => {
  const st = stateFrom([[9, 9, 'K'], [1, 1, 'k']], { b: { P: 1, L: 1, N: 1 } }, 'b');
  const moves = Core.legalMoves(st, 'b');
  assert.strictEqual(moves.some((m) => m.drop === 'P' && Core.rankOf(m.to) === 1), false);
  assert.strictEqual(moves.some((m) => m.drop === 'L' && Core.rankOf(m.to) === 1), false);
  assert.strictEqual(moves.some((m) => m.drop === 'N' && Core.rankOf(m.to) <= 2), false);
});

// ---- 後手視点の動き (色の反転が正しいか) -----------------------------------

test('後手の駒も正しく動ける (王の疑似合法手が空にならない)', () => {
  const st = stateFrom([[9, 9, 'K'], [5, 5, 'k']], null, 'w');
  const targets = Core.pieceTargets(st, Core.idx(5, 5));
  assert.strictEqual(targets.length, 8, '玉は中央で8方向に動けるはず');
});

// ---- 検証 (盤面チェック) ----------------------------------------------------

test('validatePosition: 玉が無いとエラー', () => {
  const st = stateFrom([[9, 9, 'K']], null, 'b');
  const v = Core.validatePosition(st);
  assert.ok(v.errors.some((e) => e.includes('後手の玉')));
});

test('findAlternateFirstMoves: 3手詰め局面でエラーなく動く', () => {
  const st = threeMoveMatePosition();
  const result = Core.findMate(st, { maxPlies: 7 });
  const alts = Core.findAlternateFirstMoves(st, result, { nodeBudget: 200000 });
  assert.ok(Array.isArray(alts));
});
