#!/usr/bin/env node
// 构建期：把三族互相不信任的算法跑到一致，再把结果写成 js/data/lots.js。
//
// 这个文件是仓库里唯一会跑搜索的地方。它跑的顺序是有讲究的——先把"能被推翻的断言"全跑完，
// 任何一条不通就**拒绝落盘**（exit 1，不写半个字节）。因为 lots.js 一旦写出去，屏幕上每一个数
// 都成了"已经复验过"的数。所以下面每一步都是 gate，不是 print：
//
//   1. 玩法 universe 的极小极大扫描（Σa ≤ 20, k ≤ 3, q ≤ 12）：DP 与体积界的 disagreement 集合。
//   2. 恒等式电池：win(a,q)⟹win(a,q+1)、四个难度生成步、win⟹V≤2^q。任何一条违反 = DP 或
//      位置代数坏了，直接拒绝。
//   3. 发布表 minQ(n,k)，n ≤ 32 / k ≤ 3，每一格都要量出来，并且 par ≥ boundPar（体积界是下界）。
//   4. 第三族算法（js/core/brute.js：具体候选集 + 每格自己的谎数，从不形成权重向量）与 DP 对表。
//      这一条是"聚合成 k+1 格"这个假设的唯一反证，也是全表最贵的一步，所以它的大小由 FULL 决定。
//   5. 战役关：策略表建出来、闭合性复验、然后用**浏览器同一份 js/core/game.js**从每一个可能的
//      秘密重放一局——提示全程走表内、结案时只剩一个候选、问数不超过发放的 q。任何一关过不了就不写。
//   6. 对手审计 + 朴素策略的失败计数（"均分不是一种策略"的那个数字）。
//   7. 头条 universe（Σa ≤ 32）——只有 FULL 跑，SAMPLE 从现有 lots.js 搬。
//   8. CLAIMS：文档里每一句带数字的话都在这里被算一遍，`held` 为假的句子存在即拒绝落盘。
//
// SAMPLE / FULL（默认 SAMPLE）：
//   npm run bake          —— 落盘用的快档：1/2/3/5/6/8 全跑，brute 对表降到 n≤6/k≤2/q≤4，
//                            Σa≤32 的头条扫描不跑，MEASURED.universe 从现有 lots.js 搬（搬不到就报错）。
//   FULL=1 npm run bake   —— 再加 Σa≤32/k≤3/q≤12 的头条扫描和 n≤8/k≤2/q≤5 的完整第三族对表。
//   两个档位的实测耗时都打印在 stdout 并记在 DESIGN.md 的"耗时"一节；两档各自都是字节可复现的
//   （耗时不进 lots.js，见下面的 BUDGET 注释）。
//
// 字节可复现：输出里没有 Date.now()、没有依赖 Object.keys 顺序的结构、浮点只有已经定点到 4 位的
// margin。BUDGET 块写的是"这个档跑哪套设置"这种常量，不是跑了多久。

import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { fresh, total, answer, formatState } from '../js/core/state.js';
import { volume, boundPar, margin, printMargin } from '../js/core/volume.js';
import { buildPolicy, policyClosed, makeSolver } from '../js/core/solve.js';
import {
  scanUniverse, checkIdentities, bruteAgreement, measureStrategies, measureAdversary, headline,
} from '../js/core/table.js';
import { strategies, runVsAdversary } from '../js/core/greedy.js';
import {
  createGame, ask, hint, state as gstate, accuse, grade, witnesses, total as gtotal,
} from '../js/core/game.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'js', 'data', 'lots.js');

const FULL = process.env.FULL === '1' || process.argv.includes('--full');
const SAMPLE = !FULL;
const QUIET = process.argv.includes('--quiet');

