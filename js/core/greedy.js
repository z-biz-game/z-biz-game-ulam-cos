// 玩家侧的"显然做法"——用来被打脸的。
//
// 这个仓库的主张是：**朴素的均分不是一种策略**。教科书写"问一个把候选集分成两半的问题"，
// 但在有谎的搜索里"两半"没有定义清楚：是候选个数的一半，还是体积的一半，还是权重向量的某一格
// 的一半？三种选法给出三种不同的题，而其中两种会在 DP 判 WIN 的位置上把必胜打成必败。
// 具体差多少，由 tools/bake.mjs 量出来并连同关卡一起发布（`greedy` 块），数字不是估的。
//
// 这里只放**排序/构造**，不放搜索：本文件不 import solve.js，所以浏览器可以在点击路径上用它
// （关卡表外的提示就是这个文件里的 volumeBalance），而构建期对照由 table.js 注入 `win` 完成。
//
// 每个策略都是同一个形状：{ name, cn, pick(a, q) -> y }，y 是"每一格里亮几个"的 profile，
// 具体的亮格由 game.js 按固定顺序挑格子（策略只决定数量，不决定身份，避免策略里藏棋盘知识）。

import { questions, questionCount, total } from './state.js';
import { volume } from './volume.js';

const ENUM_CAP = 250000;   // 一次点击最多枚举多少个 profile；超过就退化成逐格构造

// 体积均分：让两支的 V 尽量接近，其次让较大的那支尽量小。
function pickBalanced(a, q) {
  const d = Math.max(0, q - 1);
  let best = null;
  for (const y of questions(a)) {
    const { yes, no } = splitByProfile(a, y);
    const vy = total(yes) ? volume(yes, d) : 0;
    const vn = total(no) ? volume(no, d) : 0;
    const cand = { gap: Math.abs(vy - vn), peak: Math.max(vy, vn), y };
    if (!best || better(cand, best)) best = cand;
  }
  return best ? best.y : a.map(() => 0);
}

function better(x, r) {
  if (x.gap !== r.gap) return x.gap < r.gap;
  if (x.peak !== r.peak) return x.peak < r.peak;
  for (let i = 0; i < x.y.length; i++) if (x.y[i] !== r.y[i]) return x.y[i] < r.y[i];
  return false;
}

// 个数均分：完全无视谎数层级，只把活着的候选劈成两半。教科书里那句"二分"最粗暴的读法。
function pickHalve(a, q) {
  const t = total(a);
  const y = new Array(a.length).fill(0);
  let left = Math.floor(t / 2);
  for (let i = 0; i < a.length && left > 0; i++) {
    const take = Math.min(a[i], left);
    y[i] = take;
    left -= take;
  }
  return y;
}

// 层级均分：低层（还没被反驳过的候选）优先亮，但每一格都尽量劈开——"聪明的"那一种朴素做法。
function pickByLevel(a, q) {
  const y = new Array(a.length).fill(0);
  for (let i = 0; i < a.length; i++) y[i] = Math.floor(a[i] / 2);
  return y;
}

// 与 state.js 的 answer() 等价的本地分解，只用来算体积：不 import 是为了让这一族策略和
// 位置代数各自独立可测（test/greedy.test.mjs 把两者在同一批 profile 上对表）。
function splitByProfile(a, y) {
  const k = a.length - 1;
  const yes = new Array(k + 1);
  const no = new Array(k + 1);
  for (let j = 0; j <= k; j++) {
    yes[j] = y[j] + (j > 0 ? a[j - 1] - y[j - 1] : 0);
    no[j] = a[j] - y[j] + (j > 0 ? y[j - 1] : 0);
  }
  return { yes, no };
}

function guarded(pick) {
  return (a, q) => {
    if (questionCount(a) > ENUM_CAP) return pickByLevel(a, q);
    return pick(a, q);
  };
}

export const strategies = {
  volumeBalance: { name: 'volumeBalance', cn: '体积均分', pick: guarded(pickBalanced) },
  halveCandidates: { name: 'halveCandidates', cn: '个数均分', pick: pickHalve },
  byLevel: { name: 'byLevel', cn: '逐层对半', pick: pickByLevel },
};

export const strategyList = [strategies.volumeBalance, strategies.halveCandidates, strategies.byLevel];

// 一局的走法：玩家按 strategy 出题，对手按 `worst` 从可实现支里挑最狠的一支。
// `opts.win(a, q)` 是构建期注入的精确判定（DP），所以这个函数**只能在 node 里跑**。
// 终止条件就是游戏规则：问完 q 问必须指一个数，只有 Σa = 1 时才指得对。
export function runVsAdversary(strategy, a0, q0, opts) {
  const { win, answer } = opts;
  const path = [];
  let a = a0.slice();
  let q = q0;
  let asked = 0;
  while (q > 0) {
    const y = strategy.pick(a, q);
    const br = answer(a, y);
    const realizable = [];
    if (total(br.yes) >= 1) realizable.push(br.yes);
    if (total(br.no) >= 1) realizable.push(br.no);
    // 对手：先看有没有让玩家输的支；没有就挑剩余 par 最大的（tie：字典序第一支）。
    const losing = realizable.filter((b) => !win(b, q - 1));
    const next = losing.length ? losing[0] : realizable.reduce((p, c) => (volume(c, q - 1) > volume(p, q - 1) ? c : p));
    path.push({ a: a.slice(), q, y, chose: next.slice(), handed: losing.length > 0 });
    a = next;
    q -= 1;
    asked += 1;
    if (total(a) <= 1) break;
  }
  return { won: total(a) === 1, path, asked, final: a, left: q };
}
