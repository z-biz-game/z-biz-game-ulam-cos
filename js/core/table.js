// The measurement layer: everything the repo says about the VOLUME BOUND VERSUS THE TRUTH is
// produced here, by the same solve.js the game's par numbers come from, and frozen into
// js/data/lots.js by tools/bake.mjs. The browser reads the frozen copy; `recomputeTable()` re-runs
// a reduced scan on demand so a reader can watch the published numbers fall out again.
//
// TWO THINGS ARE COUNTED, AND THEY ARE NOT THE SAME THING
//
//   disagreement  =  { (a, q) : V(a, q) <= 2^q  AND  win(a, q) = false }
//
// i.e. positions where the textbook sphere-packing bound is silent and the position is lost
// anyway. "Volume says it fits" is a necessary condition only; the sentence this repo exists to
// print is how often that condition is not sufficient.
//
//   packDisagreement  =  the subset with V(a, q) == 2^q exactly
//
// Those are the perfect packings — the case where every answer leaf is used by exactly one
// (candidate, lie-pattern) pair, so counting has nothing left to complain about. A loss THERE is
// the bound failing in its strongest possible form, and it is the reason `win` cannot be replaced
// by an arithmetic test even at the boundary.
//
// `minQ(n, k)` is the published-style table: par of the fresh position (n, 0, …, 0), with the
// bound's own prediction `boundPar` next to it so the screen can show "the bound said 4, the
// truth is 5". A cell the scan could not settle inside qMax is written as null and READS AS
// UNMEASURED — it is never filled in with the bound's answer.
//
// Build time and tests only (DESIGN 4: nothing here is on a click path).

import { fresh, total, answer, realizable, questions, questionCount, encode } from './state.js';
import { volume, boundPar } from './volume.js';
import { makeSolver, BudgetError } from './solve.js';
import { makeBrute } from './brute.js';
import { decide } from './adversary.js';
import { strategyList, runVsAdversary } from './greedy.js';

// All weight vectors of length k+1 with 1 <= Σ a_i <= maxSum, in ascending Σ then ascending
// lexicographic order. Ordering by Σ first means the memo fills from the bottom up, which is what
// keeps the recursive solver from re-expanding a subposition it has already settled.
export function universe(k, maxSum) {
  const out = [];
  const a = new Array(k + 1).fill(0);
  (function rec(i, left) {
    if (i === k) {
      for (let v = 0; v <= left; v++) { a[i] = v; out.push(a.slice()); }
      return;
    }
    for (let v = 0; v <= left; v++) { a[i] = v; rec(i + 1, left - v); }
  })(0, maxSum);
  // Sort by (Σ, vector) so a position is always asked about after everything it can branch to.
  out.sort((p, r) => (total(p) - total(r)) || cmp(p, r));
  return out.filter((p) => total(p) >= 1);
}

function cmp(p, r) {
  for (let i = 0; i < p.length; i++) if (p[i] !== r[i]) return p[i] - r[i];
  return 0;
}