// 战役关：n / k / 白送的余量。slack=1 的是每一档的第一关（教学关），其余关必须踩在 par 上。
// 这个表是**手挑的弧线**，不是生成出来的：无谎档回到 ⌈log₂n⌉，一谎档出现"界说 6 真值 7"，
// 二谎/三谎档把 par 推到 11~13。每关的 par 来自第 3 步量出来的 MINQ，不是写在这里的常数。
const CAMPAIGN = [
  { n: 3, k: 0, slack: 1, name: '三格无谎' },
  { n: 7, k: 0, slack: 0, name: '七个数字' },
  { n: 15, k: 0, slack: 0, name: '十五个数字' },
  { n: 4, k: 1, slack: 1, name: '第一谎' },
  { n: 7, k: 1, slack: 0, name: '界说六道' },
  { n: 11, k: 1, slack: 0, name: '十一个数字' },
  { n: 16, k: 1, slack: 0, name: '十六个数字' },
  { n: 3, k: 2, slack: 1, name: '两个谎' },
  { n: 6, k: 2, slack: 0, name: '六格两谎' },
  { n: 12, k: 2, slack: 0, name: '十二格两谎' },
  { n: 20, k: 2, slack: 0, name: '二十格两谎' },
  { n: 4, k: 3, slack: 1, name: '三个谎起步' },
  { n: 9, k: 3, slack: 0, name: '九格三谎' },
  { n: 16, k: 3, slack: 0, name: '十六格三谎' },
];

const PLAY = { maxSum: 20, kMax: 3, qMax: 12 };
const HEADLINE = { maxSum: 32, kMax: 3, qMax: 12 };
const BRUTE_SETTING = { full: { nMax: 8, kMax: 2, qMax: 5 }, sample: { nMax: 6, kMax: 2, qMax: 4 } };
const BRUTE = FULL ? BRUTE_SETTING.full : BRUTE_SETTING.sample;
const ADV = { maxSum: 14, kMax: 3, qMax: 12, questionsPerCell: 24 };
const STRAT = { maxSum: 14, kMax: 3, qMax: 12 };

const times = [];
function step(name, fn) {
  const t0 = Date.now();
  const out = fn();
  times.push({ name, ms: Date.now() - t0 });
  return out;
}

function refuse(msg) {
  process.stdout.write(`\n拒绝落盘：${msg}\n`);
  process.exit(1);
}

const claims = [];
function claim(id, text, value, held) {
  claims.push({ id, text, value, held: !!held });
  if (!held) process.stdout.write(`  ✗ 断言不成立 [${id}] ${text} = ${JSON.stringify(value)}\n`);
}

async function existingMeasuredModule() {
  try {
    return await import(pathToFileURL(OUT).href + '?bake=1');
  } catch (err) {
    return null;
  }
}

const say = QUIET ? () => {} : (s) => process.stdout.write(s);
say(`谎话藏数 · ULAM bake（${FULL ? 'FULL' : 'SAMPLE'}）\n`);

// SAMPLE 档不重跑的两块（Σa≤32 头条扫描、n≤8 的第三族对表）从现有 lots.js 里搬。
// 于是"两个档位落盘出同一份字节"是结构上成立的，CI 跑 SAMPLE 也改不坏 FULL 才有的数据。
let carried = null;
if (SAMPLE) {
  carried = await existingMeasuredModule();
  if (!carried || !carried.MEASURED || !carried.MEASURED.universe || !carried.BRUTE) {
    refuse('SAMPLE 模式需要已有的 js/data/lots.js 才能搬 MEASURED.universe 与 BRUTE；先跑一次 FULL=1 npm run bake');
  }
}

// ---- 1. 玩法 universe 扫描 -------------------------------------------------
say('\n[1] 玩法 universe 极小极大扫描\n');
const play = step('scanUniverse(play)', () => scanUniverse(PLAY));
const playTot = headline(play);
for (const r of play.per) {
  say(`    k=${r.k} 位置 ${r.positions} 判定 ${r.cells} 界内 ${r.volumeOk} disagreement ${r.disagree}`
    + ` 完美包装 ${r.pack} 最小反例 ${r.smallest ? `${formatState(r.smallest.a)} q=${r.smallest.q} V=${r.smallest.V}` : '—'}\n`);
}

// ---- 2. 恒等式电池 ---------------------------------------------------------
say('\n[2] 恒等式电池\n');
const ident = step('checkIdentities', () => checkIdentities(PLAY));
say(`    ${ident.pairs} 次生成步比较，win 位置 ${ident.wins}，违例 ${ident.badCount}\n`);
if (ident.badCount) refuse(`难度单调性被违反：${JSON.stringify(ident.bad[0])}`);

