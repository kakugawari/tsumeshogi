/*!
 * solver-worker.js — 詰み探索を別スレッドで行う。
 * 画面をロックしないよう、時間のかかる探索はここに追い出す。
 */
importScripts('./core.js');

self.onmessage = function (ev) {
  const msg = ev.data;
  if (msg.type !== 'solve') return;
  const state = msg.state;
  const opts = msg.opts || {};

  const mate = Core.findMate(state, opts);
  let alternates = [];
  if (mate.mate) {
    alternates = Core.findAlternateFirstMoves(state, mate, { nodeBudget: opts.altNodeBudget });
  }
  self.postMessage({ type: 'result', requestId: msg.requestId, mate: mate, alternates: alternates });
};