// The headline sweep. `opts`: {maxSum, kMax, qMax, maxNodes, maxMs, onProgress}.
// Returns one record per k plus the totals bake.mjs reconciles against the other two routes.
export function scanUniverse(opts = {}) {
  const maxSum = opts.maxSum || 12;
  const kMax = opts.kMax === undefined ? 3 : opts.kMax;
  const qMax = opts.qMax === undefined ? 12 : opts.qMax;
  const solver = makeSolver({
    maxNodes: opts.maxNodes || 80000000,
    maxMs: opts.maxMs || 600000,
    qMax,
  });
  const started = Date.now();
  const per = [];

  for (let k = 0; k <= kMax; k++) {
    const cells = universe(k, maxSum);
    let disagree = 0;
    let pack = 0;
    let volumeOk = 0;
    let unmeasured = 0;
    let beyondDepth = 0;   // fresh(n,k) needs more questions than this sweep counts (qMax), not a failure
    let best = null;      // smallest disagreement: by Σ, then q, then lexicographic
    let bestPack = null;
    const minQ = [];      // index n -> {par, bound}
    const losses = new Map(); // q -> count, for the shape of the failure
    const winAt = new Map();  // n -> least winning q (fresh positions)

    for (const a of cells) {
      for (let q = 0; q <= qMax; q++) {
        const v = volume(a, q);
        const cap = 2 ** q;
        let w;
        try {
          w = solver.win(a, q);
        } catch (err) {
          if (err instanceof BudgetError) { unmeasured++; continue; }
          throw err;
        }
        if (v <= cap) {
          volumeOk++;
          if (!w) {
            disagree++;
            losses.set(q, (losses.get(q) || 0) + 1);
            const cand = { k, q, a, V: v, sum: total(a) };
            if (!best || smaller(cand, best)) best = cand;
            if (v === cap) { pack++; if (!bestPack || smaller(cand, bestPack)) bestPack = cand; }
          }
        } else if (w) {
          // Not a disagreement — a CONTRADICTION: the bound is a theorem, so this cannot happen.
          // bake.mjs stops the build on it, and the check is here rather than there so the same
          // sweep the browser re-runs can catch it too.
          throw new Error(`体积界被推翻：(${a.join(',')}) q=${q} V=${v} > 2^q=${cap} 而 DP 判 WIN`);
        }
      }
    }

    for (let n = 1; n <= maxSum; n++) {
      const a = fresh(n, k);
      const b = boundPar(a, qMax);
      let p = null;
      try {
        p = solver.par(a);
      } catch (err) {
        if (!(err instanceof BudgetError)) throw err;
        // Two different reasons a `par` can come back empty, and they must not be conflated:
        // "this position needs more questions than this sweep is willing to count" is a scope
        // limit, "the search ran out of nodes" is a failure. The message tells them apart because
        // par() only throws BudgetError from those two places.
        if (/no win within/.test(err.message)) beyondDepth++;
        else unmeasured++;
      }
      minQ.push({ n, par: p, bound: b, volume: p === null ? null : volume(a, p) });
      if (p !== null) winAt.set(n, p);
    }

    per.push({
      k,
      positions: cells.length,
      cells: cells.length * (qMax + 1),
      volumeOk,
      disagree,
      pack,
      smallest: best ? { q: best.q, a: best.a, V: best.V, sum: best.sum } : null,
      smallestPack: bestPack ? { q: bestPack.q, a: bestPack.a, V: bestPack.V, sum: bestPack.sum } : null,
      byDepth: [...losses.entries()].sort((x, y) => x[0] - y[0]).map(([q, c]) => ({ q, c })),
      minQ,
      unmeasured,
      beyondDepth,
      nodes: solver.nodes,
      entries: solver.memo.size,
    });
    if (opts.onProgress) opts.onProgress(per[per.length - 1]);
  }

  return { per, ms: Date.now() - started, maxSum, kMax, qMax, entries: solver.memo.size, nodes: solver.nodes };
}

function smaller(x, y) {
  if (x.sum !== y.sum) return x.sum < y.sum;
  if (x.q !== y.q) return x.q < y.q;
  return cmp(x.a, y.a) < 0;
}

// Where the bound's prediction and the measured par differ, i.e. the rows the screen prints as
// "界说 4，真值是 5". Only cells both routes actually answered can appear here.
export function mismatches(scan) {
  const out = [];
  for (const row of scan.per) {
    for (const cell of row.minQ) {
      if (cell.par === null || cell.bound === null) continue;
      if (cell.par !== cell.bound) out.push({ k: row.k, ...cell });
    }
  }
  return out;
}

export function headline(scan) {
  const tot = { cells: 0, volumeOk: 0, disagree: 0, pack: 0, positions: 0 };
  for (const r of scan.per) {
    tot.cells += r.cells;
    tot.volumeOk += r.volumeOk;
    tot.disagree += r.disagree;
    tot.pack += r.pack;
    tot.positions += r.positions;
  }
  tot.ms = scan.ms;
  tot.entries = scan.entries;
  return tot;
}

