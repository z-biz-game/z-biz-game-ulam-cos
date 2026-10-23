// 画布与指针：这一层只管像素和手势，不判断合法性。
//
// 一次拖动把"亮哪些格子"交给 js/main.js，由 js/core/game.js 决定这一问能不能问出去。所以画面
// 可以落后于规则，但永远不会画出规则不允许的一步（tango 的 view.js 是同一条规矩）。
//
// 屏幕上没有一个像素是装饰：
//   * 格子的底色 = 这一格被反驳了几次（contra 计数），从"干净"到"已经没谎可撒"是一条色阶；
//   * 边框亮起 = 玩家正把它算进这一问（亮框随定步长时钟呼吸，见下面的 dt 契约）；
//   * 顶部的 k 个槽 = 谎言账本，点亮几个 = **玩家能证明的**谎数下界（不是对手实际撒了几个，
//     那个数要到结案才摊开），所以它只会在真的能证明时前进；
//   * 结案时活下来的格子发光，秘密那格盖一张 assets/art/secret-seal.png 的印。
// 颜色全部从 css/game.css 的 token 里读，所以换配色不需要动这个文件。位图也一样：盘底纹理是
// assets/art/board-grain.png（gen_art.py 产的无缝贴图），缺图就退回矢量画法，不空屏。
//
// dt 契约（本仓唯一的逐帧仿真就是这一段）：
//   帧回调只把墙上时间喂进累加器 `accum += elapsed`，仿真按固定步长 SIM_STEP 走，
//   于是不管 30/60/120Hz，同一虚拟时长走的是同一条状态序列。呼吸相位、闪光剩余毫秒
//   都从 animClock 派生，绝不出现 `+= 0.08` 这种只在 60Hz 成立的写法。
//   暂停 = advance() 直接 return：累加器不吃帧，animClock 与 simSteps 原地不动。
//   prefers-reduced-motion = 呼吸与闪光都关掉，循环停在静图（见 motionOff）。
//
// 导出的 `cellPoint` / `ledgerPoint` / `pixelOf` 是给 tools/playtest.mjs 的探针：
// 前者把格子坐标换算成客户区坐标（点击处理里那个映射的正向版本），后者直接回读画布像素，
// 于是"亮起来"这件事是被真的像素证明的，不是被一个 class 名断言的。

import { total } from './core/state.js';
import { state as gameState, provableLies, questionsLeft, witnesses } from './core/game.js';

const PAD = 14;
const SIM_STEP = 1000 / 60;   // 一仿真步的毫秒数：定步长，帧率只决定一步喂几次
const FLASH_MS = 460;         // 刚被推高一格的格子金闪多久
const PULSE_MS = 2400;        // 亮框一次呼吸的周期
const HIT_MIN = 44;           // 触摸命中区下限（CSS 像素），小格子向外扩到这条线

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function tokens() {
  const css = typeof getComputedStyle === 'function' && typeof document !== 'undefined'
    ? getComputedStyle(document.documentElement)
    : null;
  const get = (name, fallback) => (css ? (css.getPropertyValue(name) || '').trim() || fallback : fallback);
  return {
    ink: get('--ulam-ink', '#e7ecf2'),
    dim: get('--ulam-ink-dim', 'rgba(231,236,242,0.42)'),
    plate: get('--ulam-plate', 'rgba(255,255,255,0.04)'),
    cell: get('--ulam-cell', 'rgba(255,255,255,0.06)'),
    lit: get('--ulam-lit', '#3ddad7'),
    heat: [
      get('--ulam-heat-0', 'rgba(61,218,215,0.16)'),
      get('--ulam-heat-1', 'rgba(240,181,68,0.30)'),
      get('--ulam-heat-2', 'rgba(235,120,80,0.40)'),
      get('--ulam-heat-3', 'rgba(214,72,128,0.48)'),
    ],
    dead: get('--ulam-dead', 'rgba(231,236,242,0.10)'),
    gold: get('--ulam-accent', '#f0b544'),
    win: get('--ulam-good', '#7fd88f'),
  };
}

