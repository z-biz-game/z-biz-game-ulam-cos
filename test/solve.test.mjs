// Route 1: the exact decision DP. This suite is where the repo's headline is either true or a
// bug report, so every expected number below is either (a) a value worked out on paper, with the
// paper argument written next to it, or (b) the shipped js/data/lots.js table being cross-check-
// *ed* against a solver instance that this file creates from scratch. Nothing reads an
// expectation off the function it is testing.

import { test, ok, eq, throws, run } from '../tools/harness.mjs';
import { fresh, total, answer, realizable, questions } from '../js/core/state.js';
import { volume, boundPar } from '../js/core/volume.js';
import { makeSolver, buildPolicy, policyClosed, policyRoot } from '../js/core/solve.js';
import { MINQ, LOTS } from '../js/data/lots.js';

// A solver per test: `makeSolver` owns its memo, so no assertion below can be influenced by a
// cache another test filled.
const s = makeSolver({ maxNodes: 40000000, maxMs: 300000 });

// ---- the terminal case, by definition --------------------------------------
// win(a, 0) ⟺ Σa = 1: with no questions left the only way to be able to point is that exactly one
// candidate survived. Σ = 0 is not "vacuously won", it is unreachable-in-play and reported false.
test('win(a, 0) is exactly "one candidate left"', () => {
  eq(s.win([1], 0), true, 'one clean candidate, no questions: point at it');
  eq(s.win([0, 1], 0), true, 'a candidate with k lies already against it still counts as one');
  eq(s.win([2], 0), false, 'two survivors, no question to split them');
  eq(s.win([0, 0], 0), false, 'an empty vector is a loss, never a free win');
});

test('the O(1) short-circuits agree with the recurrence that has none', () => {
  // win(a,q) for Σa = 1 is true at every depth, and for Σa = 0 false at every depth.
  for (let q = 0; q <= 5; q++) {
    eq(s.win([0, 1], q), true, `one survivor at q=${q}`);
    eq(s.win([0, 0], q), false, `no survivor at q=${q}`);
  }
});

// ---- monotone carry: the lemma solve.js uses as a short-circuit ------------
// Prove it the long way first: for every position in a small universe, win(a,q) ⟹ win(a,q+1).
// (Extra questions can never hurt: play the q-question strategy and waste the spare on an empty
// question — which state.js counts as legal.)
test('win(a,q) ⟹ win(a,q+1) over every position with Σa ≤ 6, k ≤ 2, q ≤ 5', () => {
  let checked = 0;
  for (let n = 1; n <= 6; n++) {
    for (let k = 0; k <= 2; k++) {
      const a = fresh(n, k);
      for (let q = 0; q < 5; q++) {
        if (s.win(a, q) === true) {
          eq(s.win(a, q + 1), true, `(${a.join(',')}) won at q=${q} must be won at q=${q + 1}`);
          checked++;
        }
      }
    }
  }
  ok(checked >= 25, `the implication was actually exercised (${checked} times)`);
});

// ---- k = 0: no lies, and the DP must reproduce the textbook ----------------
// ⌈log₂n⌉ worked by hand: 2→1, 3..4→2, 5..8→3, 9..16→4, 17..32→5, 33..64→6.
// Written as a table, not as Math.ceil(Math.log2(n)), so the expectation is the arithmetic.
const CEIL_LOG2 = [];
for (let n = 2; n <= 64; n++) {
  CEIL_LOG2.push(n <= 2 ? 1 : n <= 4 ? 2 : n <= 8 ? 3 : n <= 16 ? 4 : n <= 32 ? 5 : 6);
}

test('par(n, k=0) == ⌈log₂ n⌉ for n = 2..64, against a hand-written table', () => {
  const got = [];
  for (let n = 2; n <= 64; n++) got.push(s.par(fresh(n, 0)));
  eq(got, CEIL_LOG2, 'every one of the 63 values');
  eq(CEIL_LOG2.length, 63, 'the table is n=2..64');
});

test('at k=0 the volume bound is exact: n ≤ 2^q and nothing more is needed', () => {
  for (let n = 2; n <= 32; n++) {
    eq(boundPar(fresh(n, 0)), CEIL_LOG2[n - 2], `bound agrees with par at n=${n}`);
  }
});

