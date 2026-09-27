// Route 1 of 3: the exact decision DP. Everything the game prints as a difficulty number comes
// out of this file, and nothing in the shipped browser build ever calls it (DESIGN 4).
//
//   win(a, 0)        ⟺  Σ a_i = 1        (no questions left: you must be able to point)
//   win(a, q > 0)    ⟺  ∃ a question y such that EVERY REALIZABLE branch of answer(a, y)
//                        is a win at q - 1
//
// "Every REALIZABLE branch" is the whole game: the responder may lie up to k times but may not
// hand back an answer that is consistent with no number at all. A branch with Σ = 0 is not a
// position, it is a contradiction, and the quantifier simply does not range over it. That is also
// why no separate bookkeeping is needed to keep "at most k lies" true — the recurrence drops any
// candidate that would exceed the budget (slots above k are never produced by `answer`).
//
//   par(a) = the least q with win(a, q)      — computed, never asserted
//
// Four things keep it honest and finite:
//   * MEMO on (a, q). A position reached by two different question sequences is one subproblem.
//   * MONOTONE carry: win(a, q-1) ⟹ win(a, q) (proved in test/solve.test.mjs over the whole
//     universe, and used as a short-circuit here) — without it the universe scan re-expands
//     every already-won position at every depth.
//   * VOLUME: volumeVerdict() answers `false` when V(a,q) > 2^q. That is the ONE direction of
//     Berlekamp's bound that is a theorem, so it is a legal prune. This file never consults the
//     bound for a POSITIVE verdict, and tools/bake.mjs measures how often positive would have
//     been wrong.
//   * BUDGET: `guard.tick()` throws BudgetError when nodes or wall clock run out. A solver that
//     answered by giving up would print a fake par, so it throws instead and the caller is forced
//     to say "unmeasured".

import { answer, realizable, total, encode, questions, validateQuestion } from './state.js';
import { volumeVerdict, volume } from './volume.js';

export class BudgetError extends Error {}

export function makeGuard(kind, opts = {}) {
  const maxNodes = opts.maxNodes || 400000;
  const maxMs = opts.maxMs === undefined ? 20000 : opts.maxMs;
  const now = opts.now || Date.now;
  const started = now();
  let nodes = 0;
  return {
    tick() {
      nodes++;
      if (nodes > maxNodes) throw new BudgetError(`${kind}: ${nodes} nodes > maxNodes ${maxNodes}`);
      if ((nodes & 511) === 0 && now() - started > maxMs) {
        throw new BudgetError(`${kind}: ${nodes} nodes past ${maxMs}ms`);
      }
      return nodes;
    },
    get nodes() { return nodes; },
    ms() { return now() - started; },
  };
}

// A solver owns its memo, so a build-time universe scan and a test cross-check never share cache
// and a stale entry can never make two routes agree with each other.
export function makeSolver(opts = {}) {
  const guard = makeGuard('win', opts);
  const memo = new Map();      // encode(a,q) -> true | false
  const champ = new Map();     // encode(a,q) -> the question `champion` settled on
  const qMax = opts.qMax || 20;

  // The lemma `win(a,q)` is asked about; the two O(1) short-circuits below are the only things
  // that may answer it without expanding a single question, and both are re-proved by
  // js/core/brute.js on concrete positions (which has no such short-circuit).
  function win(a, q) {
    const t = total(a);
    if (t === 0) return false; // unreachable in real play; false, not "vacuously true"
    if (t === 1) return true;  // one survivor: light it, the NO branch is a contradiction
    if (q === 0) return false; // t >= 2 here, so the terminal case is a loss
    const key = encode(a, q);
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    // Monotone carry (see header). Checked before the theorem because it is a cheaper lookup and
    // because it is a property of THIS recurrence, so it must be exercisable without volume.
    if (q > 0 && memo.get(encode(a, q - 1)) === true) {
      memo.set(key, true);
      return true;
    }
    if (volumeVerdict(a, q) === false) { memo.set(key, false); return false; }
    guard.tick();
    const best = search(a, q);
    memo.set(key, best !== null);
    if (best !== null) champ.set(key, best);
    return best !== null;
  }

  // The quantifier, written out: the first question all of whose realizable branches win.
  // Returns that question, or null when no question works (a LOSS position). The visit order is
  // the lexicographic order of `questions()`, and it is because that order is fixed that the
  // champion baked into a lot is reproducible from the table alone.
  function search(a, q) {
    for (const y of questions(a)) {
      const { yes, no } = answer(a, y);
      if (realizable(yes) && !win(yes, q - 1)) continue;
      if (realizable(no) && !win(no, q - 1)) continue;
      return y;
    }
    return null;
  }

  // par(a) by iterative deepening from the volume bound: the bound is a one-way theorem, so
  // starting below it would only buy a guaranteed-failed search. When `qMax` is reached without a
  // win, `par` is UNMEASURED and this throws rather than returning `qMax` as if it were a number.
  function par(a, from = 0) {
    if (total(a) === 1) return 0;
    let lo = from;
    if (lo === 0) {
      for (let q = 0; q <= qMax; q++) { if (volumeVerdict(a, q) !== false) { lo = q; break; } lo = q + 1; }
    }
    for (let q = lo; q <= qMax; q++) if (win(a, q)) return q;
    throw new BudgetError(`par: no win within qMax=${qMax} for (${a.join(',')})`);
  }

  // The hint's answer: the champion question of a WINNING position, chosen under the same fixed
  // order `search` uses (lexicographic in y, first that works), which is what makes it
  // reproducible from the baked table alone. `null` when the position is a loss or unmeasured.
  function champion(a, q) {
    if (!win(a, q)) return null;
    const key = encode(a, q);
    const hit = champ.get(key);
    if (hit !== undefined) return hit;
    const best = search(a, q);
    if (best) champ.set(key, best);
    return best;
  }

  return {
    win,
    par,
    champion,
    get nodes() { return guard.nodes; },
    ms() { return guard.ms(); },
    memo,
    stats() {
      let w = 0;
      for (const v of memo.values()) if (v) w++;
      return { entries: memo.size, wins: w, losses: memo.size - w, nodes: guard.nodes, ms: guard.ms() };
    },
  };
}

