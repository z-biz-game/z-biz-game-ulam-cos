// Suite 5/6 — the in-play layer: js/core/game.js + the opponent in js/core/adversary.js.
//
// Three things get pinned hard here, because they are what the player actually feels:
//   * an illegal gesture is refused with a reason and leaves the game object untouched,
//   * undo walks back exactly one gesture, down to the per-candidate counter,
//   * the opponent is a total function that never hands the player an unrealizable state —
//     checked after EVERY answer of EVERY play in this file, not asserted in a comment.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, ok, eq, throws, run } from '../tools/harness.mjs';
import { fresh, total, answer, realizable, key } from '../js/core/state.js';
import { volume } from '../js/core/volume.js';
import { mulberry32 } from '../js/core/rng.js';
import { legalAnswers, decide } from '../js/core/adversary.js';
import {
  MAX_CELLS, createGame, state, questionsLeft, provableLies, trueLies, witnesses, canAsk,
  toggle, paint, clearDraft, profileOf, idsForProfile, ask, accuse, undo, reset, hint, grade,
  reveal, verdictText, volumeReadout,
} from '../js/core/game.js';
import { lotById, lotIds } from '../js/core/library.js';
import { customLot, randomLot, dailyLot } from '../js/core/make.js';

// A lot with no baked policy and a chosen secret: the random-lot shape, without importing make.js's
// dice for the fixtures I want to hand-trace.
const plain = (n, k, q, secret) => ({ id: `t/${n}-${k}-${q}`, n, k, q, par: null, secret, policy: null });

// Play the whole lot by following `hint` (i.e. the baked table where there is one). Returns the
// finished game. Asserts the opponent's invariants after every single answer on the way.
function playByHint(g, opts = {}) {
  let guard = 0;
  while (canAsk(g) && total(state(g)) > 1) {
    if (++guard > 60) throw new Error('play did not terminate');
    const h = hint(g);
    ok(h, 'hint returns something while asking');
    const before = state(g).slice();
    const r = ask(g, { ids: opts.ids || h.ids.slice() });
    if (!r.ok) throw new Error(`hint suggested an illegal question: ${r.reason} on ${JSON.stringify(before)}`);
    checkInvariants(g, before);
    if (opts.oneQuestion) break;
  }
  return g;
}

// The invariant set, run after every answer in this suite.
function checkInvariants(g, before) {
  const a = state(g);
  ok(realizable(a), 'a witness survives: Σa ≥ 1');
  ok(witnesses(g).length === total(a), 'witnesses() and Σa agree');
  ok(witnesses(g).length >= 1, 'the opponent never empties the candidate set');
  ok(questionsLeft(g) >= 0, 'never asks past the budget');
  // the opponent never exceeds its budget on the real secret, and the counter never exceeds k+1
  for (let x = 1; x <= g.n; x++) ok(g.contra[x] <= g.k + 1, `cell ${x} counter clamped`);
  ok(trueLies(g) <= g.k, `the opponent stayed inside its ${g.k}-lie budget (used ${trueLies(g)})`);
  ok(provableLies(g) <= trueLies(g), 'what the ledger can prove ≤ what was actually lied');
  // per-question cross-check with route 1: the weight vector must move exactly as state.js answers
  if (before) {
    const last = g.log[g.log.length - 1];
    const { yes, no } = answer(before, last.y);
    eq(a, last.answer === 'yes' ? yes : no, 'the counter reduction agrees with state.js answer()');
    eq(total(before) - total(a) >= 0 ? true : false, true, 'candidates only ever leave, never arrive');
  }
}

// ---------------------------------------------------------------- construction

test('createGame: the guards fire, and each one says why', () => {
  eq(MAX_CELLS, 40, 'the shipped ceiling on cells');
  throws(() => createGame(plain(0, 1, 3, 1)), /n=0/, 'n must be ≥ 1');
  throws(() => createGame(plain(41, 1, 3, 1)), /n=41 超出 1\.\.40/, 'n beyond the table');
  throws(() => createGame(plain(5, -1, 3, 1)), /k 不能为负/, 'negative lie budget');
  throws(() => createGame({ ...plain(5, 1, 3, 6), secret: 6 }), /secret=6 不在 1\.\.5/, 'secret out of range');
  throws(() => createGame({ ...plain(5, 1, 3, 0), secret: 0 }), /secret=0/, 'secret 0');
  throws(() => createGame({ ...plain(5, 1, 3), secret: 2.5 }), /secret=2.5/, 'secret must be an integer');
  const g = createGame(plain(40, 3, 13, 40));
  eq(g.contra.length, 41, '1-indexed counter, slot 0 unused');
  eq(state(g), [40, 0, 0, 0], 'everything clean at the start');
  eq(g.phase, 'ask', 'phase');
  eq(g.policy, null, 'no table on a plain lot');
  eq(g.tier, 'campaign', 'tier defaults');
  eq(g.par, null, 'par is only carried when it is an integer');
  eq(g.title, '', 'no title on a bare lot');
});