// ---- k = 1: the headline. The bound lies here. -----------------------------
// The four values below were computed by hand from the recurrences in state.test.mjs, and two of
// them contradict the textbook bound. The argument, for (n=3, k=1, q=4) — the smallest one:
//
//   The bound's opinion: V((3,0),q) = 3·(1+q), so 3·5 = 15 ≤ 16 at q=4 → "4 questions suffice".
//   The truth: after ANY first question the responder can hand back a position whose volume at
//   depth 3 is > 2³ = 8, i.e. a provable loss. Enumerate the four first questions (y₀ = how many
//   of the three clean candidates get lit) and read both branches off the hand-worked
//   recurrences; V((x,y),3) = 4x + y because ball(3,1) = 4 and ball(3,0) = 1:
//
//     y₀=0 → yes (0,3): V = 3      no (3,0): V = 12  → the honest answer NO already loses it
//     y₀=1 → yes (1,2): V = 6      no (2,1): V = 9   → 9 > 8
//     y₀=2 → yes (2,1): V = 9      no (1,2): V = 6   → 9 > 8
//     y₀=3 → yes (3,0): V = 12     no (0,3): V = 3   → 12 > 8
//
//   Every first question has a realizable branch with V > 8, and V > 2^q is a theorem of LOSS.
//   So q=4 loses and par(3,1) ≥ 5. The DP finds par(3,1) = 5, so the bound is short by exactly 1.
const BOUND_PREDICTS = [
  { n: 3, q: 4, V: 15, cap: 16 },
  { n: 5, q: 5, V: 30, cap: 32 },
  { n: 9, q: 6, V: 63, cap: 64 },
];

test('the bound\'s own arithmetic at k=1: n·(1+q) ≤ 2^q, hand-computed', () => {
  for (const b of BOUND_PREDICTS) {
    eq(volume(fresh(b.n, 1), b.q), b.V, `V(( ${b.n} | 0 ),${b.q}) = ${b.n}·(1+${b.q})`);
    eq(2 ** b.q, b.cap, 'capacity');
    ok(b.V <= b.cap, `the bound thinks ${b.q} questions are enough at n=${b.n}`);
    eq(boundPar(fresh(b.n, 1)), b.q, 'and boundPar says exactly that');
  }
});

test('the first-question table that kills q=4 at n=3, by hand', () => {
  // branch volumes at depth 3, computed from V((x,y),3) = 4x + y with the hand-worked vectors
  const rows = [
    { y0: 0, yes: [0, 3], no: [3, 0] },
    { y0: 1, yes: [1, 2], no: [2, 1] },
    { y0: 2, yes: [2, 1], no: [1, 2] },
    { y0: 3, yes: [3, 0], no: [0, 3] },
  ];
  for (const r of rows) {
    const br = answer([3, 0], [r.y0, 0]);
    eq(br.yes, r.yes, `y₀=${r.y0} YES branch`);
    eq(br.no, r.no, `y₀=${r.y0} NO branch`);
    const vy = 4 * r.yes[0] + r.yes[1];
    const vn = 4 * r.no[0] + r.no[1];
    eq([vy, vn], [volume(r.yes, 3), volume(r.no, 3)], 'the closed form matches the code once');
    ok(Math.max(vy, vn) > 8, `y₀=${r.y0}: some realizable branch has V > 2³ = 8`);
  }
});

test('k=1: par(2)=3, par(3)=5, par(5)=6, par(6)=6, par(9)=7 — the bold three beat the bound', () => {
  eq(s.par(fresh(2, 1)), 3, 'par(2)=3, and the bound also says 3');
  eq(s.par(fresh(3, 1)), 5, 'par(3)=5 while the bound says 4');
  eq(s.par(fresh(5, 1)), 6, 'par(5)=6 while the bound says 5');
  eq(s.par(fresh(6, 1)), 6, 'par(6)=6, agreeing with the bound');
  eq(s.par(fresh(9, 1)), 7, 'par(9)=7 while the bound says 6');
  eq([boundPar(fresh(2, 1)), boundPar(fresh(3, 1)), boundPar(fresh(5, 1)),
    boundPar(fresh(6, 1)), boundPar(fresh(9, 1))], [3, 4, 5, 6, 6], 'the bound\'s five opinions');
});

test('the same five cells as the shipped table prints them', () => {
  const want = { 2: [3, 3], 3: [5, 4], 5: [6, 5], 6: [6, 6], 9: [7, 6] };
  for (const n of Object.keys(want).map(Number)) {
    eq([MINQ[n].par[1], MINQ[n].bound[1]], want[n], `MINQ row n=${n} is [par, bound]`);
    eq([s.par(fresh(n, 1)), boundPar(fresh(n, 1))], want[n], `and the DP agrees for n=${n}`);
  }
});

