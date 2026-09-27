// The position algebra. Everything else in the repo — solver, adversary, view, bake — is a
// function of the four numbers defined here, so they are derived on paper first and only then
// written down.
//
// WHAT A POSITION IS
//   a = (a_0, a_1, …, a_k), where a_i = how many candidates are contradicted exactly i times.
//   A candidate is "contradicted" once for every answer it disagrees with; k is the lie budget,
//   so a candidate that would reach i = k+1 is no longer a possible secret and leaves the vector.
//   Σ a_i is the number of surviving candidates. The initial position for "a number in 1..n, no
//   questions yet" is (n, 0, …, 0) — `fresh(n, k)`.
//
// THE TWO RECURRENCES, derived rather than quoted
//   A question is, for each i, a choice of y_i of the a_i candidates to LIT (answer YES), leaving
//   n_i = a_i - y_i DARK.
//   * The answer comes back YES. A lit candidate was already saying YES, so it gains nothing: it
//     contributes y_j to slot j. A dark candidate contradicted that answer, so it moves UP one
//     slot: the n_{j-1} candidates that were dark at level j-1 land in slot j.
//         b_j = y_j + n_{j-1}                                   (n_{-1} := 0, drop j > k)
//   * The answer comes back NO. Mirror image: dark candidates stay put (n_j), lit ones were
//     contradicted and move up (y_{j-1}).
//         c_j = n_j + y_{j-1}
//   Both are one line below in `answer()`, and `test/state.test.mjs` re-derives them on a
//   hand-worked two-candidate example with the arithmetic written out in the test itself.
//
// REALIZABILITY — this is what "at most k lies" actually means
//   A branch is realizable iff Σ b_i ≥ 1: at least one surviving candidate is consistent with
//   every answer so far, which IS the statement "the answers so far are consistent with some
//   actual number and ≤ k lies". An unrealizable branch is not a position the adversary may
//   hand back, so the solver never requires a strategy to survive it. No separate witness search
//   is needed to keep the invariant — it is the definition of the branch.
//
// Pure: no DOM, no window, no mutation of arguments.

export const K_MAX = 3;      // the shipped game never exceeds 3 lies
export const N_MAX = 40;     // cells on the board (js/view.js lays out up to 40)
export const Q_MAX = 14;     // question budget cap

// A position is a plain array of length k+1. Slots must be non-negative integers.
export function fresh(n, k) {
  const a = new Array(k + 1).fill(0);
  a[0] = n;
  return a;
}

export function total(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

export function liesLeft(a) {
  return a.length - 1;
}

// Question shape validation: y must sit inside a slot by slot.
export function validateQuestion(a, y) {
  if (!Array.isArray(a) || a.length < 1) return '位置必须是至少一格的权重向量';
  if (!Array.isArray(y) || y.length !== a.length) return '问题必须与位置等长';
  for (let i = 0; i < a.length; i++) {
    if (!Number.isInteger(a[i]) || a[i] < 0) return `权重 a_${i} 非法`;
    if (!Number.isInteger(y[i]) || y[i] < 0 || y[i] > a[i]) return `y_${i} 超出 a_${i}`;
  }
  return null;
}

// The spine of the repo. `answer(a, y)` returns BOTH branches, so a caller can check
// realizability of each side without re-deriving anything.
export function answer(a, y) {
  const err = validateQuestion(a, y);
  if (err) throw new Error(err);
  const k = a.length - 1;
  const yes = new Array(k + 1);
  const no = new Array(k + 1);
  for (let j = 0; j <= k; j++) {
    const n = a[j] - y[j];
    const prevDark = j > 0 ? a[j - 1] - y[j - 1] : 0;
    const prevLit = j > 0 ? y[j - 1] : 0;
    yes[j] = y[j] + prevDark;
    no[j] = n + prevLit;
  }
  return { yes, no };
}

export function realizable(branch) {
  return total(branch) >= 1;
}

// Every question the player could ask from `a`: the cartesian product of 0..a_i. Called by the
// solver and by the greedy baselines; NOT on any click path (DESIGN 4).
export function* questions(a) {
  const k = a.length - 1;
  const y = new Array(k + 1).fill(0);
  function* rec(i) {
    if (i > k) { yield y.slice(); return; }
    for (let v = 0; v <= a[i]; v++) {
      y[i] = v;
      yield* rec(i + 1);
    }
  }
  yield* rec(0);
}

// Number of questions, without building them: Π (a_i + 1). The solver's node accounting quotes it.
export function questionCount(a) {
  let m = 1;
  for (let i = 0; i < a.length; i++) m *= a[i] + 1;
  return m;
}

// Integer key for memo tables. Base 64 is safe because Σ a_i <= 40 in the shipped game and <= 32
// in the baked universe, and q <= 31.
export function encode(a, q = 0) {
  let h = q >>> 0;
  for (let i = 0; i < a.length; i++) h = h * 64 + a[i];
  return h * 8 + a.length;
}

export function key(a, q) {
  return encode(a, q);
}

// Human-readable form used on screen and in the proof drawer: (a_0 | a_1 | a_2 | a_3).
export function formatState(a) {
  return `(${a.join(' | ')})`;
}

// The one-line summary the panel prints: "N 个候选 · 各自已矛盾 0/1/2 次".
export function describeState(a) {
  const parts = [];
  for (let i = 0; i < a.length; i++) if (a[i] > 0) parts.push(`${a[i]}×${i}谎`);
  return parts.length ? parts.join(' + ') : '空';
}

// Is `a` at least as hard as `b`? Prefix order: for every i, b's first i+1 slots hold no more
// weight than a's. **越靠左越难**：一格还没被反驳过的候选后面最多还能撒 k 次谎，而最后一格里的
// 候选已经没有谎可撒、几乎已经定了。所以"少一个候选"（Σb < Σa）与"把一个候选往上挪一格"
// （b 的权重靠右）都让 b 更容易，两者都满足 dominates(a, b)。这四个生成步在
// table.checkIdentities 里对整个 universe 逐格按在机器上：win(a,q) && a ≽ b ⟹ win(b,q)。
export function dominates(a, b) {
  if (a.length !== b.length) return false;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < a.length; i++) {
    sa += a[i];
    sb += b[i];
    if (sb > sa) return false;
  }
  return true;
}

// b = a with `count` candidates moved from slot `from` to slot `to` — used by the view to label
// what a lit/dark answer did to a specific cell.
export function moved(a, from, to, count) {
  const out = a.slice();
  out[from] -= count;
  if (to < out.length) out[to] += count;
  return out;
}
