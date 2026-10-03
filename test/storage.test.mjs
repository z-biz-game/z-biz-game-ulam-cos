// test/storage.test.mjs — 存档层，不带浏览器。
//
// js/core/storage.js 是 js/core 里唯一允许提 `window` 的文件，所以只有这个套件必须自己造一个假
// window。每个 test 都用一份**干净的模块实例**：`cache` 是模块级私有的，共用一份实例会让上一条
// 测试的存档漏进下一条，于是这里每一行断言说的都是顺序而不是行为。
//
// 实例是在文件顶部用 top-level await 串行装好的一池子，测试体本身全是同步函数 —— 异步 test 体
// 会在 `await import()` 上互相穿插，等模块真正求值时 `globalThis.window` 早就被别的测试换掉了，
// 整间套件会读到一个共享后端（第一版就是这么写然后自己漏成一片的）。
//
// 押在这里的东西，全部从 storage.js 自己推出来，只有一条键、纯 JSON：
//   * `best`（最少问几问拿下）只降不升，`unlocked`（战役前沿）只升不降，
//   * `solved` 与 `atPar` 一旦为真就抹不掉，
//   * 每日题按日历键存：同一天只认最好的那次，`at` 只是写进去的时间戳、从不参与判定，
//   * 坏载荷一律降级成空白（顶层四键之外不清洗，健壮性靠 totals()/record() 自己的守卫），
//   * `requireBackend()` 是**抛异常**而不是返回 null —— 「被拒绝」和「是空的」必须分得开。
//
// 两件事必须说清楚，因为它们是这个仓和兄弟仓不一样的地方：
//   1. `solve()` 是**模块级导出**，而外壳（js/main.js:391）按 `store.solve(...)` 调它，所以
//      `store` 门面必须把这个名字挂上（`storage.js` 门面里的 `solve,` 就是那一步）。本套件按
//      模块级那个入口测写路径，浏览器场景 @save 再钉一条 `store.solve === solve`：两个名字、
//      一份实现，谁也不能悄悄变成两份。
//   2. storage.js 里没有 `streak()`，rng.js 里也只有 `todayKey`，没有 `shiftDay()`/`dayDistance()`。
//      连击只能由 daily 的日历键推出，所以下面的加减天数是这个套件按 UTC 历法自推的，并把跨日界、
//      跨月、闰日三处边界当断言对象 —— 因为「按日历键而不是按时间戳差」正是 markDaily 的实现方式。
//
//   node test/storage.test.mjs

import { test, ok, eq, throws, run } from '../tools/harness.mjs';
import { todayKey } from '../js/core/rng.js';

const KEY = 'ulam.save.v1';

// ---------------------------------------------------------------- 假后端

function fakeLS(initial = new Map()) {
  const m = new Map(initial);
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    clear: () => m.clear(),
    get length() { return m.size; },
    _map: m,
  };
}

// 一池子干净实例，串行装好（模块体自身不碰 window，所以这里给什么都行）。
const POOL = [];
for (let i = 0; i < 44; i++) POOL.push(await import(`../js/core/storage.js?pool=${i}`));
let poolAt = 0;

// 拿一份新实例，并把 window 摆成这个测试要的样子。同步调用，所以不会互相踩。
//   use('nowin') -> 根本没有 window（node 进程）
//   use('nols')  -> 有 window 没有 localStorage
//   use(ls)      -> 正常假后端
function use(ls) {
  if (ls === 'nowin') delete globalThis.window;
  else globalThis.window = ls === 'nols' ? {} : { localStorage: ls };
  ok(poolAt < POOL.length, '实例池不够用，加大 POOL');
  return POOL[poolAt++];
}