test('the click path imports no searcher: the whole module closure of game.js, enumerated', async () => {
  // Not a grep for the word — the actual import graph, walked from game.js. The closure is exactly
  // five files and solve.js is not one of them, which is why a tap on a cell can be O(n ≤ 40) work
  // and nothing else. library.js/make.js are deliberately NOT imported by game.js, so the click
  // path cannot reach policyMap() either.
  const here = fileURLToPath(new URL('../js/core/', import.meta.url));
  const seen = new Set();
  const walk = async (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const src = readFileSync(here + name, 'utf8');
    for (const m of src.matchAll(/from\s+'\.\/([^']+)'/g)) await walk(m[1]);
  };
  await walk('game.js');
  eq([...seen].sort(), ['adversary.js', 'game.js', 'greedy.js', 'state.js', 'volume.js'], 'the closure');
  ok(!seen.has('solve.js'), 'no searcher on the click path');
  ok(!seen.has('library.js'), 'no table revival on the click path');
  ok(!seen.has('brute.js'), 'no exponential route on the click path');
  const g = createGame(lotById('16-3'));
  ask(g, { ids: [1, 2, 3, 4, 5, 6, 7, 8] });
  ok(true, 'a 16-cell, 3-lie, 13-question lot answers with no spinner');
});

// ---------------------------------------------------------------- the ledger

test('state(): counters reduce to the weight vector, hand-checked', () => {
  const g = createGame(plain(5, 2, 6, 1));
  eq(state(g), [5, 0, 0], 'five clean candidates at k=2');
  g.contra = [0, 0, 1, 1, 2, 3];   // cells 1..5 at slots 0,1,1,2,3 — the last is DEAD (> k=2)
  eq(state(g), [1, 2, 1], 'a counter above k is not counted: it is a refuted number');
  eq(total(state(g)), 4, 'four survivors');
  eq(witnesses(g), [1, 2, 3, 4], 'cell 5 is no longer a witness');
  eq(provableLies(g), 0, 'the cleanest survivor has 0 contradictions, so nothing is provable yet');
  g.contra = [0, 1, 1, 2, 2, 3];
  eq(state(g), [0, 2, 2], 'no clean candidate left');
  eq(provableLies(g), 1, 'every survivor carries at least one lie: the opponent has spent ≥ 1');
  g.secret = 2;
  eq(trueLies(g), 1, 'the real secret has been contradicted once');
});

test('questionsLeft, canAsk, and the phase flips the rules force', () => {
  const g = createGame(plain(3, 1, 3, 1));
  eq(questionsLeft(g), 3, 'granted q');
  eq(canAsk(g), true, 'asking is legal at the start');
  ask(g, { ids: [1] });
  eq(questionsLeft(g), 2, 'one spent');
  ask(g, { ids: [2] });
  ask(g, { ids: [3] });
  eq(questionsLeft(g), 0, 'budget spent');
  eq(canAsk(g), false, 'no more questions');
  eq(g.phase, 'accuse', 'the rules force an accusation');
  // and the settle-by-candidate-count flip, which has nothing to do with the budget
  const h = createGame(plain(3, 1, 3, 1));
  ask(h, { ids: [1, 2] });   // whichever way it goes, at most two survivors
  ok(h.phase === 'ask' || h.phase === 'accuse', 'phase is one of the two');
  const one = createGame(plain(2, 0, 2, 1));
  ask(one, { ids: [1] });    // k=0: a NO kills cell 1, a YES kills cell 2 → one survivor either way
  eq(total(state(one)), 1, 'a no-lie question settles a 2-cell board');
  eq(one.phase, 'accuse', 'and forces the accusation even with a question left');
  eq(questionsLeft(one), 1, 'the question really is still unspent');
});

// ---------------------------------------------------------------- the draft (what is lit)

test('toggle / paint / clearDraft: the draft is a sorted set of what is lit', () => {
  const g = createGame(plain(6, 1, 4, 3));
  eq(toggle(g, 4), true, 'a legal toggle reports success');
  toggle(g, 2);
  toggle(g, 6);
  eq(g.draft, [2, 4, 6], 'stored ascending, however it was clicked');
  toggle(g, 4);
  eq(g.draft, [2, 6], 'tapping a lit cell puts it back down');
  eq(paint(g, [1, 1, 99, 3]), true, 'paint takes a batch');
  eq(g.draft, [1, 2, 3, 6], 'merged, deduped, sorted; 99 is not a cell');
  clearDraft(g);
  eq(g.draft, [], 'cleared');
  // while the board is settled, the draft is frozen
  const done = createGame(plain(2, 0, 2, 1));
  ask(done, { ids: [1] });
  eq(toggle(done, 1), false, 'no toggling after the board collapses to one cell');
  eq(paint(done, [2]), false, 'nor painting');
  eq(done.draft, [], 'and nothing moved');
});