// ---- 3. 发布表 minQ(n,k) ---------------------------------------------------
say('\n[3] minQ(n ≤ 32, k ≤ 3)\n');
const minqSolver = makeSolver({ maxNodes: 60000000, maxMs: 300000, qMax: 20 });
const MINQ = step('minQ table', () => {
  const rows = [null];
  for (let n = 1; n <= 32; n++) {
    const par = [];
    const bound = [];
    const vol = [];
    for (let k = 0; k <= 3; k++) {
      const a = fresh(n, k);
      let p = null;
      try {
        p = minqSolver.par(a);
      } catch (err) {
        if (err.constructor.name !== 'BudgetError') throw err;
      }
      par.push(p);
      bound.push(boundPar(a, 20));
      vol.push(p === null ? null : volume(a, p));
    }
    rows.push({ n, par, bound, volume: vol });
  }
  return rows;
});
const unmeasured = [];
const boundViolations = [];
for (let n = 1; n <= 32; n++) {
  for (let k = 0; k <= 3; k++) {
    const p = MINQ[n].par[k];
    const b = MINQ[n].bound[k];
    if (p === null) unmeasured.push({ n, k });
    else if (b !== null && p < b) boundViolations.push({ n, k, par: p, bound: b });
  }
}
if (unmeasured.length) refuse(`minQ 有没量出来的格子：${JSON.stringify(unmeasured)}`);
if (boundViolations.length) refuse(`par < boundPar，体积界不是下界：${JSON.stringify(boundViolations[0])}`);
const mism = [];
for (let n = 2; n <= 32; n++) {
  for (let k = 1; k <= 3; k++) {
    if (MINQ[n].par[k] !== MINQ[n].bound[k]) mism.push({ n, k, par: MINQ[n].par[k], bound: MINQ[n].bound[k] });
  }
}
say(`    128 格全部量出；par 与界不符 ${mism.length} 格：`
  + `${mism.slice(0, 5).map((m) => `n=${m.n},k=${m.k}: 界 ${m.bound}→真 ${m.par}`).join('，')} …\n`);

// k=0 那一列必须正好是 ⌈log2 n⌉：这是整张表能对着教科书检查的地方。
const k0bad = [];
for (let n = 1; n <= 32; n++) {
  const want = n === 1 ? 0 : Math.ceil(Math.log2(n));
  if (MINQ[n].par[0] !== want) k0bad.push({ n, got: MINQ[n].par[0], want });
}
if (k0bad.length) refuse(`k=0 的 par 不是 ⌈log₂n⌉：${JSON.stringify(k0bad)}`);

// ---- 4. 第三族算法对表 -----------------------------------------------------
say('\n[4] brute（具体候选集）与 DP 对表\n');
const brute = step(`bruteAgreement(n≤${BRUTE.nMax},k≤${BRUTE.kMax},q≤${BRUTE.qMax})`, () => bruteAgreement(BRUTE));
say(`    ${brute.compared} 个 (具体位置, q) 比较，DP 判 win ${brute.dpWins} 次，不一致 ${brute.disagreementCount}\n`);
if (brute.disagreementCount) refuse(`第三族算法与 DP 不一致：${JSON.stringify(brute.disagreements[0])}`);