// ---------------------------------------------------------------------------
// THE IDENTITIES. Each one is a theorem about the recurrence, so a violation is not a
// "measurement that came out odd" — it means the DP or the position algebra is broken, and
// bake.mjs refuses to write a table on top of that. All of them run on the same memoised solver,
// so the whole battery costs a few hundred thousand map lookups, not a re-search.
//
//   monotone in q      : win(a,q) ⟹ win(a,q+1)                (a spare question is never a burden)
//   bound is a bound   : win(a,q) ⟹ V(a,q) <= 2^q              (scanUniverse throws on the reverse)
//   par >= boundPar    : everywhere the two agree to be defined
//
// and the four GENERATING steps of the hardness order. Hardness is the prefix-sum order
// (state.dominates): weight sitting further LEFT is harder, because a candidate that has not been
// contradicted yet can still lie k more times, while one in the last slot has no lies left to
// spend and is therefore nearly determined. Every comparable pair is related by these steps, so
// checking them is checking the general statement, and it costs four memo lookups per position:
//   WIN  a ⟹ WIN  a with one candidate removed        (easier)
//   WIN  a ⟹ WIN  a with one candidate moved UP       (easier)
//   LOSS a ⟹ LOSS a with one candidate added          (harder)
//   LOSS a ⟹ LOSS a with one candidate moved DOWN     (harder)
// The last two are the direction the eye gets wrong: "a candidate already contradicted once" feels
// worse than a clean one and is in fact better, and writing the check the wrong way round is how
// this repo caught itself — (1,1) is a LOSS at q=1 while (0,2) is a WIN.
// ---------------------------------------------------------------------------
export function checkIdentities(opts = {}) {
  const maxSum = opts.maxSum || 12;
  const kMax = opts.kMax === undefined ? 3 : opts.kMax;
  const qMax = opts.qMax === undefined ? 10 : opts.qMax;
  const solver = makeSolver({
    maxNodes: opts.maxNodes || 80000000,
    maxMs: opts.maxMs || 600000,
    qMax: (opts.parQMax || qMax) + 2,
  });
  const started = Date.now();
  const bad = [];
  let pairs = 0;
  let wins = 0;
  const fail = (rec) => { if (bad.length < 12) bad.push(rec); };
  for (let k = 0; k <= kMax; k++) {
    for (const a of universe(k, maxSum)) {
      const t = total(a);
      for (let q = 1; q <= qMax; q++) {
        const w = solver.win(a, q);
        pairs++;
        if (w) wins++;
        if (w && !solver.win(a, q + 1)) fail({ kind: 'monotone-q', k, a, q });
        if (w && volume(a, q) > 2 ** q) fail({ kind: 'bound', k, a, q, V: volume(a, q) });
        for (let i = 0; i < a.length; i++) {
          if (a[i] === 0) continue;
          if (w) {
            if (t >= 2) {
              const removed = a.slice();
              removed[i] -= 1;
              if (total(removed) >= 1 && !solver.win(removed, q)) fail({ kind: 'remove', k, a, q, b: removed });
            }
            if (i + 1 < a.length) {
              const up = a.slice();
              up[i] -= 1;
              up[i + 1] += 1;
              if (!solver.win(up, q)) fail({ kind: 'move-up', k, a, q, b: up });
            }
          } else {
            const added = a.slice();
            added[i] += 1;
            if (total(added) <= maxSum && solver.win(added, q)) fail({ kind: 'add', k, a, q, b: added });
            if (i > 0) {
              const down = a.slice();
              down[i] -= 1;
              down[i - 1] += 1;
              if (solver.win(down, q)) fail({ kind: 'move-down', k, a, q, b: down });
            }
          }
        }
      }
    }
  }
  return { pairs, wins, bad, badCount: bad.length, ms: Date.now() - started, maxSum, kMax, qMax };
}

