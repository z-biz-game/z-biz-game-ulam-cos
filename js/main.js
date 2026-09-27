// The shell: hash routes in, canvas out, records in between. Nothing here knows the rules of
// the game — those live in js/core/game.js — and nothing here draws — that is js/view.js. What
// this file owns is the third thing: which numbers get put on screen, when a result is written to
// the save file, and the fact that NO SEARCH HAPPENS HERE.
//
// The panel deliberately prints the bound and the measurement in one glance:
//   体积界 bound   what Berlekamp's V(a,q) ≤ 2^q predicts (js/core/volume.js, arithmetic)
//   精确值 par     what the minimax DP measured (js/core/solve.js, build time only)
//   V / 2^q        the live volume readout, recomputed every answer by js/core/game.js
// because the whole point of this game is that the first two are NOT always equal — 3 candidates
// and one lie: the bound says 4, the truth is 5 — and the player can watch them disagree.
//
// Click-path budget (DESIGN 4): a click costs a Map.get (the baked policy) plus an O(n≤40)
// counter reduction. `ulam.searchNodes()` is the assertion of that claim: the DP guard's node
// counter must still read 0 after a whole lot is played. Only recomputeTable() — a test affordance
// nobody clicks by accident — is allowed to move it.

import {
  createGame, state as gameState, questionsLeft, provableLies, witnesses,
  canAsk, toggle, paint, clearDraft, ask, accuse, undo, reset, hint, grade, reveal, verdictText,
  volumeReadout, idsForProfile, MAX_CELLS,
} from './core/game.js';
import { store, persistent, SAVE_KEY } from './core/storage.js';
import {
  lotById, campaignOrder, nextLot, indexById, bands, measured, minqTable, greedyReport,
  advisoryReport, validate, lotCount, policyMap,
} from './core/library.js';
import { TIERS, TIER_ORDER, randomLot, dailyLot, customLot, parOf, boundOf } from './core/make.js';
import { todayKey, rngFrom } from './core/rng.js';
import { total, formatState, describeState, fresh } from './core/state.js';
import { volume, boundPar, printMarginValue } from './core/volume.js';
import { solver, makeSolver } from './core/solve.js';
import { createView } from './view.js';

const $ = (id) => document.getElementById(id);
const el = {
  modes: $('modes'), totals: $('totals'), crumbs: $('crumbs'), readout: $('readout'),
  hintline: $('hintline'), veil: $('veil'), stars: $('stars'), verdict: $('verdict'),
  tally: $('tally'), reveal: $('reveal'), ask: $('ask'), clear: $('clear'), undo: $('undo'),
  hint: $('hint'), restart: $('restart'), share: $('share'), next: $('next'), again: $('again'),
  library: $('library'), home: $('home'), toast: $('toast'), canvas: $('board'), wipe: $('wipe'),
  drawer: $('drawer'), prooftotal: $('prooftotal'), prooflog: $('prooflog'), prooffoot: $('prooffoot'),
  viewMenu: $('view-menu'), viewGame: $('view-game'), bandlist: $('bandlist'), bandmeta: $('bandmeta'),
  resumeLine: $('resume-line'), resumeGo: $('resume-go'), recordsLine: $('records-line'),
  recordsList: $('records-list'), legendk: $('legendk'),
};

const LEVELS = lotCount();
// Asked once at boot: localStorage can throw on access (file://, private windows, locked-down
// profiles), and `store` then runs on its memory cache for the rest of the session. The header
// says so rather than quietly losing the player's records at the tab close.
const CAN_PERSIST = persistent();
const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const RESUME_KEY = 'ulam.resume.v1';

const app = {
  mode: 'campaign',
  index: 1,
  route: null,
  lot: null,
  game: null,
  hints: 0,
  label: '',
  day: null,
  lastLine: '',
  proof: [],
};

