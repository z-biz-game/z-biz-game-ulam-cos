// 关卡的读入口：把 js/data/lots.js 里那份**字节可复现的**烤出来的表变成游戏对象。
//
// 三条规矩：
//   1. 浏览器只读表，不搜索。策略在这里从 [[key,a,q,y], …] 复活成 Map，一次一关，复活完缓存住。
//      点击路径上唯一的计算是 Map.get 和 O(n≤40) 的计数器归约（game.js）。
//      这条规矩是可断言的：solve.js 的守卫计了 nodes，`window.ulam.searchNodes()` 在整局打完
//      之后必须还是 0 —— tools/playtest.mjs 的 @play 就这么按着它。
//   2. 读入口顺带复验。`validate()` 只查表自身的闭合性（`policyClosed`：纯查表，不搜索），
//      所以手改过的 lots.js 在开机第一步就报错，而不是让玩家在第三问走到表外。
//      复验要真跑一遍极小极大是 tools/bake.mjs 和 test/library.test.mjs 的事。
//   3. 表里没有的关卡永远不出现在池子里。战役关的 q 一律满足 par ≤ q，这一条同样在 validate 里。

import { LOTS, MEASURED, MINQ, GREEDY, ADVISORY } from '../data/lots.js';
import { total, key, fresh } from './state.js';
import { volume, printMarginValue } from './volume.js';
import { policyClosed } from './solve.js';

const revived = new Map();

// 把序列化的策略复活成 Map<key, {a,q,y}>，并顺手再查一遍键一致（key 由 a,q 重算）。
export function policyMap(rows) {
  const m = new Map();
  for (const [k, a, q, y] of rows) {
    if (key(a, q) !== k) throw new Error(`策略键不匹配：${k} vs (${a.join(',')},q=${q})`);
    m.set(k, { a, q, y });
  }
  return m;
}

export function lotCount() {
  return LOTS.length;
}

export function lotAt(i) {
  return LOTS[i] || null;
}

// id -> lot（带复活好的 policy）。找不到返回 null，由调用方决定是路由到错误页还是回战役首页。
export function lotById(id) {
  if (!id) return null;
  const hit = revived.get(id);
  if (hit) return hit;
  const raw = LOTS.find((l) => l.id === id);
  if (!raw) return null;
  const lot = { ...raw, policy: raw.policy ? policyMap(raw.policy) : null };
  revived.set(id, lot);
  return lot;
}

export function lotIds() {
  return LOTS.map((l) => l.id);
}

// 战役顺序：按 n 升序、再按 q 升序，同一尺寸里 k 小的在前。顺序写在表里，不在这儿重排，
// 所以 `#/lot/<id>` 的"下一关"和 README 里那张关卡表说的是同一个序列。
export function campaignOrder() {
  return LOTS.slice().sort((p, r) => (p.index || 0) - (r.index || 0));
}

export function nextLot(afterIndex) {
  const list = campaignOrder();
  return list[Math.min(afterIndex + 1, list.length - 1)] || list[0] || null;
}

export function indexById(id) {
  const raw = LOTS.find((l) => l.id === id);
  return raw ? (raw.index === undefined ? -1 : raw.index) : -1;
}

// 按候选数分带，屏幕上"同一批体积余量"的分组就是它。
export function bands() {
  const byN = new Map();
  for (const l of campaignOrder()) {
    const b = byN.get(l.n) || [];
    b.push(l);
    byN.set(l.n, b);
  }
  return [...byN.entries()].sort((p, r) => p[0] - r[0]).map(([n, list]) => ({
    n,
    ids: list.map((l) => l.id),
    // 这一带的难度余量是量出来的：2^q / V，1.0 就是完美球包装。
    margins: list.map((l) => +(l.margin).toFixed(3)),
  }));
}

export function measured() {
  return MEASURED;
}

export function minqTable() {
  return MINQ;
}

export function greedyReport() {
  return GREEDY;
}

export function advisoryReport() {
  return ADVISORY;
}

// 表自身的体检。返回 { ok, errors }；错误数组每一项都是能直接印到屏幕上的中文句子。
export function validate() {
  const errors = [];
  const seen = new Set();
  campaignOrder().forEach((l, i) => {
    if (seen.has(l.id)) errors.push(`关卡 id 重复：${l.id}`);
    seen.add(l.id);
    if (l.index !== i) errors.push(`${l.id} 的 index=${l.index} 与它在战役序列里的位置 ${i} 不符`);
    if (!(l.n >= 1)) errors.push(`${l.id} 的 n 非法`);
    if (!(l.k >= 0)) errors.push(`${l.id} 的 k 非法`);
    if (!(l.q >= 1)) errors.push(`${l.id} 的 q 非法`);
    if (!(l.par <= l.q)) errors.push(`${l.id} 的 par=${l.par} 大于发放的问数 q=${l.q}`);
    const V = volume(fresh(l.n, l.k), l.q);
    if (V !== l.volume) errors.push(`${l.id} 的 V=${l.volume} 与重新算出的 ${V} 不一致`);
    if (!Number.isFinite(l.margin) || printMarginValue(2 ** l.q / V) !== l.margin) {
      errors.push(`${l.id} 的余量 ${l.margin} 对不上 2^${l.q}/${V}`);
    }
    if (!l.policy || !l.policy.length) {
      errors.push(`${l.id} 没有策略表：提示只能走表外，战役关不该这样`);
      return;
    }
    const err = policyClosed(l.policy);
    if (err) errors.push(`${l.id} 的策略不闭合：${err}`);
    const root = l.policy.reduce((p, r) => (r[2] > p[2] ? r : p), l.policy[0]);
    if (root[2] !== l.q) errors.push(`${l.id} 的策略根深度 ${root[2]} 与发放的 q=${l.q} 不符`);
    if (total(root[1]) !== l.n) errors.push(`${l.id} 的策略根候选数 ${total(root[1])} 与 n=${l.n} 不符`);
  });
  return { ok: errors.length === 0, errors, count: LOTS.length };
}

// 每日关/随机关的池子大小，头栏要用一句"从 N 个已复验的关卡里选"。
export const poolSize = LOTS.length;
