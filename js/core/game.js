// 一局进行中：纯状态 + 碰它的那套规则。这个文件里没有 DOM，所以 test/game.test.mjs 和
// tools/playtest.mjs 驱动的是屏幕上同一个对象。
//
// 规则，以及每条规则在哪儿咬人：
//   * 藏起来的数在 {1..n}，对手最多说 k 个谎，玩家最多问 q 问，最后必须**指一个格子**。
//     指对了才算赢——"我推理出来了"不算。所以 `accuse` 是唯一能结束一局并判胜的动线。
//   * 每一问都是"亮一批格子，问：是不是在亮格里？"。亮空集和亮全集都**合法**：
//     亮空集时真话只能是"不在"，对手若答"在"就白送一个谎——这一手在账本上看得见，
//     屏幕上标成"空问"，因为它确实没有新信息，但它是合法的一问（DP 的 quantifier 也覆盖它）。
//   * 谎的账本记在 per-candidate 计数器上：`contra[x]` = 与"x 是秘密"相矛盾的答案条数。
//     权重向量 a_i = #{x : contra[x] === i} 因此是**算出来的**，不是别人递进来的
//     （state.js 的 answer() 与这里的一致性由 test/game.test.mjs 逐问对表）。
//   * 撤销只回退一问，且把 per-candidate 计数器整份还原：快照存在那一问的行里，
//     所以撤销不需要重放日志。
//   * `hint` 的诚实分两级（tango 的 game.js 也是这么做的）：表里查得到 = 极小极大真解出来的
//     必胜题（`exact: true`）；查不到 = 体积均分的建议，屏幕上明写"表外"。点击路径上没有搜索。
//
// 唯一一件这一层自己算的事是 O(n) 的计数器→向量归约（n ≤ 40），所以每一问之后
// "还剩几个候选 / 各被反驳几次"这些读数不需要 spinner。

import { answer, fresh, total, realizable, key } from './state.js';
import { volume } from './volume.js';
import { decide } from './adversary.js';
import { strategies } from './greedy.js';

export const MAX_CELLS = 40;

// 从 lot 造一局。lot 形状见 js/data/lots.js / js/core/make.js：
// { id, n, k, q, par, policy? }，`policy` 是 key(state,q) -> { a, q, y } 的 Map（战役关有，随机关没有）。
export function createGame(lot, opts = {}) {
  const n = lot.n;
  const k = lot.k;
  if (n < 1 || n > MAX_CELLS) throw new Error(`n=${n} 超出 1..${MAX_CELLS}`);
  if (k < 0) throw new Error('k 不能为负');
  const secret = opts.secret !== undefined ? opts.secret : lot.secret;
  if (!Number.isInteger(secret) || secret < 1 || secret > n) throw new Error(`secret=${secret} 不在 1..${n}`);
  return {
    id: lot.id,
    tier: lot.tier || 'campaign',
    title: lot.title || '',
    n,
    k,
    qBudget: lot.q,
    par: Number.isInteger(lot.par) ? lot.par : null,
    policy: lot.policy instanceof Map ? lot.policy : null,
    secret,
    contra: new Array(n + 1).fill(0),   // 1-indexed; 0 槽不用
    log: [],
    draft: [],                          // 正在亮的格子 id，升序
    asked: 0,
    done: false,
    won: false,
    phase: 'ask',                       // 'ask' | 'accuse' | 'over'
  };
}

export function state(game) {
  const a = new Array(game.k + 1).fill(0);
  for (let x = 1; x <= game.n; x++) {
    const c = game.contra[x];
    if (c <= game.k) a[c] += 1;
  }
  return a;
}

export function questionsLeft(game) {
  return Math.max(0, game.qBudget - game.asked);
}

// 玩家在这一问上真正花的"确定谎数下界"：活着的候选里被反驳最少的那个也要背这么多矛盾。
// 对手可以声称只说了这么多谎，所以账本只能点亮这么多——这是关于信息的陈述，不是猜测。
export function provableLies(game) {
  let min = Infinity;
  for (let x = 1; x <= game.n; x++) if (game.contra[x] <= game.k && game.contra[x] < min) min = game.contra[x];
  return min === Infinity ? 0 : min;
}

export function trueLies(game) {
  return game.contra[game.secret];
}

export function witnesses(game) {
  const out = [];
  for (let x = 1; x <= game.n; x++) if (game.contra[x] <= game.k) out.push(x);
  return out;
}

export function canAsk(game) {
  return !game.done && game.phase === 'ask' && questionsLeft(game) > 0;
}

export function toggle(game, id) {
  if (!canAsk(game)) return false;
  const i = game.draft.indexOf(id);
  if (i >= 0) game.draft.splice(i, 1);
  else game.draft.push(id);
  game.draft.sort((p, r) => p - r);
  return true;
}

