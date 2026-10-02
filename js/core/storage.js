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

// ---- 两段式解码 -------------------------------------------------------------
// 第一段：`JSON.parse`。这一段的坏输入（垃圾串、`null`、数组）只能整体退回空档 —— 因为连
// "有哪些记录"都读不出来，没有更细的粒度可言。
// 第二段：**逐条**。一条记录长歪了（`null`、缺字段、类型错、越界值）只丢那一条，其余照旧。
// 上一版把整档 `Object.assign(blank(), parsed)` 似地整体接受，于是手改过的
// `{"records":{"1-1":null}}` 会让 renderMenu() 在 `r.best` 上抛 TypeError，整局冻死。
// test/storage.test.mjs 用四条垃圾样本钉住这条边界。
function flag(v) {
  return !!v;
}

export function decodeRecord(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const best = Number(v.best);
  const plays = count(v.plays);
  const rec = {
    solved: flag(v.solved),
    best: Number.isFinite(best) && best >= 0 && best <= 1e6 ? Math.floor(best) : null,
    plays,
    atPar: flag(v.atPar),
  };
  // 一条记录至少要说得出"打过没有"：plays=0 且没有 best 又没 solved 的是空壳，丢掉。
  if (!rec.plays && rec.best === null && !rec.solved) return null;
  if (!rec.solved && rec.best !== null) rec.solved = true; // 有成绩就是拿下过
  return rec;
}

function decodeDaily(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const q = Number(v.questions);
  return {
    id: typeof v.id === 'string' ? v.id : '',
    done: flag(v.done),
    questions: Number.isFinite(q) && q >= 0 && q <= 1e6 ? Math.floor(q) : 0,
    at: Number.isFinite(Number(v.at)) ? Number(v.at) : 0,
  };
}

// 第二段丢掉的条数：外壳用它回答"存档里有没有被人手改坏的东西"，测试用它证明"确实丢了、而不是
// 根本没读到"。累加而不是覆盖，因为 records 与 daily 各丢各的。
let corruptDropped = 0;
export function corruptCount() {
  return corruptDropped;
}

function decodeMap(raw, decode) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let dropped = 0;
  for (const [k, v] of Object.entries(raw)) {
    const good = decode(v);
    if (good) out[k] = good; else dropped++;
  }
  corruptDropped += dropped;
  return out;
}

function load() {
  if (cache) return cache;
  corruptDropped = 0;
  const ls = backend();
  const raw = ls ? ls.getItem(KEY) : null;
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        const base = blank();
        const s = (p.stats && typeof p.stats === 'object') ? p.stats : {};
        cache = {
          records: decodeMap(p.records, decodeRecord),
          daily: decodeMap(p.daily, decodeDaily),
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

// ---- 设置档 ---------------------------------------------------------------
// 第二个 localStorage 键。成绩档回答"打过什么"，这一档回答"这台设备上的偏好"：静音、音量、
// 教学看过没有。它和成绩档分开，是因为清空成绩不该把玩家的静音偏好一起抹掉。
//
// 读写都显式落在 `window.localStorage.getItem/setItem` 上（不是只经由 backend() 的间接调用）：
// 一个只 setItem 不 getItem 的存档在重启后即丢失，而"读回来了没有"必须是能被 grep、也能被
// test/storage.test.mjs 实测的东西。
export const SETTINGS_KEY = 'ulam.settings.v1';

const SETTINGS_DEFAULTS = { muted: false, volume: 0.7, tutored: false };

let settingsCache = null;

function decodeSettings(raw) {
  const out = { ...SETTINGS_DEFAULTS };
  let p = null;
  try {
    p = JSON.parse(raw);
  } catch (err) {
    return { values: out, corrupt: true };      // 第一段坏了：整档退回默认值，但游戏照开
  }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { values: out, corrupt: true };
  let fieldsCorrupt = 0;
  // 第二段：逐字段。`muted` 是垃圾只丢 `muted`，音量仍然读得回来。
  if (typeof p.muted === 'boolean') out.muted = p.muted; else fieldsCorrupt++;
  const v = Number(p.volume);
  if (Number.isFinite(v) && v >= 0 && v <= 1) out.volume = v; else fieldsCorrupt++;
  if (typeof p.tutored === 'boolean') out.tutored = p.tutored; else fieldsCorrupt++;
  return { values: out, corrupt: fieldsCorrupt > 0 };
}

function loadSettings() {
  if (settingsCache) return settingsCache;
  let raw = null;
  try {
    raw = typeof window !== 'undefined' && window.localStorage
      ? window.localStorage.getItem(SETTINGS_KEY) : null;
  } catch (err) {
    raw = null;                                  // 被拒绝的存储：内存档
  }
  if (raw === null) {
    settingsCache = { ...SETTINGS_DEFAULTS, corrupt: false };
    return settingsCache;
  }
  const decoded = decodeSettings(raw);
  settingsCache = { ...decoded.values, corrupt: decoded.corrupt };
  return settingsCache;
}

function persistSettings() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    const { muted, volume, tutored } = settingsCache;
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ muted, volume, tutored }));
    return true;
  } catch (err) {
    return false;
  }
}

export const settings = {
  get muted() { return loadSettings().muted; },
  setMuted(on) {
    loadSettings().muted = !!on;
    persistSettings();
    return loadSettings().muted;
  },
  get volume() { return loadSettings().volume; },
  setVolume(v) {
    const n = Number(v);
    loadSettings().volume = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : loadSettings().volume;
    persistSettings();
    return loadSettings().volume;
  },
  get tutored() { return loadSettings().tutored; },
  markTutored() {
    loadSettings().tutored = true;
    persistSettings();
    return true;
  },
  all() {
    const s = loadSettings();
    return { muted: s.muted, volume: s.volume, tutored: s.tutored, persisted: persistSettings() };
  },
  reset() {
    settingsCache = { ...SETTINGS_DEFAULTS, corrupt: false };
    try {
      if (typeof window !== 'undefined' && window.localStorage) window.localStorage.removeItem(SETTINGS_KEY);
    } catch (err) { /* 本来就没落地 */ }
    return true;
  },
  // 测试与"存档不可用"的表头文案用：坏设置档被降级过没有（降级 = 用默认值继续玩，不是抛）。
  wasCorrupt() { return !!loadSettings().corrupt; },
};
