/*
 * ブラウザで実際に動かして確かめるテスト。
 *
 *   npm i -D playwright && npm run test:ui
 *
 * 画面まわりの不具合は node のテストでは捕まらない。ここでは本物の
 * ブラウザを立ち上げ、指の操作をそのまま再現して確かめる。
 *
 * ★ アプリを作ったら「ここにアプリごとの確認を足す」に書き足すこと。
 *   直した不具合には、かならず見張り役をここに置く。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const PORT = Number(process.env.PORT || 8124);
const URL = `http://localhost:${PORT}/`;
const ROOT = __dirname;
const CHROMIUM = process.env.CHROMIUM_PATH;   // 手元の Chromium を使いたいとき

let passed = 0;
let failed = 0;

function ok(condition, message) {
  if (condition) {
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + message);
  } else {
    failed++;
    console.log('  \x1b[31m✗ FAIL\x1b[0m ' + message);
  }
}

function skip(message) {
  console.log('  \x1b[90m- とばした: ' + message + '\x1b[0m');
}

function section(name) {
  console.log('\n' + name);
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      http.get(URL, (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() - started > 10000) reject(new Error('サーバーが起動しない'));
          else setTimeout(tick, 100);
        });
    };
    tick();
  });
}

async function run() {
  let chromium;
  let devices;
  try {
    ({ chromium, devices } = require('playwright'));
  } catch (e) {
    console.error('playwright が必要です:  npm i -D playwright');
    process.exit(1);
  }

  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(PORT)], {
    stdio: 'ignore'
  });
  await waitForServer();

  const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
  const errors = [];

  try {
    // ------------------------------------------------ スマホで開く
    section('スマホで開く');
    const context = await browser.newContext({ ...devices['iPhone 13'] });
    const phone = await context.newPage();
    phone.on('pageerror', (e) => errors.push('スマホ: ' + e.message));
    phone.on('console', (m) => { if (m.type() === 'error') errors.push('スマホ: ' + m.text()); });
    await phone.goto(URL);
    await phone.waitForFunction(() => window.__app);
    ok(true, 'ページが開いて、画面のしくみが立ち上がる');

    const fit = await phone.evaluate(() => ({
      wide: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      title: document.querySelector('h1') ? document.querySelector('h1').textContent.trim() : ''
    }));
    ok(fit.wide <= 1, `スマホ幅で横スクロールが出ない (はみだし ${fit.wide}px)`);
    ok(fit.title.length > 0, `見出しが出ている (${fit.title})`);

    const cellCount = await phone.locator('.cell').count();
    ok(cellCount === 81, `盤に81マスある (${cellCount})`);

    // 最初の局面 (ぴよ将棋の局面編集と同じ形): 玉方の玉が5一、残りの駒は
    // ぜんぶ玉方の駒台に入っている
    const initial = await phone.evaluate(() => ({
      hands: window.__app.state().pos.hands,
      goteKing: window.__app.state().pos.board[window.Core.idx(5, 1)],
      onBoard: window.__app.state().pos.board.filter(Boolean).length
    }));
    ok(initial.goteKing === 'k', `玉方の玉が最初から5一にある (${initial.goteKing})`);
    ok(initial.onBoard === 1, `最初に盤にあるのは玉方の玉だけ (${initial.onBoard}枚)`);
    ok(initial.hands.w.P === 18 && initial.hands.w.R === 2,
      `玉方の駒台に駒一式が入っている (${JSON.stringify(initial.hands.w)})`);
    ok(Object.values(initial.hands.b).every((n) => n === 0), '攻方の持ち駒は最初は空');

    // ------------------------------------------------ お試し局面 → 詰みチェック (1手詰め)
    section('お試し局面: 1手詰め');
    await phone.locator('#btnSample').tap();
    await phone.waitForTimeout(100);
    await phone.locator('#btnCheck').tap();
    await phone.waitForFunction(
      () => document.getElementById('resultHeadline').textContent.includes('詰み'),
      { timeout: 8000 }
    );
    const r1 = await phone.evaluate(() => document.getElementById('resultHeadline').textContent);
    ok(r1.includes('1手詰め'), `1手詰めと判定される (${r1})`);
    const moves1 = await phone.locator('#resultMoves li').count();
    ok(moves1 === 1, `手順が1手ぶん表示される (${moves1})`);

    // ------------------------------------------------ お試し局面 → 詰みチェック (3手詰め)
    section('お試し局面: 3手詰め');
    await phone.locator('#btnSample').tap();
    await phone.waitForTimeout(100);
    await phone.locator('#btnCheck').tap();
    await phone.waitForFunction(
      () => document.getElementById('resultHeadline').textContent.includes('詰み'),
      { timeout: 8000 }
    );
    const r2 = await phone.evaluate(() => document.getElementById('resultHeadline').textContent);
    ok(r2.includes('3手詰め'), `3手詰めと判定される (${r2})`);
    const moves2 = await phone.locator('#resultMoves li').count();
    ok(moves2 === 3, `手順が3手ぶん表示される (${moves2})`);

    // ------------------------------------------------ 駒台から盤へ置く
    section('駒台の駒をタップして盤に置く');
    await phone.locator('#btnClear').tap();
    await phone.waitForTimeout(50);

    // 玉方の駒台の「歩」をタップして持つ
    await phone.locator('#standWhiteChips .chip[data-type="P"]').tap();
    const picked = await phone.evaluate(() => ({
      pick: window.__app.state().pick,
      status: document.getElementById('pickStatus').textContent
    }));
    ok(picked.pick && picked.pick.type === 'P' && picked.pick.from === 'w',
      `駒台の駒をタップすると持てる (${JSON.stringify(picked.pick)})`);
    ok(picked.status.includes('歩'), `いま持っている駒が画面に出る (${picked.status.trim()})`);

    // 置いた直後に盤が飛ばないか (玉方の駒台は盤の上にあるので、駒が減って
    // 行数が変わると盤がずれる。高さを先に取ってあることの見張り)
    const jump = await measureJump(phone, '#board',
      'document.querySelector(\'.cell[data-file="5"][data-rank="5"]\').click()');
    ok(jump < 12, `駒を置いた直後に盤が飛ばない (最大ずれ ${jump}px)`);

    const afterDrop = await phone.evaluate(() => ({
      cell: window.__app.state().pos.board[window.Core.idx(5, 5)],
      left: window.__app.state().pos.hands.w.P
    }));
    ok(afterDrop.cell === 'P', `置いた駒はまず攻めの駒になる (${afterDrop.cell})`);
    ok(afterDrop.left === 17, `置いたぶん駒台から減る (歩 ${afterDrop.left}枚)`);

    // ------------------------------------------------ 盤の駒をタップして回す
    section('盤の駒: 1回目で選び、続けてタップすると回る');

    // 1回目のタップは「選ぶ」だけ。駒はまだ変わらない
    await phone.locator('.cell[data-file="5"][data-rank="5"]').tap();
    const firstTap = await phone.evaluate(() => ({
      piece: window.__app.state().pos.board[window.Core.idx(5, 5)],
      selected: window.__app.state().selected === window.Core.idx(5, 5),
      marked: document.querySelector('.cell[data-file="5"][data-rank="5"]').classList.contains('selected')
    }));
    ok(firstTap.piece === 'P', `1回目のタップでは駒は変わらない (${firstTap.piece})`);
    ok(firstTap.selected && firstTap.marked, '1回目のタップでその駒が選ばれ、印が付く');

    // 2回目以降のタップで 攻め→守り→成った攻め→成った守り→攻め と回る
    const cycle = [];
    for (let i = 0; i < 4; i++) {
      await phone.locator('.cell[data-file="5"][data-rank="5"]').tap();
      cycle.push(await phone.evaluate(() => window.__app.state().pos.board[window.Core.idx(5, 5)]));
    }
    ok(cycle.join(',') === 'p,+P,+p,P',
      `続けてタップすると 守り→成った攻め→成った守り→攻め と回る (P,${cycle.join(',')})`);

    // 金は成れないので 攻め ↔ 守り の2つだけ
    await phone.locator('#standWhiteChips .chip[data-type="G"]').tap();
    await phone.locator('.cell[data-file="4"][data-rank="5"]').tap();   // 置く
    await phone.locator('.cell[data-file="4"][data-rank="5"]').tap();   // 選ぶ
    const goldCycle = [];
    for (let i = 0; i < 2; i++) {
      await phone.locator('.cell[data-file="4"][data-rank="5"]').tap();
      goldCycle.push(await phone.evaluate(() => window.__app.state().pos.board[window.Core.idx(4, 5)]));
    }
    ok(goldCycle.join(',') === 'g,G', `金は攻め↔守りだけで回る (G,${goldCycle.join(',')})`);

    // ------------------------------------------------ 置いた駒を動かす
    section('置いた駒を別のマスへ動かす');
    // 4五の金は回したところなので、まだ選ばれたまま。そのまま6七へ動かす
    await phone.locator('.cell[data-file="6"][data-rank="7"]').tap();
    const moved = await phone.evaluate(() => ({
      from: window.__app.state().pos.board[window.Core.idx(4, 5)],
      to: window.__app.state().pos.board[window.Core.idx(6, 7)],
      hands: window.__app.state().pos.hands.w.G,
      selected: window.__app.state().selected === window.Core.idx(6, 7)
    }));
    ok(moved.from === null && moved.to === 'G',
      `選んだ駒が空いたマスへ動く (元:${moved.from} / 先:${moved.to})`);
    ok(moved.selected, '動かしたあとも、その駒が選ばれたままになる');

    // 動かしただけでは駒の枚数は増えも減りもしない
    ok(moved.hands === 3, `動かしても駒台の枚数は変わらない (金 ${moved.hands}枚)`);

    // 動かした先でもう一度タップすれば、そのまま向きを変えられる
    await phone.locator('.cell[data-file="6"][data-rank="7"]').tap();
    const afterMoveCycle = await phone.evaluate(() =>
      window.__app.state().pos.board[window.Core.idx(6, 7)]);
    ok(afterMoveCycle === 'g', `動かした先でもタップで向きが変わる (${afterMoveCycle})`);

    // 別の駒をタップすると、選び直しになる (動かしてしまわない)
    await phone.locator('.cell[data-file="5"][data-rank="5"]').tap();
    const reselected = await phone.evaluate(() => ({
      selected: window.__app.state().selected === window.Core.idx(5, 5),
      stillThere: window.__app.state().pos.board[window.Core.idx(6, 7)]
    }));
    ok(reselected.selected && reselected.stillThere === 'g',
      '駒のあるマスをタップすると、動かさずに選び直しになる');

    // ------------------------------------------------ 攻方の持ち駒へ渡す
    section('攻方の持ち駒へ渡す');
    await phone.locator('#standWhiteChips .chip[data-type="R"]').tap();
    await phone.locator('#standBlackChips .stand-drop').tap();
    const handed = await phone.evaluate(() => ({
      b: window.__app.state().pos.hands.b.R,
      w: window.__app.state().pos.hands.w.R
    }));
    ok(handed.b === 1 && handed.w === 1,
      `玉方の駒台から攻方の持ち駒へ1枚渡せる (攻方${handed.b}枚 / 玉方${handed.w}枚)`);

    // ------------------------------------------------ 消す
    section('消すと駒台に戻る');
    await phone.locator('#toolErase').tap();
    await phone.locator('.cell[data-file="5"][data-rank="5"]').tap();
    const erased = await phone.evaluate(() => ({
      cell: window.__app.state().pos.board[window.Core.idx(5, 5)],
      back: window.__app.state().pos.hands.w.P
    }));
    ok(erased.cell === null, '「消す」で盤の駒が消える');
    ok(erased.back === 18, `消した駒は玉方の駒台に戻る (歩 ${erased.back}枚)`);
    await phone.locator('#toolErase').tap();   // 消すモードを解除

    // ------------------------------------------------ 駒箱の玉
    section('駒箱の玉');
    await phone.locator('#boxKing').tap();
    await phone.locator('.cell[data-file="9"][data-rank="9"]').tap();
    const kingPlaced = await phone.evaluate(() => window.__app.state().pos.board[window.Core.idx(9, 9)]);
    ok(kingPlaced === 'K', `駒箱から玉を置ける (${kingPlaced})`);
    await phone.locator('.cell[data-file="9"][data-rank="9"]').tap();   // 選ぶ
    await phone.locator('.cell[data-file="9"][data-rank="9"]').tap();   // 回す
    const kingFlipped = await phone.evaluate(() => window.__app.state().pos.board[window.Core.idx(9, 9)]);
    ok(kingFlipped === 'k', `玉もタップで攻め↔守りが変わる (${kingFlipped})`);

    // ------------------------------------------------ 攻方の玉は無くても詰みチェックできる
    section('攻方の玉なしで詰みチェック');
    await phone.evaluate(() => {
      const ta = document.getElementById('sfenText');
      ta.value = '8k/9/7G1/9/9/9/9/9/9 b R 1';
      document.getElementById('btnLoadSfen').click();
    });
    const senteKingOnBoard = await phone.evaluate(() => window.__app.state().pos.board.includes('K'));
    ok(!senteKingOnBoard, 'この局面に先手 (攻方) の玉は置かれていない');
    await phone.locator('#btnCheck').tap();
    await phone.waitForFunction(
      () => document.getElementById('resultHeadline').textContent.includes('詰み'),
      { timeout: 8000 }
    );
    const noKingResult = await phone.evaluate(() => document.getElementById('resultHeadline').textContent);
    ok(noKingResult.includes('1手詰め'), `攻方の玉が無くても詰みチェックできる (${noKingResult})`);

    // ------------------------------------------------ 玉方の玉が無いとエラー
    section('玉方の玉が無いとき');
    await phone.locator('#btnClear').tap();
    await phone.waitForTimeout(50);
    await phone.locator('#toolErase').tap();
    await phone.locator('.cell[data-file="5"][data-rank="1"]').tap();   // 玉方の玉を消す
    await phone.locator('#toolErase').tap();
    await phone.locator('#btnCheck').tap();
    await phone.waitForTimeout(150);
    const errText = await phone.evaluate(() => document.getElementById('resultHeadline').textContent);
    ok(errText.includes('不完全'), `玉方の玉が無いと不完全と言われる (${errText})`);

    // ------------------------------------------------ 不詰み判定
    section('不詰み局面');
    await phone.evaluate(() => {
      const ta = document.getElementById('sfenText');
      ta.value = '9/9/9/9/4k4/9/9/9/4K4 b - 1';
      document.getElementById('btnLoadSfen').click();
    });
    await phone.locator('#btnCheck').tap();
    await phone.waitForFunction(
      () => /不詰み|詰み/.test(document.getElementById('resultHeadline').textContent),
      { timeout: 8000 }
    );
    const noMateText = await phone.evaluate(() => document.getElementById('resultHeadline').textContent);
    ok(noMateText.includes('不詰み'), `駒が無ければ不詰みと判定される (${noMateText})`);

    // ------------------------------------------------ SFEN の書き出し
    section('SFEN の書き出し');
    await phone.locator('#btnSample').tap();
    await phone.waitForTimeout(50);
    await phone.evaluate(() => { document.getElementById('sfenSection').open = true; });
    await phone.locator('#btnExportSfen').tap();
    const exported = await phone.inputValue('#sfenText');
    ok(exported.split(' ').length >= 3, `SFEN らしき文字列が書き出される (${exported})`);

    // ------------------------------------------------ 明るい画面・暗い画面
    section('明るい画面と暗い画面');
    for (const scheme of ['light', 'dark']) {
      const themed = await browser.newContext({ ...devices['iPhone 13'], colorScheme: scheme });
      const page = await themed.newPage();
      page.on('pageerror', (e) => errors.push(scheme + ': ' + e.message));
      await page.goto(URL);
      await page.waitForFunction(() => window.__app);
      const colors = await page.evaluate(() => ({
        bg: getComputedStyle(document.body).backgroundColor,
        fg: getComputedStyle(document.body).color
      }));
      ok(colors.bg !== colors.fg, `${scheme}: 文字と背景の色が違う (${colors.bg} / ${colors.fg})`);
      await themed.close();
    }

    section('エラー');
    ok(errors.length === 0, errors.length ? '画面のエラー: ' + errors.join(' / ') : 'JS エラーなし');
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
  process.exit(failed ? 1 : 0);
}

/**
 * 何かした直後に、その要素が本来の場所からどれだけずれるかを
 * 1 フレームずつ測る。「置いた瞬間に一瞬とぶ」たぐいの不具合はこれで見つかる。
 *
 * @returns {Promise<number>} 最大のずれ (px)
 */
function measureJump(page, selector, act) {
  return page.evaluate(async ({ sel, code }) => {
    const before = document.querySelector(sel).getBoundingClientRect();
    // eslint-disable-next-line no-new-func
    new Function(code)();
    let worst = 0;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const el = document.querySelector(sel);
      if (!el) { worst = Infinity; break; }
      const now = el.getBoundingClientRect();
      worst = Math.max(worst, Math.abs(now.left - before.left), Math.abs(now.top - before.top));
    }
    return Math.round(worst);
  }, { sel: selector, code: act });
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
