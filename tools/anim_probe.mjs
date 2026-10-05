#!/usr/bin/env node
// 帧率对拍探针（node 侧，不启浏览器）：同一份 js/view.js、同一 LCG 种子、同一虚拟时长，
// 分别按 30/60/120Hz 喂 rAF，逐字段比末态。
//
// 为什么要它在仓里：官方量具 cos_frame_probe.js 用 vm.runInContext 装载脚本，天然进不了 ES
// module（本仓从 26c710c 起就是 `<script type="module">`），实测三档全报
// `SyntaxError: Cannot use import statement outside a module` ⇒ 「结论：无法比对」。
// 简报 §3 把这种档位判为不通过，并要求「靠自己的 harness 补判」。补判一次不够 ——
// 定步长累加器是会被后人一行 `accum += 1/60` 改回去的，所以判据要留在 CI 里（test/anim.test.mjs）。
//
// 口径（三条都写死在这里，因为它们各自对应一个已经踩过的假阳性）：
//   · 时钟从 1000ms 起，不从 0 起 —— 从 0 起步会被 view 的 `lastTs === 0` 哨兵吃掉第一帧，
//     凭空造出一条 25ms 的帧率依赖；
//   · 主口径按 sim 步号对齐，不按墙钟虚拟秒 —— 1000/60 的浮点亏损会让 60Hz 少喂 5e-13 秒、
//     累加器少跑一步，按时间对齐就是凭空判红；
//   · 同时给一条「定虚拟时长」口径（极差 ≤1 步才算无关）—— 按步号对齐对「累加器吃常量」
//     这种变异是盲的：状态序列按步号永远同构，被帧率绑架的是「每单位墙钟走出几步」。
// accumulatorMs（还没凑满一步的零头）单独记账：它由帧的切分方式决定，不由状态决定，
// 任何定步长实现下都会差满一步以内，属探针边界，不是缺陷。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SIM_STEP = 1000 / 60;

// ---- 最小 DOM/画布桩 -------------------------------------------------------
// 只装 view.js 实际碰到的那一层：2D 上下文按方法名吞掉，事件表留着好让 pointer 回落可测。
function makeCtx() {
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '', textAlign: '', textBaseline: '',
    measureText: (s) => ({ width: String(s).length * 7 }),
    createPattern: () => ({ pattern: true }),
    getImageData: () => ({ data: new Uint8ClampedArray([9, 9, 9, 255]) }),
  };
  for (const m of ['beginPath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'closePath', 'fill', 'stroke',
    'fillRect', 'clearRect', 'fillText', 'strokeText', 'setTransform', 'save', 'restore',
    'setLineDash', 'drawImage', 'translate', 'scale', 'rotate', 'clip']) ctx[m] = () => {};
  return ctx;
}

function makeEl(id) {
  return {
    id, hidden: false, textContent: '', innerHTML: '', className: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [], setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    appendChild(c) { this.children.push(c); return c; },
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 44, height: 44, right: 44, bottom: 44 }),
  };
}

