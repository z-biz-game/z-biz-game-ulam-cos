// Suite 3/6 — route 2 alone: the Berlekamp–Spencer volume bound.
//
// Every number below was written by hand from the formula in the header of js/core/volume.js,
//   V(a, q) = Σ_i a_i · Σ_{j ≤ k−i} C(q, j)
// with the binomial rows spelled out in the comments. Nothing here is read back off
// volume.js's own output: where a shipped value exists (lots, anchors) it is compared against the
// hand sum, so a wrong table and a wrong formula cannot agree with each other and hide.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, ok, eq, run } from '../tools/harness.mjs';
import { fresh, total } from '../js/core/state.js';
import * as V from '../js/core/volume.js';
import { makeSolver } from '../js/core/solve.js';
import { LOTS, MINQ, MEASURED } from '../js/data/lots.js';

// ---------------------------------------------------------------- the binomial ball

test('ball(q,d) = Σ_{j≤d} C(q,j), hand table', () => {
  // C(3,·) = 1,3,3,1          → prefix sums 1,4,7,8
  eq(V.ball(3, 0), 1, 'ball(3,0)');
  eq(V.ball(3, 1), 4, 'ball(3,1) = 1+3');
  eq(V.ball(3, 2), 7, 'ball(3,2) = 1+3+3');
  eq(V.ball(3, 3), 8, 'ball(3,3) = 2^3');
  // C(4,·) = 1,4,6,4,1        → 1,5,11,15,16
  eq(V.ball(4, 1), 5, 'ball(4,1) = 1+4');
  eq(V.ball(4, 2), 11, 'ball(4,2) = 1+4+6');
  eq(V.ball(4, 3), 15, 'ball(4,3) = 16-1');
  // C(5,·) = 1,5,10,10,5,1    → 1,6,16,26,31,32
  eq(V.ball(5, 1), 6, 'ball(5,1)');
  eq(V.ball(5, 2), 16, 'ball(5,2) = 1+5+10');
  eq(V.ball(5, 4), 31, 'ball(5,4) = 32-1');
  // C(7,·) = 1,7,21,35,...    → ball(7,1) = 8, ball(7,2) = 29
  eq(V.ball(7, 1), 8, 'ball(7,1) = 1+7');
  eq(V.ball(7, 2), 29, 'ball(7,2) = 1+7+21');
  eq(V.ball(7, 7), 128, 'ball(7,7) = 2^7');
  // C(9,·) = 1,9,36,84,...    → ball(9,2) = 46
  eq(V.ball(9, 2), 46, 'ball(9,2) = 1+9+36');
  // C(11,·) = 1,11,55,...     → ball(11,2) = 67
  eq(V.ball(11, 2), 67, 'ball(11,2) = 1+11+55');
  // C(12,·) = 1,12,66,220,... → ball(12,3) = 299
  eq(V.ball(12, 3), 299, 'ball(12,3) = 1+12+66+220');
  // C(13,·) = 1,13,78,286,... → ball(13,3) = 378
  eq(V.ball(13, 3), 378, 'ball(13,3) = 1+13+78+286');
});

test('ball saturates at 2^q and drops out-of-range columns', () => {
  // Σ_{j≤d} C(q,j) with d ≥ q is the whole row: 2^q. Extra columns must add 0, not NaN.
  for (const q of [0, 1, 5, 9, 13, 14]) {
    eq(V.ball(q, q), 2 ** q, `ball(${q},${q}) = 2^${q}`);
    eq(V.ball(q, q + 4), 2 ** q, `ball(${q},${q + 4}) saturates`);
  }
  // d < 0 → empty sum. Used by a candidate at slot k with room k−k = 0.
  eq(V.ball(5, -1), 0, 'empty ball');
  eq(V.ball(0, 0), 1, 'ball(0,0): one question-free pattern');
});

// ---------------------------------------------------------------- V for hand-built vectors