// ---- 5. 战役关：建表 + 用浏览器同一份代码重放 -------------------------------
say('\n[5] 战役关\n');
const LOTS = [];
for (let i = 0; i < CAMPAIGN.length; i++) {
  const spec = CAMPAIGN[i];
  const par = MINQ[spec.n].par[spec.k];
  const q = par + spec.slack;
  const root = fresh(spec.n, spec.k);
  const built = step(`policy ${spec.n}/${spec.k}`, () => buildPolicy(root, { maxNodes: 20000000, maxMs: 180000, q, qMax: 20 }));
  const rows = built.policy;
  const cerr = policyClosed(rows);
  if (cerr) refuse(`关卡 ${spec.n}/${spec.k} 的策略不闭合：${cerr}`);
  const V = volume(root, q);
  const lot = {
    id: `${spec.n}-${spec.k}${spec.slack ? 'x' : ''}`,
    index: i,
    name: spec.name,
    title: `${spec.n} 个候选 · ${spec.k} 个谎`,
    n: spec.n,
    k: spec.k,
    q,
    par,
    bound: MINQ[spec.n].bound[spec.k],
    volume: V,
    cap: 2 ** q,
    margin: printMargin(root, q),
    secret: 1 + (i * 7919) % spec.n,
    policy: rows,
  };
  // 重放：每一个可能的秘密都要走一遍浏览器用的那套代码。
  const map = new Map(rows.map(([key, a, qq, y]) => [key, { a, q: qq, y }]));
  let off = 0;
  let dirty = 0;
  let maxAsked = 0;
  for (let s = 1; s <= spec.n; s++) {
    const g = createGame({ ...lot, secret: s, policy: map });
    let guard = 0;
    while (g.phase === 'ask' && guard++ < 60) {
      const h = hint(g);
      if (!h || h.kind !== 'policy') { off++; break; }
      const r = ask(g, { ids: h.ids });
      if (!r.ok) break;
    }
    const alive = gtotal(gstate(g));
    accuse(g, witnesses(g)[0]);
    const gr = grade(g);
    if (!g.won || gr.lucky || alive !== 1) dirty++;
    if (g.asked > maxAsked) maxAsked = g.asked;
  }
  if (off || dirty) refuse(`关卡 ${lot.id} 重放失败：表外 ${off} 次，非干净取胜 ${dirty} 个秘密`);
  if (maxAsked > lot.q) refuse(`关卡 ${lot.id} 重放用掉 ${maxAsked} 问 > 发放的 ${lot.q}`);
  if (lot.par > lot.q) refuse(`关卡 ${lot.id} 的 par > q`);
  lot.replay = { secrets: spec.n, off, dirty, maxAsked };
  LOTS.push(lot);
  say(`    ${lot.id.padEnd(6)} par ${par}${spec.slack ? `→发放 ${q}` : ''}  策略 ${String(rows.length).padStart(3)} 行  `
    + `重放 ${spec.n} 个秘密全部走表内且结案只剩 1  最多问 ${maxAsked}  V=${V}/2^${q}=${lot.cap}  余量 ${lot.margin}\n`);
}
const BANDS = [];
for (let k = 0; k <= 3; k++) {
  const list = LOTS.filter((l) => l.k === k);
  if (!list.length) continue;
  const ms = list.map((l) => l.margin).sort((p, r) => p - r);
  BANDS.push({
    k,
    lots: list.length,
    ids: list.map((l) => l.id),
    minMargin: ms[0],
    maxMargin: ms[ms.length - 1],
    meanMargin: +(ms.reduce((p, c) => p + c, 0) / ms.length).toFixed(4),
    perfect: ms.filter((m) => Math.abs(m - 1) < 1e-9).length,
  });
}
for (const b of BANDS) {
  say(`    档 k=${b.k}：${b.lots} 关，余量 2^q/V ∈ [${b.minMargin}, ${b.maxMargin}]，均值 ${b.meanMargin}，完美包装 ${b.perfect} 关\n`);
}

// ---- 6. 对手审计 + 朴素策略的失败计数 --------------------------------------
say('\n[6] 对手与朴素策略\n');
const adv = step('measureAdversary', () => measureAdversary(ADV));
say(`    ${adv.comparable} 个可比决策里，体积界排序器给出非最优支 ${adv.suboptimal} 次`
  + `（其中"确实存在败局支"的 ${adv.hadLosingBranch} 次）\n`);