// ---- resume store ---------------------------------------------------------
// The save file (js/core/storage.js) owns RESULTS and is one localStorage key by design. An
// in-progress interrogation is a different animal: it dies with the tab, so it lives in
// sessionStorage and holds only what a replay needs — the route, and the batch of cells lit per
// question. js/core/adversary.js is total + deterministic, so replaying those batches against the
// same secret reproduces the same answers byte for byte; nothing about the secret is stored.
const resume = {
  read() {
    try {
      const raw = sessionStorage.getItem(RESUME_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      return p && Array.isArray(p.steps) && typeof p.hash === 'string' ? p : null;
    } catch { return null; }
  },
  write(hash, id, steps) {
    try { sessionStorage.setItem(RESUME_KEY, JSON.stringify({ hash, id, steps })); } catch { /* memory only */ }
  },
  clear() { try { sessionStorage.removeItem(RESUME_KEY); } catch { /* nothing to clear */ } },
};

// ---- routing --------------------------------------------------------------
// #/c/7 · #/lot/7-1 · #/daily · #/random/hard/4kq2 · #/pick/12/1 · #/menu
// The lot id (or the seed) is in the URL, so a shared link resolves to the same interrogation on
// another device without the receiver needing the sender's save file — the table is fixed and
// shipped, and js/core/make.js is the only seeded derivation in the repo.
function clampIndex(n) {
  return Math.min(LEVELS, Math.max(1, Number(n) || 1));
}

function parseHash(hash = location.hash) {
  const p = String(hash).replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!p.length) return { mode: 'campaign', index: 1 };
  if (p[0] === 'menu' || p[0] === 'library') return { mode: 'menu' };
  if (p[0] === 'daily') return { mode: 'daily' };
  if (p[0] === 'random') return { mode: 'random', tier: p[1] || TIER_ORDER[0], key: p[2] || null };
  if (p[0] === 'lot') return { mode: 'lot', id: p[1] };
  if (p[0] === 'pick') return { mode: 'pick', n: Number(p[1]) || 3, k: Number(p[2]) || 0 };
  const n = p[0] === 'c' || p[0] === 'campaign' ? Number(p[1]) : Number(p[0]);
  return { mode: 'campaign', index: clampIndex(n) };
}

function linkFor(rt) {
  if (rt.mode === 'menu') return '#/menu';
  if (rt.mode === 'daily') return '#/daily';
  if (rt.mode === 'random') return `#/random/${rt.tier}/${rt.key}`;
  if (rt.mode === 'lot') return `#/lot/${rt.id}`;
  if (rt.mode === 'pick') return `#/pick/${rt.n}/${rt.k}`;
  return `#/c/${rt.index}`;
}

function resolve(rt) {
  if (rt.mode === 'daily') {
    const day = todayKey();
    return { lot: dailyLot(day), label: `每日谎话 · ${day}`, day };
  }
  if (rt.mode === 'random') {
    const key = rt.key || String(rngFrom(`rand-${rt.tier}`).int(1e6));
    return { lot: randomLot(rt.tier, key), label: `随机 · ${(TIERS[rt.tier] || TIERS.standard).cn}`, seedKey: key };
  }
  if (rt.mode === 'pick') {
    const lot = customLot(rt.n, rt.k);
    return { lot, label: `自己挑：${rt.n} 个数 · ${rt.k} 个谎` };
  }
  if (rt.mode === 'lot') return { lot: lotById(rt.id), label: `关卡 ${rt.id}` };
  const list = campaignOrder();
  const lot = list[clampIndex(rt.index) - 1] || list[0];
  return { lot, label: `战役第 ${clampIndex(rt.index)} 关` };
}

let view = null;

function go(hash) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (location.hash === target) apply();
  else location.hash = target;
}

function apply() {
  const rt = parseHash();
  // A bare `#/random` must mint its key INTO the URL. resolve() used to mint one internally,
  // which played fine but made 分享 produce `#/random/tier/null` — a link that re-rolls on every
  // open, defeating the point of sharing a puzzle. Mint first, rewrite the hash, then resolve.
  if (rt.mode === 'random' && !rt.key) {
    rt.key = String(rngFrom(`mint-${Date.now()}`).int(1e6));
    return go(linkFor(rt));
  }
  el.viewMenu.hidden = rt.mode !== 'menu';
  el.viewGame.hidden = rt.mode === 'menu';
  if (rt.mode === 'menu') {
    renderMenu();
    return;
  }
  const found = resolve(rt);
  // A route that does not name a shipped lot falls back to the campaign, never to a blank
  // board: the URL is a request, not a source of truth.
  if (!found.lot) {
    if (rt.mode !== 'campaign') return go(`#/c/${store.unlocked}`);
    app.lot = campaignOrder()[0];
    app.label = '关卡库为空';
  } else {
    app.lot = found.lot;
    app.label = found.label;
  }
  app.mode = rt.mode === 'lot' ? 'campaign' : rt.mode;
  app.index = rt.mode === 'campaign' ? clampIndex(rt.index) : indexById(app.lot.id) + 1;
  app.day = found.day || null;
  app.hints = 0;
  app.route = rt;
  app.proof = [];
  app.game = createGame(app.lot);
  // reload-and-resume: same route, same lot ⇒ replay the lit batches. ask() re-derives the
  // answer through the deterministic adversary, so the resumed weight vector is identical.
  const saved = resume.read();
  let replayed = 0;
  if (saved && saved.hash === (location.hash || '#/c/1') && saved.id === app.lot.id) {
    for (const ids of saved.steps) {
      const r = ask(app.game, { ids });
      if (!r.ok) break;
      app.proof.push(proofLine(app.game, app.game.log.length, ids, r));
      replayed++;
    }
  }
  if (!replayed) resume.clear();
  view.setGame(app.game);
  view.measure();
  el.veil.hidden = true;
  drawProof();
  render(replayed ? `接着上局 · 已重放 ${replayed} 问` : `载入 ${app.lot.id}`);
}