export function makeEnv() {
  const raf = [];
  let rafSeq = 0;
  const handlers = new Map();
  const canvas = {
    width: 0, height: 0, style: {},
    getContext: () => canvas._ctx || (canvas._ctx = makeCtx()),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 520, right: 640, bottom: 520 }),
    addEventListener: (t, fn) => handlers.set(t, fn),
    removeEventListener: (t) => handlers.delete(t),
    dispatch: (t, ev) => { const fn = handlers.get(t); if (fn) fn(ev); },
    _handlers: handlers,
  };
  const els = new Map();
  const images = [];
  class Image {
    constructor() { this._src = ''; this.onload = null; this.onerror = null; images.push(this); queueMicrotask(() => { if (this._ok !== false && this.onload) this.onload(); }); }
    set src(v) { this._src = v; }
    get src() { return this._src; }
  }
  const win = {
    devicePixelRatio: 2, innerWidth: 1040, innerHeight: 900, localStorage: null,
    requestAnimationFrame: (cb) => { raf.push({ id: ++rafSeq, cb }); return rafSeq; },
    cancelAnimationFrame: (id) => { const i = raf.findIndex((r) => r.id === id); if (i >= 0) raf.splice(i, 1); },
    addEventListener: (t, fn) => handlers.set('win:' + t, fn),
    removeEventListener: (t) => handlers.delete('win:' + t),
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    PointerEvent: function PointerEvent() {},
  };
  const doc = {
    // 相对页面 URL 解析资产路径，和浏览器同语义（Pages 把仓挂在 /<repo>/ 前缀下）
    baseURI: 'http://127.0.0.1:5222/index.html',
    documentElement: makeEl('html'), body: makeEl('body'), hidden: false,
    getElementById: (id) => (id === 'board' ? canvas : (els.get(id) || els.set(id, makeEl(id)).get(id))),
    querySelector: (sel) => (sel === 'canvas' ? canvas : null),
    createElement: (tag) => makeEl('created-' + tag),
    addEventListener() {},
  };
  const globals = {
    window: win, document: doc, Image, navigator: { userAgent: 'node' },
    performance: { now: () => 1000 },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: win.requestAnimationFrame, cancelAnimationFrame: win.cancelAnimationFrame,
    matchMedia: win.matchMedia, localStorage: null,
  };
  // node 22 的 globalThis.navigator 是只读 getter，只能 defineProperty 盖
  for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
  Object.defineProperty(globalThis, 'self', { value: win, writable: true, configurable: true });
  // 定种子 LCG：Math.random 被接管，于是「同一份源码 + 同一颗种子」真的产出同一条序列
  let s = 20261005 >>> 0;
  globalThis.__reseed = () => { s = 20261005 >>> 0; };
  Math.random = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296; };
  return { win, doc, canvas, raf, images, handlers };
}

// ---- 一局的搭建：真进关卡（不是一张静止标题）--------------------------------
async function bootAsync(env, reducedMotion, viewModule) {
  const { createView } = await import(viewModule || `${ROOT}/js/view.js`);
  const { createGame, paint } = await import(`${ROOT}/js/core/game.js`);
  const { randomLot } = await import(`${ROOT}/js/core/make.js`);
  env.raf.length = 0;
  const canvas = env.canvas;
  canvas.width = 0; canvas.height = 0; canvas._ctx = null;
  const game = createGame(randomLot('standard', 20261005));
  const view = createView(canvas, { onToggle: () => {}, onBrush: () => {}, reducedMotion });
  view.setGame(game);
  view.measure();
  paint(game, [1, 2, 3, 4]);
  view.setGame(game, [1, 2]);     // 亮 4 格 + 上膛 2 格金闪 ⇒ 仿真循环持续排帧
  return { view, game };
}

const FIELDS = ['simSteps', 'clockMs', 'flashLeft', 'flashing', 'pulse', 'lit', 'paused', 'motionOff', 'running'];
const snap = (a) => Object.fromEntries(FIELDS.map((f) => [f, Number.isFinite(a[f]) ? Number(a[f].toFixed(9)) : a[f]]));

// 喂 frames 帧（dt = 1000/fps），按到达过的每个 sim 步号存一份快照。
async function ladder(fps, frames, { viewModule, reducedMotion = false, untilStep = Infinity } = {}) {
  const env = makeEnv();
  const { view } = await bootAsync(env, reducedMotion, viewModule);
  const dt = 1000 / fps;
  const seen = new Map();
  let ts = 1000;
  let fed = 0;
  while (fed < frames) {
    const pending = env.raf.splice(0, env.raf.length);
    if (!pending.length) break;
    for (const { cb } of pending) {
      if (fed >= frames) break;
      fed++;
      ts += dt;
      cb(ts);
      const a = view.anim();
      if (!seen.has(a.simSteps)) seen.set(a.simSteps, { ...snap(a), residue: Number(a.accumulatorMs.toFixed(12)), frame: fed });
      if (a.simSteps >= untilStep) return { fps, frames: fed, seen, final: { ...snap(a), residue: Number(a.accumulatorMs.toFixed(12)) } };
    }
  }
  const a = view.anim();
  return { fps, frames: fed, seen, final: { ...snap(a), residue: Number(a.accumulatorMs.toFixed(12)) } };
}

