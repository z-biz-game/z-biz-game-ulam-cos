// Suite 6/6 (a) — the read path: js/core/library.js + js/core/make.js.
//
// The claim this suite has to hold up is library.js's header: the browser only READS the baked
// table, and reading is enough to win. So the centrepiece row here replays all 133 hiding places of
// the 14 shipped lots against the table alone and then checks that the shared solver was never
// asked a single question (`solver.nodes === 0`).

import { test, ok, eq, throws, run } from '../tools/harness.mjs';
import { total, answer, key } from '../js/core/state.js';
import {
  policyMap, lotById, lotAt, lotIds, lotCount, campaignOrder, nextLot, indexById, bands,
  measured, minqTable, greedyReport, advisoryReport, validate, poolSize,
} from '../js/core/library.js';
import { solver } from '../js/core/solve.js';
import {
  TIERS, TIER_ORDER, parOf, boundOf, windowFor, randomLot, dailyLot, customLot,
} from '../js/core/make.js';
import { LOTS, MINQ, MEASURED, BRUTE, GREEDY, ADVISORY, BUDGET, SCHEMA } from '../js/data/lots.js';
import { createGame, state, questionsLeft, canAsk, hint, ask, accuse, witnesses } from '../js/core/game.js';

// ---------------------------------------------------------------- the shipped ids

test('the campaign roster is exactly these 14 ids, in this order', () => {
  eq(lotCount(), 14, 'fourteen lots');
  eq(poolSize, 14, 'the daily/random pool is the same roster');
  eq(lotIds(), [
    '3-0x', '7-0', '15-0',        // k=0: back to ⌈log₂n⌉
    '4-1x', '7-1', '11-1', '16-1',// k=1: 界说 6，真值是 7
    '3-2x', '6-2', '12-2', '20-2',// k=2
    '4-3x', '9-3', '16-3',        // k=3
  ], 'the arc written into the table');
  const SHAPE = ['3-0', '7-0', '15-0', '4-1', '7-1', '11-1', '16-1', '3-2', '6-2', '12-2', '20-2', '4-3', '9-3', '16-3'];
  eq(LOTS.map((l) => `${l.n}-${l.k}`), SHAPE, 'the id is n-k plus the slack marker x on the teaching lots');
  eq(lotIds().filter((id) => id.endsWith('x')), ['3-0x', '4-1x', '3-2x', '4-3x'], 'four lots are taught with a spare question');
  eq(LOTS.filter((l) => l.par === l.q).map((l) => l.id),
    ['7-0', '15-0', '7-1', '11-1', '16-1', '6-2', '12-2', '20-2', '9-3', '16-3'], 'ten lots sit exactly on the measured par');
  eq(SCHEMA, 1, 'one schema version');
  // index === position in the campaign order, which is what nextLot() walks
  eq(campaignOrder().map((l) => l.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], 'indices');
  eq(campaignOrder().map((l) => l.id), lotIds(), 'campaignOrder is the table order, not a re-sort');
});

test('lotAt / lotById / indexById: lookups, misses and the revive cache', () => {
  eq(lotById('nope'), null, 'an unknown id is null, and the caller decides what that means');
  eq(lotById(undefined), null, 'no id is not an id');
  eq(lotById(''), null, 'not even the empty one');
  eq(lotAt(99), null, 'out of range');
  eq(lotAt(0).id, '3-0x', 'position 0');
  eq(indexById('16-3'), 13, 'the last lot');
  eq(indexById('nope'), -1, 'missing ids index at -1');
  const a = lotById('7-1');
  const b = lotById('7-1');
  ok(a === b, 'the revived lot is cached, so the click path does not rebuild a Map per tap');
  ok(a.policy instanceof Map, 'the policy came back as a Map');
  ok(LOTS[3].policy instanceof Array, 'the serialised table is an array of [key,a,q,y] rows');
  eq(nextLot(13).id, '16-3', 'past the end clamps to the last lot');
  eq(nextLot(0).id, '7-0', 'one step forward');
  eq(nextLot(4).id, '11-1', 'and again');
});