// ---------------------------------------------------------------- 日历键
// 这个仓的日期助手只有 todayKey(Date)：天数在这里按 UTC 历法自推，套件因此能自己数天。
const dayKey = (y, mo, d) => todayKey(new Date(Date.UTC(y, mo - 1, d)));
const nextDay = (key) => { const [y, mo, d] = key.split('-').map(Number); return dayKey(y, mo, d + 1); };
const prevDay = (key) => { const [y, mo, d] = key.split('-').map(Number); return dayKey(y, mo, d - 1); };

// storage.js 没有 streak()：连击只能数「从某天往前，连续几天 done」，起点是那一天或前一天。
function streakFrom(daily, today) {
  let count = 0;
  let cur = daily[today] && daily[today].done ? today : prevDay(today);
  while (cur && daily[cur] && daily[cur].done) {
    count++;
    cur = prevDay(cur);
  }
  return count;
}

// ---------------------------------------------------------------- 后端探针

test('storage: 存档键名就一个字符串，顶层形状就四个键', () => {
  const ls = fakeLS();
  const m = use(ls);
  eq(m.SAVE_KEY, KEY);
  eq(m.store.totals(), { solved: 0, atPar: 0, plays: 0, wins: 0, losses: 0 });
  eq(m.store.save(), true, '读过一次再存就落得下去');
  eq([...ls._map.keys()], [KEY], '整个存档永远只有一个键');
  const parsed = JSON.parse(ls.getItem(KEY));
  eq(Object.keys(parsed).sort(), ['daily', 'records', 'stats', 'unlocked', 'v']);
  eq(parsed.v, 1, '存档自带格式版本号 v');
  eq(Object.keys(parsed.stats).sort(), ['hints', 'lies', 'losses', 'plays', 'questions', 'wins']);
  m.solve('7-1', { questions: 5, par: 5, hints: 1, lies: 1, won: true });
  eq(Object.keys(JSON.parse(ls.getItem(KEY)).records['7-1']).sort(), ['atPar', 'best', 'plays', 'solved'], '一条记录只有这四个字段');
  eq(m.persistent(), true);
  eq([...ls._map.keys()], [KEY], '探针键写完即删，不留下第二条键');
});

test('storage: 一次读都没发生过的冷档，save() 写下的是 JSON 的 null —— 而它读回来是空白', () => {
  // persist() 直接把模块级的 cache 序列化，冷模块里那是 null。这个仓里没有任何路径会踩到它
  // （外壳一开机就 store.totals()），但它必须降级而不是变成一份坏档，所以按事实钉住。
  const ls = fakeLS();
  const m = use(ls);
  eq(m.store.save(), true);
  eq(ls.getItem(KEY), 'null');
  const again = use(ls);
  eq(again.store.records, {}, '读回来是干净空白，不抛');
  eq(again.store.unlocked, 1);
  eq(again.store.totals().plays, 0);
});

test('storage: node 进程里没有可持久化的后端 —— requireBackend 抛，而不是返回 null', () => {
  const m = use('nowin');
  eq(typeof window, 'undefined', '先确认这个场景里 window 真的不存在');
  const err = throws(() => m.requireBackend(), /no window/, '没有 window 却不抛，就是把「拒绝」当成了「空」');
  eq(err instanceof m.StorageError, true);
  eq(m.persistent(), false, '没有后端时 persistent 必须说实话');
  eq(m.store.save(), false, '落不了盘就得回答 false');
  const rec = m.solve('x', { questions: 4, par: 4, hints: 0, lies: 0, won: true });
  eq([rec.solved, rec.best, rec.plays, rec.atPar], [true, 4, 1, true], '内存档照样把这一局记住');
  eq(m.store.record('x').best, 4);
});

test('storage: window 在但 localStorage 不在 —— 同样抛，同样说实话', () => {
  const m = use('nols');
  throws(() => m.requireBackend(), /localStorage 不存在/);
  eq(m.persistent(), false);
  eq(m.store.save(), false);
  eq(m.store.reset(), true, '清不了盘也不能挡着玩家');
  eq(m.solve('w', { questions: 2, par: 2, hints: 0, lies: 0, won: true }).best, 2, '照玩');
});