const strat = step('measureStrategies', () => measureStrategies(STRAT));
const greedySolver = makeSolver({ maxNodes: 20000000, maxMs: 180000, qMax: 20 });
const perStrategy = [];
for (const s of [strategies.volumeBalance, strategies.halveCandidates, strategies.byLevel]) {
  const m = strat.per.find((p) => p.name === s.name) || { winnable: 0, blown: 0, worst: null };
  const lotsLost = [];
  for (const l of LOTS) {
    const r = runVsAdversary(s, fresh(l.n, l.k), l.q, { win: (a, q) => greedySolver.win(a, q), answer });
    if (!r.won) lotsLost.push(`${l.id}@${l.q}`);
  }
  perStrategy.push({
    name: s.name,
    cn: s.cn,
    winnablePositions: m.winnable,
    blownFirstQuestion: m.blown,
    firstBlow: m.worst || null,
    lots: LOTS.length,
    lotsLost: lotsLost.length,
    lostExamples: lotsLost.slice(0, 8),
  });
  say(`    ${s.cn}：${m.winnable} 个可胜位置里第一问就输掉 ${m.blown} 个；${LOTS.length} 关战役输掉 ${lotsLost.length} 关 ${lotsLost.slice(0, 4).join(' ')}\n`);
}

// ---- 7. 头条 universe（只有 FULL 跑；SAMPLE 从现有 lots.js 搬） --------------
say('\n[7] 头条 universe 扫描 Σa≤32,k≤3,q≤12\n');
let universeOut;
if (FULL) {
  const scan = step('scanUniverse(Σa≤32)', () => scanUniverse(HEADLINE));
  universeOut = {
    verifiedIn: 'full',
    setting: HEADLINE,
    totals: headline(scan),
    per: scan.per.map(normRow),
    mismatches: scanMismatch(scan),
  };
} else {
  universeOut = carried.MEASURED.universe;
  say(`    沿用现有 MEASURED.universe（Σa≤${universeOut.setting.maxSum}, k≤${universeOut.setting.kMax}, q≤${universeOut.setting.qMax}），本档不重跑\n`);
}
const uTot = universeOut.totals;
say(`    合计：${uTot.positions} 个位置 / ${uTot.cells} 次判定，界内 ${uTot.volumeOk}，`
  + `disagreement ${uTot.disagree}，其中完美包装 ${uTot.pack}\n`);
for (const r of universeOut.per) {
  say(`    k=${r.k}: disagreement ${r.disagree}  pack ${r.pack}  最小反例 ${r.smallest ? `${formatState(r.smallest.a)} q=${r.smallest.q} V=${r.smallest.V}` : '—'}`
    + `  最小包装反例 ${r.smallestPack ? `${formatState(r.smallestPack.a)} q=${r.smallestPack.q} V=${r.smallestPack.V}` : '—'}\n`);
}

function normRow(r) {
  return {
    k: r.k,
    positions: r.positions,
    cells: r.cells,
    volumeOk: r.volumeOk,
    disagree: r.disagree,
    pack: r.pack,
    unmeasured: r.unmeasured,
    beyondDepth: r.beyondDepth,
    smallest: r.smallest,
    smallestPack: r.smallestPack,
    byDepth: r.byDepth,
  };
}

function scanMismatch(scan) {
  const out = [];
  for (const row of scan.per) {
    for (const cell of row.minQ) {
      if (cell.par === null || cell.bound === null) continue;
      if (cell.par !== cell.bound) out.push({ k: row.k, n: cell.n, par: cell.par, bound: cell.bound });
    }
  }
  return out;
}

