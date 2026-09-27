// Suite 4/6 — route 3 alone: named candidates, no state aggregation, no bound, no carry.
//
// brute.js is the definition told literally, so its verdicts are only as expensive as 2^|S|.
// Everything expected below is either hand-traced in the comments or a count derived on paper from
// the sweep's own loops — never read back off brute's output.

import { test, ok, eq, throws, run } from '../tools/harness.mjs';
import { fresh, total } from '../js/core/state.js';
import { volume } from '../js/core/volume.js';
import { makeSolver } from '../js/core/solve.js';
import {
  makePosition, makeBrute, positionIds, positionCount, respond, subsets,
} from '../js/core/brute.js';
import { bruteAgreement } from '../js/core/table.js';
import { BRUTE, LOTS } from '../js/data/lots.js';

const b = makeBrute();

// ---------------------------------------------------------------- positions and responses

test('makePosition / positionIds / positionCount', () => {
  const pos = makePosition([3, 7, 11], 2);
  eq(positionIds(pos), [3, 7, 11], 'ids in the order given');
  eq(positionCount(pos), 3, 'three candidates');
  eq(pos.lies, [3, 0, 7, 0, 11, 0], 'flat pairs, all fresh');
  eq(pos.k, 2, 'budget carried');
  eq(b.weights(pos), [3, 0, 0], 'a fresh 3-set aggregates to [3,0,0]');
  eq(positionCount(makePosition([], 1)), 0, 'empty position');
});

test('respond: one hand-traced pair, including a candidate that dies', () => {
  // A clean, B already contradicted once, budget k=1. Ask "is it A?" (lit = {A}).
  const pos = { lies: [1, 0, 2, 1], k: 1 };
  const lit = new Set([1]);
  // YES means the secret is A: B is contradicted a second time, which k=1 does not allow → B dies.
  const yes = respond(pos, lit, true);
  eq(positionIds(yes), [1], 'YES: only A survives');
  eq(yes.lies, [1, 0], 'YES: A is still clean');
  // NO means A was the lie: A moves to slot 1, B keeps slot 1 → two survivors, both at slot k.
  const no = respond(pos, lit, false);
  eq(no.lies, [1, 1, 2, 1], 'NO: both survive, both one lie from dead');
  eq(b.weights(no), [0, 2], 'NO aggregates to [0,2]');
  eq(b.weights(yes), [1, 0], 'YES aggregates to [1,0]');
  eq(yes.k, 1, 'the budget rides along');
});

test('respond: the truncated array is the array (regression: undefined tail)', () => {
  // `next` is allocated at full width, so the "did anything drop?" test must compare the FILLED
  // count, not next.length — comparing lengths handed back [1,1,undefined,undefined] forever.
  const pos = { lies: [1, 0, 2, 1, 3, 1], k: 1 };   // B and C are one contradiction from dead
  // NO to "is it A?": A is contradicted (0 → 1, still alive), B and C answered truthfully and stay
  // at 1. Nobody dies, so this is the branch where the array width is unchanged.
  const out = respond(pos, new Set([1]), false);
  // YES to "is it A?": B and C are contradicted a second time, k=1 does not allow it, so both die
  // and the array has to shrink from width 6 to width 2.
  const kill = respond(pos, new Set([1]), true);
  eq(positionIds(kill), [1], 'only A survives a YES that contradicts B and C twice');
  eq(kill.lies.length, 2, 'array is truncated to the survivors');
  eq(kill.lies.every((x) => Number.isFinite(x)), true, 'no undefined holes');
  eq(JSON.stringify(kill.lies), '[1,0]', 'exactly [A,0]');
  eq(out.lies, [1, 1, 2, 1, 3, 1], 'the other branch moves A to slot 1 and keeps all three');
});