// ---- rendering ------------------------------------------------------------
function tile(key, term, value, note, cls = '') {
  return `<div class="${key}${cls ? ` ${cls}` : ''}"><dt>${term}</dt><dd>${value}${note ? `<small>${note}</small>` : ''}</dd></div>`;
}

function readoutTiles(g, lot) {
  const a = gameState(g);
  const v = volumeReadout(g);
  const bound = lot.bound === undefined ? boundPar(fresh(lot.n, lot.k)) : lot.bound;
  const par = lot.par === null || lot.par === undefined ? '—' : lot.par;
  // The two numbers the repo exists to compare, printed in the same glance. `.diff` is the
  // stylesheet hook css/game.css colours magenta: 界说 4、真值 5 就是这一格。
  const disagrees = Number.isInteger(bound) && Number.isInteger(par) && bound !== par;
  return [
    tile('size', '候选 n', lot.n, '<small> 个数</small>'),
    tile('lies', '谎上限 k', lot.k, '<small> 次</small>'),
    tile('grant', '发放 q', lot.q, '<small> 问</small>'),
    tile('bound', '体积界', bound, '<small> 问·定理</small>'),
    tile('par', '精确值', par, '<small> 问·DP</small>', disagrees ? 'diff' : ''),
    tile('volume', '体积 V', `${v.V}/${v.cap}`, `<small> 余量 ${v.margin === Infinity ? '∞' : v.margin.toFixed(2)}×</small>`),
    tile('left', '剩余候选', total(a), `<small> ${describeState(a)}</small>`),
    tile('asked', '已问', g.log.length, `<small> / ${lot.q}</small>`),
    tile('proof', '可证谎数', provableLies(g), `<small> / ${g.k}</small>`),
  ].join('');
}

function render(line) {
  const g = app.game;
  const lot = app.lot;
  if (!g || !lot) return;
  if (line !== undefined) app.lastLine = line;
  const tierCn = lot.tier && TIERS[lot.tier] ? TIERS[lot.tier].cn : '战役';
  el.crumbs.innerHTML = `${app.label} · <span class="band-tag">${tierCn}</span><b>${lot.id}</b>`;
  el.crumbs.title = `数字来自 js/data/lots.js（构建期三路线复验）${CAN_PERSIST ? '' : ' · 本机存档不可用，成绩只存内存'}`;
  el.readout.innerHTML = readoutTiles(g, lot);
  el.hintline.innerHTML = app.lastLine;
  el.legendk.textContent = String(lot.k);
  // Deliberately NOT disabled while nothing is lit: an empty question is LEGAL (it costs the
  // responder a lie if it lies), so the rule lives in game.ask() and not in the button.
  el.ask.disabled = !canAsk(g);
  el.clear.disabled = !g.draft.length;
  el.undo.disabled = !g.log.length;
  el.hint.disabled = !canAsk(g);
  el.prooffoot.innerHTML = g.phase === 'accuse'
    ? '<span class="warn">问完了或只剩一个候选：点一个格子指认。</span>'
    : `权重向量 <code>${formatState(gameState(g))}</code>：第 i 格 = 已被矛盾 i 次的候选数。`;
  const t = store.totals();
  el.totals.innerHTML = `谎话藏数 <b>${t.solved}</b>/${LEVELS} 关拿下 · 其中 <b>${t.atPar}</b> 关在精确值内 · 已解锁 ${store.unlocked}`
    + (CAN_PERSIST ? '' : ' · <span class="warn">内存模式</span>');
  for (const b of el.modes.querySelectorAll('button')) {
    b.setAttribute('aria-current', String(b.dataset.mode === app.mode));
  }
}

// The 证明抽屉: one line per answer, and each line IS the weight vector the DP saw.
function proofLine(g, i, ids, r) {
  const a = g.log[i - 1].a;
  const y = g.log[i - 1].y;
  const after = gameState(g);
  return {
    i,
    ids: ids.slice(),
    answer: r.answer,
    text: `亮 {${ids.join(',')}} → 答“${r.answer === 'yes' ? '在亮格里' : '不在亮格里'}” · `
      + `(${a.join('|')}) → <b>(${after.join('|')})</b> · 候选 ${total(after)}`
      + (g.log[i - 1].degenerate ? ' · 空问/全问' : ''),
    profile: y.join(','),
  };
}