test('the loss at (n=7, q=3, k=1): V = 7·4 = 28 > 8', () => {
  eq(volume(fresh(7, 1), 3), 28, 'ball(3,1) = 1+3 = 4, times 7 candidates');
  eq(2 ** 3, 8, 'capacity');
  eq(s.win(fresh(7, 1), 3), false, 'a loss, and the bound already proves it');
  eq(s.win(fresh(7, 1), 6), true, 'par(7,1) = 6, so q=6 is the first depth that works');
  eq(s.par(fresh(7, 1)), 6, 'and the shipped table says 6');
});

// ---- k = 2 ---------------------------------------------------------------
// par(11,2) = 10 is the brief's anchor. The bound says 9 (V((11|0|0),9) = 11·46 = 506 ≤ 512, so
// q=9 is inside the bound and still a loss) — one of the 34 disagreement cells on the minQ grid.
test('k=2: par(11) = 10 while the bound says 9', () => {
  eq(s.par(fresh(11, 2)), 10, 'the DP\'s measurement');
  eq(MINQ[11].par[2], 10, 'the shipped table says the same');
  eq(boundPar(fresh(11, 2)), 9, 'the bound is one short here');
  eq(MINQ[11].bound[2], 9, 'and the table prints that opinion next to the truth');
  eq(volume(fresh(11, 2), 9), 11 * (1 + 9 + 36), 'V at q=9: ball(9,2) = 1+9+36 = 46 → 506');
  eq(volume(fresh(11, 2), 9), 506, 'and 506 is the number');
  eq(506 <= 2 ** 9, true, '506 ≤ 512: the bound has nothing to say about q=9');
  eq(s.win(fresh(11, 2), 9), false, 'yet q=9 is a loss — the DP is the only route that knows');
});

test('the k=2 staircase in the shipped table matches a fresh DP run', () => {
  for (const n of [3, 6, 12, 20]) {
    eq(s.par(fresh(n, 2)), MINQ[n].par[2], `par(${n},2)`);
  }
  eq([MINQ[3].par[2], MINQ[6].par[2], MINQ[12].par[2], MINQ[20].par[2]], [8, 9, 10, 11],
    'hand-read off the table above, in order');
});

// ---- arbitrary states: the counterexample family ---------------------------
// (3,0) at q=4: V = 15 ≤ 16, yet LOSS (see the paper argument above).
// (3,1) at q=4: V = 16 = 2^4, a PERFECT packing, yet LOSS. The second one is the stronger
// statement: it is not a rounding slack the bound could close, the bound is exact here and wrong.
test('the arbitrary-state counterexamples: in-bound and lost', () => {
  eq(volume([3, 0], 4), 15, '3·(1+4) = 15');
  eq(2 ** 4, 16, 'capacity 16');
  eq(s.win([3, 0], 4), false, '(3|0)@q4 is a LOSS with 1 unit of slack');
  eq(volume([3, 1], 4), 16, '3·5 + 1·1 = 16: the packing is perfect');
  eq(s.win([3, 1], 4), false, '(3|1)@q4 is a LOSS at exactly V = 2^q');
  eq([s.win([3, 0], 5), s.win([3, 1], 5)], [true, true], 'both survive one question deeper');
  eq([s.par([3, 0]), s.par([3, 1])], [5, 5], 'par((3|0)) = 5 and par((3|1)) = 5, both computed');
  // ...and the direction that IS a theorem, checked on the same cells:
  eq(volume([3, 1], 5) > 2 ** 5, false, 'V((3|1),5) = 3·6+1 = 19 ≤ 32, so the bound stays silent');
});

function parOf(a) { return s.par(a); }
// ---- the whole shipped MINQ table, re-measured ----------------------------
test('par and boundPar reproduce every cell of the baked MINQ table (n ≤ 32, k ≤ 3)', () => {
  const bad = [];
  for (let n = 1; n <= 32; n++) {
    for (let k = 0; k <= 3; k++) {
      const a = fresh(n, k);
      const p = s.par(a);
      const b = boundPar(a);
      if (p !== MINQ[n].par[k]) bad.push({ n, k, what: 'par', got: p, want: MINQ[n].par[k] });
      if (b !== MINQ[n].bound[k]) bad.push({ n, k, what: 'bound', got: b, want: MINQ[n].bound[k] });
      if (volume(a, MINQ[n].par[k]) > 2 ** MINQ[n].par[k]) bad.push({ n, k, what: 'theorem' });
      ok(b <= p, `the bound is a lower bound at (${n},${k}): ${b} ≤ ${p}`);
    }
  }
  eq(bad, [], '132 cells re-measured against the shipped table');
  const mism = [];
  for (let n = 2; n <= 32; n++) for (let k = 1; k <= 3; k++) if (MINQ[n].par[k] !== MINQ[n].bound[k]) mism.push([n, k]);
  eq(mism.length, 34, 'and the disagreement census is the 34 cells MEASURED.minq.mismatches counts');
});