test('storage: 存储被拒（配额 / 隐私窗口）时游戏照样玩得下去', () => {
  const ls = fakeLS();
  ls.setItem = () => { throw new Error('QuotaExceededError'); };
  const m = use(ls);
  eq(m.persistent(), false, '探针必须说实话');
  const rec = m.solve('q', { questions: 5, par: 6, hints: 0, lies: 1, won: true });
  eq(rec.best, 5, '写不进去也要记住这一局，只是出了这个页面就忘');
  eq(ls._map.size, 0, '什么都没落盘');
  eq(m.store.record('q').best, 5, '内存里是有的');
  eq(m.store.save(), false);
  eq(m.store.unlock(4), 4, '抬前沿也不该炸');
  eq(m.store.markDaily('2026-09-27', 'd', { won: true, questions: 3 }).done, true);
  ls.removeItem = () => { throw new Error('SecurityError'); };
  eq(m.store.reset(), true, '清一个从来没落过盘的档，也不许抛');
});

// ---------------------------------------------------------------- 默认值与往返

test('storage: 新会话的默认值 —— 空档一个字节都不写', () => {
  const ls = fakeLS();
  const m = use(ls);
  eq(m.store.records, {});
  eq(m.store.daily, {});
  eq(m.store.unlocked, 1);
  eq(m.store.stats, { plays: 0, wins: 0, losses: 0, questions: 0, hints: 0, lies: 0 });
  eq(m.store.totals(), { solved: 0, atPar: 0, plays: 0, wins: 0, losses: 0 });
  eq(m.store.record('7-1'), null, '没打过的关没有记录');
  eq(ls._map.size, 0, '只读不写：一开局不该污染磁盘');
});

test('storage: 换一份实例读同一块磁盘 —— 纪录、前沿、每日全部复原', () => {
  const ls = fakeLS();
  const a = use(ls);
  a.solve('15-0', { questions: 4, par: 4, hints: 0, lies: 0, won: true });
  a.solve('15-0', { questions: 7, par: 4, hints: 2, lies: 0, won: false });
  a.store.unlock(6);
  a.store.markDaily('2026-09-27', '9-3', { won: true, questions: 6 });
  const b = use(ls);
  eq(b.store.record('15-0'), { solved: true, best: 4, plays: 2, atPar: true });
  eq(b.store.unlocked, 6);
  eq(b.store.dailyDone('2026-09-27').done, true);
  eq(b.store.dailyDone('2026-09-27').questions, 6);
  eq(b.store.totals(), { solved: 1, atPar: 1, plays: 2, wins: 1, losses: 1 });
  eq(b.store.stats, a.store.stats, '两份实例读出来的是同一份账');
  eq(b.store.dailyDone('2026-09-28'), null);
});

// ---------------------------------------------------------------- 两条单调性

test('storage: per-lot 纪录 —— best 只降不升，plays 每局加一', () => {
  const m = use(fakeLS());
  eq(m.solve('x', { questions: 6, par: 5, hints: 0, lies: 1, won: true }).best, 6);
  eq(m.solve('x', { questions: 8, par: 9, hints: 3, lies: 0, won: true }).best, 6, '更慢的一局抬不动 best');
  eq(m.solve('x', { questions: 4, par: 4, hints: 0, lies: 2, won: true }).best, 4, '更快才降');
  const lost = m.solve('x', { questions: 2, par: 9, hints: 0, lies: 0, won: false });
  eq(lost.best, 4, '输了也不动 best');
  eq(lost.plays, 4);
  eq([lost.solved, lost.atPar], [true, true], '通过过 / 在精确值内，都是抹不掉的事实');
  eq(m.store.record('x').plays, 4);
  const s = m.store.stats;
  // hand-derived：6+8+4+2 = 20 问、三胜一负、0+3+0+0 = 3 次提示、1+0+2+0 = 3 个谎
  eq([s.plays, s.wins, s.losses, s.questions, s.hints, s.lies], [4, 3, 1, 20, 3, 3]);
  eq(m.solve('x', { questions: 1, par: 9, hints: 0, lies: 0, won: false }).solved, true, '再输也还是通过过的');
});