function drawProof() {
  el.prooflog.innerHTML = app.proof.map((p) => `<li>${p.text}</li>`).join('')
    || '<li>还没有一问。权重向量现在是 (n|0|…)。</li>';
  el.prooftotal.textContent = `(${app.proof.length} 条)`;
}

function markLies(flags) {
  [...el.prooflog.children].forEach((li, i) => { if (flags[i]) li.classList.add('lied'); });
}

// ---- menu view ------------------------------------------------------------
function renderMenu() {
  const t = store.totals();
  const s = store.stats;
  el.recordsLine.innerHTML = `拿下 <b>${t.solved}</b>/${LEVELS} 关 · 在精确值内 <b>${t.atPar}</b> 关 · `
    + `对局 ${s.plays} · 胜 ${s.wins} · 负 ${s.losses} · 用掉 ${s.questions} 问 · 提示 ${s.hints} 次`;
  const recs = campaignOrder().filter((l) => store.record(l.id));
  el.recordsList.innerHTML = recs.length
    ? recs.map((l) => {
      const r = store.record(l.id);
      return `<li>${l.id} · <span class="best">最好 ${r.best === null ? '—' : `${r.best} 问`}</span>`
        + ` / 精确值 ${l.par} · 打过 ${r.plays} 次${r.atPar ? ' · 达到精确值' : ''}</li>`;
    }).join('')
    : '<li>还没有成绩。</li>';

  const saved = resume.read();
  if (saved) {
    el.resumeLine.innerHTML = `未完的一局：<b>${saved.id}</b> · 已问 ${saved.steps.length} 问`;
    el.resumeLine.classList.remove('empty');
    el.resumeGo.hidden = false;
    el.resumeGo.dataset.hash = saved.hash;
  } else {
    el.resumeLine.textContent = '没有未完的一局。';
    el.resumeLine.classList.add('empty');
    el.resumeGo.hidden = true;
  }

  const m = measured();
  const claimsOk = m.claims.filter((c) => c.held).length;
  // One string, printed straight into the rebuilt header below: #bandlist's innerHTML is replaced
  // wholesale on every menu visit, so a persistent element reference here would go stale.
  const metaLine = `${LEVELS} 关 · ${m.claims.length} 条断言 ${claimsOk} 条成立 · `
    + `minQ 表上界与真值不符 ${m.minq.mismatches.length} 格`;
  const list = campaignOrder();
  const byK = new Map();
  for (const l of list) {
    const arr = byK.get(l.k) || [];
    arr.push(l);
    byK.set(l.k, arr);
  }
  const heads = {
    0: '无谎档 · 体积界正好就是真值',
    1: '一谎档 · 界开始说谎的地方',
    2: '二谎档',
    3: '三谎档',
  };
  const cards = [...byK.entries()].sort((p, r) => p[0] - r[0]).map(([k, lots]) => {
    const rows = lots.map((l) => {
      const diff = l.bound !== l.par;
      return `<div class="lot-row" data-lot="${l.id}">
        <span class="nm">${l.index + 1}. ${l.name || l.id} · ${l.n} 数/${l.k} 谎</span>
        <span class="q">发 ${l.q} 问</span>
        <span class="bound">界 ${l.bound}</span>
        <span class="par${diff ? ' diff' : ''}">真值 ${l.par}${diff ? ' ≠' : ''}</span>
        <button type="button" data-goto="#/lot/${l.id}">开局</button>
      </div>`;
    }).join('');
    const diffCount = lots.filter((l) => l.bound !== l.par).length;
    return `<div class="band"><h3>${heads[k] || `${k} 谎档`} <small>· ${lots.length} 关 · 界与真值不符 ${diffCount} 关</small></h3>${rows}</div>`;
  }).join('');
  el.bandlist.innerHTML = `<h2>关卡库 <small>${metaLine}</small></h2>${cards}`
    + `<p class="legend-note">“界”是 <code>V(a,q) ≤ 2^q</code> 预言的最少问数，“真值”是极小极大 DP 量出来的。带 ≠ 的那几行是这仓存在的理由。另有按候选数分带的一张表：<code>ulam.bands()</code> 共 ${bands().length} 带。</p>`;
}

// ---- playing ------------------------------------------------------------
function illegalReason(r) {
  switch (r.reason) {
    case 'over': return '本局已经结案的。';
    case 'budget': return '<span class="warn">问数用完了</span> —— 现在只能指认。';
    case 'accuse': return '<span class="warn">点一个格子指认</span>，不能再问了。';
    case 'cell': return '<span class="warn">那一格不在盘上</span>，这一问没有问出去。';
    case 'settled': return `<span class="warn">只剩 ${r.left === undefined ? 1 : r.left} 个候选</span>，再问也分不开，指认吧。`;
    default: return `<span class="warn">这一问不合法（${r.reason}）</span>`;
  }
}