test('V(a,q) for three-slot vectors, sum spelled out', () => {
  // V([3,0],4): k=1, one ball at slot 0 → 3·ball(4,1) = 3·5 = 15 ≤ 16. IN the bound.
  eq(V.volume([3, 0], 4), 15, 'V([3,0],4) = 3*5');
  // V([3,1],4): 3·ball(4,1) + 1·ball(4,0) = 15 + 1 = 16 = 2^4. A PERFECT packing, still lost.
  eq(V.volume([3, 1], 4), 16, 'V([3,1],4) = 15+1');
  // V([2,1],3): 2·ball(3,1) + 1 = 8 + 1 = 9 > 8 → the bound itself forbids this one.
  eq(V.volume([2, 1], 3), 9, 'V([2,1],3) = 2*4+1 = 9');
  // V([1,2,0],5) with k=2: 1·ball(5,2) + 2·ball(5,1) + 0 = 16 + 12 = 28 ≤ 32.
  eq(V.volume([1, 2, 0], 5), 28, 'V([1,2,0],5) = 16+12');
  // V([1,2,1],5): 16 + 12 + 1·ball(5,0) = 29 ≤ 32.
  eq(V.volume([1, 2, 1], 5), 29, 'V([1,2,1],5) = 16+12+1');
  // V([0,3,0],4): nothing at slot 0, 3 at slot 1, k=2 → 3·ball(4,1) = 15.
  eq(V.volume([0, 3, 0], 4), 15, 'V([0,3,0],4)');
  eq(V.volume([0, 3, 1], 4), 16, 'V([0,3,1],4) = 15+1');
  // V([7,3,1],1): k=2, ball(1,2)=2, ball(1,1)=2, ball(1,0)=1 → 14+6+1 = 21 ≫ 2.
  eq(V.volume([7, 3, 1], 1), 21, 'V([7,3,1],1)');
  // V([3,4,1],1) = 6+8+1 = 15 ≫ 2.
  eq(V.volume([3, 4, 1], 1), 15, 'V([3,4,1],1)');
  // A candidate at slot k only ever contributes 1: it cannot afford another lie.
  eq(V.volume([0, 0, 5], 13), 5, 'slot-k candidates contribute 5*ball(13,0) = 5');
});

test('V of a fresh position is n·ball(q,k)', () => {
  // Σa = n all at slot 0, so V = n·ball(q,k). Hand pairs (n,k,q,expected).
  const rows = [
    [7, 1, 3, 28],   // 7·ball(3,1) = 7·4  — the classic (7,3,1): 28 ≫ 8
    [2, 1, 3, 8],    // 2·4 = 8  = 2^3, exactly packed
    [3, 1, 4, 15],   // 3·5
    [4, 1, 5, 24],   // 4·6
    [15, 1, 7, 120], // 15·8
    [16, 1, 7, 128], // 16·8 = 2^7, a perfect packing that IS won
    [9, 1, 6, 63],   // 9·7 = 63 ≤ 2^6 = 64 — the bound's tightest possible read on (9,1)
    [11, 2, 9, 506], // 11·ball(9,2) = 11·46
    [11, 2, 8, 407], // 11·(1+8+28) = 11·37
    [16, 3, 13, 6048], // 16·378
    [3, 0, 4, 3],    // k=0: ball is 1, so V = n whatever q is
    [40, 0, 14, 40],
  ];
  for (const [n, k, q, want] of rows) {
    eq(V.volume(fresh(n, k), q), want, `V(fresh(${n},${k}),${q})`);
    // independent of the implementation: same sum written out through ball()
    eq(n * V.ball(q, k), want, `${n}*ball(${q},${k})`);
  }
});

// ---------------------------------------------------------------- against the shipped table

