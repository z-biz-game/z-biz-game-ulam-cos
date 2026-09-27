// 存档：一个 localStorage 键，纯 JSON，带版本号。
//
// js/core 里只有这个文件允许碰 `window`，而且是受约束地碰：`node --test` 直接 import 它时
// 根本没有 window，浏览器也可能拒绝存储（无痕窗口、file://、配额满了）。规则只有两条：
//   * 读的时候退化成内存里的空档 —— 游戏永远可以玩；
//   * 问"这一局到底存没存下来"必须走 `requireBackend()`，它是**抛异常**而不是返回 null。
//     一个用 null 回答"没有存储"的探针分不清"被拒绝"和"是空的"，而 @save 套件测的正是这个区别。
//
// 整个存档设计就是两条单调性，test/storage.test.mjs 故意乱序写入来证明它们：
//   * `best`（最少问几问拿下）只降不升，
//   * `unlocked`（战役解锁到第几关）只升不降。

const KEY = 'ulam.save.v1';

export const SAVE_KEY = KEY;

export class StorageError extends Error {}

export function requireBackend() {
  if (typeof window === 'undefined') throw new StorageError('no window：node 进程里没有可持久化的存档');
  if (!window.localStorage) throw new StorageError('window.localStorage 不存在');
  return window.localStorage;
}

function backend() {
  try {
    return requireBackend();
  } catch (err) {
    return null; // 内存档：游戏照玩，只是关掉页面就忘
  }
}

function count(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function blank() {
  return {
    records: {},
    daily: {},
    unlocked: 1,
    stats: { plays: 0, wins: 0, losses: 0, questions: 0, hints: 0, lies: 0 },
  };
}

let cache = null;

function load() {
  if (cache) return cache;
  const ls = backend();
  const raw = ls ? ls.getItem(KEY) : null;
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        const base = blank();
        const s = (p.stats && typeof p.stats === 'object') ? p.stats : {};
        cache = {
          records: p.records && typeof p.records === 'object' ? p.records : base.records,
          daily: p.daily && typeof p.daily === 'object' ? p.daily : base.daily,
          unlocked: count(p.unlocked) || base.unlocked,
          stats: {
            plays: count(s.plays),
            wins: count(s.wins),
            losses: count(s.losses),
            questions: count(s.questions),
            hints: count(s.hints),
            lies: count(s.lies),
          },
        };
        return cache;
      }
    } catch (err) {
      // 坏档不值得抢救：重新开始，别让外壳崩掉。
    }
  }
  cache = blank();
  return cache;
}

function persist() {
  const ls = backend();
  if (!ls) return false;
  try {
    ls.setItem(KEY, JSON.stringify(cache));
    return true;
  } catch (err) {
    return false;
  }
}

// 这一局结束。`questions` 是玩家真正问出去的问数，`par` 是该局状态的精确值（表里量出来的），
// 所以"在 par 内拿下"是关于打法的客观事实，不是手感。
export function solve(id, { questions, par, hints, lies, won }) {
  const s = load();
  const prev = s.records[id];
  const cur = {
    solved: !!(won || (prev && prev.solved)),
    best: won && (!prev || !prev.best || questions < prev.best) ? questions : (prev ? prev.best : null),
    plays: (prev && prev.plays ? prev.plays : 0) + 1,
    atPar: !!(won && questions <= par) || !!(prev && prev.atPar),
  };
  s.records[id] = cur;
  s.stats.plays += 1;
  if (won) s.stats.wins += 1; else s.stats.losses += 1;
  s.stats.questions += count(questions);
  s.stats.hints += count(hints);
  s.stats.lies += count(lies);
  persist();
  return cur;
}

export const store = {
  get records() { return load().records; },
  get stats() { return load().stats; },
  get daily() { return load().daily; },
  get unlocked() { return load().unlocked; },

  record(id) {
    return load().records[id] || null;
  },

  // 结案写记录走这道门面，和 unlock/markDaily 对齐：外壳只认 `store.*`，模块级的那个
  // `solve` 是给测试直接调同一份实现用的，不是另一个入口。
  solve,

  unlock(n) {
    const s = load();
    if (n > s.unlocked) s.unlocked = n;
    persist();
    return s.unlocked;
  },

  // 每日题：同一天只认最好的一次，第二次打得更差不能把成绩抹掉。
  markDaily(dateKey, id, result) {
    const s = load();
    const prev = s.daily[dateKey];
    if (prev && prev.done && (!result || !result.won || count(result.questions) >= count(prev.questions))) {
      s.daily[dateKey] = { id, done: true, questions: prev.questions, at: prev.at };
    } else {
      s.daily[dateKey] = {
        id,
        done: !!(result && result.won),
        questions: (result && result.questions) || 0,
        at: Date.now(),
      };
    }
    persist();
    return s.daily[dateKey];
  },

  dailyDone(dateKey) {
    return load().daily[dateKey] || null;
  },

  // 战役列表头打的计数；放在这里是为了让"几个数"只有一份定义。
  totals() {
    const s = load();
    let solved = 0;
    let atPar = 0;
    for (const r of Object.values(s.records)) {
      if (r && r.solved) solved++;
      if (r && r.atPar) atPar++;
    }
    return { solved, atPar, plays: s.stats.plays, wins: s.stats.wins, losses: s.stats.losses };
  },

  reset() {
    cache = blank();
    const ls = backend();
    if (ls) {
      try {
        ls.removeItem(KEY);
      } catch (err) {
        /* 本来就没存下来 */
      }
    }
    return true;
  },

  save() {
    return persist();
  },
};

// 只有测试和"清空存档"的文案用得上：这一局到底有没有真的落地。
export function persistent() {
  const ls = backend();
  if (!ls) return false;
  try {
    ls.setItem('ulam.probe', '1');
    ls.removeItem('ulam.probe');
    return true;
  } catch (err) {
    return false;
  }
}