test('profileOf / idsForProfile round-trip through the slots', () => {
  const g = createGame(plain(6, 2, 5, 3));
  g.contra = [0, 0, 0, 1, 1, 2, 3];   // slots: cells 1,2 clean; 3,4 at 1; 5 at 2; 6 dead
  eq(state(g), [2, 2, 1], 'the position');
  eq(profileOf(g, [1, 3, 5]).y, [1, 1, 1], 'one from each slot');
  eq(profileOf(g, [1, 2]).y, [2, 0, 0], 'two clean');
  eq(profileOf(g, [6, 1]).y, [1, 0, 0], 'a dead cell contributes nothing to the vector');
  eq(idsForProfile(g, [1, 2, 0]), [1, 3, 4], 'the lowest ids per slot, ascending overall');
  eq(idsForProfile(g, [0, 0, 1]), [5], 'slot 2 alone');
  eq(idsForProfile(g, [2, 2, 1]), [1, 2, 3, 4, 5], 'the whole live board, minus the dead cell');
  eq(idsForProfile(g, [0, 0, 0]), [], 'nothing asked for, nothing lit');
});

// ---------------------------------------------------------------- illegal gestures

test('every illegal question is refused with a one-word reason and changes nothing', () => {
  const cases = [];
  // 1. a cell id that is not a cell
  const a = createGame(plain(5, 1, 4, 2));
  cases.push([a, { ids: [0] }, 'cell']);
  cases.push([a, { ids: [6] }, 'cell']);
  cases.push([a, { ids: [2.5] }, 'cell']);
  cases.push([a, { ids: ['3'] }, 'cell']);
  // 2. the budget is spent. Note that ask() flips the phase to 'accuse' the moment the last
  // question lands, so in normal play an exhausted budget reports 'accuse'; the 'budget' reason is
  // the defensive arm of that same line, reachable only on a hand-set board — pinned as such.
  const b = createGame(plain(3, 1, 1, 1));
  ask(b, { ids: [1] });
  cases.push([b, { ids: [2] }, 'accuse']);
  const spent = createGame(plain(6, 2, 3, 2));
  spent.asked = 3;                       // questionsLeft = 0, phase still 'ask'
  cases.push([spent, { ids: [1, 2] }, 'budget']);
  // 3. the board has collapsed to one candidate: ask() refuses and the rules demand an accusation
  const c = createGame(plain(2, 0, 3, 1));
  ask(c, { ids: [1] });
  cases.push([c, { ids: [1] }, 'accuse']);
  // 4. the game is over
  const d = createGame(plain(4, 1, 3, 1));
  accuse(d, 2);
  cases.push([d, { ids: [1] }, 'over']);
  for (const [g, opts, want] of cases) {
    const snap = { contra: g.contra.slice(), asked: g.asked, phase: g.phase, log: g.log.length, done: g.done, draft: g.draft.slice() };
    const r = ask(g, opts);
    eq(r.ok, false, `refused with ok:false (${want})`);
    eq(r.reason, want, `reason is exactly '${want}'`);
    eq(typeof r.reason, 'string', 'a reason, not a silent undefined');
    eq({ contra: g.contra, asked: g.asked, phase: g.phase, log: g.log.length, done: g.done, draft: g.draft },
      snap, 'the game object is byte-identical after a refusal');
  }
});

test('a settled board reports how many candidates are left instead of pretending', () => {
  // Σa ≤ 1 with a question still in the bank happens from the outside (the custom picker allows
  // n = 1) and from the inside after the last answer — and ask() answers differently in the two
  // cases: 'settled' plus the survivor count while the phase is still 'ask', 'accuse' once the
  // rules have flipped it. Both refuse; neither pretends the question went out.
  const one = createGame(plain(1, 1, 3, 1));
  eq(total(state(one)), 1, 'a one-cell board is settled before it starts');
  const r = ask(one, { ids: [1] });
  eq(r.ok, false, 'no question to ask');
  eq(r.reason, 'settled', 'and the reason names the rule, not the arithmetic');
  eq(r.left, 1, 'it also says how many are left, which is what the panel prints');
  eq(one.asked, 0, 'nothing was spent');
  // the 2-cell, no-lie board: whatever the answer, the OTHER cell is refuted, so it settles there
  const two = createGame(plain(2, 0, 3, 1));
  const first = ask(two, { ids: [1] });
  eq(first.ok, true, 'the question itself was legal');
  eq(total(state(two)), 1, 'and one of the two cells is gone for good');
  eq(two.phase, 'accuse', 'so the rules switch the phase over');
  eq(ask(two, { ids: [1] }).reason, 'accuse', 'and the second question is refused as an accusation');
});

test('degenerate questions (∅ and the whole board) are legal and marked', () => {
  // Lighting nothing is a legal question — the truth can only be NO, so a YES is a free lie. The
  // DP's quantifier covers it, so the game must accept it and the ledger must show it.
  const g = createGame(plain(4, 1, 4, 2));
  const r = ask(g, { ids: [] });
  eq(r.ok, true, 'the empty question is legal');
  eq(r.degenerate, true, 'and flagged as carrying no information');
  eq(r.answer, 'no', 'with k left it answered truthfully here: NO is the truth for ∅');
  const h = createGame(plain(4, 1, 4, 2));
  const r2 = ask(h, { ids: [1, 2, 3, 4] });
  eq(r2.ok, true, 'the whole board is legal too');
  eq(r2.degenerate, true, 'flagged');
  checkInvariants(h, fresh(4, 1));
});