test('all 14 shipped lots: V, 2^q and margin reproduced by hand', () => {
  // Hand sums: V = n·ball(q,k), c = 2^q, margin rounded to 4 dp = c/V.
  const want = [
    ['3-0x', 3, 0, 3, 3, 8, 2.6667],
    ['7-0', 7, 0, 3, 7, 8, 1.1429],
    ['15-0', 15, 0, 4, 15, 16, 1.0667],
    ['4-1x', 4, 1, 6, 28, 64, 2.2857],
    ['7-1', 7, 1, 6, 49, 64, 1.3061],
    ['11-1', 11, 1, 7, 88, 128, 1.4545],
    ['16-1', 16, 1, 7, 128, 128, 1],
    ['3-2x', 3, 2, 9, 138, 512, 3.7101],
    ['6-2', 6, 2, 9, 276, 512, 1.8551],
    ['12-2', 12, 2, 10, 672, 1024, 1.5238],
    ['20-2', 20, 2, 11, 1340, 2048, 1.5284],
    ['4-3x', 4, 3, 12, 1196, 4096, 3.4247],
    ['9-3', 9, 3, 13, 3402, 8192, 2.408],
    ['16-3', 16, 3, 13, 6048, 8192, 1.3545],
  ];
  eq(LOTS.map((l) => l.id), want.map((r) => r[0]), 'lot order is pinned');
  want.forEach(([id, n, k, q, v, cap, margin], i) => {
    const lot = LOTS[i];
    eq(lot.n, n, `${id}.n`);
    eq(lot.k, k, `${id}.k`);
    eq(lot.q, q, `${id}.q`);
    eq(V.volume(fresh(n, k), q), v, `${id} hand V`);
    eq(lot.volume, v, `${id} shipped volume`);
    eq(V.capacity(q), cap, `${id} 2^${q}`);
    eq(lot.cap, cap, `${id} shipped cap`);
    eq(lot.margin, margin, `${id} shipped margin`);
    // shipped margin is the hand ratio rounded to 4 dp — derive the rounding, do not trust it.
    ok(Math.abs(V.margin(fresh(n, k), q) - margin) < 5e-5, `${id} margin(${v}) ≈ ${margin}`);
    ok(V.margin(fresh(n, k), q) >= 1, `${id} ships in-bound: V=${v} ≤ ${cap}`);
  });
  // Every campaign lot is a position the bound considers possible, so the table's own
  // `bound ≤ par ≤ q` chain is checkable from the volumes above alone.
  for (const lot of LOTS) {
    ok(lot.bound <= lot.par && lot.par <= lot.q, `${lot.id}: bound ${lot.bound} ≤ par ${lot.par} ≤ q ${lot.q}`);
  }
});

test('MEASURED.anchors: every V in the build census reproduced by hand', () => {
  const t = MEASURED.anchors.triples;
  // a → expected V written out from the ball table above
  const cases = [
    ['loss_n7_q3_k1', 28],   // 7·4
    ['win_n2_q3_k1', 8],     // 2·4
    ['decide_n3_q4_k1', 15], // 3·5
    ['win_n4_q5_k1', 24],    // 4·6
    ['win_n15_q7_k1', 120],  // 15·8
  ];
  for (const [name, want] of cases) {
    const row = t[name];
    ok(row, `anchor ${name} exists`);
    eq(V.volume(row.a, row.q), want, `${name} V`);
    eq(row.V, want, `${name} shipped V`);
    eq(V.capacity(row.q), row.cap, `${name} cap`);
  }
  const v = MEASURED.anchors.vectors;
  const vecCases = [
    ['smallestLoss', 15], ['perfectPackLoss', 16], ['twoClean', 8],
    ['oneSeven', 11],   // [1,7] k=1 q=3: 1·4 + 7·1 = 11
    ['loss7_3_1', 21], ['loss2_3_1', 11], ['loss3_4_1', 15],
  ];
  for (const [name, want] of vecCases) {
    const row = v[name];
    eq(V.volume(row.a, row.q), want, `${name} V`);
    eq(row.V, want, `${name} shipped V`);
  }
  // [1,7] at q=3 is in bound-free territory: 11 > 8, so the bound DOES prove it. The table says
  // win:false for every one of these, which is the only direction the theorem supports.
  for (const row of Object.values(t)) {
    if (row.V > row.cap) ok(row.win === false, `${JSON.stringify(row.a)}: V>cap must be a loss`);
  }
});