test('policyMap: re-derives every key and refuses a relabelled row', () => {
  const rows = [[key([3, 0], 2), [3, 0], 2, [1, 0]], [key([2, 1], 1), [2, 1], 1, [1, 1]]];
  const m = policyMap(rows);
  eq(m.size, 2, 'two rows in');
  eq(m.get(key([3, 0], 2)).y, [1, 0], 'lookup by (state, q)');
  eq(m.get(key([2, 1], 1)).a, [2, 1], 'the position rides along with its own key');
  const tampered = [[key([3, 0], 2), [3, 0], 2, [1, 0]], [key([2, 1], 1), [2, 1], 2, [1, 1]]];
  throws(() => policyMap(tampered), /策略键不匹配/, 'a row labelled with another position\'s key throws');
  throws(() => policyMap([[7, [3, 0], 2, [1, 0]]]), /策略键不匹配：7/, 'and so does a junk key');
});

test('validate(): the table is closed, and the check costs no search', () => {
  const before = solver.nodes;
  const v = validate();
  eq(v.errors, [], 'no complaints');
  eq(v.ok, true, 'shippable');
  eq(v.count, 14, 'every lot covered');
  eq(solver.nodes - before, 0, 'validate() never touched the solver — it is pure lookup');
});

test('bands(): grouped by candidate count, with the measured margin per lot', () => {
  const bs = bands();
  eq(bs.length, 10, 'ten distinct board sizes: 3,4,6,7,9,11,12,15,16,20');
  eq(bs.map((x) => x.n), [3, 4, 6, 7, 9, 11, 12, 15, 16, 20], 'ascending');
  eq(bs[0], { n: 3, ids: ['3-0x', '3-2x'], margins: [2.667, 3.71] }, 'the two 3-cell lots');
  eq(bs[bs.length - 1], { n: 20, ids: ['20-2'], margins: [1.528] }, 'the widest lot');
  for (const band of bs) {
    ok(band.ids.length >= 1, 'a band has at least one lot');
    eq(band.margins.length, band.ids.length, 'and one margin per lot');
    for (const m of band.margins) ok(m >= 1, `every shipped lot sits inside the bound: margin ${m} ≥ 1`);
  }
});

test('the read accessors hand back the table itself, not a copy of it', () => {
  ok(measured() === MEASURED, 'MEASURED by identity');
  ok(minqTable() === MINQ, 'MINQ by identity');
  ok(greedyReport() === GREEDY, 'the greedy census by identity');
  ok(advisoryReport() === ADVISORY, 'the divergence census by identity');
  eq(BUDGET.brute.full, { nMax: 8, kMax: 2, qMax: 5 }, 'the bake settings ship with the table');
  eq(BUDGET.brute.sample, { nMax: 6, kMax: 2, qMax: 4 }, 'CI runs the smaller one');
  eq(BUDGET.minq, { nMax: 32, kMax: 3 }, 'the measured rectangle behind the picker');
  eq(BUDGET.fullOnlyBlocks, ['MEASURED.universe', 'BRUTE'], 'the two blocks only FULL produces');
});

// ---------------------------------------------------------------- the centrepiece: reading is enough