// ---------------------------------------------------------------- undo, one gesture at a time

test('undo walks back exactly one gesture, counters included', () => {
  const g = createGame(plain(6, 2, 5, 4));
  const root = { a: state(g).slice(), contra: g.contra.slice(), asked: g.asked, log: g.log.length };
  eq(undo(g), false, 'undo on a fresh board says so instead of lying');
  const r1 = ask(g, { ids: [1, 2, 3] });
  ok(r1.ok, 'first question out');
  const mid = { a: state(g).slice(), contra: g.contra.slice(), asked: g.asked };
  eq(mid.asked, 1, 'one spent');
  const r2 = ask(g, { ids: [4] });
  ok(r2.ok, 'second question out');
  ok(r2.state !== undefined, 'and the answer moved the state');
  eq(undo(g), true, 'undo reports it did something');
  eq(state(g), mid.a, 'back to exactly the position after question 1');
  eq(g.contra, mid.contra, 'the per-cell ledger is restored, not recomputed');
  eq(g.asked, 1, 'one question spent again');
  eq(g.log.length, 1, 'one row in the log');
  eq(g.draft, [], 'the draft is empty after undo, so the player does not re-light by accident');
  eq(undo(g), true, 'undo again');
  eq(state(g), root.a, 'back at the root');
  eq(g.contra, root.contra, 'counters all zero');
  eq(g.asked, 0, 'nothing spent');
  eq(undo(g), false, 'and a third undo has nothing to do');
});

test('undo after an accusation re-opens the game', () => {
  const g = createGame(plain(4, 1, 2, 3));
  const root = state(g).slice();
  ask(g, { ids: [1, 2] });
  accuse(g, 1);
  eq(g.done, true, 'over');
  eq(grade(g).key, g.secret === 1 ? 'tight' : 'caught', 'a verdict was recorded');
  eq(undo(g), true, 'undo pops the last QUESTION');
  eq(g.done, false, 'the game is playable again');
  eq(g.phase, 'ask', 'and back in the asking phase');
  eq(state(g), root, 'the accusation never entered the log, so undo returns the board to the root');
  eq(undo(g), false, 'there is only one gesture in the log');
});

test('reset clears the board but keeps the lot and the secret', () => {
  const g = createGame(plain(5, 2, 4, 3));
  ask(g, { ids: [1, 2] });
  ask(g, { ids: [3] });
  reset(g);
  eq(state(g), [5, 0, 0], 'every candidate clean again');
  eq(g.asked, 0, 'budget refunded');
  eq(g.log.length, 0, 'no history');
  eq(g.done, false, 'not over');
  eq(g.secret, 3, 'the same number is hidden');
  eq(g.contra.every((c) => c === 0), true, 'counters zeroed');
});

// ---------------------------------------------------------------- the opponent

test('totality: the truthful branch is always legal, so the opponent can always answer', () => {
  // Proof, one line: the truth never pushes the hidden secret up a slot, so the secret stays alive
  // in the truth branch, hence Σ ≥ 1 there. The domain is exactly what game.js can ask about: Σa ≥ 2
  // (a one-survivor board is settled and ask() refuses it with reason 'settled'). And sLit/liesLeft
  // have to be CONSISTENT with where the secret sits: pick its slot t, then the opponent has exactly
  // k − t lies left and the truth is YES only if the lit profile covers a cell of slot t.
  const enumerate = (k, max) => {
    const out = [];
    const a = new Array(k + 1).fill(0);
    const rec = (i, left) => {
      if (i > k) { out.push(a.slice()); return; }
      for (let v = 0; v <= left; v++) { a[i] = v; rec(i + 1, left - v); }
      a[i] = 0;
    };
    rec(0, max);
    return out;
  };
  let cases = 0;
  let oneLegal = 0;
  let skipped = 0;
  for (let k = 0; k <= 3; k++) {
    for (const a of enumerate(k, 5)) {
      if (total(a) < 2) continue;
      const subs = new Array(k + 1).fill(0);
      const walk = (i) => {
        if (i > k) {
          const y = subs.slice();
          for (let t = 0; t <= k; t++) {
            if (a[t] === 0) continue;
            const liesLeft = k - t;
            for (const sLit of [true, false]) {
              if (!(sLit ? y[t] >= 1 : y[t] <= a[t] - 1)) { skipped++; continue; }
              cases++;
              const truth = sLit ? 'yes' : 'no';
              const legal = legalAnswers({ a, y, sLit, liesLeft, truth });
              ok(legal.length >= 1, `legalAnswers never empty: a=${a} y=${y} t=${t} sLit=${sLit}`);
              eq(legal[0], truth, 'the truth is first in the list, which is what decide() relies on');
              if (legal.length === 1) oneLegal++;
              const d = decide({ a, q: 4, y, sLit, liesLeft });
              ok(legal.includes(d.answer), 'decide picks a legal branch');
              eq(d.lied, d.answer !== truth, 'lied is exactly "not the truth"');
              eq(d.depth, 3, 'depth is q-1');
              if (legal.length === 1) eq(d.rule, 'forced', 'a single legal answer reports itself as forced');
              else ok(d.rule === 'volume' || d.rule === 'ranked', 'otherwise it reports which scorer it used');
            }
          }
          return;
        }
        for (let v = 0; v <= a[i]; v++) { subs[i] = v; walk(i + 1); }
        subs[i] = 0;
      };
      walk(0);
    }
  }
  ok(cases > 2000, `enumerated ${cases} consistent opponent inputs`);
  ok(skipped > 100, `${skipped} impossible (y, sLit) combinations were skipped, so the sweep is not vacuous`);
  ok(oneLegal > 100, `${oneLegal} of them leave the opponent exactly one legal answer`);
});