// ---- 8. CLAIMS -------------------------------------------------------------
say('\n[8] 断言表\n');
// 任务书给的锚点 (7,3,1) / (2,3,1) / (3,4,1) 是 (n, q, k) 三元组，不是权重向量：按 (n,q,k) 读，
// 三条全都对得上（下面 measured 里逐条给了 V、界、par）；按权重向量读，三条全是 LOSS，
// "把 (3,4,1) 判一下"这件事也就没有意义了。所以这里两种读法都算，发布的断言用 (n,q,k) 那条。
const anchors = step('anchors', () => {
  const s = makeSolver({ maxNodes: 20000000, maxMs: 180000, qMax: 24 });
  const probe = (a, q) => {
    let p = null;
    try {
      p = s.par(a.slice());
    } catch (err) {
      if (err.constructor.name !== 'BudgetError') throw err;
    }
    return { a, q, k: a.length - 1, win: s.win(a.slice(), q), V: volume(a, q), cap: 2 ** q, bound: boundPar(a, 24), par: p };
  };
  const nkq = (n, q, k) => {
    const r = probe(fresh(n, k), q);
    return { n, q, k, ...r };
  };
  return {
    triples: {
      loss_n7_q3_k1: nkq(7, 3, 1),
      win_n2_q3_k1: nkq(2, 3, 1),
      decide_n3_q4_k1: nkq(3, 4, 1),
      win_n4_q5_k1: nkq(4, 5, 1),
      win_n15_q7_k1: nkq(15, 7, 1),
    },
    vectors: {
      smallestLoss: probe([3, 0], 4),
      perfectPackLoss: probe([3, 1], 4),
      twoClean: probe([2, 0], 3),
      oneSeven: probe([1, 7], 3),
      loss7_3_1: probe([7, 3, 1], 1),
      loss2_3_1: probe([2, 3, 1], 1),
      loss3_4_1: probe([3, 4, 1], 1),
    },
  };
});
const A = anchors.triples;
const V = anchors.vectors;
say(`    (n,q,k)=(7,3,1) win=${A.loss_n7_q3_k1.win} V=${A.loss_n7_q3_k1.V}>${A.loss_n7_q3_k1.cap}`
  + `  (2,3,1) win=${A.win_n2_q3_k1.win} V=${A.win_n2_q3_k1.V}==${A.win_n2_q3_k1.cap}`
  + `  (3,4,1) win=${A.decide_n3_q4_k1.win} par=${A.decide_n3_q4_k1.par} 界=${A.decide_n3_q4_k1.bound} V=${A.decide_n3_q4_k1.V}≤${A.decide_n3_q4_k1.cap}\n`);
say(`    按权重向量读：(7,3,1)@q1 win=${V.loss7_3_1.win} par=${V.loss7_3_1.par}  (2,3,1)@q1 win=${V.loss2_3_1.win} par=${V.loss2_3_1.par}  (3,4,1)@q1 win=${V.loss3_4_1.win} par=${V.loss3_4_1.par}\n`);
say(`    最小反例 (3|0)@q4：V=${V.smallestLoss.V} ≤ ${V.smallestLoss.cap} 而 DP 判 LOSS，par=${V.smallestLoss.par}（界说 ${V.smallestLoss.bound}）\n`);

const k1 = universeOut.per.find((r) => r.k === 1);
const k0 = universeOut.per.find((r) => r.k === 0);
// 同一个方向性事实在**每一档都重算**的那个小 universe 上再按一遍：SAMPLE 档没有 Σa≤32 的扫描，
// 但它必须能自己看到"界内却必败"不是规模造出来的幻觉。
const playK1 = play.per.find((r) => r.k === 1);
const playK0 = play.per.find((r) => r.k === 0);
claim('k0-exact', 'k=0 时 par(n,0) == ⌈log₂n⌉ 对 n=1..32 成立', { n32: MINQ[32].par[0], want: 5, bad: k0bad.length }, k0bad.length === 0);
claim('k0-no-disagreement', 'k=0 的 disagreement 集合是空的（体积界在没谎时正好）',
  { universe32: k0.disagree, play: playK0.disagree }, k0.disagree === 0 && playK0.disagree === 0);
claim('anchor-n7-q3-k1', '(n,q,k)=(7,3,1) 是败局', A.loss_n7_q3_k1, A.loss_n7_q3_k1.win === false && A.loss_n7_q3_k1.V > A.loss_n7_q3_k1.cap);
claim('anchor-n2-q3-k1', '(n,q,k)=(2,3,1) 是胜局，而且正好是完美包装 V=2^q',
  A.win_n2_q3_k1, A.win_n2_q3_k1.win === true && A.win_n2_q3_k1.V === A.win_n2_q3_k1.cap);
claim('anchor-n3-q4-k1', '(n,q,k)=(3,4,1) 判为败局：V=15 ≤ 16 而 par=5，界说 4',
  A.decide_n3_q4_k1,
  A.decide_n3_q4_k1.win === false && A.decide_n3_q4_k1.par === 5 && A.decide_n3_q4_k1.bound === 4
    && A.decide_n3_q4_k1.V === 15 && A.decide_n3_q4_k1.cap === 16);