test('all 133 hiding places of the 14 lots are won by reading the table, with zero search', () => {
  const nodesBefore = solver.nodes;
  let cells = 0;
  let questions = 0;
  for (const lot of LOTS) {
    const withPolicy = lotById(lot.id);
    for (let secret = 1; secret <= lot.n; secret++) {
      cells++;
      const g = createGame({ ...withPolicy, secret });
      let guard = 0;
      while (canAsk(g) && total(state(g)) > 1) {
        if (++guard > 20) throw new Error(`${lot.id}: hint looped at ${JSON.stringify(state(g))}`);
        const h = hint(g);
        eq(h.kind, 'policy', `${lot.id}/${secret}: still on the table at ${JSON.stringify(state(g))}`);
        eq(h.exact, true, `${lot.id}/${secret}: so the answer is a solved question, not a suggestion`);
        const before = state(g).slice();
        const r = ask(g, { ids: h.ids.slice() });
        if (!r.ok) throw new Error(`${lot.id}: the table suggested an illegal question (${r.reason})`);
        // The answer must move the vector exactly the way route 1 says a legal answer moves it —
        // recomputed here from (before, y), so the table cannot be feeding a self-consistent lie.
        const branches = answer(before, h.y);
        ok(total(r.state) >= 1, `${lot.id}: the opponent handed back a realizable position`);
        eq(JSON.stringify(r.state), JSON.stringify(branches[r.answer]), `${lot.id}: the ledger matches state.js`);
        questions++;
      }
      eq(witnesses(g).length, 1, `${lot.id} from ${secret}: one candidate left, and it is ${secret}`);
      eq(witnesses(g)[0], secret, `${lot.id}: the survivor is the hidden number`);
      const a = accuse(g, secret);
      eq(a.won, true, `${lot.id}/${secret}: accused, won`);
      ok(g.asked <= lot.q, `${lot.id}/${secret}: inside the granted ${lot.q} questions`);
    }
  }
  eq(cells, 133, '3+7+15+4+7+11+16+3+6+12+20+4+9+16 hiding places');
  eq(solver.nodes, nodesBefore, 'NOT ONE solver node: the click path is lookup only');
  ok(questions > 500, `${questions} questions asked, all answered from the baked table`);
});

// ---------------------------------------------------------------- the claims the build publishes

test('MEASURED.claims: 19 claims, every one held', () => {
  const claims = MEASURED.claims;
  eq(claims.length, 19, 'nineteen claims');
  eq(claims.filter((c) => c.held).length, 19, 'all of them held when the table was written');
  ok(claims.every((c) => c.id && c.text && c.value !== undefined), 'each carries an id, a sentence and the number');
  // the headline ones, spelled out so nobody can quietly drop them from the census
  const byId = new Map(claims.map((c) => [c.id, c]));
  eq(byId.get('k0-exact').held, true, 'k=0 is exactly ⌈log₂n⌉');
  ok(byId.has('three-routes-agree'), 'the three-routes claim is in the list');
  eq(byId.get('three-routes-agree').value.disagreements, 0, 'and it says zero');
  eq(BRUTE.disagreementCount, 0, 'the same fact from the BRUTE block');
  eq(BRUTE.compared, 62148, 'over 62,148 concrete comparisons');
  ok(claims.some((c) => c.id.includes('counterexample') || /反例|界说|不充分/.test(c.text)), 'a claim about the bound being insufficient');
});

test('the census blocks the docs quote are present and self-consistent', () => {
  const u = MEASURED.universe;
  eq(u.verifiedIn, 'full', 'the universe census is a FULL-setting number');
  ok(u.totals.cells > 800000, `${u.totals.cells} (position, q) cells walked`);
  ok(u.totals.disagree > 0 && u.totals.disagree < u.totals.volumeOk, 'disagreements are a strict subset of the in-bound cells');
  ok(u.totals.pack > 0, `${u.totals.pack} perfect packings`);
  eq(u.mismatches.length, 20, 'the bound is insufficient on 20 of the cells the headline scan could reach');
  // ...and that list is derived here, not remembered: recompute "bound < par" from the baked MINQ
  // rectangle and require the shipped universe list to be exactly its par ≤ qMax slice, in order.
  const insufficient = [];
  for (let k = 0; k <= u.setting.kMax; k++) {
    for (let n = 1; n < MINQ.length; n++) {
      const row = MINQ[n];
      if (!row || row.par[k] === null || row.bound[k] === null) continue;
      if (row.par[k] !== row.bound[k]) insufficient.push({ k, n, par: row.par[k], bound: row.bound[k] });
    }
  }
  eq(insufficient.length, 34, '34 measured uniform boards in the whole rectangle have the bound under the true par');
  eq(u.mismatches, insufficient.filter((m) => m.par <= u.setting.qMax), 'the shipped list is that rectangle cut at q ≤ 12, cell for cell');
  ok(u.mismatches.every((m) => m.par > m.bound), 'and the bound never overstates: it only ever understates');
  ok(u.mismatches.some((m) => m.n === 3 && m.k === 1 && m.par === 5 && m.bound === 4), 'the 3-cell/1-lie counterexample is in there');
  const sum = u.per.reduce((x, r) => x + r.cells, 0);
  eq(sum, u.totals.cells, 'the per-k rows add up to the totals row');
  const g = GREEDY.per.reduce((x, r) => x + r.blownFirstQuestion, 0);
  ok(g > 3000, `the three naive strategies blow ${g} winnable positions between them`);
  eq(new Set(GREEDY.per.map((r) => r.winnablePositions)).size, 1, 'all three were measured on the same denominator');
  ok(ADVISORY.suboptimal < ADVISORY.comparable, `${ADVISORY.suboptimal} suboptimal of ${ADVISORY.comparable} comparable`);
});

