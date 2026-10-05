// test/sound.test.mjs — 「真静音」的证据，不带浏览器。
//
// 这一条为什么值得单独钉：把 gain 设成 0 也叫「静音」，字符串扫描与 HUD 文案都看不出区别，
// 但 AudioContext 还在跑、振荡器还在建、尾音还在推进 —— 简报 §2 点名的就是这个区别。
// 所以这里断言的不是「没声音」，而是**节点数不涨、上下文被挂起、解除时是 resume 而不是重建**。
//
// 造假的 AudioContext 是刻意的：不启动真实音频设备（CI 上没有，也不该有），但接口形状与真实
// 的一样（state / currentTime / createGain / createOscillator / suspend / resume），
// 并且把「建过几个上下文」记下来 —— 那正是「重建 vs 复用」的唯一可观测量。
import { test, ok, eq, run } from '../tools/harness.mjs';

let built = 0;      // 新建过几个 AudioContext：解除静音必须是 resume 而不是再建一个
let suspends = 0;
let resumes = 0;

class FakeAudioContext {
  constructor() {
    built++;
    this.state = 'running';
    this.currentTime = 0;
    this.destination = { connect() {} };
    this.oscillators = 0;
  }
  createGain() {
    return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} };
  }
  createOscillator() {
    this.oscillators++;
    return { type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {}, start() {}, stop() {} };
  }
  suspend() { suspends++; this.state = 'suspended'; return Promise.resolve(); }
  resume() { resumes++; this.state = 'running'; return Promise.resolve(); }
}

globalThis.AudioContext = FakeAudioContext;
const { createSound } = await import('../js/core/sound.js');
const VOICES = ['tap', 'lit', 'askYes', 'askNo', 'lie', 'win', 'lose', 'ui'];

function fresh() {
  built = 0; suspends = 0; resumes = 0;
  return createSound();
}

test('打开声音时才会建上下文，且每种音色真的排出了振荡器', () => {
  const s = fresh();
  eq(s.state().ctx, 'none', '没发声之前不该有 AudioContext');
  eq(s.play('tap'), true);
  eq(built, 1, '第一次 play 建且只建一个上下文');
  ok(s.state().nodes > 0, `nodes 应大于 0，实测 ${s.state().nodes}`);
  eq(s.state().ctx, 'running');
});

test('setMuted(true) 是挂起上下文，不是把 gain 调小', () => {
  const s = fresh();
  VOICES.forEach((v) => s.play(v));
  s.setMuted(true);
  eq(s.state().muted, true);
  eq(s.state().ctx, 'suspended', `静音后上下文状态应为 suspended，实测 ${s.state().ctx}`);
  eq(suspends, 1, 'setMuted 应恰好调用一次 ctx.suspend()');
});

test('静音期间一个振荡器都不许新建（假静音就是这么露馅的）', () => {
  const s = fresh();
  VOICES.forEach((v) => s.play(v));
  const before = s.state().nodes;
  ok(before > 0, '前置条件：静音前已经建过节点');
  s.setMuted(true);
  for (let i = 0; i < 4; i++) VOICES.forEach((v) => s.play(v));
  eq(s.state().nodes, before, `静音态 play() 建了 ${s.state().nodes - before} 个新振荡器`);
  eq(s.play('win'), false, '静音态 play() 必须返回 false');
});

test('开局就是静音：连 AudioContext 都不该被构造', () => {
  const s = fresh();
  s.setMuted(true);
  eq(built, 0, '静音态没有上下文可挂起，所以也不该新建一个');
  VOICES.forEach((v) => s.play(v));
  eq(built, 0, '静音期间仍不建上下文');
  eq(s.state().nodes, 0);
  eq(s.state().lastError, null, '降级要安静，但不能抛');
});

test('解除静音走 resume，复用同一个上下文，然后立刻能出声', () => {
  const s = fresh();
  s.play('tap');
  s.setMuted(true);
  s.setMuted(false);
  eq(built, 1, `解除静音不该重建上下文（建了 ${built} 个）`);
  eq(resumes, 1, '应恰好一次 ctx.resume()');
  eq(s.state().ctx, 'running');
  const before = s.state().nodes;
  s.play('win');
  ok(s.state().nodes > before, `解除静音后必须还能发声：${before} -> ${s.state().nodes}`);
});

test('静音优先于暂停：静音态的 suspend()/resume() 返回 false 且不碰上下文', () => {
  const s = fresh();
  s.play('lit');
  s.setMuted(true);
  const susp = suspends; const res = resumes;
  eq(s.suspend(), false, '已经静音还去 suspend 是多余的一次挂起');
  eq(s.resume(), false, '静音期间 resume 会把声音放出来，必须拒绝');
  eq(suspends, susp); eq(resumes, res);
  eq(s.state().ctx, 'suspended');
  eq(s.suspend(), false, '静音优先：暂停的挂起动作全程被静音这一层挡掉');
});

test('暂停的音频半边：未静音时 suspend/resume 成对，恢复后状态回到 running', () => {
  const s = fresh();
  s.play('tap');
  eq(s.suspend(), true);
  eq(s.state().ctx, 'suspended');
  eq(s.resume(), true);
  eq(s.state().ctx, 'running');
  eq(suspends, 1); eq(resumes, 1);
});

test('音量夹在 0..1，且非法输入不改变现值', () => {
  const s = fresh();
  eq(s.setVolume(2), 1);
  eq(s.setVolume(-1), 0);
  eq(s.setVolume(0.4), 0.4);
  eq(s.setVolume('loud'), 0.4, 'NaN 音量不许把现值冲掉');
});

run();
