// Route 3 of 3: the definition, told literally, with no state aggregation at all.
//
// js/core/state.js replaces "which candidates are possible, and how many lies each has accrued"
// with a k+1-slot weight vector. That quotient is the entire reason the DP is cheap — and it is
// also an assumption: two positions with the same weight vector must have the same winner. This
// file never makes it. A position here is a LIST OF NAMED NUMBERS, each carrying its own lie
// count, and a question is a SUBSET OF THOSE NUMBERS.
//
//   bruteWin(S, q, k):
//     |S| = 0 -> false                      (nothing left to point at)
//     |S| = 1 -> true                       (one candidate, point at it)
//     q = 0   -> false                      (two or more left and no question to split them)
//     otherwise: true iff SOME subset T of S has the property that both
//        YES: every x in T keeps its count, every x outside T gains one (x > k leaves S)
//        NO : the mirror image
//     is realizable (>= 1 survivor) and bruteWin(..., q-1, k).
//
// No memo is shared with solve.js, no volume bound is consulted, no short-circuit from either
// solver is imported — the two things solve.js leans on that are NOT reproduced here are the
// Berlekamp prune (V > 2^q ⟹ loss) and the monotone carry in q, so a bug in either shows up as a
// disagreement rather than as agreement. `tools/bake.mjs` and `test/brute.test.mjs` run the
// agreement check over the whole concrete universe of n <= 8, k <= 2, q <= 5 and print how many
// positions were compared; that count is the evidence, not a comment claiming it.
//
// Exponential by construction: it runs in tests and at build time, never on a click.

// A concrete position: `lies` is a flat array, pairs of (candidate id, contradiction count), in
// ascending id order. Dead candidates (count > k) are dropped at the point they die, which is the
// only bookkeeping the game needs.
export function makePosition(ids, k) {
  const lies = new Array(ids.length * 2);
  for (let i = 0; i < ids.length; i++) {
    lies[2 * i] = ids[i];
    lies[2 * i + 1] = 0;
  }
  return { lies, k };
}

export function positionIds(pos) {
  const out = [];
  for (let i = 0; i < pos.lies.length; i += 2) out.push(pos.lies[i]);
  return out;
}

export function positionCount(pos) {
  return pos.lies.length / 2;
}

// Answer a question. `lit` is a Set of candidate ids that answered YES.
// The `n === lies.length` reuse is on FILLED entries, not array length: `next` is allocated at
// full size, so comparing lengths would always be true and hand back the input untouched — which
// is exactly the bug `test/brute.test.mjs` now pins with a one-step fixture.
export function respond(pos, lit, answerIsYes) {
  const { lies, k } = pos;
  const next = new Array(lies.length);
  let n = 0;
  for (let i = 0; i < lies.length; i += 2) {
    const id = lies[i];
    let c = lies[i + 1];
    const said = lit.has(id);
    if (said !== answerIsYes) c++;
    if (c > k) continue;
    next[n++] = id;
    next[n++] = c;
  }
  return { lies: n === lies.length ? next : next.slice(0, n), k };
}

// Every subset of the position's ids, as a Set, in mask order. 2^|S| of them, which is why |S| <= 8.
export function subsets(ids) {
  const out = [];
  const n = ids.length;
  for (let m = 0; m < (1 << n); m++) {
    const s = new Set();
    for (let i = 0; i < n; i++) if (m & (1 << i)) s.add(ids[i]);
    out.push(s);
  }
  return out;
}

export function makeBrute(opts = {}) {
  const maxNodes = opts.maxNodes || 8000000;
  const memo = new Map();
  let nodes = 0;
  let compared = 0; // positions this route actually answered (memo hits included)

  function keyOf(pos, q) {
    // Order-independent: `respond` preserves ascending id order, so the flat array is canonical.
    // `k` MUST be part of the key. It looks redundant — the same lies array is a legal position
    // for several budgets — but a LARGER budget is worse for the searcher, so the same array flips
    // verdict across k: "two candidates, one already contradicted, 3 questions" is a WIN at
    // budget 1 (par 2 — light the clean one, both branches leave a single survivor) and a LOSS at
    // budget 2 (par 4 — the responder can afford to contradict twice). Dropping `k` let a verdict
    // computed for one budget answer the lookup for another, and this repo's first run of the
    // agreement check caught it: 75,989 phantom disagreements, all of them brute's own bug.
    // test/brute.test.mjs pins it with exactly that same-array fixture, both orders.
    return pos.k + '|' + q + ':' + pos.lies.join(',');
  }

  function win(pos, q) {
    compared++;
    if (positionCount(pos) === 0) return false;
    if (positionCount(pos) === 1) return true;   // re-derived, not short-circuited: one survivor
    if (q === 0) return false;                   // two survivors, no question left
    const key = keyOf(pos, q);
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    if (++nodes > maxNodes) throw new Error(`brute: ${nodes} nodes > maxNodes ${maxNodes}`);
    const ids = positionIds(pos);
    let out = false;
    const all = subsets(ids);
    for (let i = 0; i < all.length && !out; i++) {
      const yes = respond(pos, all[i], true);
      if (positionCount(yes) > 0 && !win(yes, q - 1)) continue;
      const no = respond(pos, all[i], false);
      if (positionCount(no) > 0 && !win(no, q - 1)) continue;
      out = true;
    }
    memo.set(key, out);
    return out;
  }

  return {
    win,
    get nodes() { return nodes; },
    get positions() { return compared; },
    memo,
    // Does this concrete position aggregate to the weight vector `a`? Used by the cross-check to
    // hand the DP the same position in the other route's vocabulary.
    weights(pos) {
      const a = new Array(pos.k + 1).fill(0);
      for (let i = 0; i < pos.lies.length; i += 2) a[pos.lies[i + 1]]++;
      return a;
    },
  };
}