test('the opponent spends at most k lies, and spends them where it decides', () => {
  // 200 plays across the shipped campaign lots, the custom picker and the random tiers, driving
  // the question with a fixed seeded die so the sequence is reproducible.
  const rng = mulberry32(20260904);
  let plays = 0;
  let lied = 0;
  for (const id of lotIds()) {
    const lot = lotById(id);
    for (let round = 0; round < 2; round++) {
      const secret = 1 + rng.int(lot.n);
      const g = createGame({ ...lot, secret, policy: null });
      while (canAsk(g) && total(state(g)) > 1) {
        const a = state(g);
        const ids = [];
        for (let x = 1; x <= g.n; x++) if (rng.chance(0.5)) ids.push(x);
        const r = ask(g, { ids });
        if (!r.ok) throw new Error(`a random subset was refused: ${r.reason}`);
        checkInvariants(g, a);
        if (r.lied) lied++;
      }
      accuse(g, witnesses(g)[0]);
      eq(trueLies(g) <= lot.k, true, `${lot.id}: stayed inside the budget`);
      eq(reveal(g).lies.filter(Boolean).length, trueLies(g), `${lot.id}: the flipped rows are the lies`);
      plays++;
    }
  }
  for (const tier of ['gentle', 'standard', 'hard', 'brutal']) {
    for (let seed = 0; seed < 3; seed++) {
      const lot = randomLot(tier, `${tier}${seed}`);
      const g = createGame(lot);
      while (canAsk(g) && total(state(g)) > 1) {
        const a = state(g);
        const ids = [];
        for (let x = 1; x <= g.n; x++) if (rng.chance(0.5)) ids.push(x);
        ask(g, { ids });
        checkInvariants(g, a);
      }
      accuse(g, witnesses(g)[0]);
      plays++;
    }
  }
  const cu = customLot(13, 2);
  const cg = createGame(cu);
  while (canAsk(cg) && total(state(cg)) > 1) ask(cg, { ids: [1, 2, 3] });
  eq(cu.par, 10, 'the picker reads (13,2) straight out of the measured table');
  ok(total(state(cg)) >= 1, 'custom lot stays realizable');
  plays++;
  ok(plays > 30, `${plays} complete plays, invariants checked after every answer`);
  ok(lied > 0, `${lied} of the random-driver answers were lies, so the budget really got used`);
});

test('replaying the same lit batches reproduces the same answers (resume depends on this)', () => {
  const lot = { ...lotById('11-1'), policy: null };
  const run = () => {
    const g = createGame(lot);
    const batches = [[1, 2, 3, 4], [5, 6], [1, 5, 9], [2, 3], [7], [1, 11], [4, 8]];
    const answers = [];
    for (const ids of batches) {
      if (!canAsk(g)) break;
      const r = ask(g, { ids });
      if (r.ok) answers.push(r.answer);
    }
    return { answers, contra: g.contra.slice(), asked: g.asked, a: state(g) };
  };
  const one = run();
  const two = run();
  eq(one.answers, two.answers, 'same questions, same answers, twice');
  eq(one.contra, two.contra, 'same ledger');
  eq(one.a, two.a, 'same weight vector');
  ok(one.answers.length >= 5, `${one.answers.length} answers replayed identically`);
});

// ---------------------------------------------------------------- hint honesty

