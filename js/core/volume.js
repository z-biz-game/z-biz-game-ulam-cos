// Route 2 of 3: the Berlekamp–Spencer volume bound, as an INDEPENDENT measurement.
//
// This file imports nothing — not state.js, not solve.js — on purpose. The point of a second
// route is that a shared bug cannot make both solvers agree, and the only thing this one needs
// from the position is the weight vector itself.
//
//   V(a, q) = Σ_i  a_i · Σ_{j ≤ k−i} C(q, j)
//
// Reading it out loud: a candidate sitting at contradiction level i still has to be able to take
// up to k−i more lies over the rest of the game, and with q questions left there are
// Σ_{j≤k−i} C(q,j) ways to choose which of them. So V counts "candidate × lie-pattern" pairs, and
// every answer doubles the number of distinguishable patterns. That gives the one-directional
// theorem this repo uses:
//
//   win(a, q)  ⟹  V(a, q) ≤ 2^q
//
// **The converse is false and is never assumed anywhere.** The repo's centrepiece measurement
// (tools/bake.mjs, 屏幕上的证明抽屉里那份读数) is exactly the set of positions where
// V ≤ 2^q and yet the DP says LOSS. `volumeVerdict` therefore only ever answers "impossible",
// never "winnable"; the DP is the only thing that answers that.
//
// Exact integer arithmetic only: C(q,j) for q ≤ 14 fits in 32 bits, and V fits well inside
// Number.MAX_SAFE_INTEGER for every position the repo considers (Σa ≤ 40, q ≤ 14 ⇒ V < 10^7).

// Pascal's triangle, built on demand. The build walks DOWN from the requested row to row 0 and
// back up, so a cold process may legally ask for q=13 before it ever asks for q=4 — the screen's
// first readout does exactly that on a 16-cell lot. (A `PASCAL[n - 1] || [1]` shortcut here
// silently filled row 12 from `[1]` on such a call and cached NaN all the way up, which poisoned
// every later V on the page and turned the DP's volume prune into a no-op.)
const PASCAL = [];
function pascalRow(n) {
  if (PASCAL[n]) return PASCAL[n];
  if (n === 0) {
    PASCAL[0] = [1];
    return PASCAL[0];
  }
  const prev = pascalRow(n - 1);
  const row = new Array(n + 1);
  row[0] = 1;
  row[n] = 1;
  for (let i = 1; i < n; i++) row[i] = prev[i - 1] + prev[i];
  PASCAL[n] = row;
  return row;
}

function binom(n, r) {
  if (r < 0 || r > n) return 0;
  return pascalRow(n)[r];
}

// Σ_{j ≤ d} C(q, j), the number of ≤d-subsets of a q-set.
export function ball(q, d) {
  let s = 0;
  for (let j = 0; j <= d; j++) s += binom(q, j);
  return s;
}

// `a` is the weight vector; slot i holds candidates already contradicted i times.
export function volume(a, q) {
  const k = a.length - 1;
  let s = 0;
  for (let i = 0; i <= k; i++) {
    if (a[i]) s += a[i] * ball(q, k - i);
  }
  return s;
}

export function capacity(q) {
  return 2 ** q;
}

// The bound's own opinion about how many questions are needed: the least q with V(a,q) ≤ 2^q.
// Returns null when no q up to `qMax` satisfies it, i.e. the bound cannot certify this position
// at any depth we are willing to talk about.
export function boundPar(a, qMax = 24) {
  for (let q = 0; q <= qMax; q++) {
    if (volume(a, q) <= 2 ** q) return q;
  }
  return null;
}

// What the bound can say for sure. `false` = provably impossible; `null` = silent, NOT a win.
export function volumeVerdict(a, q) {
  return volume(a, q) > 2 ** q ? false : null;
}

// The slack the screen prints as a difficulty readout: how much of the answer tree the volume
// bound leaves over. 1.0 means a perfect packing (every leaf is a distinct lie-pattern), and it
// is exactly the boundary where the bound stops being informative in practice.
export function margin(a, q) {
  const v = volume(a, q);
  return v === 0 ? Infinity : 2 ** q / v;
}

// 表里写的余量是四位小数：比"表里的 margin"和"现场重算的 margin"必须两边都过这个函数，
// 拿全精度去比 4 位小数会永远不等，把好数据读成坏数据。
export const MARGIN_DP = 4;
export function printMarginValue(v) {
  return Number.isFinite(v) ? +v.toFixed(MARGIN_DP) : v;
}
export function printMargin(a, q) {
  return printMarginValue(margin(a, q));
}

export function formatVolume(a, q) {
  const v = volume(a, q);
  return `V=${v} vs 2^${q}=${2 ** q}`;
}