function commit() {
  const g = app.game;
  const ids = g.draft.slice();
  const r = ask(g);
  if (!r.ok) {
    render(`${illegalReason(r)} · 盘上状态没变`);
    view.setGame(g);
    return;
  }
  app.proof.push(proofLine(g, g.log.length, ids, r));
  resume.write(location.hash || '#/c/1', g.id, g.log.map((e) => e.ids));
  drawProof();
  const bumped = bumpedCells(g);
  view.setGame(g, REDUCED ? [] : bumped);
  const a = gameState(g);
  render(`第 ${g.log.length} 问：答“${r.answer === 'yes' ? '在' : '不在'}” · 候选 ${total(a)} · `
    + `权重 <b>(${a.join('|')})</b> · 还剩 ${r.qLeft} 问`);
  if (g.phase === 'accuse') render(`候选 ${total(a)} 个 · <span class="gold">点一个格子指认</span>（还剩 ${questionsLeft(g)} 问的预算）`);
}

// Which cells just moved up a contradiction level — the flash the view paints in gold.
function bumpedCells(g) {
  const last = g.log[g.log.length - 1];
  if (!last) return [];
  const out = [];
  for (let x = 1; x <= g.n; x++) if ((last.contraBefore[x] || 0) < (g.contra[x] || 0)) out.push(x);
  return out;
}

function finish() {
  const g = app.game;
  const lot = app.lot;
  const gr = grade(g);
  const used = g.log.length;
  const rv = reveal(g);
  store.solve(lot.id, {
    questions: used, par: lot.par === null ? used + 1 : lot.par,
    hints: app.hints, lies: rv.trueLies, won: g.won,
  });
  if (g.won) {
    const at = indexById(lot.id) + 1;
    if (at > 0) store.unlock(Math.min(LEVELS, Math.max(store.unlocked, at + 1)));
    if (app.mode === 'daily' && app.day) store.markDaily(app.day, lot.id, { won: true, questions: used });
  }
  resume.clear();
  markLies(rv.lies);
  el.stars.textContent = '★'.repeat(gr.stars) + '☆'.repeat(3 - gr.stars);
  el.verdict.textContent = gr.label;
  el.tally.innerHTML = (g.won
    ? `用了 <b>${used}</b> 问 · 这一关的精确值是 <b>${lot.par}</b> · 体积界说 <b>${lot.bound}</b><br>`
      + `对手实际撒了 <b>${rv.trueLies}</b> 个谎（上限 ${lot.k}），你只能证明 <b>${rv.provableLies}</b> 个 · 提示 ${app.hints} 次`
    : `秘密是 <b>${rv.secret}</b> · 你指的是 <b>${rv.accused === null ? '—' : rv.accused}</b> · 结案时还有 <b>${rv.witnesses.length}</b> 个候选与全部答案相容<br>`
      + `精确值 ${lot.par} 问本该够 · 按“重开”再试一次`)
    + `<br><span class="warn">结论：</span>${verdictText(g)}`;
  el.reveal.innerHTML = rv.cells.map((c) => `<li>格子 <b>${c.id}</b> · 被矛盾 ${c.contra} 次${c.alive ? '' : ' · 出局'}${c.id === rv.secret ? ' · 就是它' : ''}</li>`).join('');
  el.veil.hidden = false;
  render(verdictText(g));
  view.setGame(g);
}

function restart() {
  const g = app.game;
  reset(g);
  app.hints = 0;
  app.proof = [];
  resume.clear();
  el.veil.hidden = true;
  drawProof();
  view.setGame(g);
  render(`重开 · ${g.n} 个候选 · ${g.k} 个谎 · 精确值 ${g.par === null ? '未量' : `${g.par} 问`} · 界说 ${app.lot.bound}`);
}

function doHint() {
  const g = app.game;
  const h = hint(g);
  if (!h) { render('<span class="warn">现在该指认，不是问。</span>'); return; }
  app.hints++;
  if (h.kind === 'settled') { render(`只剩 <b>${h.left}</b> 个候选，直接点它。`); return; }
  const lit = h.degenerate
    ? '<b>空问</b>（一个格子也不亮：真话只能是「不在」，对手若答「在」就白送一个谎）'
    : `亮 {${h.ids.join(',')}}`;
  if (h.exact) {
    render(`策略表：${lit} —— 这一问在构建期被极小极大解过，答完最多还需 <b>${h.qLeft - 1}</b> 问`);
  } else {
    render(`<span class="warn">表外（${h.kind === 'absent' ? '这一关没烤策略表' : '你走到表外了'}），</span>给的是体积均分建议 ${lit} —— 不担保精确值`);
  }
}

// ---- wiring ---------------------------------------------------------------
function toast(msg) {
  el.toast.hidden = false;
  el.toast.textContent = msg;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.toast.hidden = true; }, 2200);
}