export function paint(game, ids) {
  if (!canAsk(game)) return false;
  const seen = new Set(game.draft);
  for (const id of ids) if (id >= 1 && id <= game.n) seen.add(id);
  game.draft = [...seen].sort((p, r) => p - r);
  return true;
}

export function clearDraft(game) {
  game.draft = [];
}

// profile：每一格里亮了几个。策略只决定数量，身份由升序固定顺序决定——棋盘上不藏知识。
export function profileOf(game, ids = game.draft) {
  const a = state(game);
  const y = new Array(game.k + 1).fill(0);
  for (const id of ids) {
    const c = game.contra[id];
    if (c <= game.k) y[c] += 1;
  }
  return { a, y };
}

// 把 profile 落回具体格子：按 id 升序从每一格里取 y_i 个。hint 用它把表里的题变成能亮的格子。
export function idsForProfile(game, y) {
  const need = y.slice();
  const out = [];
  for (let i = 0; i < need.length; i++) {
    for (let x = 1; x <= game.n && need[i] > 0; x++) {
      if (game.contra[x] === i) { out.push(x); need[i] -= 1; }
    }
  }
  return out.sort((p, r) => p - r);
}

// 问出去。返回值里的 `rule`/`lied` 只有构建期与调试抽屉会看，屏幕上的文案用 `answer`。
export function ask(game, opts = {}) {
  if (game.done) return { ok: false, reason: 'over' };
  if (!canAsk(game)) return { ok: false, reason: game.phase === 'accuse' ? 'accuse' : 'budget' };
  const ids = opts.ids !== undefined ? opts.ids.slice().sort((p, r) => p - r) : game.draft.slice();
  if (ids.some((id) => !Number.isInteger(id) || id < 1 || id > game.n)) return { ok: false, reason: 'cell' };
  const { a, y } = profileOf(game, ids);
  if (total(a) <= 1) return { ok: false, reason: 'settled', left: total(a) };
  const sLit = ids.includes(game.secret);
  const d = decide({
    a,
    q: questionsLeft(game),
    y,
    sLit,
    liesLeft: game.k - game.contra[game.secret],
    rank: opts.rank || null,
  });
  game.log.push({
    ids,
    y,
    a,
    answer: d.answer,
    lied: d.lied,
    rule: d.rule,
    stateBefore: a.slice(),
    contraBefore: game.contra.slice(),
    askedBefore: game.asked,
    degenerate: ids.length === 0 || ids.length === total(a),
  });
  applyAnswer(game, d.answer, ids);
  game.asked += 1;
  game.draft = [];
  // 只剩一个候选就没必要再问了：规则上此时必须指认，屏幕上把这一格点亮等着点。
  if (questionsLeft(game) === 0 || total(state(game)) <= 1) game.phase = 'accuse';
  return {
    ok: true,
    answer: d.answer,
    lied: d.lied,
    rule: d.rule,
    state: state(game),
    left: total(state(game)),
    degenerate: game.log[game.log.length - 1].degenerate,
    qLeft: questionsLeft(game),
  };
}

function applyAnswer(game, side, ids) {
  const lit = new Set(ids);
  for (let x = 1; x <= game.n; x++) {
    const contradicted = side === 'yes' ? !lit.has(x) : lit.has(x);
    if (contradicted && game.contra[x] <= game.k) game.contra[x] += 1;
  }
}

// 只回退一问：整份计数器快照还原，所以不需要重放日志。
export function undo(game) {
  const last = game.log.pop();
  if (!last) return false;
  game.contra = last.contraBefore.slice();
  game.asked = last.askedBefore;
  game.draft = [];
  game.done = false;
  game.won = false;
  game.phase = 'ask';
  return true;
}

export function reset(game) {
  game.contra = new Array(game.n + 1).fill(0);
  game.log = [];
  game.draft = [];
  game.asked = 0;
  game.done = false;
  game.won = false;
  game.phase = 'ask';
}

// 指着格子结案。指错了就是输了；指对了还要看谎数账——账本在这里已经由 applyAnswer 保证
// 每格 ≤ k 才会活着，所以指对了就赢，不需要再问一次"那你有没有说过超过 k 个谎"。
export function accuse(game, id) {
  if (game.done) return { ok: false, reason: 'over' };
  if (!Number.isInteger(id) || id < 1 || id > game.n) return { ok: false, reason: 'cell' };
  game.phase = 'over';
  game.done = true;
  game.won = id === game.secret;
  game.accused = id;
  game.aliveAtEnd = total(state(game));
  return { ok: true, won: game.won, id, secret: game.secret, alive: game.aliveAtEnd };
}

// 一问题是不是"什么也没问"：亮空集或亮全集。两边都是合法问题（DP 的 quantifier 覆盖它们），
// 但屏幕上必须标出来，不然玩家会以为提示坏了——发放的问数有余量时，表里字典序第一问就是空问。
function isDegenerate(a, y) {
  return y.every((v) => v === 0) || y.every((v, i) => v === a[i]);
}