test('respond: the two branches partition each candidate\'s survival, by slot', () => {
  // Hand rule: a candidate at slot c survives a branch iff c + (was it contradicted by that
  // branch? 1 : 0) ≤ k. So a candidate at slot k survives EXACTLY one branch (the one that agrees
  // with it), and a candidate below slot k survives BOTH.
  const pos = { lies: [1, 0, 2, 1, 3, 2, 4, 0], k: 2 };  // slots 0,1,2,0
  for (const t of subsets([1, 2, 3, 4])) {
    const yes = respond(pos, t, true);
    const no = respond(pos, t, false);
    const ys = new Set(positionIds(yes));
    const ns = new Set(positionIds(no));
    for (const [id, c] of [[1, 0], [2, 1], [3, 2], [4, 0]]) {
      const times = (ys.has(id) ? 1 : 0) + (ns.has(id) ? 1 : 0);
      eq(times, c === pos.k ? 1 : 2, `candidate ${id} at slot ${c}, lit=${t.has(id)}`);
      // and the slot it lands on is exactly what the branch claims
      if (ys.has(id)) {
        const i = positionIds(yes).indexOf(id);
        eq(yes.lies[2 * i + 1], t.has(id) ? c : c + 1, 'YES branch slot');
      }
      if (ns.has(id)) {
        const i = positionIds(no).indexOf(id);
        eq(no.lies[2 * i + 1], t.has(id) ? c + 1 : c, 'NO branch slot');
      }
    }
    // the two branches answer different questions, so they cannot both be empty... they can:
    // total survivors ≤ 2·|S|, and each branch is a legal position on its own
    ok(positionCount(yes) + positionCount(no) <= 8, 'no branch invents candidates');
  }
});

test('subsets(): 2^n, mask order, no repeats', () => {
  eq(subsets([]).length, 1, 'the empty set is a subset of nothing');
  eq(subsets([9]).map((s) => [...s]), [[], [9]], 'one element: ∅ then {9}');
  // mask order for [1,2]: 0b00 ∅, 0b01 {1}, 0b10 {2}, 0b11 {1,2}
  eq(subsets([1, 2]).map((s) => [...s]), [[], [1], [2], [1, 2]], 'mask order, low bit = first id');
  const four = subsets([1, 2, 3, 4]);
  eq(four.length, 16, '2^4');
  eq(new Set(four.map((s) => [...s].join('-'))).size, 16, 'all distinct');
  ok(four.every((s) => s instanceof Set), 'Sets, not arrays — the game hands Sets to respond()');
  eq([...four[15]], [1, 2, 3, 4], 'last mask is the full set');
});

// ---------------------------------------------------------------- the base cases, out loud

test('terminal verdicts: nothing to point at, one thing to point at, no questions left', () => {
  eq(b.win(makePosition([], 1), 3), false, '0 candidates: false, not vacuously true');
  eq(b.win(makePosition([42], 1), 0), true, '1 candidate and no questions left: point at it');
  eq(b.win(makePosition([42], 1), 3), true, '1 candidate: win at any depth');
  eq(b.win(makePosition([1, 2], 1), 0), false, '2 candidates, 0 questions: loss');
  // one candidate already at slot k is still one candidate: it cannot be contradicted again, but
  // there is nothing left to lie about
  eq(b.win({ lies: [7, 1], k: 1 }, 0), true, 'a dead-end survivor is still a survivor');
});

test('k is part of the identity of a position (regression: 75,989 phantom disagreements)', () => {
  // Same flat array, two budgets. At k=1 the position [1,1] is par 2 (light the clean one: YES
  // leaves one survivor, NO leaves two survivors both at slot 1, and one question splits them).
  // At k=2 the same array means A clean, B at one lie out of TWO — the responder has more room, so
  // this is a loss at 3 questions and a win only at 4 (V([1,1,0],3) = 7+4 = 11 > 8 proves it).
  eq(volume([1, 1, 0], 3), 11, 'V > 2^3, so budget 2 must lose at q=3');
  const arr = [1, 0, 2, 1];
  const asK1 = { lies: arr.slice(), k: 1 };
  const asK2 = { lies: arr.slice(), k: 2 };
  const shared = makeBrute();            // one memo, so the key is the only thing separating them
  eq(shared.win(asK2, 3), false, 'budget 2: loss at q=3 (asked FIRST)');
  eq(shared.win(asK1, 3), true, 'budget 1: win at q=3 (asked SECOND, must not reuse the above)');
  // and the reverse order, so neither direction can pass by luck
  const other = makeBrute();
  eq(other.win(asK1, 2), true, 'budget 1 wins already at q=2');
  eq(other.win(asK2, 2), false, 'budget 2 does not');
  // one more budget for the same array: k=3 makes the pair need 6 questions (V([1,1,0,0],5) =
  // ball(5,3)+ball(5,2) = 26+16 = 42 > 32 proves the loss at 5)
  eq(volume([1, 1, 0, 0], 5), 42, 'V > 2^5 at budget 3');
  eq(other.win({ lies: arr.slice(), k: 3 }, 5), false, 'budget 3: loss at q=5');
  eq(other.win({ lies: arr.slice(), k: 3 }, 6), true, 'budget 3: win at q=6');
});