test('the volume route stays independent: volume.js imports nothing', () => {
  const src = readFileSync(fileURLToPath(new URL('../js/core/volume.js', import.meta.url)), 'utf8');
  ok(!/^\s*import\s/m.test(src), 'volume.js must not import another module, or agreement stops meaning anything');
  ok(!/require\(/.test(src), 'no require either');
});

// ---------------------------------------------------------------- cold-start regression

test('cold process: the FIRST call may use the largest q (regression: NaN)', async () => {
  // PASCAL rows used to be built from `PASCAL[n-1] || [1]`, so a first call at q=13 cached
  // garbage and every later V came out NaN — silently disabling the DP prune and putting NaN on
  // the screen for the 16-cell band-3 lot. Import a pristine instance and call big-q first.
  const cold = await import(`../js/core/volume.js?cold=${Date.now()}`);
  eq(cold.volume([16, 0, 0, 0], 13), 6048, 'first call: 16·378');
  eq(cold.ball(13, 3), 378, 'big row built first');
  // ...and the small rows it depends on must still be right afterwards.
  eq(cold.ball(4, 1), 5, 'row 4 after a cold row 13');
  eq(cold.volume([3, 0], 4), 15, 'small q after big q');
  eq(cold.boundPar([9, 0]), 6, 'boundPar walks q upward and agrees');
  eq(cold.formatVolume([3, 0], 4), 'V=15 vs 2^4=16', 'no NaN in the readout');
  // out-of-order binom requests, the exact pattern that used to break
  eq(cold.ball(14, 2), 106, 'ball(14,2) = 1+14+91');
  eq(cold.ball(2, 2), 4, 'tiny row after huge rows');
  eq(cold.volume([1, 0, 0, 0], 14), 470, 'one clean cell, k=3: 1+14+91+364');
  eq(cold.volume([1, 0, 0, 0], 14), cold.volume(fresh(1, 3), 14), 'same vector, same V');
});

test('V is monotone in q and never exceeds the trivial n·2^q count', () => {
  const positions = [[3, 0], [3, 1], [2, 1], [7, 0], [16, 0, 0, 0], [0, 3, 1], [1, 2, 1], fresh(20, 2)];
  for (const a of positions) {
    let prev = -1;
    for (let q = 0; q <= 14; q++) {
      const v = V.volume(a, q);
      ok(Number.isFinite(v), `V(${a},${q}) finite`);
      ok(v >= prev, `V(${a},q) nondecreasing at q=${q}`);
      ok(v <= total(a) * 2 ** q, `V(${a},${q}) ≤ ${total(a)}·2^${q}`);
      prev = v;
    }
    // each extra question at most doubles the volume: C(q+1,j) = C(q,j)+C(q,j-1)
    for (let q = 0; q < 14; q++) ok(V.volume(a, q + 1) <= 2 * V.volume(a, q), `doubling at q=${q}`);
  }
});

// ---------------------------------------------------------------- what the bound may conclude

test('volumeVerdict answers false or null — never true', () => {
  const positions = [
    [3, 0], [3, 1], [2, 1], [2, 0], [7, 0], [9, 0], [16, 0], [1, 7], [7, 3, 1], [1, 2, 1], fresh(11, 2), fresh(16, 3),
  ];
  for (const a of positions) {
    for (let q = 0; q <= 14; q++) {
      const v = V.volume(a, q);
      const cap = 2 ** q;
      const got = V.volumeVerdict(a, q);
      ok(got !== true, `verdict must never certify a win (${a} q=${q})`);
      ok(got === false || got === null, `verdict is false or null (${a} q=${q})`);
      eq(got, v > cap ? false : null, `false ⟺ V>2^q (${a} q=${q}: ${v} vs ${cap})`);
    }
  }
});

test('boundPar: the bound\'s own question count, hand table', () => {
  // k=0: V = n for every q, so the bound says ⌈log2 n⌉.
  const clean = [[1, 0], [2, 1], [3, 2], [4, 2], [5, 3], [8, 3], [9, 4], [16, 4], [17, 5], [32, 5], [33, 6], [40, 6]];
  for (const [n, want] of clean) eq(V.boundPar(fresh(n, 0)), want, `boundPar(n=${n},k=0)`);
  // k=1: V = n·(q+1). Least q with n(q+1) ≤ 2^q.
  eq(V.boundPar([2, 0]), 3, '2(q+1)≤2^q first at q=3 (8=8)');
  eq(V.boundPar([3, 0]), 4, '3·5=15 ≤ 16, and 3·4=12 > 8 → 4. TRUE VALUE IS 5');
  eq(V.boundPar([4, 0]), 5, '4·6=24 ≤ 32, 4·5=20 > 16 → 5');
  eq(V.boundPar([5, 0]), 5, '5·6=30 ≤ 32, 5·5=25 > 16 → 5');
  eq(V.boundPar([6, 0]), 6, '6·7=42 ≤ 64, 6·6=36 > 32 → 6');
  eq(V.boundPar([9, 0]), 6, '9·7=63 ≤ 64, 9·6=54 > 32 → 6. TRUE VALUE IS 7');
  eq(V.boundPar([16, 0]), 7, '16·8=128 = 2^7 exactly');
  // [1,1] (k=1): V = ball(q,1) + ball(q,0) = (q+1) + 1 = q+2 → q+2 ≤ 2^q first at q=2 (4=4).
  eq(V.boundPar([1, 1]), 2, 'V([1,1],q) = q+2, so 4 ≤ 4 at q=2');
  // with qMax too small the bound stays silent — null, not a guess
  eq(V.boundPar([9, 0], 3), null, 'silent below its own answer');
  eq(V.boundPar(fresh(40, 3), 5), null, '40 cells, 3 lies, 5 questions: the bound gives up');
});

test('bound ≤ par: where they differ, the bound\'s own depth is a re-measured loss', () => {
  // MEASURED.minq.mismatches is the shipped list of cells with bound < par. At k ≤ 1 there are
  // exactly three — (n,k) = (3,1), (5,1), (9,1) with par 5, 6, 7 against bound 4, 5, 6 — and that
  // the count is 3 is itself a claim: at k = 0 the bound is exact for every n ≤ 32.
  const mm = MEASURED.minq.mismatches;
  eq(mm.filter((r) => r.k === 0), [], 'no k=0 mismatch: volume nails ⌈log2 n⌉');
  eq(mm.filter((r) => r.k === 1), [
    { n: 3, k: 1, par: 5, bound: 4 },
    { n: 5, k: 1, par: 6, bound: 5 },
    { n: 9, k: 1, par: 7, bound: 6 },
  ], 'the three k=1 shortfalls, hand-listed');
  const s = makeSolver({ maxNodes: 8000000, maxMs: 60000 });
  for (const { n, k, par, bound } of mm.filter((r) => r.k <= 1)) {
    const a = fresh(n, k);
    eq(V.boundPar(a), bound, `boundPar(${n},${k}) recomputed here, not copied`);
    ok(V.volume(a, bound) <= 2 ** bound, `(${n},${k}) is IN bound at q=${bound}`);
    eq(s.win(a, bound), false, `(${n},${k}) LOSES at the bound's own depth q=${bound}`);
    eq(s.win(a, par), true, `(${n},${k}) wins at the measured par=${par}`);
    eq(s.par(a), par, `par(${n},${k}) re-measured`);
  }
  for (const lot of LOTS) ok(lot.bound <= lot.par, `${lot.id}: bound ${lot.bound} ≤ par ${lot.par}`);
  // Cost guard, so this suite never becomes the reason a gate is slow.
  ok(s.nodes < 5000, `re-measure stayed cheap: ${s.nodes} DP nodes`);
});

test('MINQ\'s bound and volume columns are this route\'s own arithmetic, 128 cells', () => {
  // Nothing below consults solve.js: the shipped `bound` column must equal this file's formula for
  // every (n ≤ 32, k ≤ 3) cell — that is what lets the screen print 界 and 真值 side by side
  // without one column being derived from the other. `volume` is V taken AT the measured par.
  const ns = MINQ.filter((row) => row).map((row) => row.n).sort((x, y) => x - y);
  eq(MINQ.length, 33, 'MINQ[0] is the null placeholder, then one row per n = 1..32');
  eq(MINQ[0], null, 'no n=0 position: nothing to hide');
  eq(ns.length, 32, 'one row per n = 1..32');
  eq(ns[0], 1, 'starts at 1');
  eq(ns[31], 32, 'ends at 32');
  let cells = 0;
  for (const n of ns) {
    const row = MINQ[n];
    eq(row.n, n, `MINQ is indexed by n`);
    eq([row.par.length, row.bound.length, row.volume.length], [4, 4, 4], `MINQ[${n}] covers k=0..3`);
    for (let k = 0; k <= 3; k++) {
      cells++;
      const a = fresh(n, k);
      eq(V.boundPar(a), row.bound[k], `boundPar(n=${n},k=${k})`);
      eq(n * V.ball(row.par[k], k), row.volume[k], `V(fresh(${n},${k}), par=${row.par[k]})`);
      // the theorem holds at the DP's own answer depth — win ⟹ V ≤ 2^q, cell by cell
      ok(row.volume[k] <= 2 ** row.par[k], `V ≤ 2^par at n=${n},k=${k}: ${row.volume[k]} ≤ ${2 ** row.par[k]}`);
      ok(row.bound[k] <= row.par[k], `bound ≤ par at n=${n},k=${k}`);
    }
  }
  eq(cells, 128, '32 × 4 cells checked');
});

test('capacity and margin, hand values', () => {
  eq(V.capacity(0), 1, '2^0');
  eq(V.capacity(7), 128, '2^7');
  eq(V.capacity(14), 16384, '2^14');
  // margin = 2^q / V: 16/15 for the (3,0) counterexample, 1 for a perfect packing
  eq(V.margin([3, 0], 4), 16 / 15, 'margin(3,0,q=4)');
  eq(V.margin([16, 0], 7), 1, '16 clean cells, 7 questions, budget 1: exactly full');
  ok(V.margin([3, 0], 4) > 1, 'in bound means margin > 1');
  ok(V.margin([7, 0], 3) < 1, 'V=28 vs 8: margin 2/7, out of bound');
  eq(V.margin([0, 0], 3), Infinity, 'empty position: no volume to compare against');
});

test('formatVolume prints the two numbers the screen shows side by side', () => {
  eq(V.formatVolume([3, 0], 4), 'V=15 vs 2^4=16', '(3,0) at q=4');
  eq(V.formatVolume([3, 1], 4), 'V=16 vs 2^4=16', 'perfect packing');
  eq(V.formatVolume([7, 0], 3), 'V=28 vs 2^3=8', 'the classic loss');
  eq(V.formatVolume([16, 0, 0, 0], 13), 'V=6048 vs 2^13=8192', 'the deepest shipped lot');
});

// ---------------------------------------------------------------- the census this repo exists for

test('theorem direction over a 312-position census: V>2^q ⟹ the DP loses', () => {
  // All weight vectors with Σa ≤ 4 at k ∈ {0,1,2}: the count of (k+1)-tuples with sum ≤ 4 is
  // C(4+k+1, k+1), so 5, 15, 35 — minus one all-zero vector each, 4 + 14 + 34 = 52 positions, over
  // q = 0..5 ⇒ 312 (position, q) pairs. The count is asserted, not assumed.
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
  const s = makeSolver({ maxNodes: 8000000, maxMs: 60000 });
  let checked = 0;
  const lostInBound = [];
  for (const k of [0, 1, 2]) {
    for (const a of enumerate(k, 4)) {
      if (total(a) === 0) continue;
      for (let q = 0; q <= 5; q++) {
        checked++;
        const out = V.volumeVerdict(a, q);
        const won = s.win(a, q);
        if (out === false) ok(won === false, `V>2^q yet won: ${a} q=${q}`);
        if (out === null && !won) lostInBound.push(`${a.join(',')}@${q}`);
      }
    }
  }
  eq(checked, 312, '52 non-empty positions × 6 depths');
  // The interesting half: 6 positions the bound waves through and the DP refuses. Hand list, with
  // each one's V spelled out above. test/brute.test.mjs re-checks the four k=2 shapes against
  // named candidates, so no route is taking the DP's word for a loss.
  eq(lostInBound, [
    '3,0@4',     // V=15 ≤ 16, lost (par 5)
    '3,1@4',     // V=16 = 16, a perfect packing, lost
    '0,3,0@4',   // the k=2 lift of the same argument
    '0,3,1@4',   // and its perfect-packing twin
    '1,2,0@5',   // V=28 ≤ 32, lost
    '1,2,1@5',   // V=29 ≤ 32, lost
  ], 'in-bound-but-lost census');
  // smallest by (Σa, q): exactly the (3,0) counterexample the README leads with
  let smallest = null;
  for (const row of lostInBound) {
    const [str, q] = row.split('@');
    const sum = str.split(',').reduce((x, y) => x + Number(y), 0);
    const key = sum * 100 + Number(q);
    if (!smallest || key < smallest.key) smallest = { key, row, sum, q: Number(q) };
  }
  eq(smallest.row, '3,0@4', 'the smallest in-bound-but-lost position');
});

run();