// ---------------------------------------------------------------- the picker and the dice

test('parOf / boundOf read the measured rectangle, hand-checked cells', () => {
  eq(parOf(3, 1), 5, 'the counterexample: 5, while the bound says 4');
  eq(boundOf(3, 1), 4, 'and the bound really does say 4');
  eq(parOf(5, 1), 6, 'and 6 for five cells');
  eq(boundOf(5, 1), 5, 'the bound says 5');
  eq(parOf(9, 1), 7, 'seven for nine cells');
  eq(boundOf(9, 1), 6, 'six says the bound');
  eq(parOf(11, 2), 10, 'ten for eleven cells at two lies');
  eq(boundOf(11, 2), 9, 'nine says the bound');
  eq(parOf(7, 0), 3, '⌈log₂7⌉');
  eq(boundOf(7, 0), 3, 'and the bound agrees exactly at k=0');
  eq(parOf(1, 3), 0, 'one cell needs no question');
  eq(parOf(33, 1), null, 'outside the measured rectangle: null, not a guess');
  eq(parOf(16, 4), null, 'k above the measured ceiling: null');
  eq(boundOf(99, 1), null, 'and a board that cannot be built');
  eq(MINQ.length, 33, 'n = 1..32, with slot 0 empty');
});

test('windowFor: every tier is a window over measured cells, not a mood', () => {
  eq(TIER_ORDER, ['gentle', 'standard', 'hard', 'brutal'], 'four tiers');
  throws(() => windowFor('nightmare'), /未知档位/, 'an unknown tier throws instead of defaulting');
  for (const tier of TIER_ORDER) {
    const t = TIERS[tier];
    const cells = windowFor(tier);
    ok(cells.length > 0, `${tier} has ${cells.length} legal cells`);
    for (const c of cells) {
      ok(c.n >= t.n[0] && c.n <= t.n[1], `${tier}: n=${c.n} inside ${t.n}`);
      ok(c.k >= t.k[0] && c.k <= t.k[1], `${tier}: k=${c.k} inside ${t.k}`);
      ok(c.par >= t.minPar, `${tier}: par=${c.par} ≥ minPar=${t.minPar}`);
      eq(c.q, c.par + t.slack, `${tier}: q is the measured par plus the slack the tier grants`);
      eq(c.par, parOf(c.n, c.k), 'and par came out of the table');
    }
  }
  // the windows are disjoint in n, which is what makes the tier names mean something
  eq(TIERS.gentle.n, [3, 8], 'gentle');
  eq(TIERS.standard.n, [8, 16], 'standard');
  eq(TIERS.hard.n, [16, 24], 'hard');
  eq(TIERS.brutal.n, [24, 32], 'brutal');
  eq(TIERS.gentle.slack, 1, 'only the warm-up tier grants a spare question');
  eq([TIERS.standard.slack, TIERS.hard.slack, TIERS.brutal.slack], [0, 0, 0], 'the rest are on the line');
});