// ---------------------------------------------------------------- hand-traced wins and losses

test('hand-traced verdicts, DP and brute agreeing one at a time', () => {
  const s = makeSolver({});
  const cases = [
    // [n, k, q, expected] — every `expected` argued on paper, see comments
    [2, 1, 3, true],   // (2,1) par 3: q=3 is exactly enough
    [2, 1, 2, false],  // and one short: the responder answers both questions to keep two stories
    [3, 1, 4, false],  // THE counterexample: V=15 ≤ 16 and still lost
    [3, 1, 5, true],   // par(3,1) = 5
    [4, 1, 5, true],   // par(4,1) = 5
    [7, 1, 3, false],  // the classic: V=28 ≫ 8
    [7, 1, 6, true],   // par(7,1) = 6
    [1, 1, 0, true],   // one candidate, nothing needed
    [3, 2, 7, false],  // par(3,2) = 8 → seven questions are one short
    [3, 2, 8, true],   // and 8 wins
  ];
  for (const [n, k, q, want] of cases) {
    const pos = makePosition(Array.from({ length: n }, (_, i) => i + 1), k);
    eq(b.win(pos, q), want, `brute (${n},${k}) q=${q}`);
    eq(s.win(fresh(n, k), q), want, `DP (${n},${k}) q=${q} agrees`);
  }
});

test('the four k≤2 in-bound-but-lost shapes from test/volume.test.mjs, with names on them', () => {
  // volume.test.mjs lists six positions that sit inside the bound and are lost anyway over
  // Σa ≤ 4, k ≤ 2, q ≤ 5. Two of them ((3,0)@4 and (3,1)@4) are k=1 and already covered above;
  // these four are the k=2 ones, rebuilt here as concrete candidates so the weight-vector
  // quotient is not doing any of the work.
  const s = makeSolver({});
  const shapes = [
    // [pos, q]  →  weight vector, all losses at that depth
    [{ lies: [1, 1, 2, 1, 3, 1], k: 2 }, 4],           // [0,3,0]: V=15 ≤ 16
    [{ lies: [1, 1, 2, 1, 3, 1, 4, 2], k: 2 }, 4],     // [0,3,1]: V=16 = 2^4
    [{ lies: [1, 0, 2, 1, 3, 1], k: 2 }, 5],           // [1,2,0]: V=28 ≤ 32
    [{ lies: [1, 0, 2, 1, 3, 1, 4, 2], k: 2 }, 5],     // [1,2,1]: V=29 ≤ 32
  ];
  const wantVec = [[0, 3, 0], [0, 3, 1], [1, 2, 0], [1, 2, 1]];
  shapes.forEach(([pos, q], i) => {
    eq(b.weights(pos), wantVec[i], 'aggregates to the vector the volume suite named');
    ok(volume(wantVec[i], q) <= 2 ** q, `the bound waves it through: V=${volume(wantVec[i], q)} ≤ 2^${q}`);
    eq(b.win(pos, q), false, `brute: ${wantVec[i]} q=${q} is a LOSS`);
    eq(s.win(wantVec[i], q), false, `DP agrees: ${wantVec[i]} q=${q}`);
  });
});

test('renaming candidates changes nothing (the quotient this route never makes, checked anyway)', () => {
  const one = makePosition([1, 2, 3], 1);
  const two = makePosition([11, 5, 108], 1);   // same shape, different names, same ascending order? no: deliberately unsorted
  for (let q = 0; q <= 5; q++) eq(b.win(two, q), b.win(one, q), `q=${q}`);
  // respond() keeps ids in the order they were given, so the memo keys differ while the verdicts
  // must not — which is exactly why the agreement sweep sorts by construction.
  eq(positionIds(two), [11, 5, 108], 'brute does not sort, by design');
});