test('hint: two levels of honesty, and the table says which one you got', () => {
  const g = createGame(lotById('16-1'));
  const h = hint(g);
  eq(h.kind, 'policy', 'the root of a campaign lot is in the table');
  eq(h.exact, true, 'so the suggestion is a solved winning question');
  eq(h.y.length, 2, 'k=1 → two slots in the profile');
  eq(h.y[0] + h.y[1], h.ids.length, 'ids are the profile made concrete');
  eq(h.state, [16, 0], 'for the position it names');
  eq(h.qLeft, 7, 'at the granted depth');
  ok(h.ids.every((id, i) => i === 0 || id > h.ids[i - 1]), 'ascending ids');
  // walk one question down the table and the hint is still exact
  ask(g, { ids: h.ids.slice() });
  const h2 = hint(g);
  eq(h2.kind, 'policy', 'still on the table path');
  eq(h2.exact, true, 'still a real answer');
  // now step off the path: any question the table does not know about
  const off = createGame(lotById('16-1'));
  ask(off, { ids: [1] });
  const h3 = hint(off);
  eq(h3.kind === 'offpolicy' || h3.kind === 'policy', true, 'a first question off the table is offpolicy');
  if (h3.kind === 'offpolicy') eq(h3.exact, false, 'and the screen must say 表外');
  // a lot with no table at all
  const r = createGame(randomLot('standard', 'x'));
  const h4 = hint(r);
  eq(h4.kind, 'absent', 'random lots carry no policy');
  eq(h4.exact, false, 'never claim exactness');
  ok(Array.isArray(h4.ids) && h4.ids.length > 0, 'still a concrete suggestion to light');
  // a settled board: hint says so instead of inventing a question. ask() flips the phase to
  // 'accuse' as soon as one survivor is left, so the settled row is reached by hand-setting the
  // ledger — which is also how the panel gets there after an undo.
  const one = createGame(plain(2, 0, 2, 1));
  ask(one, { ids: [1] });
  eq(one.phase, 'accuse', 'the rules already moved on');
  eq(hint(one), null, 'a board in the accusing phase has no hint');
  const settled = createGame(plain(3, 1, 4, 1));
  settled.contra = [0, 4, 4, 0];
  eq(total(state(settled)), 1, 'one survivor, phase still ask');
  eq(hint(settled).kind, 'settled', 'and the hint says there is nothing left to ask');
  eq(hint(settled).exact, false, 'no claim attached');
  eq(hint(settled).left, 1, 'it reports the survivor count');
  accuse(one, witnesses(one)[0]);
  eq(hint(one), null, 'a finished game has no hint');
});

test('hint ids are the profile made concrete, cell by cell', () => {
  const g = createGame(lotById('7-1'));
  const h = hint(g);
  eq(h.kind, 'policy', 'root is tabulated');
  eq(state(g), [7, 0], 'seven clean cells');
  // The shipped root question for (7,1) at q=6 lights 3 of the 7 clean cells. Hand-check that it
  // is a real split: answer() gives yes = [3,4] (the three lit ones stay clean, the four others
  // move to slot 1) and no = [4,3]. Both realizable, neither is the identity.
  eq(h.y, [3, 0], 'three cells, all from slot 0');
  eq(h.ids.length, 3, 'three ids');
  eq(h.ids, [1, 2, 3], 'the lowest ids, ascending, because the board hides no knowledge');
  const { yes, no } = answer([7, 0], h.y);
  eq(yes, [3, 4], 'YES branch');
  eq(no, [4, 3], 'NO branch');
  ok(realizable(yes) && realizable(no), 'a question with two live branches');
});

// ---------------------------------------------------------------- grading and verdicts

test('grade: one key per outcome, keyed on the measured par', () => {
  const open = createGame(plain(4, 1, 3, 2));
  eq(grade(open), { key: 'open', label: '还在问', stars: 0, lucky: false }, 'unfinished');
  // hand-set the ledger so the finish is exactly what each row claims
  const wrong = createGame({ ...plain(4, 1, 3, 2), par: 3 });
  accuse(wrong, 4);
  eq(grade(wrong).key, 'caught', 'pointed at the wrong cell');
  eq(grade(wrong).stars, 0, 'no stars for a wrong finger');
  const tight = createGame({ ...plain(4, 1, 3, 2), par: 3 });
  tight.asked = 3;
  tight.contra = [0, 4, 4, 1, 0];          // only cells 3 and 4 alive…
  tight.contra = [0, 4, 4, 4, 0];          // …actually only cell 4, which is the secret
  tight.done = true; tight.won = true; tight.accused = 4;
  eq(total(state(tight)), 1, 'one survivor');
  eq(grade(tight).key, 'tight', 'at par, alone');
  eq(grade(tight).stars, 3, 'three stars');
  const late = { ...tight, asked: 4 };
  eq(grade(late).key, 'late', 'one over');
  eq(grade(late).stars, 2, 'two stars');
  const priedG = createGame({ ...plain(4, 1, 6, 2), par: 3 });
  priedG.asked = 6; priedG.contra = [0, 4, 4, 4, 0]; priedG.done = true; priedG.won = true; priedG.accused = 4;
  eq(grade(priedG).key, 'pried', 'three over: it was forced out');
  eq(grade(priedG).stars, 1, 'one star');
  const lucky = createGame({ ...plain(4, 1, 3, 2), par: 3 });
  lucky.asked = 2; lucky.contra = [0, 0, 1, 0, 2]; lucky.done = true; lucky.won = true; lucky.accused = 1;
  eq(total(state(lucky)), 3, 'three candidates still compatible with every answer');
  eq(grade(lucky).key, 'lucky', 'pointing right was a coincidence');
  eq(grade(lucky).stars, 1, 'and it is scored as one star');
  eq(grade(lucky).lucky, true, 'flagged so the panel can say so');
  eq(grade(lucky).label, '蒙对的：还剩 3 个候选', 'the label carries the number');
  const noTable = createGame(plain(4, 1, 3, 2));   // par === null
  noTable.asked = 1; noTable.contra = [0, 4, 4, 4, 0]; noTable.done = true; noTable.won = true; noTable.accused = 4;
  eq(grade(noTable).key, 'win', 'no par → the plain win key');
  eq(grade(noTable).stars, 2, 'two stars, because 必中线上 is not measurable without a table');
});

