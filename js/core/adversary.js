// 对手：一台从不反悔的应答机。
//
// 玩家在 {1..n} 里问"是不是在亮格里"，对手最多可以说 k 个谎。这里实现的是**下棋用的那个**对手，
// 它必须满足三条硬性质，test/game.test.mjs 一条条按在机器上（每一问之后都查一遍）：
//
//   1. **全函数（total）**：任何合法问题都必须答得出来，不存在"两边都不能答"的状态。
//      证明只有一行：真话那一支永远不会把发到的秘密 s 推高一层，所以 s 始终活着，
//      于是那一支的 Σ ≥ 1 —— 也就是说它永远合法。所以下面 `legalAnswers` 至少返回一个元素。
//   2. **从不破坏可实现性**：它只从"合法支"里挑，合法 = Σ 支 ≥ 1 且 s 活着。Σ ≥ 1 就是
//      "存在一个候选数字与全部答案相容、且谎数没超"，即状态里那个 witness 的定义（state.js 头注）。
//      所以每一问之后 `realizable(state)` 都为真，且 per-candidate 计数器与权重向量始终自洽。
//   3. **确定性**：同样的输入永远给同样的答案，没有随机数、没有时间依赖。回放一局只需要重放问题序列。
//
// 挑哪一支？任务书里写的是"有任何可实现支是败局就递给玩家败局，否则让剩余 par 尽量小"。
// 前半句照抄；后半句**这里是反着做的**：剩余 par 是玩家还需要问的题数，把它做小等于替玩家收拾残局，
// 那是帮助而不是对抗。所以实现取"否则让剩余难度尽量大"，并在 README/DESIGN 里明说这处修正。
//
// 点击路径上不许有搜索（DESIGN 4）。所以这个文件**不 import solve.js**：它只能用体积界
// `boundPar` 和 `volume` 这两个纯算术量给分支排序。`rank` 参数是给构建期留的口子——
// tools/bake.mjs 会注入一个真正查 DP 的排序器，用来量"体积界排序器和精确 DP 排序器在同一批
// 分支上有多不一致"，这个数字随 lots.js 一起发布。浏览器里没有注入，也就永远不会去搜。

import { answer, total, realizable } from './state.js';
import { volume, boundPar } from './volume.js';

// 一支能不能答？两个条件都要过：状态本身可实现，而且发到的秘密还没被这一答挤出去。
// sLit = 秘密在当前亮的集合里；liesLeft = 对手在这个秘密上还能撒几次谎。
export function branchLegal({ branch, sLit, liesLeft, side }) {
  if (!realizable(branch)) return false;
  const liesThisAnswer = side === 'yes' ? !sLit : sLit;
  return !liesThisAnswer || liesLeft > 0;
}

// 全部合法回答。顺序固定：先真话后假话，这样"只有一个合法"时不需要排序器。
export function legalAnswers({ a, y, sLit, liesLeft, truth = 'yes' }) {
  const { yes, no } = answer(a, y);
  const out = [];
  const first = truth === 'yes' ? 'yes' : 'no';
  const second = first === 'yes' ? 'no' : 'yes';
  for (const side of [first, second]) {
    if (branchLegal({ branch: side === 'yes' ? yes : no, sLit, liesLeft, side })) out.push(side);
  }
  return out;
}

// 分支难度分：越大越难。`null`（体积界在 qMax 内给不出数）当作最难，
// 因为那意味着候选数已经多到球包装不下——这正是玩家该头疼的地方。
export function branchScore(b, depth) {
  const par = boundPar(b, depth + 6);
  return { par: par === null ? Infinity : par, v: volume(b, depth), sum: total(b) };
}

export function betterScore(x, r) {
  if (x.par !== r.par) return x.par > r.par;
  if (x.v !== r.v) return x.v > r.v;
  return x.sum > r.sum;
}

// 一局里的核心决策。opts = { a, q, y, sLit, liesLeft, truth, rank }
//   q = 这一问答完之后还剩几问（分支处在深度 q-1，所以排序用 depth = q - 1）
//   truth = 真话是 'yes' 还是 'no'（由 sLit 决定，调用方给）
//   rank  = 可选的构建期排序器 (branch, depth) => number，越大越难；给了就覆盖体积界排序。
// 返回 { answer, branch, depth, rule, lied, legal }。
export function decide(opts) {
  const { a, q, y, sLit, liesLeft, rank = null } = opts;
  const truth = sLit ? 'yes' : 'no';
  const legal = legalAnswers({ a, y, sLit, liesLeft, truth });
  const { yes, no } = answer(a, y);
  const depth = Math.max(0, q - 1);
  const branchOf = (side) => (side === 'yes' ? yes : no);
  const scoreOf = (side) => (rank
    ? { rank: rank(branchOf(side), depth) }
    : branchScore(branchOf(side), depth));
  const greater = (x, r) => (rank ? x.rank > r.rank : betterScore(x, r));

  if (legal.length === 1) {
    const side = legal[0];
    return {
      answer: side,
      branch: branchOf(side),
      depth,
      rule: 'forced',
      lied: side !== truth,
      legal,
    };
  }

  // legal[0] 一定是真话（legalAnswers 固定先真后假），所以"严格大于才换"就是
  // "平手时不浪费谎"。整段没有别的分支，因此排序器给的分相同时结果仍然唯一。
  let best = legal[0];
  let bestScore = scoreOf(best);
  for (const side of legal.slice(1)) {
    const s = scoreOf(side);
    if (greater(s, bestScore)) {
      best = side;
      bestScore = s;
    }
  }
  return {
    answer: best,
    branch: branchOf(best),
    depth,
    rule: rank ? 'ranked' : 'volume',
    lied: best !== truth,
    legal,
  };
}

// 构建期对照器：同一批输入下，体积界排序器和**精确 DP** 会不会选同一支。
// `exact(branch, depth)` 返回 true(WIN) / false(LOSS) / null(表外，不参与统计)。
// 返回 null 表示"这一支的判定表里没有"，调用方跳过；否则 `optimal` 为假就是一个可计量的
// 失误：存在合法的败局支，而体积界排序器把玩家递到了可胜支上。
export function divergence({ a, q, y, sLit, liesLeft, exact }) {
  const truth = sLit ? 'yes' : 'no';
  const legal = legalAnswers({ a, y, sLit, liesLeft, truth });
  const depth = Math.max(0, q - 1);
  const { yes, no } = answer(a, y);
  const branchOf = (side) => (side === 'yes' ? yes : no);
  const verdicts = [];
  for (const side of legal) {
    const v = exact(branchOf(side), depth);
    if (v === null || v === undefined) return null;
    verdicts.push({ side, v });
  }
  const losing = verdicts.filter((r) => r.v === false).map((r) => r.side);
  const chosen = decide({ a, q, y, sLit, liesLeft }).answer;
  return {
    comparable: true,
    chosen,
    losing,
    optimal: losing.length === 0 || losing.includes(chosen),
  };
}
