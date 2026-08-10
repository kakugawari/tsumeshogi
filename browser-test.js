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

    // 最初から後手の持ち駒に駒一式が入っている (置き方がわからない、への対策)
    const initialHands = await phone.evaluate(() => window.__app.state().pos.hands);
    ok(initialHands.w.P === 18 && initialHands.w.R === 2, `後手の持ち駒に駒一式が最初から入っている (${JSON.stringify(initialHands.w)})`);
    ok(Object.values(initialHands.b).every((n) => n === 0), '先手の持ち駒は最初は空');

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

    // 駒を置いた直後に盤自体が飛ばないか (持ち駒の枠は駒の増減で高さが変わるのが
    // 正しい動きなので、ここでは高さが変わらないはずの盤そのもので確かめる)
    await phone.locator('.palette-piece[data-color="b"][data-type="P"]').tap();
    const jump = await measureJump(phone, '#board',
      'document.querySelector(\'.cell[data-file="5"][data-rank="5"]\').click()');
    ok(jump < 12, `駒を置いた直後に盤が飛ばない (最大ずれ ${jump}px)`);

    // ------------------------------------------------ 盤面の編集
    section('盤面の編集 (駒を置く・消す)');
    await phone.locator('#btnClear').tap();
    await phone.waitForTimeout(50);
    const emptyCount = await phone.evaluate(() => window.__app.state().pos.board.filter(Boolean).length);
    ok(emptyCount === 0, 'クリアすると盤が空になる');

    // 先手玉を9九に、後手玉を1一に置く
    await phone.locator('.palette-piece[data-color="b"][data-type="K"]').tap();
    await phone.locator('.cell[data-file="9"][data-rank="9"]').tap();
    await phone.locator('.palette-piece[data-color="w"][data-type="K"]').tap();
    await phone.locator('.cell[data-file="1"][data-rank="1"]').tap();
    const afterPlace = await phone.evaluate(() => ({
      sente: window.__app.state().pos.board[8 * 9 + 8],
      gote: window.__app.state().pos.board[0]
    }));
    ok(afterPlace.sente === 'K' && afterPlace.gote === 'k', `駒を置いた通りに配置される (${JSON.stringify(afterPlace)})`);

    // 同じ駒をもう一度タップすると消える (トグル)
    await phone.locator('.palette-piece[data-color="w"][data-type="K"]').tap();
    await phone.locator('.cell[data-file="1"][data-rank="1"]').tap();
    const afterToggle = await phone.evaluate(() => window.__app.state().pos.board[0]);
    ok(afterToggle === null, '同じ駒をもう一度タップすると消える');

    // 玉が足りない状態でチェックするとエラーが出る
    await phone.locator('#btnCheck').tap();
    await phone.waitForTimeout(150);
    const errText = await phone.evaluate(() => document.getElementById('resultHeadline').textContent);
    ok(errText.includes('不完全'), `玉が無いと不完全と言われる (${errText})`);

    // ------------------------------------------------ 持ち駒の編集 (数を選ぶ欄なし)
    section('持ち駒の編集 (タップで足す・戻す)');
    await phone.locator('#btnClear').tap();
    await phone.waitForTimeout(50);

    // 駒を選ばずに「＋」は押せない
    const addDisabledBefore = await phone.evaluate(() =>
      document.querySelector('#handBlackPieces .hand-add').disabled);
    ok(addDisabledBefore, '駒を選んでいないと「＋」は押せない');

    // 先手の金を選んで、先手の持ち駒欄の「＋」で1枚加える
    await phone.locator('.palette-piece[data-color="b"][data-type="G"]').tap();
    const addEnabled = await phone.evaluate(() =>
      !document.querySelector('#handBlackPieces .hand-add').disabled);
    ok(addEnabled, '駒を選ぶと「＋」が押せるようになる');
    await phone.locator('#handBlackPieces .hand-add').tap();
    const afterAdd = await phone.evaluate(() => window.__app.state().pos.hands.b.G);
    ok(afterAdd === 1, `「＋」で先手の持ち駒に金が1枚加わる (${afterAdd})`);

    // その駒の札をタップすると1枚戻る
    await phone.locator('#handBlackPieces .hand-piece').first().tap();
    const afterRemove = await phone.evaluate(() => window.__app.state().pos.hands.b.G);
    ok(afterRemove === 0, '持ち駒の札をタップすると1枚戻る');

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

    // ------------------------------------------------ 不詰み判定
    section('不詰み局面');
    await phone.locator('#btnClear').tap();
    await phone.evaluate(() => {
      const app = window.__app;
      app.loadSfen; // no-op reference
    });
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