// ---- the champion and its policy table ------------------------------------
test('champion() only returns questions all of whose realizable branches win', () => {
  const cases = [[[3, 0], 5], [[7, 0], 6], [[2, 1], 4], [[4, 0, 0], 8]];
  for (const [a, q] of cases) {
    ok(s.win(a, q), `(${a.join(',')})@${q} is a win before asking for its champion`);
    const y = s.champion(a, q);
    ok(Array.isArray(y) && y.length === a.length, 'a question of the right shape');
    ok(y.every((v, i) => v >= 0 && v <= a[i]), 'and legal');
    const { yes, no } = answer(a, y);
    for (const branch of [yes, no]) {
      if (!realizable(branch)) continue;
      eq(s.win(branch, q - 1), true, `every realizable branch wins one question deeper (${branch.join(',')})`);
    }
  }
});

test('buildPolicy() produces a closed, descending table; policyClosed() notices a hand-edit', () => {
  const root = fresh(3, 1);
  const { q0, policy } = buildPolicy(root, { q: 5 });
  eq(q0, 5, 'the pinned root depth is what the campaign grants, not par');
  eq(policyClosed(policy), null, 'closed as built');
  const rootRow = policyRoot(policy);
  eq(rootRow[2], 5, 'the deepest row is the root');
  eq(rootRow[1], [3, 0], 'and it is the root position');
  // descend once: the champion's YES branch must be in the table at q-1
  const [, , rq, ry] = rootRow;
  const yes = answer(root, ry).yes;
  ok(policy.some((r) => r[1].join() === yes.join() && r[2] === rq - 1), 'the child row exists at q-1');
  // now break one row and demand the checker notice
  const tampered = policy.slice();
  tampered[0] = [tampered[0][0] + 1, tampered[0][1], tampered[0][2], tampered[0][3]];
  ok(/策略键/.test(policyClosed(tampered) || ''), 'a mismatched key is caught by re-derivation');
  // drop a row that is a CHILD of another row: the parent's realizable branch then points at
  // nothing. (Dropping a leaf would be legal, and pretending otherwise would be a fake check.)
  const rootRowIdx = policy.findIndex((r) => r[2] === q0);
  const childVec = answer(root, policy[rootRowIdx][3]).yes;
  const childIdx = policy.findIndex((r) => r[2] === q0 - 1 && r[1].join() === childVec.join());
  ok(childIdx >= 0, `the child (${childVec.join(',')})@${q0 - 1} is tabulated before removing it`);
  const dropped = policy.filter((_, i) => i !== childIdx);
  ok(/策略不闭合/.test(policyClosed(dropped) || ''), 'removing it leaves a hole the checker finds');
  eq(policyClosed(policy), null, 'and the untouched table still passes: the failure was the edit');
});

test('buildPolicy refuses a losing root instead of shipping a fake strategy', () => {
  throws(() => buildPolicy([3, 0], { q: 4 }), /败局/, '(3|0)@q4 is a LOSS: no policy may be baked');
});

test('every shipped campaign lot is a win at its granted depth, re-measured here', () => {
  const t = makeSolver({ maxNodes: 40000000, maxMs: 300000 });
  for (const lot of LOTS) {
    eq(t.win(fresh(lot.n, lot.k), lot.q), true, `${lot.id} winnable at q=${lot.q}`);
    eq(t.par(fresh(lot.n, lot.k)), lot.par, `${lot.id} par`);
    ok(lot.par <= lot.q, `${lot.id} grants at least par`);
    eq(policyClosed(lot.policy), null, `${lot.id} policy table closed by re-lookup`);
  }
  eq(LOTS.length, 14, 'the census the docs quote');
});

// ---- the budget: an out-of-budget answer is "unmeasured", never a number ---
test('a solver that runs out throws BudgetError rather than inventing a par', () => {
  const tight = makeSolver({ maxNodes: 8, qMax: 20 });
  throws(() => tight.par(fresh(20, 2)), /nodes|maxNodes|past/, 'the node cap fires');
  const shallow = makeSolver({ qMax: 3 });
  throws(() => shallow.par(fresh(9, 1)), /qMax/, 'and so does the depth cap: no silent 3');
});

run();