function shareLink() {
  const url = `${location.origin}${location.pathname}${linkFor(parseHash())}`;
  const done = () => toast('链接已复制，对方打开就是同一局（同一种子同一问）');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done, () => toast(url));
  } else {
    toast(url);
  }
}

el.ask.addEventListener('click', commit);
el.clear.addEventListener('click', () => {
  clearDraft(app.game);
  view.setGame(app.game);
  render(`亮格清空了 · 候选还是 ${total(gameState(app.game))} 个`);
});
el.undo.addEventListener('click', () => {
  if (undo(app.game)) {
    app.proof.pop();
    el.veil.hidden = true;
    drawProof();
    resume.write(location.hash || '#/c/1', app.game.id, app.game.log.map((e) => e.ids));
    view.setGame(app.game);
    const a = gameState(app.game);
    render(`退回一问 · 候选 ${total(a)} · 权重 (${a.join('|')})`);
  }
});
el.hint.addEventListener('click', doHint);
el.restart.addEventListener('click', restart);
el.share.addEventListener('click', shareLink);
el.again.addEventListener('click', restart);
el.next.addEventListener('click', () => {
  const nl = nextLot(app.index - 1);
  if (nl) go(`#/lot/${nl.id}`);
});
el.library.addEventListener('click', () => go('#/menu'));
el.home.addEventListener('click', () => go('#/menu'));
el.resumeGo.addEventListener('click', () => go(el.resumeGo.dataset.hash || '#/c/1'));

// The band list is event-delegated: renderMenu() rewrites its innerHTML, so a listener per row
// would leak on every visit to the menu.
el.bandlist.addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-goto]');
  if (b) go(b.dataset.goto);
});

// The three mode buttons in the header route, exactly like a hand-typed hash would, so
// campaign/daily/random are reachable without knowing the URL grammar.
el.modes.addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b || !b.dataset.mode) return;
  const md = b.dataset.mode;
  if (md === 'daily') go('#/daily');
  else if (md === 'random') go(linkFor({
    mode: 'random',
    tier: app.lot && TIERS[app.lot.tier] ? app.lot.tier : TIER_ORDER[1],
    key: String(rngFrom(`btn-${Date.now()}`).int(1e6)),
  }));
  else go(`#/c/${app.index || store.unlocked}`);
});

// Wiping the save is the one destructive thing this game can do, so it asks twice.
let wipeArmed = false;
el.wipe.addEventListener('click', () => {
  if (!wipeArmed) {
    wipeArmed = true;
    toast('再点一次会清空本机全部成绩');
    setTimeout(() => { wipeArmed = false; }, 4000);
    return;
  }
  store.reset();
  resume.clear();
  wipeArmed = false;
  toast('存档已清空');
  apply();
});

window.addEventListener('hashchange', apply);
window.addEventListener('resize', () => { if (!el.viewGame.hidden) view.measure(); });
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (el.viewGame.hidden) return;
  const g = app.game;
  if (!g) return;
  if (g.done) {
    if (ev.key === 'Escape') el.veil.hidden = true;
    return;
  }
  if (ev.key === 'Escape') {
    if (g.draft.length) {
      clearDraft(g);
      view.setGame(g);
      render(`这一问的亮格清空了 · 候选还是 ${total(gameState(g))} 个`);
    }
    return;
  }
  if (ev.key === 'Enter') { el.ask.click(); ev.preventDefault(); return; }
  if (ev.key.toLowerCase() === 'u') { el.undo.click(); return; }
  if (ev.key.toLowerCase() === 'h') { el.hint.click(); return; }
  if (ev.key.toLowerCase() === 'r') { el.restart.click(); return; }
  const d = Number(ev.key);
  if (Number.isInteger(d) && d >= 1 && d <= Math.min(9, g.n)) tapCell(d);
});

view = createView(el.canvas, {
  onToggle: (id) => tapCell(id),
  onBrush: (ids, added) => {
    const g = app.game;
    if (g.phase === 'accuse') { render('<span class="warn">已经不能问了：点一个格子指认。</span>'); return; }
    if (added) paint(g, ids);
    else { for (const id of ids) if (g.draft.includes(id)) toggle(g, id); }
    view.setGame(g);
    render(`正把 ${ids.length} 格${added ? '刷亮' : '熄灭'} · 当前亮 ${g.draft.length} 格`);
  },
});