test('storage: 第一次就输的一局 —— solved:false、best 是 null 而不是 0', () => {
  const m = use(fakeLS());
  eq(m.solve('y', { questions: 3, par: 3, hints: 1, lies: 1, won: false }), { solved: false, best: null, plays: 1, atPar: false });
  eq(m.solve('y', { questions: 9, par: 3, hints: 0, lies: 0, won: true }), { solved: true, best: 9, plays: 2, atPar: false }, '9 问 > 精确值 3：拿下了但不算在精确值内');
  eq(m.store.totals(), { solved: 1, atPar: 0, plays: 2, wins: 1, losses: 1 });
});

test('storage: unlocked 只升不降，负数与 undefined 都推不动它', () => {
  const ls = fakeLS();
  const m = use(ls);
  eq(m.store.unlock(5), 5);
  eq(m.store.unlock(5), 5, '同一前沿重复喊话');
  eq(m.store.unlock(2), 5);
  eq(m.store.unlock(0), 5);
  eq(m.store.unlock(-4), 5);
  eq(m.store.unlock(undefined), 5);
  eq(m.store.unlock(14), 14);
  eq(m.store.unlocked, 14);
  ok(ls.getItem(KEY), '前沿是要落盘的');
  eq(JSON.parse(ls.getItem(KEY)).unlocked, 14);
  eq(use(ls).store.unlocked, 14, '换一份实例读回来还是 14');
});

// ---------------------------------------------------------------- 每日题

test('storage: 每日赢过一次就擦不掉，更差的重玩保留问数', () => {
  const m = use(fakeLS());
  const first = m.store.markDaily('2026-09-27', '9-3', { won: true, questions: 6 });
  eq([first.id, first.done, first.questions], ['9-3', true, 6]);
  eq(typeof first.at, 'number');
  const worse = m.store.markDaily('2026-09-27', '15-0', { won: false, questions: 40 });
  eq(worse.done, true, '打输了不能把已经拿下的一天抹掉');
  eq(worse.questions, 6, '6 问那次仍然是这一天的成绩');
  eq(worse.at, first.at, '保留的那一次连时间戳都不重铸');
  eq(worse.id, '15-0', '粘性分支会把 id 换成这一次的：done/questions 才是成绩');
  const better = m.store.markDaily('2026-09-27', '15-0', { won: true, questions: 5 });
  eq([better.done, better.questions], [true, 5], '只有赢得更快才改写这一天的问数');
  eq(m.store.dailyDone('2026-09-28'), null, '另一天不受牵连');
});

test('storage: 没赢过的那天可以从 false 翻到 true；result 缺席也不崩', () => {
  const m = use(fakeLS());
  eq(m.store.markDaily('2026-10-01', 'd1', { won: false, questions: 4 }).done, false);
  const bare = m.store.markDaily('2026-10-02', 'd2', null);
  eq(bare, { id: 'd2', done: false, questions: 0, at: m.store.dailyDone('2026-10-02').at });
  eq(m.store.markDaily('2026-10-01', 'd3', { won: true, questions: 7 }).done, true, '同一天后来赢了就认赢');
  eq(m.store.markDaily('2026-10-02', 'd4', { won: true, questions: 2 }).questions, 2, '从 done:false 起，第一次赢直接改写');
});