// ---------------------------------------------------------------- the sweep that is the evidence

test('full agreement sweep n≤8, k≤2, q≤5 — the shipped BRUTE record re-run', () => {
  // The loop shape in table.js is Σ_{k=0..2} Σ_{n=1..8} (k+1)^n · (qMax+1=6):
  //   k=0: 8·1·6 = 48   k=1: (2+4+…+256)·6 = 510·6 = 3060   k=2: (3+9+…+6561)·6 = 9840·6 = 59040
  //   total 62148 comparisons. Hand-derived, so a sweep that silently stopped early is caught.
  const r = bruteAgreement({ nMax: 8, kMax: 2, qMax: 5 });
  eq(r.compared, 62148, 'comparisons counted on paper');
  eq(r.disagreementCount, 0, 'not one disagreement');
  eq(r.disagreements, [], 'nothing to report');
  // dpWins is the measurement, so it is compared with the record that ships in js/data/lots.js —
  // a changed engine that shifts it fails here rather than quietly re-labelling the census.
  eq(r.dpWins, BRUTE.dpWins, 'DP wins matches the shipped record');
  eq(BRUTE.setting, { nMax: 8, kMax: 2, qMax: 5 }, 'and the record describes this sweep');
  eq(BRUTE.verifiedIn, 'full', 'the shipped record is the FULL setting, not the CI sample');
});

test('CI sample sweep n≤6, k≤2, q≤4 — same property, 1/10th the cost', () => {
  // Σ_{k=0..2} Σ_{n=1..6} (k+1)^n · 5 = (6 + 126 + 1092)·5 = 1224·5 = 6120
  const r = bruteAgreement({ nMax: 6, kMax: 2, qMax: 4 });
  eq(r.compared, 6120, 'sample sweep counted on paper');
  eq(r.disagreementCount, 0, 'no disagreement in the sample either');
  ok(r.dpWins <= 1353, 'a smaller universe cannot contain more DP wins');
});

test('brute respects its own node budget instead of lying about a verdict', () => {
  const tight = makeBrute({ maxNodes: 3 });
  throws(() => tight.win(makePosition([1, 2, 3, 4, 5, 6], 2), 5), /maxNodes/, 'gives up loudly');
  // ...and the position itself is a plain LOSS that both other routes also call a loss — par(6,2)
  // is 9, so five questions were never going to be enough. The throw came from the budget, not
  // from a hard question: a win in the same shape is answered instantly by a fresh instance.
  const s = makeSolver({});
  eq(s.win(fresh(6, 2), 5), false, 'DP: (6,2) at q=5 is a loss');
  eq(s.par(fresh(6, 2)), 9, 'par(6,2) = 9, four more than brute was asked about');
  eq(makeBrute().win(makePosition([1, 2, 3, 4, 5, 6], 2), 5), false, 'brute: same loss, no throw');
  eq(makeBrute().win(makePosition([1, 2, 3], 2), 8), true, 'brute: (3,2) at q=8 is a win');
});

test('every shipped campaign root is a win for the route that knows no state vector', () => {
  // |S| ≤ 8 keeps this affordable, and the campaign has exactly three such lots: 3-0x, 7-0, 4-1x,
  // 7-1, 3-2x, 6-2, 4-3x → n ≤ 7. The rest are covered by the sweep's own (n,k,q) grid.
  const small = LOTS.filter((l) => l.n <= 7);
  eq(small.map((l) => l.id), ['3-0x', '7-0', '4-1x', '7-1', '3-2x', '6-2', '4-3x'], 'which lots brute can re-do');
  for (const lot of small) {
    const pos = makePosition(Array.from({ length: lot.n }, (_, i) => i + 1), lot.k);
    eq(total(b.weights(pos)), lot.n, `${lot.id}: brute sees ${lot.n} candidates`);
    eq(b.win(pos, lot.q), true, `${lot.id} is winnable at the granted q=${lot.q}`);
    if (lot.par === lot.q) {
      // a lot with no slack must be lost one question short — brute says so too
      eq(b.win(pos, lot.q - 1), false, `${lot.id} loses at q-1 = ${lot.q - 1}`);
    }
  }
});

run();