// 口径一：同一 sim 步号上的可见态必须逐字段全等。
async function compareStepsImpl(fpsList = [30, 60, 120], target = 180, opts = {}) {
  const runs = [];
  for (const f of fpsList) runs.push(await ladder(f, 4000, { untilStep: target, ...opts }));
  const sets = runs.map((r) => new Set(r.seen.keys()));
  const common = [...sets[0]].filter((k) => sets.every((s) => s.has(k))).sort((a, b) => a - b);
  const mismatches = [];
  for (const fld of FIELDS) {
    for (const k of common) {
      const vals = runs.map((r) => r.seen.get(k)[fld]);
      if (new Set(vals).size > 1) mismatches.push({ step: k, field: fld, values: vals });
    }
  }
  const residueSpread = Math.max(...common.map((k) => {
    const v = runs.map((r) => r.seen.get(k).residue);
    return Math.max(...v) - Math.min(...v);
  }), 0);
  return { runs, common: common.length, mismatches, residueSpread, verdict: mismatches.length === 0 };
}

// 口径二：定虚拟时长下走出多少步（变异检的靶子在这里 —— 按步号对齐对它是盲的）。
async function compareAtDurationImpl(fpsList = [30, 60, 120], tMs = 3000, opts = {}) {
  const rows = [];
  for (const f of fpsList) {
    const frames = Math.round(tMs / (1000 / f));
    const r = await ladder(f, frames, opts);
    rows.push({ fps: f, frames, steps: r.final.simSteps, clockMs: r.final.clockMs, pulse: r.final.pulse, residue: r.final.residue });
  }
  const steps = rows.map((r) => r.steps);
  const spread = Math.max(...steps) - Math.min(...steps);
  return { rows, spread, expected: Math.round(tMs / SIM_STEP), verdict: spread <= 1 };
}

// 暂停半边：暂停期间累加器不吃帧、animClock 与 simSteps 原地不动。
async function pauseHeldImpl(fpsList = [30, 60, 120], frames = 120) {
  const out = [];
  for (const f of fpsList) {
    const env = makeEnv();
    const { view } = await bootAsync(env, false);
    const a0 = view.anim();
    view.setPaused(true);
    let ts = 1000;
    for (let n = 0; n < frames; n++) {
      const pending = env.raf.splice(0, env.raf.length);
      for (const { cb } of pending) { ts += 1000 / f; cb(ts); }
    }
    const a1 = view.anim();
    out.push({ fps: f, clockMs: a1.clockMs - a0.clockMs, steps: a1.simSteps - a0.simSteps, held: a1.clockMs === a0.clockMs && a1.simSteps === a0.simSteps });
  }
  return out;
}

// 重开半边：reset() 之后时钟、累加器、步号、金闪全归零（只 init() 不清这些会漏呼吸相位）。
// 喂 20 帧（≈333ms < FLASH_MS=460）就复位：金闪必须还活着，否则「flash 归零」是它自己到点散的，
// 不是 reset 清掉的 —— 那正是这类复位最容易蒙过去的地方。
async function resetZeroedImpl() {
  const env = makeEnv();
  const { view } = await bootAsync(env, false);
  let ts = 1000;
  for (let n = 0; n < 20; n++) {
    const pending = env.raf.splice(0, env.raf.length);
    for (const { cb } of pending) { ts += 1000 / 60; cb(ts); }
  }
  const before = view.anim();
  view.reset();
  const after = view.anim();
  return { before, after, zeroed: after.clockMs === 0 && after.simSteps === 0 && after.accumulatorMs === 0 && after.flashing === 0 };
}

// reduceMotion 真分支：动效恒 0，循环自己停下（不是一条还在跑的静图循环）。
async function motionHeldImpl(fpsList = [30, 60, 120], frames = 60) {
  const out = [];
  for (const f of fpsList) {
    const env = makeEnv();
    const { view } = await bootAsync(env, true);
    let ts = 1000;
    for (let n = 0; n < frames; n++) {
      const pending = env.raf.splice(0, env.raf.length);
      for (const { cb } of pending) { ts += 1000 / f; cb(ts); }
    }
    const a = view.anim();
    out.push({ fps: f, pulse: a.pulse, flashing: a.flashing, clockMs: a.clockMs, running: a.running, held: a.pulse === 0 && a.flashing === 0 && a.clockMs === 0 });
  }
  return out;
}