test('storage: 连击按日历键推（这里没有 streak()）—— 跨日界 / 跨月 / 闰日各写一天', () => {
  // 手推的历法事实：先证明这个套件数天的方式是可信的
  eq(nextDay('2026-08-31'), '2026-09-01', '跨月不能凭空多出一天');
  eq(nextDay('2024-02-28'), '2024-02-29', '2024 是闰年');
  eq(nextDay('2026-02-28'), '2026-03-01', '2026 不是闰年');
  eq(nextDay('2026-12-31'), '2027-01-01', '跨年同理');
  eq(prevDay('2026-03-01'), '2026-02-28');
  eq(dayKey(2026, 9, 27), '2026-09-27', 'todayKey 补零：键的形状就是 daily 用的那个');

  const m = use(fakeLS());
  const days = [];
  let cur = '2026-08-29';
  for (let i = 0; i < 5; i++) { days.push(cur); cur = nextDay(cur); }
  eq(days, ['2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02']);
  for (const d of days) m.store.markDaily(d, `daily-${d}`, { won: true, questions: 4 });
  eq(Object.keys(m.store.daily).length, 5, '五天就是五个键，跨月不合并也不掉');
  eq(streakFrom(m.store.daily, '2026-09-02'), 5, '连着五天，含月界那一天');
  eq(streakFrom(m.store.daily, '2026-09-01'), 4, '从月界往回数四天');
  eq(streakFrom(m.store.daily, '2026-08-30'), 2);
  eq(streakFrom(m.store.daily, '2026-09-05'), 0, '断了一天就是断了');
  // 今天输了不该把昨天为止的连胜抹掉：done:false 那天不参与回溯
  m.store.markDaily('2026-09-03', 'daily-2026-09-03', { won: false, questions: 9 });
  eq(streakFrom(m.store.daily, '2026-09-03'), 5, '从昨天往前数仍然是 5');
  eq(m.store.dailyDone('2026-09-03').done, false, '而那一天本身记的是没拿下');
  eq(m.store.dailyDone('2026-08-31').questions, 4, '相邻日各自独立');
});

// ---------------------------------------------------------------- 坏载荷

test('storage: 损坏的存档降级成空白，而不是把页面搞崩', () => {
  for (const junk of ['{', 'not json at all', '[]', 'null', '"a string"', '0', '', 'NaN', 'true', '12']) {
    const ls = fakeLS(new Map([[KEY, junk]]));
    const m = use(ls);
    eq(m.store.records, {}, `${junk} 应该读成空记录`);
    eq(m.store.daily, {});
    eq(m.store.unlocked, 1);
    eq(m.store.totals(), { solved: 0, atPar: 0, plays: 0, wins: 0, losses: 0 });
    eq(m.store.save(), true, '坏档之后必须还能重写');
    eq(JSON.parse(ls.getItem(KEY)).records, {}, '重写出去的就是干净空白');
  }
});

test('storage: 半坏的载荷 —— unlocked 不是数字退回 1，stats 逐项取整、负数与 NaN 归零', () => {
  const payload = {
    unlocked: 'many',
    stats: { plays: -5, wins: 2.9, losses: null, questions: '12', hints: undefined, lies: NaN },
    records: 'not an object',
    daily: 7,
  };
  const ls = fakeLS(new Map([[KEY, JSON.stringify(payload)]]));
  const m = use(ls);
  eq(m.store.unlocked, 1, '"many" 不是数字');
  eq(m.store.stats, { plays: 0, wins: 2, losses: 0, questions: 12, hints: 0, lies: 0 }, 'count() 逐项收拾：负数归零、2.9 取整、字符串数字收下');
  eq(m.store.records, {}, 'records 不是对象就整块退回空白');
  eq(m.store.daily, {}, 'daily 同理');
  eq(m.store.totals().plays, 0);
  eq(m.store.unlock(2), 2, '降级之后照样能往前写');
});