// One cell, one meaning: while asking it toggles the batch; once the position is settled it is an
// accusation, because 指对才算赢 (js/core/game.js accuse()).
function tapCell(id) {
  const g = app.game;
  if (g.done) return false;
  if (g.phase === 'accuse' || total(gameState(g)) <= 1) {
    if (total(gameState(g)) <= 1 && g.phase === 'ask' && questionsLeft(g) > 0) {
      // Still has budget but only one survivor: the rules force the accusation, ask() would say
      // 'settled', so fall through to accuse and let the ledger show it.
      g.phase = 'accuse';
    }
    const res = accuseOf(g, id);
    if (!res.ok) { render(`<span class="warn">${illegalReason(res)}</span>`); return false; }
    finish();
    return true;
  }
  if (!toggle(g, id)) return false;
  view.setGame(g);
  render(`亮 ${g.draft.length} 格 {${g.draft.join(',')}} · 按“问出去”`);
  return true;
}

// accuse() lives in core; imported under a local name so the shell's own click handler reads as
// one action per function.
// accuse() is the only move that ends a lot, so the shell wraps it with the one thing core does
// not know: a click on an out-of-range cell must explain itself instead of doing nothing.
function accuseOf(g, id) {
  if (g.done) return { ok: false, reason: 'over' };
  if (!Number.isInteger(id) || id < 1 || id > g.n) return { ok: false, reason: 'cell' };
  return accuse(g, id);
}

// ---- test surface ---------------------------------------------------------
// tools/playtest.mjs drives THESE plus real mouse events. Everything here is read-only or a call
// into the same handlers a finger reaches, never a parallel implementation.
function stateSnapshot() {
  const g = app.game;
  const lot = app.lot;
  if (!g || !lot) return { id: null };
  const a = gameState(g);
  return {
    mode: app.mode,
    label: app.label,
    id: lot.id,
    tier: lot.tier || 'campaign',
    index: app.index,
    n: lot.n,
    k: lot.k,
    q: lot.q,
    par: lot.par,
    bound: lot.bound === undefined ? boundPar(fresh(lot.n, lot.k)) : lot.bound,
    volume: lot.volume === undefined ? volume(fresh(lot.n, lot.k), lot.q) : lot.volume,
    margin: lot.margin === undefined ? null : lot.margin,
    asked: g.log.length,
    qLeft: questionsLeft(g),
    vec: a,
    vecText: formatState(a),
    left: total(a),
    draft: g.draft.slice(),
    done: !!g.done,
    won: !!g.won,
    phase: g.phase,
    grade: grade(g).key,
    lucky: grade(g).lucky,
    provable: provableLies(g),
    hints: app.hints,
    unlocked: store.unlocked,
    solved: store.totals().solved,
    atPar: store.totals().atPar,
    persist: CAN_PERSIST,
    veil: !el.veil.hidden,
    menu: !el.viewMenu.hidden,
    line: el.hintline.textContent,
    day: app.day,
    proof: app.proof.length,
    witnesses: witnesses(g),
    resume: !!resume.read(),
    maxCells: MAX_CELLS,
    searchNodes: solver.nodes,
  };
}

// One-time browser-side closure check (library.js rule 2). Pure lookups: it re-derives every
// policy key from its own (a,q) and walks each realizable branch of every stored question back
// into the table. Costs a few ms and ZERO search nodes.
function closure() {
  const v = validate();
  return { ok: v.ok, errors: v.errors.slice(0, 5), count: v.count, nodes: solver.nodes };
}

// The same claim, checked against the OTHER route in the browser: a bounded DP re-solve of the
// headline cells. Opt-in (only tests and the console call it), so a click can never pay for it.
function recomputeTable(opts = {}) {
  const s = makeSolver({ maxNodes: opts.maxNodes || 400000, maxMs: opts.maxMs || 8000 });
  const out = { closure: closure(), cells: 0, checked: 0, mismatches: [], unmeasured: 0, errors: [] };
  const minq = minqTable();
  // (1) the table's own arithmetic: V recomputed from scratch against every printed number
  for (const l of campaignOrder()) {
    out.cells++;
    const V = volume(fresh(l.n, l.k), l.q);
    if (V !== l.volume) out.mismatches.push({ id: l.id, what: 'volume', got: l.volume, want: V });
    if (printMarginValue(2 ** l.q / V) !== l.margin) out.mismatches.push({ id: l.id, what: 'margin', got: l.margin });
    const b = boundPar(fresh(l.n, l.k));
    if (b !== l.bound) out.mismatches.push({ id: l.id, what: 'bound', got: l.bound, want: b });
    out.checked++;
  }
  // (2) a bounded DP re-measurement of the small roots, against the shipped MINQ row
  const nMax = Math.min(opts.nMax === undefined ? 8 : opts.nMax, 12);
  for (let n = 1; n <= nMax; n++) {
    for (let k = 0; k <= 2; k++) {
      const row = minq[n];
      if (!row) continue;
      try {
        const p = s.par(fresh(n, k));
        out.checked++;
        if (p !== row.par[k]) out.mismatches.push({ n, k, what: 'par', got: row.par[k], want: p });
      } catch (err) {
        out.unmeasured++;
        out.errors.push(`n=${n} k=${k}: ${err.message}`);
      }
    }
  }
  out.nodes = s.nodes;
  out.ok = out.closure.ok && out.mismatches.length === 0;
  return out;
}

