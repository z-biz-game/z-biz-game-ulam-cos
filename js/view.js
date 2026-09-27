// 画布与指针：这一层只管像素和手势，不判断合法性。
//
// 一次拖动把"亮哪些格子"交给 js/main.js，由 js/core/game.js 决定这一问能不能问出去。所以画面
// 可以落后于规则，但永远不会画出规则不允许的一步（tango 的 view.js 是同一条规矩）。
//
// 屏幕上没有一个像素是装饰：
//   * 格子的底色 = 这一格被反驳了几次（contra 计数），从"干净"到"已经没谎可撒"是一条色阶；
//   * 边框亮起 = 玩家正把它算进这一问；
//   * 顶部的 k 个槽 = 谎言账本，点亮几个 = **玩家能证明的**谎数下界（不是对手实际撒了几个，
//     那个数要到结案才摊开），所以它只会在真的能证明时前进；
//   * 结案时活下来的格子发光，秘密那格另加一个标记。
// 颜色全部从 css/game.css 的 token 里读，所以换配色不需要动这个文件。
//
// 导出的 `cellPoint` / `ledgerPoint` / `pixelOf` 是给 tools/playtest.mjs 的探针：
// 前者把格子坐标换算成客户区坐标（点击处理里那个映射的正向版本），后者直接回读画布像素，
// 于是"亮起来"这件事是被真的像素证明的，不是被一个 class 名断言的。

import { total } from './core/state.js';
import { state as gameState, provableLies, questionsLeft, witnesses } from './core/game.js';

const PAD = 14;

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

export function createView(canvas, { onToggle, onBrush } = {}) {
  const ctx = canvas.getContext('2d');
  const T = tokens();
  let game = null;
  let geo = { cell: 40, gap: 8, cols: 1, rows: 1, ox: PAD, oy: PAD, ledger: 18, w: 320, h: 320 };
  let flash = new Map();     // id -> 0..1, 刚被推高一格的格子闪一下
  let raf = 0;
  let press = null;          // { anchor, added, moved }

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

  function cellAt(p) {
    for (let id = 1; id <= (game ? game.n : 0); id++) {
      const b = cellXY(id);
      if (p.x >= b.x - geo.gap / 2 && p.x <= b.x + b.w + geo.gap / 2
        && p.y >= b.y - geo.gap / 2 && p.y <= b.y + b.h + geo.gap / 2) return id;
    }
    return 0;
  }

  function localPoint(ev) {
    const box = canvas.getBoundingClientRect();
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
    if (!game || game.done) return;
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

  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  canvas.addEventListener('pointerleave', () => { if (press) { press = null; } });

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

  function drawCell(id, a, aliveSet, litSet) {
    const b = cellXY(id);
    const c = game.contra[id];
    const dead = c > game.k;
    const heat = T.heat[Math.min(c, T.heat.length - 1)];
    const f = flash.get(id) || 0;
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
      ctx.strokeStyle = T.lit;
      ctx.lineWidth = 3;
      roundRect(ctx, b.x + 1.5, b.y + 1.5, b.w - 3, b.h - 3, 7);
      ctx.stroke();
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
        ctx.strokeStyle = game.won ? T.win : '#d64880';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(b.x + b.w / 2, b.y + b.h / 2, b.w * 0.44, 0, Math.PI * 2);
        ctx.stroke();
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
    if (!game) return;
    drawLedger();
    const a = gameState(game);
    const litSet = new Set(game.draft);
    const aliveSet = new Set(game.done ? witnesses(game) : []);
    for (let id = 1; id <= game.n; id++) drawCell(id, a, aliveSet, litSet);
    ctx.fillStyle = T.dim;
    ctx.font = `12px ui-monospace, monospace`;
    ctx.fillText(`候选 ${total(a)} · ${a.map((v, i) => `${v}×${i}矛盾`).join(' ')} · 亮 ${game.draft.length}`,
      geo.ox, geo.oy + geo.rows * (geo.cell + geo.gap) + 10);
  }

  function tick() {
    raf = 0;
    if (flash.size) {
      const next = new Map();
      for (const [id, v] of flash) {
        const t = v + 0.08;
        if (t < 1) next.set(id, t);
      }
      flash = next;
    }
    draw();
    if (flash.size && !raf) raf = window.requestAnimationFrame(tick);
  }

  return {
    setGame(g, changed = []) {
      const was = game;
      game = g;
      if (was !== g && changed.length) {
        flash = new Map(changed.map((id) => [id, 0]));
      } else if (was !== g) {
        flash = new Map();
      }
      if (flash.size && !raf) raf = window.requestAnimationFrame(tick);
      else draw();
    },
    measure,
    draw,
    geom() {
      return { ...geo, n: game ? game.n : 0 };
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
