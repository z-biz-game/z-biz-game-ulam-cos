// test/anim.test.mjs — 定步长仿真的帧率无关性，不带浏览器。
//
// 为什么这条套件必须存在于仓里：官方量具 cos_frame_probe.js 用 vm.runInContext 装载脚本，
// 进不了 ES module —— 本仓实测三档全报 `Cannot use import statement outside a module`，
// 判语停在「结论：无法比对」。简报 §3 把这种档位明确判为不通过，要求「靠自己的 harness 补判」。
// 补判一次不够：`accum += elapsed` 被人改成 `accum += 1000/60` 之后，页面看上去照常跑，
// 只是 30Hz 的手感变成半速 —— 只有把判据留在 CI 里，这条不变式才是 invariant 而不是传闻。
//
// 环境桩在 tools/anim_probe.mjs（最小 DOM/画布/指针桩 + 定种子 LCG），这里只押判据。
// 两个口径都要跑，因为各自会漏另一种缺陷：按 sim 步号对齐看不见「每单位墙钟走几步」，
// 按虚拟时长对齐又会被 1000/60 的浮点零头判出假红（所以它的容差是 1 步）。
import { test, ok, eq, run } from '../tools/harness.mjs';
import {
  SIM_STEP, compareSteps, compareAtDuration, pauseHeld, resetZeroed, motionHeld, mutatedViewPath,
} from '../tools/anim_probe.mjs';

const FPS = [30, 60, 120];

test('同一 sim 步号上，30/60/120Hz 的可见态逐字段全等', async () => {
  const r = await compareSteps(FPS, 180);
  eq(r.common, 90, '三档共同走到的步号数（30Hz 每帧两步，奇数步号天然不落在帧边界上）');
  ok(r.mismatches.length === 0, `字段不一致 ${JSON.stringify(r.mismatches.slice(0, 3))}`);
  for (const run_ of r.runs) eq(run_.final.simSteps, 180, `${run_.fps}Hz 应走到第 180 步`);
});

test('每一步的长度恒等于 SIM_STEP：定步长的定义性不变式', async () => {
  const r = await compareSteps(FPS, 120);
  for (const one of r.runs) {
    for (const k of [...one.seen.keys()]) {
      const s = one.seen.get(k);
      ok(Math.abs(s.clockMs - k * SIM_STEP) < 1e-6, `${one.fps}Hz 第 ${k} 步 clockMs=${s.clockMs} 应为 ${(k * SIM_STEP).toFixed(6)}`);
    }
  }
});

test('定虚拟时长 3000ms：三档走出的步数最年多差 1 步（一阶采样滞后的上界）', async () => {
  const d = await compareAtDuration(FPS, 3000);
  eq(d.expected, 180, '3000ms 该是 180 步');
  ok(d.spread <= 1, `步号极差 ${d.spread} 应 ≤1；读数 ${JSON.stringify(d.rows)}`);
});

test('阴性对照：累加器改吃常量，判尺必须变红', async () => {
  const path = await mutatedViewPath();
  const mut = await compareAtDuration(FPS, 3000, { viewModule: path });
  ok(mut.spread > 1, `尺子空跑了：变异后极差只有 ${mut.spread}，读数 ${JSON.stringify(mut.rows)}`);
  // 按步号对齐对这条变异是盲的（状态序列按步号永远同构）—— 记在这里，防止有人把口径一
  // 当成唯一判据后以为「全等」就等于「帧率无关」。
  const blind = await compareSteps(FPS, 180, { viewModule: path });
  ok(blind.mismatches.length === 0, '口径一看不见这条变异（已知盲区，故两条口径并存）');
});

test('暂停期间仿真一步不走：三档各喂 120 帧，时钟与步号原地不动', async () => {
  const p = await pauseHeld(FPS, 120);
  for (const one of p) {
    eq(one.clockMs, 0, `${one.fps}Hz 暂停后 animClock 仍在涨`);
    eq(one.steps, 0, `${one.fps}Hz 暂停后 simSteps 仍在涨`);
    ok(one.held, `${one.fps}Hz 没停住`);
  }
});

test('重开把时钟、累加器、步号、金闪一起归零（复位前金闪必须还活着）', async () => {
  const r = await resetZeroed();
  ok(r.before.flashing > 0, `复位前金闪已经是 0，这条断言就退化成「等它自己散掉」：${JSON.stringify(r.before)}`);
  ok(r.before.simSteps > 0 && r.before.clockMs > 0, '复位前时钟确实走过');
  ok(r.zeroed, `reset 后没归零：${JSON.stringify(r.after)}`);
  eq(r.after.clockMs, 0); eq(r.after.simSteps, 0); eq(r.after.accumulatorMs, 0); eq(r.after.flashing, 0);
});

test('reduceMotion 是静图而不是慢图：动效恒 0，循环自己停下', async () => {
  const m = await motionHeld(FPS, 60);
  for (const one of m) {
    eq(one.pulse, 0, `${one.fps}Hz 呼吸相位还在动`);
    eq(one.flashing, 0, `${one.fps}Hz 金闪没关`);
    eq(one.clockMs, 0, `${one.fps}Hz 仿真时钟仍在走`);
    eq(one.running, false, `${one.fps}Hz 循环没停下来（静图也逐帧重画 = 白烧电）`);
    ok(one.held);
  }
});

run();