// 提示。两级诚实：
//   policy —— 这一局的 (状态, 剩余问数) 在构建期被极小极大真解过，y 是必胜题；
//   volume —— 表外（随机关，或者玩家走歪了），给的是体积均分建议，不担保 par。
export function hint(game) {
  if (game.done || game.phase !== 'ask') return null;
  const a = state(game);
  const q = questionsLeft(game);
  if (total(a) <= 1) return { kind: 'settled', exact: false, ids: [], left: total(a) };
  if (!game.policy) return { kind: 'absent', exact: false, ...fallbackHint(game, a, q), left: total(a) };
  const entry = game.policy.get(key(a, q));
  if (entry && Array.isArray(entry.y) && entry.y.length === a.length) {
    const ok = entry.y.every((v, i) => Number.isInteger(v) && v >= 0 && v <= a[i]);
    if (ok) {
      return {
        kind: 'policy',
        exact: true,
        ids: idsForProfile(game, entry.y),
        y: entry.y.slice(),
        degenerate: isDegenerate(a, entry.y),
        left: total(a),
        qLeft: q,
        state: a,
      };
    }
  }
  return { kind: 'offpolicy', exact: false, ...fallbackHint(game, a, q), left: total(a) };
}

function fallbackHint(game, a, q) {
  const y = strategies.volumeBalance.pick(a, q);
  return { ids: idsForProfile(game, y), y, degenerate: isDegenerate(a, y) };
}

// 结案读数。三档全部 keyed 在构建期量出来的 par 上，而不是手感上。
// `lucky` 是单独一栏：指对了但结案时还有 N 个候选与全部答案相容，那一次对是蒙的——
// 游戏照算赢（Ulam 的原规则就是"指对即赢"），但屏幕上必须明写这是运气，不是推理。
export function grade(game) {
  if (!game.done) return { key: 'open', label: '还在问', stars: 0, lucky: false };
  if (!game.won) return { key: 'caught', label: '指错了', stars: 0, lucky: false };
  const alive = total(state(game));
  const lucky = alive > 1;
  if (game.par === null) return { key: 'win', label: lucky ? '蒙对了' : '拿下', stars: lucky ? 1 : 2, lucky };
  const over = game.asked - game.par;
  if (lucky) return { key: 'lucky', label: `蒙对的：还剩 ${alive} 个候选`, stars: 1, lucky: true };
  if (over <= 0) return { key: 'tight', label: `${game.par} 问必中线上`, stars: 3, lucky: false };
  if (over === 1) return { key: 'late', label: '多问了一问', stars: 2, lucky: false };
  return { key: 'pried', label: '硬撬出来的', stars: 1, lucky: false };
}

// 复盘：哪几问答谎了（只有结案后才摊开），以及每一个格子被反驳了几次。
export function reveal(game) {
  const cells = [];
  for (let x = 1; x <= game.n; x++) cells.push({ id: x, contra: Math.min(game.contra[x], game.k + 1), alive: game.contra[x] <= game.k });
  return {
    secret: game.secret,
    accused: game.accused === undefined ? null : game.accused,
    cells,
    lies: game.log.map((r) => r.lied),
    trueLies: trueLies(game),
    provableLies: provableLies(game),
    witnesses: witnesses(game),
    verdictText: verdictText(game),
  };
}

// 结论文案。任务书要求"故意输的那条线必须能断言文案"，所以这句话是 API 的一部分，
// 不是 view 层拼出来的装饰。
export function verdictText(game) {
  if (!game.done) return '尚未结案';
  const a = state(game);
  const left = total(a);
  if (game.won) {
    const luck = left > 1 ? `严格说这一次是蒙的：结案时还有 ${left} 个候选与全部答案相容。` : '结案时候选集只剩这一个，所以这不是运气。';
    return `你指着 ${game.accused}，秘密就是 ${game.secret}：对手一共说了 ${trueLies(game)} 个谎（最多允许 ${game.k} 个）。${luck}`;
  }
  const dead = left === 0 ? '候选集已空——对手的答案互相矛盾，这一局不该出现这种局面。' : '';
  return `你指着 ${game.accused === undefined ? '？' : game.accused}，但秘密是 ${game.secret}。`
    + `结案时还有 ${left} 个候选与全部答案相容，${game.asked} 问问完没能唯一确定`
    + (game.par !== null ? `（这一关的精确值是 ${game.par} 问，允许 ${game.k} 个谎）。` : '。')
    + dead;
}

// 体积读数：屏幕上"界还剩多少余量"那一行。纯算术，点击路径安全。
export function volumeReadout(game) {
  const a = state(game);
  const q = questionsLeft(game);
  return { a, q, V: volume(a, q), cap: 2 ** q, margin: volume(a, q) === 0 ? Infinity : 2 ** q / volume(a, q), total: total(a) };
}

export { realizable, total, fresh, key };