window.ulam = {
  version: 1,
  SAVE_KEY,
  get state() { return stateSnapshot(); },
  stateVec() { return gameState(app.game); },
  recomputeTable,
  closure,
  campaign: () => campaignOrder().map((l) => ({ id: l.id, index: l.index, n: l.n, k: l.k, q: l.q, par: l.par, bound: l.bound, volume: l.volume, margin: l.margin })),
  lotById: (id) => { const l = lotById(id); return l ? { id: l.id, n: l.n, k: l.k, q: l.q, par: l.par, secret: l.secret, policy: l.policy ? l.policy.size : 0 } : null; },
  bands,
  measured,
  greedyReport,
  advisoryReport,
  minq: minqTable,
  claims: () => measured().claims,
  load(hash) { go(hash); return app.lot && app.lot.id; },
  route: () => linkFor(parseHash()),
  // geometry probes for the driver
  cellPoint: (id) => view.cellPoint(id),
  ledgerPoint: (i) => view.ledgerPoint(i),
  pixelOf: (id) => view.pixelOf(id),
  geom: () => view.geom(),
  buttonPoint(id) {
    const b = el[id];
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  },
  boardBox() {
    const r = el.canvas.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  },
  // the same handlers a finger reaches
  tapCell: (id) => tapCell(id),
  brush(ids) { paint(app.game, ids); view.setGame(app.game); return app.game.draft.slice(); },
  clear() { el.clear.click(); return app.game.draft.length; },
  tapAsk() { commit(); return app.game.log.length; },
  tapUndo() { el.undo.click(); return app.game.log.length; },
  tapHint() { doHint(); return { hints: app.hints, line: el.hintline.textContent }; },
  tapRestart() { restart(); return app.game.log.length; },
  accuse: (id) => tapCell(id),
  hintMove() {
    const g = app.game;
    const h = hint(g);
    if (!h) return null;
    return { ...h, ids: h.ids.slice(), vec: gameState(g), qLeft: questionsLeft(g) };
  },
  proofLines: () => app.proof.map((p) => p.text.replace(/<[^>]+>/g, '')),
  // scripted plays: the policy route to a win, the empty-question route to a loss
  autoPlay(limit = 16) {
    let n = 0;
    while (!app.game.done && n < limit) {
      const g = app.game;
      if (g.phase === 'accuse' || total(gameState(g)) <= 1) {
        const w = witnesses(g);
        tapCell(w.length ? w[0] : 1);
        break;
      }
      const h = hint(g);
      if (!h || !h.ids.length) { if (!ask(g).ok) break; }
      else { paint(g, h.ids); commit(); }
      n++;
    }
    return { asked: app.game.log.length, won: app.game.won, done: app.game.done, grade: grade(app.game).key };
  },
  autoLose(limit = 16) {
    let n = 0;
    while (canAsk(app.game) && n < limit) {
      // an empty batch is legal and informationless: the surest way to lose on purpose
      const r = ask(app.game, { ids: [] });
      if (!r.ok) break;
      app.proof.push(proofLine(app.game, app.game.log.length, [], r));
      n++;
    }
    drawProof();
    const g = app.game;
    if (g.phase !== 'accuse') g.phase = 'accuse';
    const w = witnesses(g);
    const wrong = w.find((x) => x !== g.secret) || w[w.length - 1] || 1;
    const res = accuseOf(g, wrong);
    if (res.ok) finish();
    return { asked: g.log.length, won: g.won, done: g.done, accused: g.accused, secret: g.secret };
  },
  dailyFor: (dateKey) => {
    const l = dailyLot(dateKey);
    return { id: l.id, campaignId: l.campaignId, n: l.n, k: l.k, q: l.q, par: l.par, secret: l.secret };
  },
  randomFor: (tier, seed) => {
    const l = randomLot(tier, seed);
    return { id: l.id, tier: l.tier, n: l.n, k: l.k, q: l.q, par: l.par, bound: l.bound, secret: l.secret };
  },
  tiers: TIERS,
  tierOrder: TIER_ORDER,
  parOf,
  boundOf,
  policyMap,
  searchNodes: () => solver.nodes,
  idsForProfile: (y) => idsForProfile(app.game, y),
  store,
  els: el,
};

// No rAF loop of its own: the view flashes the bumped cells and then stops. The shell drives the
// first measure explicitly so the board is drawn before any test probes a point on it.
apply();