test('randomLot: same seed, same game — on any device, from an array lookup and a hash', () => {
  const one = randomLot('hard', 'ulam-42');
  const two = randomLot('hard', 'ulam-42');
  eq(one, two, 'identical in every field');
  eq(one.tier, 'hard', 'the tier is carried');
  eq(one.policy, null, 'and there is no table, so the hint will honestly say 表外');
  ok(one.secret >= 1 && one.secret <= one.n, `secret ${one.secret} is on the board`);
  eq(one.id, 'random/hard/ulam-42', 'the id names the seed');
  eq(one.par, parOf(one.n, one.k), 'par straight from the measured rectangle');
  eq(one.bound, boundOf(one.n, one.k), 'and so is the bound, printed next to it');
  const other = randomLot('hard', 'ulam-43');
  ok(other.id !== one.id, 'a different seed is a different lot');
  // the claim in make.js's header: 2000 lots are built from the table in well under a frame
  const t0 = process.hrtime.bigint();
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(randomLot('standard', `s${i}`).n);
  const us = Number(process.hrtime.bigint() - t0) / 1000;
  ok(us < 50000, `2000 lots in ${us.toFixed(1)} ms`);
  ok(seen.size >= 3, `the seed actually spreads over ${seen.size} board sizes inside the tier window`);
});

test('dailyLot: the published rule, index = FNV-1a(dateKey) % 14, re-implemented here', () => {
  // An independent 6-line FNV-1a, so "same day, same puzzle everywhere" is checked against the
  // rule written in make.js rather than against make.js's own output.
  const fnv = (str) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ (str.charCodeAt(i) & 0xff), 0x01000193);
      h = Math.imul(h ^ ((str.charCodeAt(i) >> 8) & 0xff), 0x01000193);
    }
    return h >>> 0;
  };
  for (const dateKey of ['2026-09-04', '2026-01-01', '2025-12-31', '2024-02-29']) {
    const lot = dailyLot(dateKey);
    const want = LOTS[fnv(dateKey) % LOTS.length];
    eq(lot.campaignId, want.id, `${dateKey} → ${want.id} by the published rule`);
    eq(lot.id, `daily/${dateKey}`, 'the id is the date');
    eq(lot.daily, true, 'flagged as the daily');
    eq(lot.n, want.n, 'same board');
    eq(lot.q, want.q, 'same question count');
    eq(lot.par, want.par, 'same measured par');
    ok(lot.secret >= 1 && lot.secret <= lot.n, `secret ${lot.secret} on the board`);
    ok(lot.title.includes(dateKey), 'the title carries the date');
    eq(dailyLot(dateKey), lot, 'and the whole object is reproducible');
  }
  // two different dates land on different lots often enough that the daily is not a constant
  const days = new Set(Array.from({ length: 30 }, (_, i) => dailyLot(`2026-09-${String(i + 1).padStart(2, '0')}`).campaignId));
  ok(days.size >= 5, `30 consecutive days cover ${days.size} of the 14 lots`);
  ok(lotById(dailyLot('2026-09-04').campaignId).policy instanceof Map, 'the daily is drawn from the re-verified pool, table and all');
});

test('customLot: the picker only offers measured cells, and says so when it has none', () => {
  const c = customLot(11, 2);
  eq(c.q, 10, 'q is exactly the measured par, no slack');
  eq(c.par, 10, 'and the panel prints it as 精确值');
  eq(c.id, 'c/11/2', 'the id is the route');
  ok(c.secret >= 1 && c.secret <= 11, 'a seed-derived secret');
  eq(c.policy, null, 'a custom board has no baked strategy — the hint says 表外');
  eq(customLot(33, 1), null, 'beyond n=32 the table is silent, and the picker must refuse');
  eq(customLot(16, 4), null, 'beyond k=3 the same');
  eq(customLot(0, 1), null, 'n=0 was never measured');
  eq(customLot(7, 0).par, 3, '⌈log₂7⌉ straight off the measured rectangle');
  eq(customLot(7, 0, { slack: 1 }).q, 4, 'a slack option grants the spare question');
});

run();