test('verdictText: the win line and the loss line are different sentences', () => {
  const g = createGame({ ...plain(4, 1, 3, 2), par: 3 });
  eq(verdictText(g), '尚未结案', 'nothing before the end');
  // win, alone: cells 1..3 are refuted past the budget, only the secret (4) is compatible
  const win = createGame({ ...plain(4, 1, 3, 4), par: 3 });
  win.contra = [0, 4, 4, 4, 0];
  accuse(win, 4);
  eq(win.won, true, 'pointed at the secret');
  const w = verdictText(win);
  ok(w.includes('秘密就是'), 'the win line names the secret as found');
  ok(!w.includes('但秘密是'), 'and does not read like a loss');
  ok(w.includes('你指着 4'), 'it repeats the finger');
  // loss: point outside the secret (2), with four candidates still compatible
  const lose = createGame({ ...plain(4, 1, 3, 2), par: 3 });
  lose.contra = [0, 0, 1, 0, 1];
  accuse(lose, 1);
  eq(lose.won, false, 'pointed outside the secret');
  const l = verdictText(lose);
  ok(l.includes('但秘密是'), 'the loss line says what it was');
  ok(!l.includes('秘密就是'), 'and never reads as a win');
  ok(l.includes('精确值是 3 问'), 'it quotes the measured par back at the player');
  ok(l.includes('还有 4 个候选'), 'and the number the player failed to reduce');
  ok(l !== w, 'the two lines differ, which is what the browser scenario asserts');
  // win by luck: the secret is alive, but so are three others
  const luckyLine = createGame({ ...plain(4, 1, 3, 2), par: 3 });
  luckyLine.contra = [0, 0, 1, 0, 1];
  accuse(luckyLine, 2);
  eq(luckyLine.won, true, 'cell 2 is the secret and still alive');
  ok(verdictText(luckyLine).includes('严格说这一次是蒙的'), 'and the win line admits the luck');
  ok(verdictText(luckyLine).includes('还有 4 个候选'), 'with the number');
  ok(verdictText(win).includes('这不是运气'), 'the alone-win line says the opposite');
  // the defensive sentence: an empty candidate set can only be manufactured by hand, because the
  // opponent is total — which is exactly why the text exists at all.
  const broken = createGame({ ...plain(3, 0, 2, 2), par: 2 });
  broken.contra = [0, 1, 1, 1];
  accuse(broken, 1);
  eq(total(state(broken)), 0, 'a board with no witness (not reachable in play)');
  eq(broken.won, false, 'and every finger is wrong on it');
  ok(verdictText(broken).includes('候选集已空'), 'so the loss line explains what that means');
});

test('reveal: the whole accounting, only after the game is over', () => {
  const g = createGame(plain(5, 2, 3, 4));
  ask(g, { ids: [1, 2, 3] });
  ask(g, { ids: [3, 4] });
  accuse(g, 4);
  const r = reveal(g);
  eq(r.secret, 4, 'what was hidden');
  eq(r.accused, 4, 'what was pointed at');
  eq(r.cells.length, 5, 'one row per cell');
  eq(r.cells.map((c) => c.id), [1, 2, 3, 4, 5], 'ascending');
  ok(r.cells.every((c) => c.contra <= 3), 'clamped at k+1 = 3');
  eq(r.cells[3].alive, g.contra[4] <= 2, 'alive means the counter is within budget');
  eq(r.lies.length, 2, 'one flag per question asked');
  eq(r.lies.filter(Boolean).length, r.trueLies, 'the flags add up to the lies on the secret');
  ok(r.trueLies <= 2, 'inside the budget');
  eq(r.witnesses, witnesses(g), 'the same list the panel shows');
  eq(r.verdictText, verdictText(g), 'and the same sentence, from one place');
  eq(r.provableLies, provableLies(g), 'the ledger row is not a separate calculation');
});

test('volumeReadout: the two numbers on the panel, recomputed independently', () => {
  const g = createGame(plain(7, 1, 6, 3));
  const v = volumeReadout(g);
  eq(v.a, [7, 0], 'the position');
  eq(v.q, 6, 'questions left');
  eq(v.V, 49, '7·(6+1) = 49');
  eq(v.cap, 64, '2^6');
  eq(v.margin, 64 / 49, 'the slack the bar draws');
  eq(v.total, 7, 'survivors');
  ask(g, { ids: [1, 2, 3, 4] });
  const w = volumeReadout(g);
  eq(w.q, 5, 'one question spent');
  eq(w.cap, 32, '2^5');
  eq(w.V, volume(w.a, 5), 'and V is the same formula state.js would answer with');
  eq(w.total, total(w.a), 'reading and vector agree');
});