// 位图资产：相对页面 URL 解析（Pages 把仓挂在路径前缀下），拿不到就永远不赋值，
// 于是 draw() 走矢量回落 —— 少一层质感，绝不少一块盘。
function loadArt(ctx, onReady) {
  const out = { grain: null, seal: null };
  if (typeof Image !== 'function') return out;
  const base = (typeof document !== 'undefined' && document.baseURI) || null;
  const href = (p) => (base ? new URL(p, base).href : p);
  const grab = (path, done) => {
    const im = new Image();
    im.onload = () => { done(im); onReady(); };
    im.onerror = () => { /* 资产缺席 = 回落，不是错误 */ };
    im.src = href(path);
  };
  grab('assets/art/board-grain.png', (im) => {
    try { out.grain = ctx.createPattern(im, 'repeat'); } catch (err) { out.grain = null; }
  });
  grab('assets/art/secret-seal.png', (im) => { out.seal = im; });
  return out;
}

export function createView(canvas, { onToggle, onBrush, reducedMotion = false } = {}) {
  const ctx = canvas.getContext('2d');
  const T = tokens();
  let game = null;
  let geo = { cell: 40, gap: 8, cols: 1, rows: 1, ox: PAD, oy: PAD, ledger: 18, w: 320, h: 320 };
  let flash = new Map();     // id -> 已经闪了多少毫秒（定步长推进，不是每帧 +0.08）
  let raf = 0;
  let press = null;          // { anchor, added, moved }
  let paused = false;
  let motionOff = !!reducedMotion;

  // ---- 仿真时钟（本仓唯一的逐帧状态）-------------------------------------
  let animClock = 0;         // 已推进的仿真毫秒；暂停时不涨
  let accum = 0;             // 帧 dt 的累加器 —— 阴性对照就钉在这一行的消费方上
  let simSteps = 0;          // 定步长走了几步
  let lastTs = 0;            // 0 是"还没取到上一帧"的哨兵，不是第 0 毫秒

  const art = loadArt(ctx, () => { if (!raf) schedule(); });

  function pulsePhase() {
    return motionOff ? 0 : (animClock % PULSE_MS) / PULSE_MS;
  }

  function anim() {
    return {
      clockMs: animClock,
      simSteps,
      accumulatorMs: accum,
      flashLeft: flash.size ? Math.max(...[...flash.values()].map((ms) => FLASH_MS - ms)) : 0,
      flashing: flash.size,
      pulse: pulsePhase(),
      paused,
      motionOff,
      lit: game ? game.draft.length : 0,
      running: !!raf,
      art: { grain: !!art.grain, seal: !!art.seal },
    };
  }

  function step(s) {
    animClock += s;
    simSteps++;
    for (const [id, ms] of flash) {
      const t = ms + s;
      if (t >= FLASH_MS) flash.delete(id);
      else flash.set(id, t);
    }
  }

  // 帧 dt 只进累加器；仿真按 SIM_STEP 走。暂停 ⇒ 一行都不推进（累加器也不吃这一帧）。
  function advance(elapsed) {
    if (paused) return;
    accum += elapsed;
    let guard = 0;
    while (accum >= SIM_STEP && guard++ < 8) {
      step(SIM_STEP);
      accum -= SIM_STEP;
    }
    if (guard >= 8) accum = 0;      // 追不上就丢掉积压，绝不一次补画八步
  }

  function needsFrame() {
    if (paused || motionOff) return false;
    return flash.size > 0 || (game && game.draft.length > 0 && !game.done);
  }

  function schedule() {
    if (!raf && typeof window !== 'undefined' && window.requestAnimationFrame) raf = window.requestAnimationFrame(frame);
  }

  function frame(ts) {
    raf = 0;
    const now = Number.isFinite(ts) ? ts : (typeof performance !== 'undefined' ? performance.now() : 0);
    let elapsed = lastTs ? now - lastTs : 0;
    lastTs = now;
    if (elapsed < 0) elapsed = 0;
    if (elapsed > 50) elapsed = 50;   // 后台标签页回来不补画一屏
    advance(elapsed);
    draw();
    if (needsFrame()) schedule();
  }

  function measure() {
    const box = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    const W = Math.max(220, Math.round(box.width));
    const H = Math.max(240, Math.round(box.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = game ? game.n : 4;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    const rows = Math.max(1, Math.ceil(n / cols));
    const ledgerH = 34;
    const avail = Math.min((W - PAD * 2) / cols, (H - PAD * 2 - ledgerH) / rows);
    const cell = Math.max(18, Math.min(72, Math.floor(avail) - 8));
    const gap = Math.max(4, Math.round(cell * 0.18));
    geo = {
      cell,
      gap,
      cols,
      rows,
      ox: Math.round((W - (cols * (cell + gap) - gap)) / 2),
      oy: Math.round(PAD + ledgerH),
      ledger: ledgerH,
      w: W,
      h: H,
    };
    draw();
  }

  function cellXY(id) {
    const i = id - 1;
    const c = i % geo.cols;
    const r = Math.floor(i / geo.cols);
    return {
      x: geo.ox + c * (geo.cell + geo.gap),
      y: geo.oy + r * (geo.cell + geo.gap),
      w: geo.cell,
      h: geo.cell,
    };
  }

  // 命中区不小于 HIT_MIN：格子被挤小时向外借，重叠时取中心最近的那一格。
  function cellAt(p) {
    const pad = Math.max(geo.gap / 2, (HIT_MIN - geo.cell) / 2);
    let best = 0;
    let bestD = Infinity;
    for (let id = 1; id <= (game ? game.n : 0); id++) {
      const b = cellXY(id);
      if (p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad) {
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
        if (d < bestD) { bestD = d; best = id; }
      }
    }
    return best;
  }

  function localPoint(ev) {
    const box = canvas.getBoundingClientRect();
    // CSS 缩放换算：一律走 clientX/clientY 减盒子左上角，绝不用 offsetX/line（缩放页面上会点 A 打 B）
    return { x: ev.clientX - box.left, y: ev.clientY - box.top };
  }

  function idsInRect(a, b) {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const out = [];
    for (let id = lo; id <= hi; id++) out.push(id);
    return out;
  }

  function down(ev) {
    if (!game || game.done || paused) return;
    const id = cellAt(localPoint(ev));
    if (!id) return;
    press = { anchor: id, added: !game.draft.includes(id), moved: false };
    ev.preventDefault();
  }

  function move(ev) {
    if (!press) return;
    const id = cellAt(localPoint(ev));
    if (!id || id === press.anchor) return;
    press.moved = true;
    if (onBrush) onBrush(idsInRect(press.anchor, id), press.added);
    ev.preventDefault();
  }

  function up(ev) {
    if (!press) return;
    const wasDrag = press.moved;
    const anchor = press.anchor;
    press = null;
    if (!wasDrag && onToggle) onToggle(anchor);
    else if (wasDrag) draw();
    if (ev && ev.preventDefault) ev.preventDefault();
  }

  // pointerdown 优先；没有 PointerEvent 的环境（老 Safari / iOS ≤12）回落 touch* + mouse*。
  const HAS_POINTER = typeof window !== 'undefined' && 'PointerEvent' in window;
  const touchPoint = (ev) => {
    const t = (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]) || ev;
    return { clientX: t.clientX, clientY: t.clientY, preventDefault: () => ev.preventDefault() };
  };
  if (HAS_POINTER) {
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    canvas.addEventListener('pointerleave', () => { if (press) { press = null; } });
  } else {
    canvas.addEventListener('touchstart', (ev) => down(touchPoint(ev)), { passive: false });
    canvas.addEventListener('touchmove', (ev) => move(touchPoint(ev)), { passive: false });
    window.addEventListener('touchend', (ev) => up(touchPoint(ev)));
    canvas.addEventListener('mousedown', down);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function drawLedger() {
    if (!game) return;
    const r = Math.min(13, Math.max(8, Math.round(geo.cell * 0.3)));
    const spent = provableLies(game);
    const k = game.k;
    const y = PAD + r;
    let x = geo.ox;
    ctx.font = `${Math.max(10, Math.round(r * 0.95))}px ui-monospace, "SF Mono", monospace`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = T.dim;
    ctx.fillText(`谎账本 ${spent}/${k}`, x, y);
    x += ctx.measureText(`谎账本 ${spent}/${k}`).width + 10;
    for (let i = 0; i < k; i++) {
      const burnt = i < spent;
      ctx.beginPath();
      ctx.arc(x + r, y, r * 0.82, 0, Math.PI * 2);
      ctx.fillStyle = burnt ? T.gold : 'rgba(255,255,255,0.07)';
      ctx.fill();
      ctx.lineWidth = burnt ? 0 : 1.5;
      ctx.setLineDash(burnt ? [] : [3, 3]);
      ctx.strokeStyle = T.dim;
      ctx.stroke();
      ctx.setLineDash([]);
      x += r * 2.6;
    }
    const left = questionsLeft(game);
    ctx.fillStyle = T.dim;
    ctx.textAlign = 'right';
    ctx.fillText(`还剩 ${left} 问`, geo.ox + geo.cols * (geo.cell + geo.gap) - geo.gap, y);
    ctx.textAlign = 'left';
  }

  function drawCell(id, a, aliveSet, litSet, pulse) {
    const b = cellXY(id);
    const c = game.contra[id];
    const dead = c > game.k;
    const heat = T.heat[Math.min(c, T.heat.length - 1)];
    const f = flash.has(id) ? flash.get(id) / FLASH_MS : 0;
    ctx.save();
    ctx.fillStyle = dead ? T.dead : heat;
    roundRect(ctx, b.x, b.y, b.w, b.h, 8);
    ctx.fill();
    if (f > 0) {
      ctx.globalAlpha = 0.55 * (1 - f);
      ctx.fillStyle = T.gold;
      roundRect(ctx, b.x, b.y, b.w, b.h, 8);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (litSet.has(id)) {
      // 呼吸：相位来自 animClock，所以 30/60/120Hz 在同一虚拟时刻画同一道边框
      ctx.strokeStyle = T.lit;
      ctx.lineWidth = 2 + 1.6 * pulse;
      ctx.globalAlpha = 0.72 + 0.28 * pulse;
      roundRect(ctx, b.x + 1.5, b.y + 1.5, b.w - 3, b.h - 3, 7);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(61,218,215,0.16)';
      roundRect(ctx, b.x, b.y, b.w, b.h, 8);
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(231,236,242,0.14)';
      ctx.lineWidth = 1;
      roundRect(ctx, b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, 7);
      ctx.stroke();
    }
    if (game.done) {
      if (id === game.secret) {
        if (art.seal) {
          const s = b.w * 1.02;
          ctx.globalAlpha = 0.95;
          ctx.drawImage(art.seal, b.x + (b.w - s) / 2, b.y + (b.h - s) / 2, s, s);
          ctx.globalAlpha = 1;
        } else {
          ctx.strokeStyle = game.won ? T.win : '#d64880';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(b.x + b.w / 2, b.y + b.h / 2, b.w * 0.44, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else if (!dead && aliveSet.has(id)) {
        ctx.strokeStyle = 'rgba(127,216,143,0.55)';
        ctx.lineWidth = 2;
        roundRect(ctx, b.x + 3, b.y + 3, b.w - 6, b.h - 6, 6);
        ctx.stroke();
      }
    }
    ctx.fillStyle = dead ? T.dead : T.ink;
    ctx.textAlign = 'center';
    ctx.font = `600 ${Math.round(b.w * 0.38)}px ui-monospace, "SF Mono", monospace`;
    ctx.fillText(String(id), b.x + b.w / 2, b.y + b.h / 2 + 1);
    if (c > 0) {
      ctx.fillStyle = dead ? T.dead : T.gold;
      ctx.font = `${Math.round(b.w * 0.22)}px ui-monospace, monospace`;
      ctx.fillText(dead ? '出局' : `${c}矛盾`, b.x + b.w / 2, b.y + b.h - Math.round(b.h * 0.16));
    }
    if (game.done && game.accused === id) {
      ctx.strokeStyle = T.gold;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(b.x + 4, b.y + 4);
      ctx.lineTo(b.x + b.w - 4, b.y + b.h - 4);
      ctx.stroke();
    }
    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, geo.w, geo.h);
    ctx.fillStyle = T.plate;
    roundRect(ctx, 4, 4, geo.w - 8, geo.h - 8, 12);
    ctx.fill();
    if (art.grain) {
      // 盘底纹理：无缝贴图的振幅只有 0..26/255，压在格子底下，不改变任何一格的读数语义
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = art.grain;
      roundRect(ctx, 4, 4, geo.w - 8, geo.h - 8, 12);
      ctx.fill();
      ctx.restore();
    }
    if (!game) return;
    drawLedger();
    const a = gameState(game);
    const litSet = new Set(game.draft);
    const aliveSet = new Set(game.done ? witnesses(game) : []);
    const pulse = 0.5 + 0.5 * Math.sin(pulsePhase() * Math.PI * 2);
    for (let id = 1; id <= game.n; id++) drawCell(id, a, aliveSet, litSet, pulse);
    ctx.fillStyle = T.dim;
    ctx.font = `12px ui-monospace, monospace`;
    ctx.fillText(`候选 ${total(a)} · ${a.map((v, i) => `${v}×${i}矛盾`).join(' ')} · 亮 ${game.draft.length}`,
      geo.ox, geo.oy + geo.rows * (geo.cell + geo.gap) + 10);
    if (paused) {
      ctx.fillStyle = 'rgba(8,12,16,0.62)';
      roundRect(ctx, 4, 4, geo.w - 8, geo.h - 8, 12);
      ctx.fill();
      ctx.fillStyle = T.ink;
      ctx.textAlign = 'center';
      ctx.font = `600 ${Math.max(16, Math.round(geo.cell * 0.5))}px ui-monospace, monospace`;
      ctx.fillText('已暂停', geo.w / 2, geo.h / 2);
      ctx.textAlign = 'left';
    }
  }

  function reset() {
    // 重开要把时钟、累加器、步号、闪光、按压态全部归零 —— 只调 init() 不清这些，
    // 下一局会继承上一局的呼吸相位与金闪。
    animClock = 0;
    accum = 0;
    simSteps = 0;
    lastTs = 0;
    flash = new Map();
    press = null;
    paused = false;
    if (raf && typeof window !== 'undefined' && window.cancelAnimationFrame) window.cancelAnimationFrame(raf);
    raf = 0;
  }

  return {
    setGame(g, changed = []) {
      const was = game;
      game = g;
      // 换局清空；`changed` 非空就重新上膛（commit 传进来的是同一个 g 对象，
      // 按 `was !== g` 判会让金闪永远画不出来 —— 这是 dt 重写之前就存在的缺陷）；
      // 空 list 不动已经在跑的闪光，否则紧随其后的 render() 会把它当场抹掉。
      if (was !== g) flash = new Map();
      if (changed.length && !motionOff) flash = new Map(changed.map((id) => [id, 0]));
      if (needsFrame()) schedule();
      else draw();
    },
    // 暂停的画布半边：仿真停摆（advance 直接 return），画面留一版带"已暂停"的静图。
    setPaused(on) {
      paused = !!on;
      lastTs = 0;                 // 恢复时不把暂停期间走过的墙钟算成一帧
      if (paused && raf && typeof window !== 'undefined' && window.cancelAnimationFrame) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
      if (!paused && needsFrame()) schedule();
      draw();
      return paused;
    },
    paused: () => paused,
    setReducedMotion(on) {
      motionOff = !!on;
      if (motionOff) flash = new Map();
      if (needsFrame()) schedule();
      draw();
      return motionOff;
    },
    anim,
    reset,
    measure,
    draw,
    geom() {
      return { ...geo, n: game ? game.n : 0, hitPad: Math.max(geo.gap / 2, (HIT_MIN - geo.cell) / 2) };
    },
    // ---- 给 tools/playtest.mjs 的探针 ----
    cellPoint(id) {
      const b = cellXY(id);
      const box = canvas.getBoundingClientRect();
      return {
        x: Math.round(box.left + b.x + b.w / 2),
        y: Math.round(box.top + b.y + b.h / 2),
        cell: b.w,
      };
    },
    // 某格中心的实际像素（0-255）：测试用它断言"亮了"和"变色了"。
    pixelOf(id) {
      const b = cellXY(id);
      const dpr = canvas.width / geo.w;
      const px = Math.round((b.x + b.w / 2) * dpr);
      const py = Math.round((b.y + b.h * 0.22) * dpr);
      const d = ctx.getImageData(px, py, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    },
    ledgerPoint(i) {
      const box = canvas.getBoundingClientRect();
      const r = Math.min(13, Math.max(8, Math.round(geo.cell * 0.3)));
      return { x: Math.round(box.left + geo.ox + 90 + i * r * 2.6 + r), y: Math.round(box.top + PAD + r) };
    },
  };
}