// ---------------------------------------------------------------------------
// ROUTE 3 AGREEMENT. js/core/brute.js enumerates actual candidate sets with per-candidate lie
// counters and never forms a weight vector, so this is the one check that does not assume the
// aggregation in state.js is correct. It is the expensive check: the shipped setting
// (n<=8, k<=2, q<=5) is ~6·10^5 (position,depth) comparisons, which is why the reduced mode drops
// to n<=6 and FULL=1 raises it.
// ---------------------------------------------------------------------------
export function bruteAgreement(opts = {}) {
  const nMax = opts.nMax === undefined ? 6 : opts.nMax;
  const kMax = opts.kMax === undefined ? 2 : opts.kMax;
  const qMax = opts.qMax === undefined ? 4 : opts.qMax;
  const solver = makeSolver({
    maxNodes: opts.maxNodes || 80000000,
    maxMs: opts.maxMs || 600000,
    qMax: qMax + 4,
  });
  const started = Date.now();
  let compared = 0;
  let dpWins = 0;
  const disagreements = [];
  for (let k = 0; k <= kMax; k++) {
    const brute = makeBrute({ maxNodes: opts.bruteNodes || 40000000 });
    for (let n = 1; n <= nMax; n++) {
      const ids = [];
      for (let x = 1; x <= n; x++) ids.push(x);
      const count = (k + 1) ** n;
      const lvl = new Array(n).fill(0);
      for (let m = 0; m < count; m++) {
        const lies = new Array(2 * n);
        for (let i = 0; i < n; i++) { lies[2 * i] = ids[i]; lies[2 * i + 1] = lvl[i]; }
        const pos = { lies, k };
        for (let q = 0; q <= qMax; q++) {
          const bw = brute.win(pos, q);
          const a = brute.weights(pos);
          const dw = solver.win(a, q);
          compared++;
          if (dw) dpWins++;
          if (bw !== dw && disagreements.length < 12) {
            disagreements.push({ k, q, a, pos: lies.slice(), brute: bw, dp: dw });
          }
        }
        for (let i = 0; i < n; i++) { lvl[i]++; if (lvl[i] <= k) break; lvl[i] = 0; }
      }
    }
  }
  return {
    nMax, kMax, qMax, compared, dpWins,
    disagreements,
    disagreementCount: disagreements.length,
    bruteNodes: solver.nodes,
    ms: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// "NAIVE BALANCED SPLITTING IS NOT A STRATEGY", measured. For every position the DP can win we
// hand the naive strategy the pen and ask what its FIRST question does: if some realizable branch
// of that question is a loss, the naive player has just thrown away a winnable position. Counted
// over the whole universe, so the number in the README is a denominator-inclusive measurement.
// ---------------------------------------------------------------------------
export function measureStrategies(opts = {}) {
  const maxSum = opts.maxSum || 14;
  const kMax = opts.kMax === undefined ? 2 : opts.kMax;
  const qMax = opts.qMax === undefined ? 8 : opts.qMax;
  const solver = makeSolver({
    maxNodes: opts.maxNodes || 80000000,
    maxMs: opts.maxMs || 600000,
    qMax: (opts.parQMax || qMax) + 2,
  });
  const started = Date.now();
  const per = strategyList.map((s) => ({ name: s.name, cn: s.cn, winnable: 0, blown: 0, worst: null }));
  for (let k = 0; k <= kMax; k++) {
    for (const a of universe(k, maxSum)) {
      if (total(a) <= 1) continue;
      for (let q = 1; q <= qMax; q++) {
        if (!solver.win(a, q)) continue;
        for (let i = 0; i < per.length; i++) {
          const s = strategyList[i];
          const y = s.pick(a, q);
          per[i].winnable++;
          const { yes, no } = answer(a, y);
          const bad = (realizable(yes) && !solver.win(yes, q - 1)) || (realizable(no) && !solver.win(no, q - 1));
          if (bad) {
            per[i].blown++;
            if (!per[i].worst) per[i].worst = { k, q, a, y };
          }
        }
      }
    }
  }
  return { maxSum, kMax, qMax, per, ms: Date.now() - started };
}

// The adversary's own audit: how often the click-time volume ranking hands the player something
// the exact DP would not have. `exact` is asked only where the memo already holds an answer, so
// this never triggers a search of its own beyond what the scan already did.
export function measureAdversary(opts = {}) {
  const maxSum = opts.maxSum || 14;
  const kMax = opts.kMax === undefined ? 2 : opts.kMax;
  const qMax = opts.qMax === undefined ? 8 : opts.qMax;
  const perCell = opts.questionsPerCell === undefined ? 40 : opts.questionsPerCell;
  const solver = makeSolver({
    maxNodes: opts.maxNodes || 80000000,
    maxMs: opts.maxMs || 600000,
    qMax: (opts.parQMax || qMax) + 2,
  });
  const started = Date.now();
  // Warm the memo the honest way: settle EVERY position in the sweep universe at every depth once.
  // After this pass the audit below only ever reads verdicts that are already committed, so the
  // reported ms is the audit's cost plus one known sweep, not a hidden re-search.
  const cellsByK = [];
  for (let k = 0; k <= kMax; k++) {
    const cells = universe(k, maxSum);
    for (const a of cells) for (let q = 0; q <= qMax; q++) solver.win(a, q);
    cellsByK.push(cells);
  }
  const warmed = { comparable: 0, suboptimal: 0, skipped: 0, hadLosingBranch: 0, worst: null };
  for (const cells of cellsByK) {
    for (const a of cells) {
      if (total(a) <= 1 || questionCount(a) > 4000) { warmed.skipped++; continue; }
      let taken = 0;
      for (const y of questions(a)) {
        if (++taken > perCell) break;
        const { yes, no } = answer(a, y);
        if (!realizable(yes) || !realizable(no)) { warmed.skipped++; continue; }
        for (let q = 1; q <= qMax; q++) {
          const depth = q - 1;
          warmed.comparable++;
          const losing = [];
          if (!solver.win(yes, depth)) losing.push(yes);
          if (!solver.win(no, depth)) losing.push(no);
          if (losing.length) warmed.hadLosingBranch++;
          // sLit=true and liesLeft>=1 is exactly the case where both branches are legal answers for
          // the dealt secret too, i.e. the only case where the ranking actually makes a choice.
          const pick = decide({ a, q, y, sLit: true, liesLeft: 1 });
          const chosen = pick.answer === 'yes' ? yes : no;
          if (losing.length && !losing.includes(chosen)) {
            warmed.suboptimal++;
            if (!warmed.worst) warmed.worst = { a, q, y };
          }
        }
      }
    }
  }
  const { comparable, suboptimal, skipped, hadLosingBranch, worst } = warmed;
  return { maxSum, kMax, qMax, comparable, suboptimal, skipped, hadLosingBranch, worst, ms: Date.now() - started };
}

