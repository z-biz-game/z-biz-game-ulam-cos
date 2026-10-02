// 声音：唯一能碰 AudioContext 的地方，且只在"真的该出声"时才建节点。
//
// 两条判据靠这个文件成立，不是靠字符串：
//   * **静音是真静音** —— setMuted(true) 走 `ctx.suspend()`（时钟停摆，已排队的包不再推进），
//     并且 play() 在静音态**直接 return**：一个振荡器节点都不新建。只把 gain 设 0 是假静音，
//     节点照建、回调照跑，静音时 `nodes` 计数会涨——test/state.test.mjs 钉的就是这个计数。
//   * **暂停期间不出声** —— 外壳在暂停时不调 play()，同时 suspend() 让残留的尾音冻住而不是拖出去。
//
// 没有 AudioContext 的环境（node --test、被禁用的浏览器、file:// 的一部分）里整套 API 都必须
// 安静地降级成 no-op，并且**不抛**：游戏永远可以玩，声音是附加物。

const VOL_SCALE = 0.55;

// 每个音色 = 一串 (freq, at, dur, type, gain)。写死在这里，是为了让"同一事件同一声音"
// 与 js/core/game.js 的确定性一致：不问随机，不读时钟。
const VOICES = {
  tap: [[520, 0, 0.05, 'triangle', 0.20]],
  lit: [[660, 0, 0.06, 'triangle', 0.16], [880, 0.045, 0.06, 'triangle', 0.10]],
  askYes: [[392, 0, 0.10, 'sine', 0.24], [588, 0.08, 0.14, 'sine', 0.18]],
  askNo: [[294, 0, 0.12, 'sine', 0.24], [220, 0.10, 0.16, 'sine', 0.18]],
  lie: [[160, 0, 0.16, 'sawtooth', 0.16], [120, 0.10, 0.20, 'sawtooth', 0.12]],
  win: [[523, 0, 0.10, 'sine', 0.22], [659, 0.09, 0.10, 'sine', 0.22], [784, 0.18, 0.22, 'sine', 0.24]],
  lose: [[330, 0, 0.14, 'triangle', 0.20], [262, 0.12, 0.26, 'triangle', 0.20]],
  ui: [[740, 0, 0.04, 'square', 0.08]],
};

export function createSound() {
  let ctx = null;
  let master = null;
  let muted = false;
  let volume = 0.7;
  let nodes = 0;        // 真建过的振荡器数：静音态必须不涨，这是"真静音"的证据
  let suspends = 0;
  let resumes = 0;
  let lastError = null;

  function Ctor() {
    return typeof AudioContext !== 'undefined' ? AudioContext
      : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null);
  }

  function ensure() {
    if (ctx || muted) return ctx;         // 静音态连 context 都不新建：suspend 一个没建的东西没有意义
    const AC = Ctor();
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volume * VOL_SCALE;
      master.connect(ctx.destination);
    } catch (err) {
      lastError = String(err && err.message || err);
      ctx = null;
      master = null;
    }
    return ctx;
  }

  function play(name) {
    if (muted) return false;              // 静音 = 零节点，不是零音量
    const spec = VOICES[name];
    if (!spec) return false;
    const c = ensure();
    if (!c) return false;
    if (c.state === 'suspended' && c.resume) { resumes++; c.resume().catch(() => {}); }
    const t0 = c.currentTime;
    for (const [freq, at, dur, type, gain] of spec) {
      try {
        const osc = c.createOscillator();
        const env = c.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t0 + at);
        env.gain.setValueAtTime(0.0001, t0 + at);
        env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * volume * VOL_SCALE), t0 + at + 0.012);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
        osc.connect(env);
        env.connect(master);
        osc.start(t0 + at);
        osc.stop(t0 + at + dur + 0.02);
        nodes++;
      } catch (err) {
        lastError = String(err && err.message || err);
      }
    }
    return true;
  }

  return {
    play,
    voices: Object.keys(VOICES),
    setMuted(on) {
      muted = !!on;
      if (muted) {
        // 真停：挂起上下文，尾音不再推进；不销毁 ctx，所以解除静音是 resume 而不是重建。
        if (ctx && ctx.suspend) { suspends++; ctx.suspend().catch(() => {}); }
      } else if (ctx && ctx.resume) {
        resumes++;
        ctx.resume().catch(() => {});
      }
      return muted;
    },
    muted: () => muted,
    setVolume(v) {
      const n = Number(v);
      volume = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : volume;
      if (master && master.gain) master.gain.value = volume * VOL_SCALE;
      return volume;
    },
    volume: () => volume,
    // 暂停/恢复的音频半边：静音优先于暂停（静音时本来就该是 suspend 态）
    suspend() {
      if (!ctx || muted || !ctx.suspend) return false;
      suspends++;
      ctx.suspend().catch(() => {});
      return true;
    },
    resume() {
      if (!ctx || muted || !ctx.resume) return false;
      resumes++;
      ctx.resume().catch(() => {});
      return true;
    },
    state() {
      return {
        muted, volume, nodes, suspends, resumes,
        ctx: ctx ? (ctx.state || 'unknown') : 'none',
        hasAudioContext: !!Ctor(),
        lastError,
      };
    },
  };
}

// 单例：外壳与测试读的是同一份计数（"整局静音 ⇒ nodes 不涨"必须能被外部证明）。
export const sound = createSound();