test('storage: records 逐条清洗 —— 烂的那条只丢自己，好的那条一点不受牵连', () => {
  const payload = {
    records: { good: { solved: true, best: 3, plays: 2, atPar: true }, junk: 'garbage', half: {} },
    daily: { '2026-05-01': { id: 'd', done: true, questions: 4 }, nope: 3 },
  };
  const m = use(fakeLS(new Map([[KEY, JSON.stringify(payload)]])));
  eq(m.store.record('good').best, 3, '一条坏的拖累不了好的');
  eq(m.store.record('junk'), null, '不是对象的记录直接丢掉，绝不原样透传成一条"记录"');
  eq(m.store.record('half'), { solved: false, best: null, plays: 0, atPar: false },
    '半条记录逐字段归一成默认，而不是让缺字段漏进业务代码');
  eq(m.store.totals(), { solved: 1, atPar: 1, plays: 0, wins: 0, losses: 0 }, 'totals 只数 r && r.solved，烂记录进不了账');
  eq(m.store.dailyDone('nope'), 3, '不合格的日历键照样读得回来 —— 连击是调用方的事');
  eq(m.solve('junk', { questions: 2, par: 2, hints: 0, lies: 0, won: true }).best, 2, '打一次就把那条烂记录覆盖掉');
  eq(m.store.totals().solved, 2);
});

test('storage: 解构缺字段不抛；questions 缺席时 best 写成 undefined，落盘就没这个键', () => {
  const ls = fakeLS();
  const m = use(ls);
  eq(m.solve('bare', {}), { solved: false, best: null, plays: 1, atPar: false }, 'won 缺席就是没赢');
  const cur = m.solve('bare', { won: true });
  eq([cur.solved, cur.plays, cur.atPar], [true, 2, false]);
  eq(cur.best === undefined, true, '没有 questions 就没有 best：不是 0，也不是 null');
  m.store.save();
  eq(Object.keys(JSON.parse(ls.getItem(KEY)).records.bare).sort(), ['atPar', 'plays', 'solved'], 'JSON 把 undefined 键抹掉了');
  const s = m.store.stats;
  eq([s.plays, s.wins, s.losses, s.questions, s.hints, s.lies], [2, 1, 1, 0, 0, 0], '缺的数目按 0 累加');
});

// ---------------------------------------------------------------- 清档

test('storage: reset 把内存与磁盘一起清掉，下一局从头记', () => {
  const ls = fakeLS();
  const m = use(ls);
  m.solve('z', { questions: 3, par: 3, hints: 0, lies: 0, won: true });
  m.store.markDaily('2026-09-27', 'd', { won: true, questions: 3 });
  m.store.unlock(9);
  ok(ls.getItem(KEY), '先确认落盘了');
  eq(m.store.reset(), true);
  eq(ls.getItem(KEY), null, 'reset 是删键，不是写一个空档');
  eq(Object.keys(m.store.records).length, 0);
  eq(m.store.unlocked, 1);
  eq(m.store.totals(), { solved: 0, atPar: 0, plays: 0, wins: 0, losses: 0 });
  eq(m.store.dailyDone('2026-09-27'), null);
  eq(m.solve('z', { questions: 7, par: 3, hints: 0, lies: 0, won: true }).plays, 1, '清完再打是第一局');
  eq(m.store.reset(), true, '连着清两次也不许抛');
  eq(ls.getItem(KEY), null);
});

test('storage: 落盘探针用的是另一个键，而且当场擦干净', () => {
  const ls = fakeLS();
  const m = use(ls);
  eq(m.persistent(), true);
  eq([...ls._map.keys()], [], 'ulam.probe 写完即删，不留残渣');
  m.solve('p', { questions: 1, par: 1, hints: 0, lies: 0, won: true });
  eq([...ls._map.keys()], [KEY], '整个游戏只写那一条存档键');
  ok(ls.getItem(KEY).length < 4096, `档不该膨胀：${ls.getItem(KEY).length} 字节`);
  eq(m.persistent(), true, '探针可以反复按');
  eq([...ls._map.keys()], [KEY]);
});

run();
