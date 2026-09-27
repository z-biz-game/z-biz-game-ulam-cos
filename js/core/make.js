// 随机关与每日关的构造器：只用**已经烤好的表**，绝不在浏览器里搜索。
//
// 一局随机关需要一个题量 q，而 q 必须是量出来的：`MINQ[n][k]` 是 tools/bake.mjs 用精确 DP
// 跑 fresh(n,k) 得到的 par。所以这一层的成本是一次数组下标 + 一个种子哈希，实测在几十微秒级
// （test/make.test.mjs 会把"构造 2000 局随机关 < 50ms"按在机器上，而不是嘴上说快）。
//
// 三档难度（TIER）不是形容词，是两个数：候选个数 n 与谎数 k。窗口的选取理由写在下面，
// 且和 MINQ 一起由 tools/bake.mjs 复算：某一档只有在"表里的 par 落在 [qMin, qMax] 之内"时
// 才允许出这个 n，所以调档就是调表，不是调手感。
//
// `secret` 由 seed 决定：同一颗种子在任何设备上给出同一局。回放只需要重放问题序列。

import { MINQ } from '../data/lots.js';
import { campaignOrder } from './library.js';
import { rngFrom, hashSeed } from './rng.js';

// 档位 -> 候选数窗口 + 谎数窗口。qSlack 是在量出来的 par 之上白送的余量（0 = 必须完美）。
export const TIERS = {
  gentle: { cn: '热身', n: [3, 8], k: [0, 1], slack: 1, minPar: 2 },
  standard: { cn: '正常', n: [8, 16], k: [1, 2], slack: 0, minPar: 5 },
  hard: { cn: '烧脑', n: [16, 24], k: [2, 3], slack: 0, minPar: 9 },
  brutal: { cn: '不留情', n: [24, 32], k: [3, 3], slack: 0, minPar: 11 },
};

export const TIER_ORDER = ['gentle', 'standard', 'hard', 'brutal'];

// MINQ 的形状由 tools/bake.mjs 写死：`MINQ[n] = { par: [k=0..], bound: [...], volume: [...] }`。
// 三行并排放着，屏幕上"界说 4、真值是 5"这句话才是同一格里比对出来的，不是两处代码各算各的。
export function parOf(n, k) {
  const row = MINQ[n];
  if (!row || !row.par) return null;
  const v = row.par[k];
  return v === undefined ? null : v;
}

export function boundOf(n, k) {
  const row = MINQ[n];
  if (!row || !row.bound) return null;
  const v = row.bound[k];
  return v === undefined ? null : v;
}

// 这一档能出哪些 (n,k)：完全由表决定。表里没量出来的格子（null）永远不会被选上——
// 这是"未测"和"不可胜"的区别，两者都不该出现在玩家面前。
export function windowFor(tier) {
  const t = TIERS[tier];
  if (!t) throw new Error(`未知档位 ${tier}`);
  const out = [];
  for (let n = t.n[0]; n <= t.n[1]; n++) {
    for (let k = t.k[0]; k <= t.k[1]; k++) {
      const par = parOf(n, k);
      if (par === null || par === undefined) continue;
      if (par < t.minPar) continue;
      out.push({ n, k, par, q: par + t.slack });
    }
  }
  return out;
}

// seed -> 一局随机关。纯函数：同一颗种子永远给同一个 lot。
export function randomLot(tier, seed) {
  const cells = windowFor(tier);
  if (!cells.length) throw new Error(`档位 ${tier} 在烤好的表里没有任何合法 (n,k)`);
  const rng = rngFrom(seed === undefined ? String(Date.now()) : String(seed));
  const cell = cells[rng.int(cells.length)];
  const secret = rng.range(1, cell.n);
  return {
    id: `random/${tier}/${String(seed)}`,
    tier,
    title: `${TIERS[tier].cn} ${cell.n} 数 · ${cell.k} 谎`,
    n: cell.n,
    k: cell.k,
    q: cell.q,
    par: cell.par,
    bound: boundOf(cell.n, cell.k),
    secret,
    policy: null,
    seed: String(seed),
  };
}

// 每日关：从战役池里按日期键选一个，规则固定到可以写进测试。
//   index = FNV-1a(dateKey) % LOTS.length，secret 再按同一个 rng 流取。
// 之所以从战役池选而不是随机生成：每日关的 par、体积、余量都已经在 lots.js 里被复验过一遍。
export function dailyLot(dateKey, opts = {}) {
  const pool = opts.pool || campaignOrder();
  if (!pool.length) throw new Error('战役池是空的');
  const rng = rngFrom(`daily:${dateKey}`);
  const base = pool[hashSeed(dateKey) % pool.length];
  const secret = rng.range(1, base.n);
  return {
    ...base,
    id: `daily/${dateKey}`,
    campaignId: base.id,
    title: `每日 ${dateKey} · ${base.title}`,
    secret,
    daily: true,
    dateKey,
  };
}

// 自定义一盘：路由 #/c/<n> 上的"自己挑个数"。k 固定为 1（屏幕上可切），q 取自表。
export function customLot(n, k, opts = {}) {
  const par = parOf(n, k);
  if (par === null) return null;   // 表外：屏幕必须说"这一格没量出来"，而不是给个近似值
  return {
    id: `c/${n}/${k}`,
    tier: 'custom',
    title: `${n} 个候选 · ${k} 个谎`,
    n,
    k,
    q: opts.slack ? par + opts.slack : par,
    par,
    secret: opts.secret || 1 + (hashSeed(`c:${n}:${k}`) % n),
    policy: null,
  };
}