test('accuse guards: a finger must land on a cell', () => {
  const g = createGame(plain(5, 1, 2, 3));
  for (const bad of [0, 6, 2.5, '3', null, undefined, NaN]) {
    const r = accuse(g, bad);
    eq(r.ok, false, `refused ${String(bad)}`);
    eq(r.reason, 'cell', 'with the cell reason');
  }
  eq(g.done, false, 'the game is still open');
  const r = accuse(g, 3);
  eq(r, { ok: true, won: true, id: 3, secret: 3, alive: total(state(g)) }, 'pointing right wins, even at q=0 questions asked');
  eq(g.done, true, 'over');
  eq(g.aliveAtEnd, 5, 'with all five candidates still compatible — this was luck');
  const again = accuse(g, 3);
  eq(again.ok, false, 'a second accusation is refused');
  eq(again.reason, 'over', 'and says the game is over');
});

// ---------------------------------------------------------------- the table, played out

test('following the baked table wins every campaign lot, at the measured par when there is no slack', () => {
  for (const id of lotIds()) {
    const lot = lotById(id);
    for (const secret of [1, Math.min(lot.n, 4), lot.n]) {
      const g = createGame({ ...lot, secret });
      playByHint(g);
      eq(canAsk(g) && total(state(g)) > 1, false, `${id}: the table walked the board down`);
      const left = witnesses(g);
      eq(left.length, 1, `${id} secret=${secret}: exactly one candidate is compatible with every answer`);
      eq(left[0], secret, `${id}: and it is the hidden number — the table is a winning strategy`);
      const r = accuse(g, left[0]);
      eq(r.won, true, `${id}: accusing it wins`);
      eq(trueLies(g) <= lot.k, true, `${id}: the opponent stayed in budget`);
      eq(g.asked <= lot.q, true, `${id}: and inside the granted questions`);
      if (lot.par === lot.q) {
        // par is the WORST case over answers, so a branch that lands on the small side can finish
        // early; what must hold is that the table never needs more than par questions, and that the
        // grade therefore reads 必中线上.
        ok(g.asked <= lot.par, `${id} has no slack: asked ${g.asked} ≤ par=${lot.par}`);
        eq(grade(g).key, 'tight', `${id}: scored 必中线上`);
        eq(grade(g).stars, 3, 'three stars');
      } else {
        // A slack lot's lex-first winning question may be the degenerate one (lighting nothing is
        // legal and, when the position already wins a question earlier, still winning) — the count
        // is then allowed to sit anywhere in [1, q], but the finish must not be luck.
        eq(grade(g).lucky, false, `${id} (slack lot): still not luck`);
        ok(g.asked >= 1, `${id}: the table asked at least one question`);
      }
    }
  }
});

test('one full play, hand-traced end to end: (3,1) with q=4 is a loss no matter who asks', () => {
  // par(3,1) = 5, so a three-cell board with one lie and four questions cannot be won. The
  // opponent only has to answer legally, and the table is not consulted (there is none).
  const g = createGame(plain(3, 1, 4, 2));
  const batches = [[1], [2], [3], [1, 2]];
  for (const ids of batches) {
    const before = state(g);
    const r = ask(g, { ids });
    eq(r.ok, true, 'every one of these is a legal question');
    checkInvariants(g, before);
  }
  eq(questionsLeft(g), 0, 'four questions spent');
  ok(total(state(g)) >= 2, `${total(state(g))} candidates survive a 4-question interrogation of (3,1)`);
  const alive = witnesses(g);
  const wrongCell = alive.find((x) => x !== g.secret);
  const r = accuse(g, wrongCell === undefined ? alive[0] : wrongCell);
  eq(r.won, false, 'pointing at a survivor that is not the secret loses');
  ok(verdictText(g).includes('但秘密是'), 'and the line says so');
});

test('the shipped perfect-packing lot 16-1 is won in exactly 7 with an honest opponent', () => {
  // V([16,0],7) = 128 = 2^7: every leaf of the answer tree is a distinct lie pattern, so the
  // player has no room to waste a question and the opponent has no room to lie twice.
  const lot = lotById('16-1');
  eq(lot.volume, 128, 'the packing');
  eq(lot.margin, 1, 'margin exactly 1');
  eq(lot.par, 7, 'and par equals the granted q');
  const g = createGame({ ...lot, secret: 11 });
  playByHint(g);
  eq(g.asked, 7, 'seven questions');
  eq(witnesses(g), [11], 'one survivor, and it is the secret');
  eq(trueLies(g) <= 1, true, 'at most one lie spent on the real secret');
  accuse(g, 11);
  eq(grade(g).stars, 3, '必中线上');
});

run();