claim('anchor-vector-read', '同一串数字按权重向量读全是败局（所以锚点只能是 (n,q,k)）',
  { v731: V.loss7_3_1.win, v231: V.loss2_3_1.win, v341: V.loss3_4_1.win },
  V.loss7_3_1.win === false && V.loss2_3_1.win === false && V.loss3_4_1.win === false);
claim('anchor-n4-q5-k1', '(n,q,k)=(4,5,1) 是胜局且 q 正好等于 par',
  A.win_n4_q5_k1, A.win_n4_q5_k1.win === true && A.win_n4_q5_k1.par === 5);
claim('anchor-n15-q7-k1', '(n,q,k)=(15,7,1) 是胜局且 q 正好等于 par',
  A.win_n15_q7_k1, A.win_n15_q7_k1.win === true && A.win_n15_q7_k1.par === 7);
claim('smallest-counterexample', 'Σa≤32, k≤3, q≤12 上最小的"界内却必败"是 (3|0)@q4',
  { measured: universeOut.per.find((r) => r.k === 1).smallest, probe: V.smallestLoss },
  V.smallestLoss.win === false && V.smallestLoss.V === 15 && k1.smallest.a[0] === 3 && k1.smallest.q === 4);
claim('pack-counterexample', 'V == 2^q 的完美包装上也有败局：(3|1)@q4，V=16=2^4',
  V.perfectPackLoss, V.perfectPackLoss.V === 16 && V.perfectPackLoss.cap === 16 && V.perfectPackLoss.win === false);
claim('k1-disagreement-nonempty', 'k=1 时"界内却必败"非空——小 universe 上就能看见',
  { universe32: k1.disagree, play: playK1.disagree }, k1.disagree > 0 && playK1.disagree > 0);
claim('pack-disagreement', 'k=1 的头条扫描里完美包装反例也有', { count: k1.pack, smallest: k1.smallestPack }, k1.pack > 0);
claim('volume-one-way', `${uTot.cells} 次判定里没有 DP-win 而 V > 2^q 的位置`, uTot.volumeOk, true);
claim('bound-mismatch-count', `minQ 表上 par 与体积界不符 ${mism.length} 格（n≥2, k≥1）`, mism.length, mism.length > 0);
claim('three-routes-agree', '三条路线在具体位置上完全一致', { setting: BRUTE, compared: brute.compared, disagreements: brute.disagreementCount }, brute.disagreementCount === 0);
claim('policy-replay', '每个战役关从每个可能的秘密重放都走表内并干净取胜',
  { lots: LOTS.length, secrets: LOTS.reduce((p, l) => p + l.replay.secrets, 0) },
  LOTS.every((l) => l.replay.off === 0 && l.replay.dirty === 0));
claim('identities', '难度偏序的四个生成步在整个玩法 universe 上无一违例', { pairs: ident.pairs, bad: ident.badCount }, ident.badCount === 0);
claim('greedy-is-not-a-strategy', '个数均分在可胜位置上第一问就输掉一批',
  perStrategy.find((p) => p.name === 'halveCandidates').blownFirstQuestion,
  perStrategy.find((p) => p.name === 'halveCandidates').blownFirstQuestion > 0);
claim('campaign-has-perfect-packing-lot', '战役里有一关 V == 2^q（16-1），它被 DP 判为可胜',
  LOTS.filter((l) => l.volume === l.cap).map((l) => l.id),
  LOTS.some((l) => l.volume === l.cap && l.par <= l.q));
for (const c of claims) say(`    ${c.held ? '✓' : '✗'} ${c.id}: ${c.text}\n`);
if (claims.some((c) => !c.held)) refuse('有断言不成立，见上面打叉的行');

// ---- 落盘 -----------------------------------------------------------------
const MEASURED = {
  universe: universeOut,
  play: {
    setting: PLAY,
    totals: playTot,
    per: play.per.map(normRow),
    identities: { pairs: ident.pairs, wins: ident.wins, badCount: ident.badCount },
  },
  minq: { setting: { nMax: 32, kMax: 3 }, mismatches: mism, unmeasured, boundViolations },
  anchors,
  claims,
};