// The default build-time solver. Generous node budget: an out-of-budget universe cell is
// reported as UNMEASURED by tools/bake.mjs, never as a number.
export const solver = makeSolver({ maxNodes: 60000000, maxMs: 600000 });

export function win(a, q) { return solver.win(a, q); }
export function par(a, from) { return solver.par(a, from); }
export function champion(a, q) { return solver.champion(a, q); }

// The policy a shipped lot needs: for every position reachable under the champion strategy, the
// champion question itself. Expanded from the root, so the table is
//   * CLOSED — every realizable answer to a tabulated position is itself tabulated (or reduced to
//     one survivor, which needs no strategy), and
//   * DESCENDING — the tabulated question count drops by exactly one per ply, so the "还需 N 步"
//     the hint prints can never grow while the player is following it.
// Both are re-checked from the serialised array by test/library.test.mjs, and `tools/bake.mjs`
// refuses to ship a lot whose policy fails. That is what turns 提示 from a suggestion into a claim.
//
// A row is [key, a, q, y]. `a` and `q` are carried alongside their own encoding deliberately:
// `policyClosed` re-derives `key` from them and fails if they disagree, so a hand-edited
// js/data/lots.js cannot quietly relabel a strategy from another position.
//
// `opts.q` pins the root depth. A lot that grants MORE questions than the measured par
// (par <= q, which is what the campaign ships) needs the tree rooted at the granted depth, or the
// in-game lookup would miss the very first position; `win` is monotone in q, so the champion at a
// larger depth is still a winning question.
export function buildPolicy(root, opts = {}) {
  const s = makeSolver(opts);
  const q0 = opts.q === undefined ? s.par(root) : opts.q;
  if (!s.win(root, q0)) throw new Error(`策略根是败局：(${root.join(',')}) q=${q0}`);
  const out = new Map();
  const visit = (a, q) => {
    if (total(a) <= 1 || q === 0) return;
    const key = encode(a, q);
    if (out.has(key)) return;
    const y = s.champion(a, q);
    if (!y) return; // a loss position: the champion strategy never walks here
    out.set(key, { a, q, y });
    const { yes, no } = answer(a, y);
    if (realizable(yes)) visit(yes, q - 1);
    if (realizable(no)) visit(no, q - 1);
  };
  visit(root, q0);
  const policy = [...out.entries()]
    .sort((p, r) => p[0] - r[0])
    .map(([k, v]) => [k, v.a, v.q, v.y]);
  return { q0, policy, nodes: s.nodes, ms: s.ms(), solver: s };
}

// Verify a serialised policy without re-searching anything: pure lookups, cheap enough to run on
// every shipped lot in a test. Returns an error string, or null when the table holds.
export function policyClosed(policy) {
  const byKey = new Map();
  for (const row of policy) {
    const [key, a, q, y] = row;
    if (!Array.isArray(a) || !Array.isArray(y) || !Number.isInteger(q)) return `策略行 ${key} 形状非法`;
    if (encode(a, q) !== key) return `策略键 ${key} 与它标注的 (${a.join(',')}, q=${q}) 不一致`;
    if (byKey.has(key)) return `策略键 ${key} 出现两次`;
    byKey.set(key, { a, q, y });
  }
  for (const { a, q, y } of byKey.values()) {
    if (q < 1) return `q=${q} 的位置还存了步法：(${a.join(',')})`;
    if (total(a) <= 1) return `策略表给一个只剩 ${total(a)} 个候选的位置存了步法`;
    const err = validateQuestion(a, y);
    if (err) return `步法非法：${err}`;
    const { yes, no } = answer(a, y);
    for (const branch of [yes, no]) {
      if (!realizable(branch)) continue;
      if (total(branch) === 1) continue; // one survivor needs no further strategy
      if (!byKey.has(encode(branch, q - 1))) {
        return `策略不闭合：(${a.join(',')}) 问 ${y.join(',')} 得到 (${branch.join(',')})，q=${q - 1} 不在表里`;
      }
    }
  }
  return null;
}

// The root entry of a policy: the question the DP would ask first, and the count it promises.
export function policyRoot(policy) {
  let best = null;
  for (const row of policy) {
    const [, , q] = row;
    if (!best || q > best[2]) best = row;
  }
  return best;
}

// `volume` re-exported so a caller can print the two routes side by side without a second import
// cycle; solve.js is allowed to know about volume.js, never the other way round.
export { volume };