// 变异检：把「仍在吃帧 dt 的那一行」（累加器 accum += elapsed）换成常量，判尺必须变红。
// 简报 §6 的口径：定步长改造完成的仓里，逐粒子位移行拿到的 dt 恒等于 SIM_STEP，改成常量
// 照样绿，那是结构性无关不是尺子空跑 —— 所以靶子钉在累加器上。
async function mutatedViewPathImpl() {
  const src = readFileSync(`${ROOT}/js/view.js`, 'utf8');
  const needle = 'accum += elapsed;';
  if (!src.includes(needle)) throw new Error('变异检找不到靶子行 accum += elapsed —— view.js 的累加器写法变了，判尺要跟着重新对表');
  const mutated = src.replace(needle, 'accum += 1000 / 60;   // MUTANT（阴性对照，只在内存与 tmp 里）')
    .replace(/from '\.\/core\/([a-z]+)\.js'/g, (m, f) => `from '${ROOT}/js/core/${f}.js'`);
  const path = resolve(tmpdir(), `ulam-view-mutant-${createHash('sha256').update(mutated).digest('hex').slice(0, 10)}.mjs`);
  if (!existsSync(path)) writeFileSync(path, mutated);
  return `file://${path}`;
}


// ---- 串行闸门 ---------------------------------------------------------------
// 每个口径都要造一份 DOM 桩并把它装到 globalThis 上（view.js 探 window/document 只有这一条路），
// 于是两个口径并发跑就会互相顶掉后端：A 的 view 排帧排进 B 的队列，读回来的数是交叉污染的。
// test/*.test.mjs 用 harness 的 `test()`，异步体是**并发启动**的，所以这里自己上锁 ——
// 判尺的复现性不能依赖调用方碰巧按顺序 await。
let _chain = Promise.resolve();
const serialized = (fn) => (...args) => {
  const next = _chain.then(() => fn(...args));
  _chain = next.catch(() => {});
  return next;
};
export const compareSteps = serialized(compareStepsImpl);
export const compareAtDuration = serialized(compareAtDurationImpl);
export const pauseHeld = serialized(pauseHeldImpl);
export const resetZeroed = serialized(resetZeroedImpl);
export const motionHeld = serialized(motionHeldImpl);
export const mutatedViewPath = serialized(mutatedViewPathImpl);

if (import.meta.url === `file://${process.argv[1]}`) {
  const steps = await compareSteps();
  console.log(`口径一 同 sim 步号对拍 30/60/120Hz：共同步号 ${steps.common} 个，${steps.mismatches.length} 处字段不一致 ⇒ ${steps.verdict ? '✅' : '❌'}`);
  console.log(`  末态：${steps.runs.map((r) => `${r.fps}Hz 喂${r.frames}帧→${r.final.simSteps}步 clockMs=${r.final.clockMs} pulse=${r.final.pulse} flashLeft=${r.final.flashLeft}`).join('  |  ')}`);
  console.log(`  亚步残余 accumulatorMs 三档极差 = ${steps.residueSpread.toFixed(6)} ms（SIM_STEP=${SIM_STEP.toFixed(6)}，非可见态，按探针边界记账）`);
  const dur = await compareAtDuration();
  console.log(`口径二 定虚拟时长 ${dur.expected * SIM_STEP}ms：${dur.rows.map((r) => `${r.fps}Hz=${r.steps}步`).join('  ')} 极差=${dur.spread} 步 ⇒ ${dur.verdict ? '✅ 与帧率无关' : '❌ 帧率依赖确证'}`);
  const path = await mutatedViewPath();
  const mut = await compareAtDuration([30, 60, 120], 3000, { viewModule: path });
  console.log(`阴性对照 accum += 1000/60：${mut.rows.map((r) => `${r.fps}Hz=${r.steps}步`).join('  ')} 极差=${mut.spread} 步 ⇒ ${mut.verdict ? '❌ 尺子空跑' : '✅ 变红，判尺有效'}`);
  const base = steps.runs[0].final;
  console.log(`暂停：${(await pauseHeld()).map((r) => `${r.fps}Hz Δclock=${r.clockMs} Δsteps=${r.steps}`).join('  ')}`);
  const rz = await resetZeroed();
  console.log(`重开复位：reset 前 clock=${rz.before.clockMs.toFixed(1)} steps=${rz.before.simSteps} flash=${rz.before.flashing} → 后 clock=${rz.after.clockMs} steps=${rz.after.simSteps} accum=${rz.after.accumulatorMs} flash=${rz.after.flashing}`);
  console.log(`reduceMotion：${(await motionHeld()).map((r) => `${r.fps}Hz pulse=${r.pulse} flash=${r.flashing} clock=${r.clockMs} running=${r.running}`).join('  ')}`);
  console.log(`基准末态参考：${JSON.stringify(base)}`);
}