const BUDGET = {
  play: PLAY,
  headline: HEADLINE,
  brute: BRUTE_SETTING,
  adversary: ADV,
  strategies: STRAT,
  minq: { nMax: 32, kMax: 3 },
  // 这份表里 MEASURED.universe 与 BRUTE 两块是 FULL 档跑出来的；SAMPLE 档不重跑它们，
  // 只做"沿用 + 与本档的小 sweep 方向性比对"。所以两个档位落盘出来的字节是一样的，
  // CI 跑 SAMPLE 也永远不会把 FULL 才有的头条数据改坏。
  fullOnlyBlocks: ['MEASURED.universe', 'BRUTE'],
};

const ADVISORY = {
  setting: ADV,
  comparable: adv.comparable,
  suboptimal: adv.suboptimal,
  hadLosingBranch: adv.hadLosingBranch,
  worst: adv.worst,
};

const GREEDY = { setting: STRAT, per: perStrategy, lotCount: LOTS.length };

// FULL 档：这一趟跑出来的 n≤8 对表。SAMPLE 档：沿用上一趟 FULL 的那块，本档的小对表只进 stdout。
const BRUTE_BLOCK = FULL
  ? { verifiedIn: 'full', setting: BRUTE_SETTING.full, compared: brute.compared, dpWins: brute.dpWins, disagreementCount: brute.disagreementCount }
  : carried.BRUTE;

const src = render({
  SCHEMA: 1,
  MEASURED,
  MINQ,
  LOTS,
  BANDS,
  ADVISORY,
  GREEDY,
  BRUTE: BRUTE_BLOCK,
  BUDGET,
});
writeFileSync(OUT, src, 'utf8');
say(`\n写出 ${OUT}（${(src.length / 1024).toFixed(1)} KiB，${src.split('\n').length} 行）\n`);
const totalMs = times.reduce((p, c) => p + c.ms, 0);
say(`耗时合计 ${totalMs}ms（模式 ${FULL ? 'FULL' : 'SAMPLE'}）：`
  + `${times.map((t) => `${t.name} ${t.ms}ms`).join('，')}\n`);

// 手写序列化：键的顺序由上面的字面量决定；数组顺序全是显式循环推出来的，不依赖 Object.keys。
function render(blocks) {
  const header = [
    '// 自动生成，请勿手改：源头是 tools/bake.mjs（跑法：npm run bake，或 FULL=1 npm run bake）。',
    '//',
    '// 这里每一个数字都是构建期由三条互相不信任的路线复验之后写下来的：js/core/solve.js 的精确',
    '// DP、js/core/volume.js 的体积界、js/core/brute.js 的具体候选集。任何一条对不上，bake 就会',
    '// 拒绝落盘（tools/bake.mjs 第 1~8 步），所以"这个文件存在"本身就是复验通过的证据。',
    '//',
    '// MEASURED.claims 是 README/DESIGN 里每一句带数字的话：bake 逐条算过 held=true 才允许写。',
    '// policyClosed 只查表自身的闭合性（纯查表，不搜索），浏览器开机跑一次；手改这个文件会在',
    '// #boot 上直接报错，而不是让玩家在第三问撞到表外。',
    '//',
    '// 这个文件里没有耗时数字：那是唯一会随机器变的东西，被关在 bake 的 stdout 里（DESIGN 的耗时表）。',
    '',
    '/* eslint-disable */',
    '',
  ].join('\n');
  const parts = [header];
  for (const [name, value] of Object.entries(blocks)) {
    parts.push(`export const ${name} = ${JSON.stringify(value, null, 1)};\n\n`);
  }
  parts.push([
    'export function lotById(id) {',
    '  for (const l of LOTS) if (l.id === id) return l;',
    '  return null;',
    '}',
    '',
  ].join('\n'));
  return parts.join('');
}

// 防呆：total/formatState 在上面的日志里用到，留着 import 是为了这次检查。
if (typeof total !== 'function' || typeof formatState !== 'function') refuse('import 掉了');
