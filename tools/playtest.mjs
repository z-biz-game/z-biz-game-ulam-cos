// Minimal CDP driver for headless playtesting (Node 21+ global WebSocket/fetch). Zero deps, no
// Playwright — that is the whole contract.
//
// env: CDP_PORT (devtools port, default 9372 — this repo's pair is 5222/9372: one machine, ~17
//      sibling repos, and only ONE headless Chrome may bind a debug port at a time; tools/verify.sh
//      refuses to start on a squatted port unless ALLOW_ORPHAN_CHROME=1)
//      BASE_URL (page to attach to, default http://127.0.0.1:5222/ — the page is found by where
//      BASE_URL points, never by a hardcoded port inside a scenario)
// usage:
//   node playtest.mjs open  <url>                # reuse-or-create our page and navigate
//   node playtest.mjs nav   <url>
//   node playtest.mjs eval  '<js expression>'    # pass `nonav` to skip the reload
//   node playtest.mjs eval  '@boot' nonav        # | @play | @routes | @save | @pointer
//   node playtest.mjs shot  <path.png>
//   node playtest.mjs logs
//
// Every scenario reports { rows, fail } in the same shape as tools/harness.mjs, so verify.sh
// aggregates node suites and browser suites on one line — and a scenario that reports zero rows is
// a failure, not a pass: an empty suite is exactly what a silently-dead harness prints.
//
// Why `call()` exists: a scenario that dies halfway tells one story instead of twenty. Anything the
// page might throw on is wrapped, the throw becomes a FAILING ROW carrying the message as its
// detail, and the rest of the suite still runs. A caught throw is never counted as a pass.
const PORT = process.env.CDP_PORT || 9372;
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5222/';
const SHELL_TIMEOUT = Number(process.env.SHELL_TIMEOUT || 30000);
const ORIGIN = new URL(BASE).origin;
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);
const cmd = process.argv[2];
const arg = process.argv[3];

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (globalThis.__printEvents) globalThis.__printEvents(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A page-side collector: whatever the shell throws on its OWN clock (a hashchange handler, a rAF
// callback) is invisible to Runtime.evaluate and would otherwise pass silently.
const COLLECTOR = `(() => {
  if (window.__ulamHooked) return (window.__ulamErrors || []).length;
  window.__ulamHooked = true;
  window.__ulamErrors = [];
  window.__ulamConsoleErrors = [];
  addEventListener('error', (e) => window.__ulamErrors.push('error: ' + String((e && (e.message || e.type)) || '').slice(0, 200)));
  addEventListener('unhandledrejection', (e) => window.__ulamErrors.push('reject: ' + String(e && e.reason).slice(0, 200)));
  const ce = console.error;
  console.error = (...a) => { window.__ulamConsoleErrors.push(a.map((x) => String(x)).join(' ').slice(0, 200)); return ce.apply(console, a); };
  return 1;
})()`;

async function main() {
  const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) if (t.type === 'page' && isOurs(t.url)) {
      try { await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId }); } catch { /* gone already */ }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let targetId, sessionId;
  if (existing) {
    targetId = existing.id || existing.targetId;
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  } else {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }
  const logs = [];
  globalThis.__printEvents = (m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error' || e.source === 'rendering') logs.push(`[log:${e.level}] ${e.text} ${e.url || ''}`);
    }
  };
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const runJS = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const install = async () => { try { await runJS(COLLECTOR); } catch { /* the shell is not up yet */ } };

  // Wait on the shell, not on a timer: the page is a module graph fetched over the network (the
  // baked table plus the campaign is a megabyte of js/data/lots.js), and a fixed sleep that works
  // on localhost shows the canvas as an unstyled 300x150 box against GitHub Pages.
  const waitShell = async (floorMs, budgetMs = SHELL_TIMEOUT) => {
    await sleep(floorMs);
    const deadline = Date.now() + budgetMs;
    for (;;) {
      let ready = false;
      try {
        ready = await runJS('!!(window.ulam && window.ulam.state && window.ulam.state.id)');
      } catch { ready = false; }
      if (ready) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  };

  if (cmd === 'open') {
    await cdp.send('Page.navigate', { url: arg || BASE }, sessionId);
    await waitShell(600);
    await install();
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'nav') {
    await cdp.send('Page.navigate', { url: arg }, sessionId);
    await waitShell(400);
    await install();
    console.log('navigated\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'eval') {
    if (process.argv[4] !== 'nonav') {
      await cdp.send('Page.navigate', { url: BASE }, sessionId);
      await waitShell(300);
      await install();
    }
    if (arg && arg.startsWith('@')) {
      const name = arg.slice(1);
      let value = null;
      const H = { cdp, sessionId, runJS, sleep, waitShell, install, BASE };
      try {
        if (name === 'pointer') value = await pointerScenario(H);
        else if (name === 'save') value = await saveScenario(H);
        else if (SCENARIOS[name]) value = await runJS(SCENARIOS[name]);
        else { console.log('unknown scenario ' + name + ' — have ' + Object.keys(SCENARIOS).join(', ') + ', save, pointer'); process.exit(1); }
      } catch (err) {
        const dumped = await runJS('JSON.stringify(window.__lastRows||[])').catch(() => '[]');
        value = { rows: JSON.parse(dumped) };
        value.rows.push({ test: `@${name} 整段抛了（后面的断言没跑）`, pass: false, detail: String(err.message).slice(0, 300) });
      }
      value.rows = value.rows || [];
      // An empty suite is a dead harness, not a green one.
      if (value.rows.length === 0) {
        value.rows.push({ test: `@${name} reported zero checks`, pass: false, detail: 'the scenario ran but asserted nothing' });
      }
      value.fail = value.rows.filter((r) => !r.pass).map((r) => r.test);
      console.log(JSON.stringify(value, null, 2));
    } else {
      try {
        console.log(JSON.stringify(await runJS(arg), null, 2));
      } catch (err) {
        console.log('EVAL THROW: ' + err.message);
      }
    }
    if (logs.length) console.log('--- console ---\n' + logs.join('\n'));
  } else if (cmd === 'shot') {
    await runJS('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    (await import('node:fs')).writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log('wrote ' + arg + ' (' + Math.round(data.length / 1024) + 'kB b64)');
  } else if (cmd === 'logs') {
    await sleep(800);
    console.log(logs.join('\n') || '(none)');
  }
  ws.close();
  process.exit(0);
}

// ---- in-page suites: each returns { rows: [{ test, pass, detail }] } -----------------------------
const HEAD = `const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    const call = (fn) => { try { return { ok: true, v: fn() }; } catch (e) { return { ok: false, err: String((e && e.message) || e).slice(0, 200) }; } };
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = (id) => document.getElementById(id);
    const TXT = (id) => String(D(id).textContent);
    const c = window.ulam;
    const KEY = 'ulam.save.v1';
    // 测试要在页内拿引擎模块做对照（store.solve 与模块级 solve 是不是同一个函数对象），
    // 但站点在 Pages 上挂在 /<repo>/ 前缀下：斜杠开头的说明符是 origin 根，本地 server 恰好
    // 以仓库为根所以看不出问题，发到 Pages 就 404，而一个 404 的动态 import 把整段场景拦腰抛断。
    // 以文档自己的 baseURI 为基解析，前缀是什么都指向同一份发货代码。
    const MOD = (p) => import(new URL(p, document.baseURI).href);
    // view.measure() clamps dpr to 1..3 before it sizes the backing store; geom() does not report it,
    // so the probe reads the same window.devicePixelRatio the view reads.
    const DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    // A pixel census copied into a scratch context made WITH willReadFrequently: reading the game's
    // own 2D context over and over makes Chrome log a rendering warning, and a dirty console is a
    // failure in this repo. The game's context is only touched by the repo's own view.pixelOf().
    const CENSUS = () => { const cv = D('board'); const s = document.createElement('canvas'); s.width = cv.width; s.height = cv.height;
      const g = s.getContext('2d', { willReadFrequently: true }); g.clearRect(0, 0, s.width, s.height); g.drawImage(cv, 0, 0);
      const d = g.getImageData(0, 0, s.width, s.height).data; let lit = 0, warm = 0; const seen = new Set();
      for (let i = 0; i < d.length; i += 4) { if (d[i + 3] === 0) continue;
        if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 40) lit++;
        if (d[i] > 150 && d[i + 1] > 110 && d[i + 2] < d[i]) warm++;
        seen.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4) + ',' + (d[i + 3] >> 4)); }
      return { lit, warm, colours: seen.size, w: s.width, h: s.height }; };`;

const SCENARIOS = {
  boot: `(async () => {
    ${HEAD}
    const IDS = ['3-0x','7-0','15-0','4-1x','7-1','11-1','16-1','3-2x','6-2','12-2','20-2','4-3x','9-3','16-3'];
    rec('外壳起来了：window.ulam.version 1、正打着战役第一关', c.version === 1 && !!c.state.id && c.state.mode === 'campaign', c && { id: c.state.id, mode: c.state.mode });
    rec('页内一条异常都没有（error / unhandledrejection / console.error 计数全为 0）', (window.__ulamErrors || []).length === 0 && (window.__ulamConsoleErrors || []).length === 0, { errors: window.__ulamErrors, consoleErrors: window.__ulamConsoleErrors });
    const cl = c.closure();
    rec('闭包体检在浏览器里跑一次就过：ok 且一节点不搜', cl.ok === true && cl.nodes === 0 && cl.errors.length === 0, cl);
    rec('这条体检不花任何搜索节点（ulam.searchNodes() 还是 0）', c.searchNodes() === 0, { nodes: c.searchNodes(), closureNodes: cl.nodes });
    const rc = c.recomputeTable();
    rec('第二路线：页内 DP 重算与发货表零处不符（mismatches 空、ok 真）', rc.ok === true && rc.mismatches.length === 0 && rc.closure.ok === true, { ok: rc.ok, cells: rc.cells, checked: rc.checked, mismatches: rc.mismatches.slice(0, 4), unmeasured: rc.unmeasured, errors: rc.errors.slice(0, 3) });
    rec('重算真的动了 DP（checked 覆盖 14 关 + 小根重测），不是空跑一遍', rc.cells === 14 && rc.checked > 14, { cells: rc.cells, checked: rc.checked, nodes: rc.nodes });
    rec('recomputeTable 用的是它自己的 solver：点击路径的节点计数不许被它带起来', c.searchNodes() === 0, { afterRecompute: c.searchNodes(), recomputeNodes: rc.nodes });
    const camp = c.campaign();
    rec('战役 14 关，一关不多一关不少', camp.length === 14, { length: camp.length });
    rec('14 关的 id 序列就是发货那一条', camp.map((l) => l.id).join(' ') === IDS.join(' '), camp.map((l) => l.id).join(' '));
    rec('每一关的 index / n / k / q / par / bound / volume 都是表上的整数', camp.every((l, i) => l.index === i && Number.isInteger(l.n) && Number.isInteger(l.k) && Number.isInteger(l.q) && Number.isInteger(l.par) && Number.isInteger(l.bound) && Number.isInteger(l.volume)), camp.slice(0, 3));
    rec('minQ 表 33 行（那一整张矩形都在浏览器里）', Array.isArray(c.minq()) && c.minq().length === 33, { length: c.minq().length });
    const claims = c.claims();
    rec('发货的每一句带数字的话都成立（claims 全部 held）', claims.length > 0 && claims.every((x) => x.held === true), { total: claims.length, broke: claims.filter((x) => !x.held).slice(0, 3) });
    const cv = D('board');
    const rect = cv.getBoundingClientRect();
    rec('画布在 DOM 上且有真实 CSS 尺寸（外壳的 el.canvas 就是 #board；这个仓没有 id="canvas" 的元素）', !!document.querySelector('canvas#board') && !document.querySelector('#canvas') && rect.width > 100 && rect.height > 100, { cssW: Math.round(rect.width), cssH: Math.round(rect.height), canvases: [...document.querySelectorAll('canvas')].map((e) => e.id) });
    const gm = c.geom(); const bb = c.boardBox();
    rec('geom 与 boardBox 说的是同一个盒子（CSS 像素）', gm.w === bb.w && gm.h === bb.h && gm.w > 100 && gm.h > 100, { geom: { w: gm.w, h: gm.h, cell: gm.cell, cols: gm.cols, rows: gm.rows }, box: bb });
    rec('画布按 devicePixelRatio 放大：backing store = round(CSS 宽 × dpr) 且非零', cv.width === Math.round(gm.w * DPR) && cv.height === Math.round(gm.h * DPR) && cv.width > 0 && cv.height > 0, { back: { w: cv.width, h: cv.height }, dpr: DPR, cssW: gm.w, cssH: gm.h });
    const cen = CENSUS();
    rec('盘上的格子真的画进去了（非透明像素以千计、颜色不止一种）', cen.lit > 2000 && cen.colours >= 4 && cen.w === cv.width, cen);
    const off = camp.filter((l) => l.bound !== l.par);
    rec('界与真值不符的那几关存在（这仓存在的理由）', off.length >= 1, { count: off.length, ids: off.map((l) => l.id + ':界' + l.bound + '/真值' + l.par) });
    c.load('#/lot/' + off[0].id); await sleep(180);
    rec('不符的那一屏把 精确值 挂上 diff 类名（颜色来自整数而不是文案）', D('readout').querySelector('.diff') !== null && /体积界/.test(TXT('readout')) && /精确值/.test(TXT('readout')), { id: c.state.id, bound: c.state.bound, par: c.state.par, tiles: [...D('readout').children].map((t) => t.className) });
    c.load('#/c/1'); await sleep(160);
    rec('开局那一屏：phase=ask、已问 0、候选 = n、预算 = q', c.state.phase === 'ask' && c.state.asked === 0 && c.state.left === c.state.n && c.state.qLeft === c.state.q, { phase: c.state.phase, asked: c.state.asked, left: c.state.left, n: c.state.n, qLeft: c.state.qLeft });
    rec('按候选数分带的那张表也在（bands 非空）', (() => { const b = c.bands(); return Array.isArray(b) && b.length > 0 && b.every((x) => x && typeof x === 'object'); })(), { bands: c.bands().length });
    rec('两条独立路线的报告都发货了（greedy / advisory 不是空壳）', JSON.stringify(c.greedyReport()).length > 4 && JSON.stringify(c.advisoryReport()).length > 4, { greedy: Object.keys(c.greedyReport()).slice(0, 6), advisory: Object.keys(c.advisoryReport()).slice(0, 6) });
    rec('这一台设备真的能落盘', c.state.persist === true, { persist: c.state.persist });
    rec('没有请求任何图片/字体/音频：全部资源同源（零依赖、程序画的）', (() => { const rs = performance.getEntriesByType('resource'); return rs.length > 0 && rs.every((e) => e.name.startsWith(location.origin)) && rs.every((e) => !/\\.(png|jpe?g|gif|webp|woff2?|mp3|ogg)$/i.test(e.name.split('?')[0])); })(), performance.getEntriesByType('resource').map((e) => e.name.replace(location.origin, '/').slice(0, 40)));
    rec('页眉三个模式按钮都在，aria-current 只亮一个', (() => { const b = [...D('modes').querySelectorAll('button')]; return b.length >= 3 && b.filter((x) => x.getAttribute('aria-current') === 'true').length === 1; })(), [...D('modes').querySelectorAll('button')].map((b) => [b.dataset.mode, b.getAttribute('aria-current')]));
    rec('提示语说一句、且只说一句', TXT('hintline').length > 0 && !/\\n/.test(TXT('hintline')), TXT('hintline').slice(0, 90));
    rec('状态快照里没有秘密（不然玩家能读答案）', Object.keys(c.state).indexOf('secret') < 0, Object.keys(c.state));
    return { rows };
  })()`,

  play: `(async () => {
    ${HEAD}
    c.store.reset();
    const camp = c.campaign();
    const l71 = camp.find((l) => l.id === '7-1');
    rec('战役里有 7-1：7 个数 · 1 个谎', !!l71 && l71.n === 7 && l71.k === 1, l71);
    const nodesBefore = c.searchNodes();
    c.load('#/lot/7-1'); await sleep(200);
    const lot = c.lotById('7-1');
    rec('载入一关不花一个搜索节点', nodesBefore === 0 && c.searchNodes() === 0, { nodesBefore, now: c.searchNodes(), id: c.state.id });
    rec('题卡带着烤好的策略表（条目数 > 0）与量出来的精确值', !!lot && lot.policy > 0 && lot.par === l71.par && lot.q === l71.q && lot.n === 7 && lot.k === 1, lot);
    const hm = c.hintMove();
    rec('表内关的提示来自策略表：kind=policy 且 exact=true', !!hm && hm.kind === 'policy' && hm.exact === true && Array.isArray(hm.ids), hm && { kind: hm.kind, exact: hm.exact, ids: hm.ids, y: hm.y });
    rec('提示给的那一问合法：id 升序、都在 1..n、不超 MAX_CELLS', hm.ids.every((x, i) => Number.isInteger(x) && x >= 1 && x <= 7 && (i === 0 || x > hm.ids[i - 1])) && hm.ids.length <= c.state.maxCells, { ids: hm.ids, maxCells: c.state.maxCells });
    rec('hintMove 报的向量就是当前局面', JSON.stringify(hm.vec) === JSON.stringify(c.stateVec()) && hm.qLeft === c.state.qLeft, { vec: hm.vec, now: c.stateVec(), qLeft: hm.qLeft });
    const tipOnTable = c.tapHint();
    rec('屏幕把这一问说成策略表给的（不是近似建议）', /策略表/.test(tipOnTable.line) && !/表外/.test(tipOnTable.line) && tipOnTable.hints === 1, tipOnTable);
    const w1 = call(() => c.autoPlay(24));
    const s1 = c.state;
    rec('照表打 7-1 能赢：done 且 won（autoPlay 走的就是点击路径）', s1.done === true && s1.won === true, { threw: w1.err || null, asked: s1.asked, grade: s1.grade, won: s1.won });
    rec('问数不超过发放的 q', s1.asked === s1.q - s1.qLeft && s1.asked <= l71.q && s1.qLeft >= 0, { asked: s1.asked, q: l71.q, qLeft: s1.qLeft });
    rec('评级是核心算出来的事实：赢了就不是 caught', ['tight','late','pried','lucky','win'].includes(s1.grade) && s1.lucky === (s1.left > 1), { grade: s1.grade, left: s1.left, par: s1.par });
    rec('头条断言：整关打满，ulam.searchNodes() 依然是 0（点击路径从不搜索）', c.searchNodes() === 0, { nodes: c.searchNodes(), asked: s1.asked });
    rec('证明抽屉里每一问留一行，条数 == 已问数', s1.proof === s1.asked && D('prooflog').children.length === s1.asked && /\\(\\d+ 条\\)/.test(TXT('prooftotal')), { proof: s1.proof, asked: s1.asked, prooftotal: TXT('prooftotal') });
    const l3 = camp.find((l) => l.k === 3);
    c.tapRestart(); await sleep(120);
    c.load('#/lot/' + l3.id); await sleep(200);
    rec('三谎关载入：k=3 且有烤好的表（' + l3.id + '）', c.state.k === 3 && c.state.n === l3.n && c.lotById(l3.id).policy > 0, { id: l3.id, n: l3.n, q: l3.q, par: l3.par, lot: c.lotById(l3.id) });
    const w3 = call(() => c.autoPlay(26));
    const s3 = c.state;
    rec('照表打三谎关也赢：' + l3.id, s3.done === true && s3.won === true, { threw: w3.err || null, asked: s3.asked, grade: s3.grade });
    rec('三谎关全程也不搜索（k=3 是表量出来的，不是现场解的）', c.searchNodes() === 0, { nodes: c.searchNodes(), asked: s3.asked, proof: s3.proof });
    // 预算：问数用完之后再问必须被拒
    c.tapRestart(); await sleep(100);
    c.load('#/lot/7-1'); await sleep(180);
    const q = c.state.q;
    const lens = [];
    for (let i = 0; i < q; i++) { c.brush([]); lens.push(c.tapAsk()); }
    rec('发放的 q 问全都问得出去（空问是合法问题：一次都没被拒）', lens.join(',') === Array.from({ length: q }, (_, i) => i + 1).join(','), { q, lens });
    const atBudget = c.state;
    rec('预算耗尽时还有 ' + atBudget.left + ' 个候选、问数归零、phase 该指认', atBudget.asked === q && atBudget.qLeft === 0 && atBudget.left === 7 && atBudget.phase === 'accuse', { asked: atBudget.asked, qLeft: atBudget.qLeft, left: atBudget.left, phase: atBudget.phase });
    const extra = call(() => c.tapAsk());
    rec('多问一问被拒：已问数纹丝不动', extra.ok === true && c.state.asked === q, { asked: c.state.asked, q, ret: extra.v, err: extra.err });
    rec('拒绝在屏幕上说出一句话，不是沉默', new RegExp('问数用完了|点一个格子指认|结案').test(TXT('hintline')) && /warn/.test(D('hintline').innerHTML), TXT('hintline').slice(0, 90));
    rec('预算用尽后「问出去」与「提示」都进了禁用态', c.els.ask.disabled === true && c.els.hint.disabled === true, { ask: c.els.ask.disabled, hint: c.els.hint.disabled });
    rec('这时候 hintMove() 不编一口（phase 已经不是 ask）', c.hintMove() === null, { phase: c.state.phase, hintMove: c.hintMove() });
    // 撤销：stateVec 精确回到上一问之前
    c.tapRestart(); await sleep(100);
    c.load('#/lot/11-1'); await sleep(190);
    const v0 = c.stateVec();
    const h1 = c.hintMove(); c.brush(h1.ids); c.tapAsk();
    const v1 = c.stateVec();
    rec('一问下去权重向量真的动了', JSON.stringify(v0) !== JSON.stringify(v1) && c.state.asked === 1, { v0, v1 });
    const h2 = c.hintMove();
    rec('第二问仍然在表里（对手给的每个答案都落回表内）', h2 && h2.kind === 'policy', h2 && { kind: h2.kind, vec: h2.vec });
    c.brush(h2.ids); c.tapAsk();
    const undone = c.tapUndo();
    rec('撤销一问：stateVec() 精确回到上一问之前', undone === 1 && JSON.stringify(c.stateVec()) === JSON.stringify(v1) && c.state.asked === 1, { undone, now: c.stateVec(), want: v1 });
    c.tapUndo();
    rec('再撤一问回到开局向量 (n|0|0|…)', JSON.stringify(c.stateVec()) === JSON.stringify(v0) && c.state.asked === 0 && c.stateVec()[0] === 11, { now: c.stateVec(), asked: c.state.asked });
    const nothing = call(() => c.tapUndo());
    rec('没东西可撤时它不动局面也不炸', nothing.ok === true && c.state.asked === 0 && JSON.stringify(c.stateVec()) === JSON.stringify(v0), { ret: nothing.v, err: nothing.err, asked: c.state.asked });
    rec('撤销之后抽屉里的条数也退回去了', c.state.proof === 0 && D('prooflog').children.length === 1 && /还没有一问/.test(TXT('prooflog')), { proof: c.state.proof, rows: D('prooflog').children.length });
    // 还能赢的局面指错 = 判负
    c.tapRestart(); await sleep(100);
    c.load('#/lot/15-0'); await sleep(190);
    const secret = c.lotById('15-0').secret;
    const lostRun = call(() => c.autoLose(30));
    const sL = c.state;
    rec('烧完预算再指错：规则判负（done、won=false、grade=caught、phase 收在 over）——结案时外壳在 finish() 里抛，见 @save 的红行', sL.done === true && sL.won === false && sL.grade === 'caught' && sL.phase === 'over', { threw: lostRun.err || null, grade: sL.grade, won: sL.won, done: sL.done, phase: sL.phase, secret });
    rec('指错的时候还有 ' + sL.witnesses.length + ' 个候选与全部答案相容：这局本来指对就赢', sL.left >= 2 && sL.witnesses.indexOf(secret) >= 0 && sL.provable <= sL.k, { left: sL.left, witnesses: sL.witnesses.length, secret, provable: sL.provable });
    rec('输一局也不搜索任何节点', c.searchNodes() === 0, { nodes: c.searchNodes() });
    const vecL = c.stateVec(); const askedL = c.state.asked;
    const retry = call(() => c.accuse(secret));
    rec('判负之后局面是钉死的：再指一次返回 false、已问数与权重向量一根手指都不动', retry.ok === true && retry.v === false && c.state.asked === askedL && JSON.stringify(c.stateVec()) === JSON.stringify(vecL) && c.state.done === true, { ret: retry.v, err: retry.err || null, asked: c.state.asked, vec: c.stateVec() });
    // 表外关：随机局没有烤好的策略表，提示必须说实话
    c.load('#/random/hard/4242'); await sleep(220);
    const hmR = c.hintMove();
    rec('随机关无表：提示走表外分支 kind=absent、exact=false', !!hmR && hmR.kind === 'absent' && hmR.exact === false, hmR && { kind: hmR.kind, exact: hmR.exact, left: hmR.left, ids: hmR.ids });
    const tipOff = c.tapHint();
    rec('屏幕上明说「表外（这一关没烤策略表）」并声明不担保精确值', /表外/.test(tipOff.line) && /不担保精确值/.test(tipOff.line) && /体积均分/.test(tipOff.line), tipOff.line.slice(0, 150));
    rec('表外建议仍然是一个合法子集（升序、1..n）', hmR.ids.every((x, i) => x >= 1 && x <= c.state.n && (i === 0 || x > hmR.ids[i - 1])), { ids: hmR.ids, n: c.state.n });
    rec('表外分支也不搜索：searchNodes() 依旧是 0', c.searchNodes() === 0, { nodes: c.searchNodes(), tier: c.state.tier, id: c.state.id });
    rec('随机关的 par 来自 MINQ 表而不是现场解', (() => { const r = c.randomFor('hard', '4242'); return Number.isInteger(r.par) && Number.isInteger(r.bound) && r.q >= r.par; })(), c.randomFor('hard', '4242'));
    return { rows };
  })()`,

  routes: `(async () => {
    ${HEAD}
    const IDS = ['3-0x','7-0','15-0','4-1x','7-1','11-1','16-1','3-2x','6-2','12-2','20-2','4-3x','9-3','16-3'];
    c.store.reset();
    c.load('#/'); await sleep(190);
    rec('#/ 落到战役第一关（route() 把它规范化成 #/c/1）', c.route() === '#/c/1' && c.state.id === IDS[0] && c.state.mode === 'campaign' && c.state.index === 1, { route: c.route(), hash: location.hash, id: c.state.id });
    c.load('#/lot/7-1'); await sleep(190);
    rec('#/lot/7-1 直接开那一关，route() 原样还回去', c.route() === '#/lot/7-1' && c.state.id === '7-1' && c.state.n === 7 && c.state.k === 1, { route: c.route(), id: c.state.id, label: c.state.label });
    rec('面包屑把这一关的 id 印在 DOM 上', /7-1/.test(D('crumbs').innerHTML), TXT('crumbs'));
    c.load('#/daily'); await sleep(190);
    const daily = c.state.id; const dailyDay = c.state.day;
    rec('#/daily 给每日一题：mode=daily、状态里带日期键', c.route() === '#/daily' && c.state.mode === 'daily' && new RegExp('^每日谎话 · \\\\d{4}-\\\\d{2}-\\\\d{2}$').test(c.state.label), { id: daily, day: dailyDay, label: c.state.label });
    c.load('#/c/3'); await sleep(150);
    c.load('#/daily'); await sleep(190);
    rec('#/daily 两次进来是同一道题（不是每进来一次重摇）', c.state.id === daily && c.state.day === dailyDay, { first: daily, again: c.state.id, day: c.state.day });
    const a1 = c.dailyFor('2026-09-27'); const a2 = c.dailyFor('2026-09-27');
    rec('dailyFor(2026-09-27) 两次调用逐字段相同（纯函数）', JSON.stringify(a1) === JSON.stringify(a2) && IDS.indexOf(a1.campaignId) >= 0, { a1, a2 });
    rec('每日一题就是从战役池里按日期选的（campaignId 在 14 关里、题面字段一致）', IDS.indexOf(a1.campaignId) >= 0 && a1.n === c.lotById(a1.campaignId).n && a1.q === c.lotById(a1.campaignId).q, a1);
    rec('不同日期真的会换题', new Set(['2026-09-27','2026-09-28','2026-10-01','2026-12-31','2027-01-01'].map((d) => c.dailyFor(d).id + ':' + c.dailyFor(d).secret)).size >= 3, ['2026-09-27','2026-09-28','2026-10-01','2026-12-31','2027-01-01'].map((d) => c.dailyFor(d).id + '/s' + c.dailyFor(d).secret));
    c.load('#/random/hard/4242'); await sleep(210);
    const rnd = c.state.id; const rf = c.randomFor('hard', '4242');
    rec('#/random/hard/<seed> 开这一题，route() 把种子留在 URL 里', c.route() === '#/random/hard/4242' && c.state.id === rnd && rnd === 'random/hard/4242' && c.state.mode === 'random', { route: c.route(), id: c.state.id, mode: c.state.mode });
    rec('randomFor(hard,4242) 与屏上那一题逐字段相同（链接可以直接分享）', rf.id === c.state.id && rf.tier === c.state.tier && rf.n === c.state.n && rf.k === c.state.k && rf.q === c.state.q && rf.par === c.state.par, { rf, state: { id: c.state.id, tier: c.state.tier, n: c.state.n, k: c.state.k, q: c.state.q, par: c.state.par } });
    rec('屏上这一题的秘密对玩家不可见（快照里没有 secret，randomFor 那边是个整数）', c.state.secret === undefined && Number.isInteger(rf.secret) && rf.secret >= 1 && rf.secret <= rf.n, { stateSecret: c.state.secret, rfSecret: rf.secret, n: rf.n });
    c.load('#/c/2'); await sleep(150);
    location.hash = '#/random/hard/4242'; await sleep(210);
    rec('同一颗种子第二次进来还是同一题（纯函数：同种子同问）', c.state.id === rnd && c.state.n === rf.n && c.state.q === rf.q && Object.keys(c.state).indexOf('secret') < 0, { again: c.state.id, want: rnd });
    rec('四个档位都在（gentle/standard/hard/brutal）', c.tierOrder.length === 4 && JSON.stringify(c.tierOrder) === JSON.stringify(['gentle','standard','hard','brutal']) && Object.keys(c.tiers).length === 4, { order: c.tierOrder, tiers: Object.keys(c.tiers) });
    for (const t of c.tierOrder) { const r = call(() => c.randomFor(t, 'probe-seed')); rec('档位 ' + t + ' 能按种子出题（n/k/q/par/bound 齐全）', r.ok && Number.isInteger(r.v.n) && r.v.n >= 1 && Number.isInteger(r.v.q) && r.v.q >= r.v.par && Number.isInteger(r.v.bound), r.ok ? r.v : r.err); }
    const badTier = call(() => c.randomFor('不存在', 'x'));
    rec('陌生档位被表拒绝，而不是悄悄给一题', badTier.ok === false && badTier.err.length > 0, { err: badTier.err });
    c.load('#/lot/nope'); await sleep(260);
    rec('#/lot/nope 退回战役而不是白盘：路由改写到 #/c/<已解锁>', c.state.id === IDS[c.store.unlocked - 1] && c.route() === '#/c/' + c.store.unlocked && location.hash === '#/c/' + c.store.unlocked, { hash: location.hash, id: c.state.id, route: c.route(), unlocked: c.store.unlocked });
    rec('这一趟退回没有留下任何页内异常', (window.__ulamErrors || []).length === 0, { errors: window.__ulamErrors });
    c.load('#/c/99'); await sleep(180);
    rec('#/c/99 钳到最后一关（14），不是空白盘', c.state.index === 14 && c.state.id === IDS[13], { index: c.state.index, id: c.state.id, route: c.route() });
    c.load('#/c/0'); await sleep(180);
    rec('#/c/0 钳到第 1 关', c.state.index === 1 && c.state.id === IDS[0], { index: c.state.index, id: c.state.id });
    c.load('#/menu'); await sleep(180);
    rec('#/menu 打开关卡库视图：game 视图收起、14 行都在', c.state.menu === true && D('view-game').hidden === true && D('bandlist').querySelectorAll('.lot-row').length === 14, { menu: c.state.menu, rows: D('bandlist').querySelectorAll('.lot-row').length, route: c.route() });
    rec('关卡库的每一行都指向 #/lot/<id>（点它就能开局）', [...D('bandlist').querySelectorAll('button[data-goto]')].map((b) => b.dataset.goto).join(' ') === IDS.map((i) => '#/lot/' + i).join(' '), [...D('bandlist').querySelectorAll('button[data-goto]')].slice(0, 2).map((b) => b.dataset.goto));
    D('bandlist').querySelector('button[data-goto="#/lot/11-1"]').click(); await sleep(200);
    rec('关卡库里的「开局」按钮真的在路由', c.state.id === '11-1' && c.route() === '#/lot/11-1' && c.state.menu === false, { id: c.state.id, route: c.route() });
    c.load('#/pick/12/1'); await sleep(190);
    rec('#/pick/<n>/<k> 自定义局进得来（id 里带着 n 与 k）', c.state.id === 'c/12/1' && c.state.n === 12 && c.state.k === 1 && c.state.tier === 'custom', { id: c.state.id, n: c.state.n, k: c.state.k, tier: c.state.tier });
    location.hash = '#/lot/9-3'; await sleep(210);
    rec('直接写 location.hash 外壳也认（hashchange 是唯一入口）', c.state.id === '9-3' && c.route() === '#/lot/9-3', { hash: location.hash, id: c.state.id });
    c.load('#/random'); await sleep(260);
    rec('光秃秃的 #/random 把种子写进 URL（分享链接不会重摇）', new RegExp('^#/random/(gentle|standard|hard|brutal)/\\\\d+$').test(location.hash), location.hash);
    const seeded = location.hash;
    c.load('#/c/1'); await sleep(150);
    location.hash = seeded; await sleep(220);
    rec('那条带种子的链接再走一遍还是同一题', location.hash === seeded && c.state.mode === 'random' && c.route() === seeded, { seeded, id: c.state.id });
    D('modes').querySelector('button[data-mode=daily]').click(); await sleep(200);
    rec('页眉「每日」按钮真的在路由', c.state.mode === 'daily' && location.hash === '#/daily', { mode: c.state.mode, hash: location.hash });
    D('modes').querySelector('button[data-mode=campaign]').click(); await sleep(200);
    rec('「战役」按钮路由回来', c.state.mode === 'campaign' && new RegExp('^#/c/\\\\d+$').test(location.hash), { mode: c.state.mode, hash: location.hash });
    rec('载入到这儿为止依旧一个搜索节点都没花', c.searchNodes() === 0, { nodes: c.searchNodes() });
    rec('路由全过程没留下页内异常', (window.__ulamErrors || []).length === 0, { errors: window.__ulamErrors });
    return { rows };
  })()`,
};

// ---- @save: the one suite that needs a real Page.navigate (a real document reload) --------------
// Everything about a save file is a claim about DISK, and a page-side script that never reloads
// proves nothing: it can only read its own memory back. So the driver reloads the document twice —
// once to prove the records survived, once to prove a corrupt payload degrades instead of throwing.
const SAVE_A = `(async () => {
  ${HEAD}
  c.store.reset();
  rec('reset 之后磁盘上没有这条键、records 空、前沿回到 1', localStorage.getItem(KEY) === null && Object.keys(c.store.records).length === 0 && c.store.unlocked === 1 && c.store.totals().plays === 0, { raw: localStorage.getItem(KEY), records: Object.keys(c.store.records), unlocked: c.store.unlocked });
  rec('totals() 全零（solved/atPar/plays/wins/losses 五个数）', (() => { const t = c.store.totals(); return t.solved === 0 && t.atPar === 0 && t.plays === 0 && t.wins === 0 && t.losses === 0; })(), c.store.totals());
  rec('页眉总账说的是同一份零', /0\\/14 关拿下/.test(TXT('totals')) && /已解锁 1/.test(TXT('totals')), TXT('totals'));
  rec('这一台设备能真的落盘（persistent 探针 + store.save()）', c.state.persist === true && c.store.save() === true && localStorage.getItem(KEY) !== null, { persist: c.state.persist });
  c.load('#/lot/7-1'); await sleep(200);
  const w = call(() => c.autoPlay(24));
  const s = c.state;
  rec('点出来的胜利：7-1 打完了（done 且 won）', s.done === true && s.won === true, { threw: w.err || null, asked: s.asked, grade: s.grade });
  const shell = (() => { const raw = JSON.parse(localStorage.getItem(KEY) || 'null'); return { raw, t: c.store.totals(), header: TXT('totals'), rec: c.store.record('7-1'), unlocked: c.store.unlocked }; })();
  // 前沿推到哪一关不是写死的：7-1 是战役第 indexById+1 关，赢它就该把前沿推到下一关。
  const lib = await MOD('js/core/library.js');
  const frontier = lib.indexById('7-1') + 2;
  rec('赢完 7-1 后三处一起动：磁盘与内存都有纪录、解锁前沿推到下一关、页眉 1/14（曾经红在 js/main.js:391 叫 store.solve 而门面上没这个名字）', shell.rec !== null && shell.rec.solved === true && shell.rec.best === s.asked && shell.t.solved === 1 && shell.t.plays === 1 && shell.t.wins === 1 && shell.unlocked === frontier && /1\\/14 关拿下/.test(shell.header), { frontier, ...shell });
  rec('结案卡片浮起来了：星星/判词/结算都非空（同一个 finish() 若在第 391 行抛，后面的渲染就跑不到）', /★/.test(TXT('stars')) && TXT('verdict').length > 0 && /用了/.test(TXT('tally')) && s.veil === true, { veil: s.veil, stars: TXT('stars'), verdict: TXT('verdict'), tally: TXT('tally').slice(0, 60) });
  const m = await MOD('js/core/storage.js');
  rec('两条写路径指向同一份实现：模块级 solve 与门面 store.solve 是同一个函数对象', m.store.solve === m.solve && typeof m.store.solve === 'function' && typeof c.store.record === 'function', { same: m.store.solve === m.solve, storeKeys: Object.keys(c.store) });
  m.solve('#/synthetic/15-0', { questions: 4, par: 4, hints: 0, lies: 0, won: true });
  m.solve('#/synthetic/15-0', { questions: 9, par: 4, hints: 1, lies: 1, won: true });
  rec('存档层的写路径是通的：best 只降不升、atPar 粘住', (() => { const r = c.store.record('#/synthetic/15-0'); return r.solved === true && r.best === 4 && r.plays === 2 && r.atPar === true; })(), c.store.record('#/synthetic/15-0'));
  rec('unlock 只升不降（连写三次只认最大）', (() => { c.store.unlock(11); c.store.unlock(3); c.store.unlock(-2); return c.store.unlocked === 11; })(), { unlocked: c.store.unlocked });
  const days = ['2026-08-30', '2026-08-31', '2026-09-01'];
  for (const d of days) c.store.markDaily(d, 'daily-' + d, { won: true, questions: 5 });
  rec('跨月界的三天各写一条、互不牵连（连击只能按日历键推：storage.js 没有 streak()）', days.every((d) => c.store.dailyDone(d) && c.store.dailyDone(d).done === true && c.store.dailyDone(d).questions === 5) && Object.keys(c.store.daily).length === 3, days.map((d) => c.store.dailyDone(d)));
  rec('每日赢过一次就擦不掉：更差的重玩仍然记 5 问', (() => { const after = c.store.markDaily('2026-09-01', 'other', { won: false, questions: 40 }); return after.done === true && after.questions === 5; })(), c.store.dailyDone('2026-09-01'));
  c.load('#/daily'); await sleep(220);
  const today = c.state.day;
  rec('每日一题的日期键在状态里（路由与 store 用的是同一个键）', c.state.mode === 'daily' && new RegExp('^\\\\d{4}-\\\\d{2}-\\\\d{2}$').test(today), { day: today, id: c.state.id });
  rec('今天的每日还没打过', c.store.dailyDone(today) === null, c.store.dailyDone(today));
  const wd = call(() => c.autoPlay(24));
  rec('每日题照表打赢：won=true', c.state.done === true && c.state.won === true, { threw: wd.err || null, asked: c.state.asked });
  rec('每日一题打赢也写得进 daily：第 391 行的 store.solve 通了，才轮得到第 398 行的 markDaily（这一条曾经红在门面上少 solve 这个名字）', (() => { const mk = c.store.dailyDone(today); return !!mk && mk.done === true && mk.questions === c.state.asked; })(), { day: today, mark: c.store.dailyDone(today), won: c.state.won, asked: c.state.asked });
  rec('整个游戏只写那一条存档键', Object.keys(localStorage).filter((k) => /ulam\\./.test(k)).join(',') === KEY, Object.keys(localStorage));
  return { rows };
})()`;

const SAVE_B = `(async () => {
  ${HEAD}
  const days = ['2026-08-30', '2026-08-31', '2026-09-01'];
  rec('真 reload 之后外壳又起来了（window.ulam 在、正在打一关）', c.version === 1 && !!c.state.id, { id: c.state.id, route: c.route() });
  rec('localStorage 活过一次真文档重载：合成纪录读回来了', (() => { const r = c.store.record('#/synthetic/15-0'); return !!r && r.solved === true && r.best === 4 && r.plays === 2 && r.atPar === true; })(), { disk: JSON.parse(localStorage.getItem(KEY) || '{}').records, memory: c.store.record('#/synthetic/15-0') });
  rec('前沿跨重载保留（磁盘上仍是数字 11）', c.store.unlocked === 11 && JSON.parse(localStorage.getItem(KEY)).unlocked === 11, { unlocked: c.store.unlocked });
  rec('每日那三天跨重载还在（含月界那一天）', days.every((d) => c.store.dailyDone(d) && c.store.dailyDone(d).done === true && c.store.dailyDone(d).questions === 5), days.map((d) => c.store.dailyDone(d)));
  rec('总账跨重载一致：totals() 与磁盘上的 stats 同一份', (() => { const t = c.store.totals(); const st = JSON.parse(localStorage.getItem(KEY)).stats; return t.plays === st.plays && t.wins === st.wins && t.losses === st.losses; })(), { totals: c.store.totals(), stats: JSON.parse(localStorage.getItem(KEY)).stats });
  rec('reload 之后 records 的条数与磁盘一致', Object.keys(c.store.records).length === Object.keys(JSON.parse(localStorage.getItem(KEY)).records).length, Object.keys(c.store.records));
  rec('页眉总账把磁盘上的数念出来', new RegExp(String(c.store.totals().solved) + '/14 关拿下').test(TXT('totals')), TXT('totals'));
  rec('roster 计数就是 records 里 solved 的条数（storage.js 文档的那一份口径，只有这一处定义）', (() => { const rs = Object.values(c.store.records); return c.store.totals().solved === rs.filter((r) => r && r.solved).length && c.store.totals().atPar === rs.filter((r) => r && r.atPar).length; })(), { totals: c.store.totals(), records: Object.keys(c.store.records) });
  c.load('#/c/4'); await sleep(190);
  const beforeVec = c.stateVec();
  rec('重载后还能继续玩：第 4 关载入并问得出去', (() => { const h = c.hintMove(); c.brush(h.ids); c.tapAsk(); return c.state.id === '4-1x' && c.state.asked === 1 && JSON.stringify(c.stateVec()) !== JSON.stringify(beforeVec); })(), { id: c.state.id, asked: c.state.asked, vec: c.stateVec() });
  const rp = JSON.parse(sessionStorage.getItem('ulam.resume.v1') || 'null');
  rec('续局写在 sessionStorage（与存档是两条不同的键）', rp !== null && typeof rp.hash === 'string' && Array.isArray(rp.steps) && rp.steps.every((x) => Array.isArray(x)), { resume: rp, saveKeys: Object.keys(localStorage).filter((k) => /ulam\\./.test(k)) });
  rec('续局只记亮过的格与路由，不记秘密（重放靠确定性对手）', rp !== null && JSON.stringify(rp).indexOf('secret') < 0, rp);
  rec('重载回来的第 4 关是按续局重放的（已问 1 问、向量与重放一致）', c.state.asked === 1 && c.state.proof === 1, { asked: c.state.asked, proof: c.state.proof, line: c.state.line.slice(0, 60) });
  const rs = call(() => c.store.reset());
  rec('store.reset() 不抛、返回 true、内存与磁盘一起清空', rs.ok === true && rs.v === true && localStorage.getItem(KEY) === null && Object.keys(c.store.records).length === 0 && c.store.unlocked === 1, { ret: rs.v, err: rs.err, raw: localStorage.getItem(KEY), unlocked: c.store.unlocked });
  rec('reset 归零的是整份存档：stats 六个数、daily、records、unlocked 一起回空白', (() => { const t = c.store.totals(); return t.solved === 0 && t.atPar === 0 && t.plays === 0 && t.wins === 0 && t.losses === 0 && Object.keys(c.store.daily).length === 0 && Object.keys(c.store.records).length === 0 && c.store.unlocked === 1; })(), { totals: c.store.totals(), daily: Object.keys(c.store.daily), unlocked: c.store.unlocked });
  c.load('#/c/1'); await sleep(170);
  rec('下一次渲染把页眉带回零（页眉读的是同一份 totals()）', /0\\/14 关拿下/.test(TXT('totals')) && /已解锁 1/.test(TXT('totals')), TXT('totals'));
  D('wipe').click(); await sleep(90);
  rec('「清空存档」第一次点击只是上膛（问一句要不要真的清）', D('toast').hidden === false && /再点一次/.test(TXT('toast')), { toast: TXT('toast'), armed: true });
  const m2 = await MOD('js/core/storage.js');
  m2.solve('4-1x', { questions: 5, par: 5, hints: 0, lies: 0, won: true });
  rec('为清空按钮造一条纪录（磁盘上现在有东西了）', !!c.store.record('4-1x') && localStorage.getItem(KEY) !== null, c.store.record('4-1x'));
  D('wipe').click(); await sleep(240);
  rec('第二次点击真的清空了（纪录归零、键被删、局面还在）', Object.keys(c.store.records).length === 0 && localStorage.getItem(KEY) === null && c.store.unlocked === 1 && !!c.state.id, { records: Object.keys(c.store.records), raw: localStorage.getItem(KEY), id: c.state.id });
  await sleep(160);
  const fresh = call(() => { c.tapRestart(); c.brush([1]); return c.tapAsk(); });
  rec('清档之后照样能玩：一问出得去，续局写到 sessionStorage（存档键不会被一问顶回来）', fresh.ok === true && c.state.asked === 1 && localStorage.getItem(KEY) === null && !!sessionStorage.getItem('ulam.resume.v1'), { asked: c.state.asked, raw: localStorage.getItem(KEY), resume: !!sessionStorage.getItem('ulam.resume.v1') });
  rec('清档之后照样写得进盘：store.save() 把键原样建回来', c.store.save() === true && localStorage.getItem(KEY) !== null && (() => { const raw = JSON.parse(localStorage.getItem(KEY)); return ['daily', 'records', 'stats', 'unlocked'].join(',') === Object.keys(raw).sort().join(','); })(), { raw: (localStorage.getItem(KEY) || '').slice(0, 90) });
  localStorage.setItem(KEY, '{ not json');
  rec('把坏档写进磁盘，等着下一次真重载', localStorage.getItem(KEY) === '{ not json', localStorage.getItem(KEY));
  return { rows };
})()`;

const SAVE_C = `(async () => {
  ${HEAD}
  rec('坏档没有把页面弄崩：外壳仍然起来并在打一关', c.version === 1 && !!c.state.id && c.state.n >= 3, { id: c.state.id, route: c.route() });
  rec('页内一条异常都没有（error / unhandledrejection / console.error 计数为 0）', (window.__ulamErrors || []).length === 0 && (window.__ulamConsoleErrors || []).length === 0, { errors: window.__ulamErrors, consoleErrors: window.__ulamConsoleErrors });
  rec('坏档读成干净空白：records 空、前沿 1、每日空', Object.keys(c.store.records).length === 0 && c.store.unlocked === 1 && Object.keys(c.store.daily).length === 0, { records: Object.keys(c.store.records), unlocked: c.store.unlocked, daily: Object.keys(c.store.daily) });
  rec('totals() 也回落到全零', (() => { const t = c.store.totals(); return t.solved === 0 && t.atPar === 0 && t.plays === 0 && t.wins === 0 && t.losses === 0; })(), c.store.totals());
  const wrote = call(() => { c.tapRestart(); c.brush([1]); return c.tapAsk(); });
  rec('坏档之后还能继续玩：重开、亮一格、问得出去（局面是活的）', wrote.ok === true && c.state.asked === 1 && c.state.done === false, { asked: c.state.asked, err: wrote.err, raw: (localStorage.getItem(KEY) || '').slice(0, 40) });
  rec('坏档被读成空白后，store.save() 重写出去的是合法 JSON、还是那四个键、前沿 1', (() => { const okWrite = c.store.save(); const raw = localStorage.getItem(KEY); if (!raw || raw === '{ not json') return false; let p; try { p = JSON.parse(raw); } catch { return false; } return okWrite === true && ['daily', 'records', 'stats', 'unlocked'].join(',') === Object.keys(p).sort().join(',') && p.unlocked === 1; })(), { raw: (localStorage.getItem(KEY) || '').slice(0, 90) });
  rec('坏档没让点击路径开始搜索', c.searchNodes() === 0, { nodes: c.searchNodes() });
  const rr = call(() => c.store.reset());
  rec('reset() 对着坏档也不抛：键被删掉、回到空白（storage.js 说它总是返回 true）', rr.ok === true && rr.v === true && localStorage.getItem(KEY) === null, { ret: rr.v, err: rr.err, raw: localStorage.getItem(KEY) });
  localStorage.setItem(KEY, JSON.stringify({ records: { 'synthetic-partial': { solved: true, best: 3, plays: 7, atPar: false } }, unlocked: 'many', stats: { wins: 2 }, daily: 'nope' }));
  rec('再备一份半对半错的档（unlocked 是字符串、daily 是字符串、stats 缺一半），等着下一次真重载', (localStorage.getItem(KEY) || '').indexOf('synthetic-partial') >= 0, localStorage.getItem(KEY));
  return { rows };
})()`;

const SAVE_D = `(async () => {
  ${HEAD}
  rec('半对半错的档没把页面弄崩：外壳照样起来在打一关', c.version === 1 && !!c.state.id && c.state.n >= 3, { id: c.state.id, route: c.route() });
  rec('页内仍然一条异常都没有（畸形 payload 走的是 try/catch，不是抛）', (window.__ulamErrors || []).length === 0 && (window.__ulamConsoleErrors || []).length === 0, { errors: window.__ulamErrors, consoleErrors: window.__ulamConsoleErrors });
  rec('unlocked:"many" 经 count() 落 0，再回落到基线 1', c.store.unlocked === 1, { unlocked: c.store.unlocked, raw: (localStorage.getItem(KEY) || '').slice(0, 120) });
  rec('records 原样透传（storage.js 不发明字段）：那条合成纪录读回来了', (() => { const r = c.store.record('synthetic-partial'); return !!r && r.solved === true && r.best === 3 && r.plays === 7 && r.atPar === false; })(), c.store.record('synthetic-partial'));
  rec('daily:"nope"（字符串不是对象）读成空对象', JSON.stringify(c.store.daily) === '{}' && c.store.dailyDone('2026-09-27') === null, { daily: c.store.daily, done: c.store.dailyDone('2026-09-27') });
  rec('stats 缺的字段补 0、在场的那个留着（plays 0 / wins 2 / losses 0 / questions 0 / hints 0 / lies 0）', (() => { const st = c.store.stats; return st.plays === 0 && st.wins === 2 && st.losses === 0 && st.questions === 0 && st.hints === 0 && st.lies === 0; })(), c.store.stats);
  rec('totals() 在残缺档上照样算得出来：solved 1 / atPar 0 / plays 0 / wins 2 / losses 0', (() => { const t = c.store.totals(); return t.solved === 1 && t.atPar === 0 && t.plays === 0 && t.wins === 2 && t.losses === 0; })(), c.store.totals());
  const m4 = await MOD('js/core/storage.js');
  m4.solve('synthetic-partial', { questions: 9, par: 4, hints: 2, lies: 1, won: true });
  rec('残缺档上还能写：best 只降不升（9 问并不回 3）', (() => { const r = c.store.record('synthetic-partial'); return r.best === 3 && r.plays === 8 && r.solved === true; })(), c.store.record('synthetic-partial'));
  m4.solve('synthetic-partial', { questions: 2, par: 4, hints: 0, lies: 0, won: true });
  rec('写得更好就真的降下来，atPar 从 false 翻成 true', (() => { const r = c.store.record('synthetic-partial'); return r.best === 2 && r.atPar === true; })(), c.store.record('synthetic-partial'));
  rec('写完这一路，磁盘上的 JSON 也一起换了（同一条键，没有旁路）', (() => { const raw = JSON.parse(localStorage.getItem(KEY) || 'null'); return !!raw && raw.records['synthetic-partial'].best === 2 && raw.unlocked === 1; })(), (() => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return 'still junk'; } })());
  rec('半残档这一趟也没让点击路径开始搜索', c.searchNodes() === 0, { nodes: c.searchNodes() });
  const back = call(() => c.store.reset());
  rec('收尾的 reset 仍然不抛（这一段对磁盘做的都收干净了）', back.ok === true && back.v === true && localStorage.getItem(KEY) === null, { ret: back.v, raw: localStorage.getItem(KEY) });
  return { rows };
})()`;

async function saveScenario({ cdp, sessionId, runJS, sleep, waitShell, install, BASE }) {
  const rows = [];
  const rec = (name, pass, detail) => rows.push({
    test: name, pass: !!pass,
    detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)),
  });
  const grab = async (snippet, label) => {
    let v;
    try {
      v = await runJS(snippet);
    } catch (err) {
      const dumped = await runJS('JSON.stringify(window.__lastRows||[])').catch(() => '[]');
      const partial = JSON.parse(dumped);
      rows.push(...partial);
      rec(label + '：页内脚本抛了，剩下的断言没跑', false, String(err.message).slice(0, 300));
      return partial.length;
    }
    const r = (v && v.rows) || [];
    rows.push(...r);
    return r.length;
  };
  // A stable viewport: this suite is about bytes on disk, and a squished layout must not decide it.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 780, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send('Page.navigate', { url: BASE + '?save=a#/lot/7-1' }, sessionId);
  const upA = await waitShell(300);
  await install();
  rec('第一段：外壳在新 URL 上起来了（真文档，不是同文档改 hash）', upA === true, { url: BASE + '?save=a#/lot/7-1' });
  await grab(SAVE_A, '@save 前半（写入）');
  // A real document reload: only a different PATH can force one — a fragment-only navigate would be
  // a same-document navigation and would "prove" persistence for free.
  await cdp.send('Page.navigate', { url: BASE + '?save=b#/lot/7-1' }, sessionId);
  const upB = await waitShell(300);
  await install();
  rec('真 reload 之后 window.ulam 又装好了（?save=b 换的是 query，不是 fragment）', upB === true, null);
  await grab(SAVE_B, '@save 后半（reload 之后读回）');
  await cdp.send('Page.navigate', { url: BASE + '?save=c#/c/1' }, sessionId);
  const upC = await waitShell(300);
  await install();
  rec('坏档那一次重载，页面自己站起来了（readiness 轮询过了）', upC === true, null);
  await grab(SAVE_C, '@save 第三段（坏档降级）');
  await cdp.send('Page.navigate', { url: BASE + '?save=d#/c/2' }, sessionId);
  const upD = await waitShell(300);
  await install();
  rec('半残档那一次重载页面也站起来了（readiness 轮询过了）', upD === true, { url: BASE + '?save=d#/c/2' });
  await grab(SAVE_D, '@save 第四段（partial payload 降级）');
  await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
  return { rows };
}

// ---- @pointer: real mouse events, a real viewport override, a real reload -------------------------
async function pointerScenario({ cdp, sessionId, runJS, sleep, waitShell, install, BASE }) {
  const rows = [];
  const rec = (name, pass, detail) => rows.push({
    test: name, pass: !!pass,
    detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)),
  });
  const mouse = (type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons, clickCount: type === 'mousePressed' ? 1 : 0,
  }, sessionId);
  const click = async (p) => {
    await mouse('mousePressed', p.x, p.y, 1);
    await sleep(40);
    await mouse('mouseReleased', p.x, p.y, 0);
    await sleep(130);
  };
  const S = () => runJS('JSON.parse(JSON.stringify(window.ulam.state))');
  // The census lives on the page so it can be reinstalled after a reload; it copies the game's
  // canvas into a scratch context made WITH willReadFrequently, because repeatedly reading back the
  // game's own 2D context makes Chrome log a rendering warning and a dirty console is a failure.
  const INSTALL_CENSUS = `(() => {
    const cv = document.getElementById('board');
    const scratch = document.createElement('canvas');
    const sg = scratch.getContext('2d', { willReadFrequently: true });
    window.__census = () => {
      if (scratch.width !== cv.width || scratch.height !== cv.height) { scratch.width = cv.width; scratch.height = cv.height; }
      sg.clearRect(0, 0, scratch.width, scratch.height);
      sg.drawImage(cv, 0, 0);
      const d = sg.getImageData(0, 0, scratch.width, scratch.height).data;
      let lit = 0, warm = 0; const seen = new Set();
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 40) lit++;
        if (d[i] > 150 && d[i + 1] > 110 && d[i + 2] < d[i]) warm++;
        seen.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4) + ',' + (d[i + 3] >> 4));
      }
      return { lit, warm, colours: seen.size, w: scratch.width, h: scratch.height };
    };
    // A single-device-pixel read that also goes through the scratch context: the colour change is
    // evidence, and the game's own context is only ever read back ONCE per document by view.pixelOf.
    window.__px = (x, y) => {
      if (scratch.width !== cv.width || scratch.height !== cv.height) { scratch.width = cv.width; scratch.height = cv.height; }
      sg.clearRect(0, 0, scratch.width, scratch.height);
      sg.drawImage(cv, 0, 0);
      const d = sg.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    };
    return 1;
  })()`;
  const CENSUS = () => runJS('window.__census()');

  // ---- desktop geometry: the probes must agree with the box ------------------------------------
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1040, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
  await cdp.send('Page.navigate', { url: BASE + '?ptr=a#/lot/7-1' }, sessionId);
  rec('画布在这趟导航里量好了（waitShell 过了）', await waitShell(300) === true, null);
  await install();
  await runJS(INSTALL_CENSUS);
  await sleep(240);
  let st = await S();
  rec('真鼠标会话开在指定的那一关（7-1）', st.id === '7-1' && st.n === 7 && st.k === 1, { id: st.id, n: st.n, k: st.k, q: st.q });
  const geo = await runJS('window.ulam.geom()');
  const box = await runJS('window.ulam.boardBox()');
  const back = await runJS('({ w: document.getElementById("board").width, h: document.getElementById("board").height, dpr: Math.max(1, Math.min(3, window.devicePixelRatio || 1)) })');
  rec('geom 与 boardBox 报同一个盒子（列×行×格宽自洽）', geo.w === box.w && geo.h === box.h && geo.cols * geo.rows >= geo.n && geo.cell >= 18, { geo, box });
  rec('backing store = round(geom.w × dpr)、高同理，且都非零', back.w === Math.round(geo.w * back.dpr) && back.h === Math.round(geo.h * back.dpr) && back.w > 0 && back.h > 0, { back, cssW: geo.w, cssH: geo.h });
  const pts = await runJS('[1,2,3,4,5,6,7].map((i) => window.ulam.cellPoint(i))');
  const inside = (p) => p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
  rec('七个格子的探针中心都在盘内（一个都不越界）', pts.length === 7 && pts.every(inside), pts.map((p) => [p.x, p.y]));
  rec('cellPoint 报的格宽就是 geom.cell', pts.every((p) => p.cell === geo.cell), pts.map((p) => p.cell));
  rec('同一行相邻两格中心差 = cell + gap（网格算术与画出来的一致）', Math.abs((pts[1].x - pts[0].x) - (geo.cell + geo.gap)) <= 1 && Math.abs((pts[2].x - pts[1].x) - (geo.cell + geo.gap)) <= 1, { dx: pts[1].x - pts[0].x, want: geo.cell + geo.gap });
  rec('探针那一格的中心落在 cellXY 反算出来的位置上', Math.abs(pts[3].x - (box.x + geo.ox + (3 % geo.cols) * (geo.cell + geo.gap) + geo.cell / 2)) <= 1 && Math.abs(pts[3].y - (box.y + geo.oy + Math.floor(3 / geo.cols) * (geo.cell + geo.gap) + geo.cell / 2)) <= 1, { p: pts[3], ox: geo.ox, oy: geo.oy, cols: geo.cols });
  const led = await runJS('[0,1,2].map((i) => window.ulam.ledgerPoint(i))');
  rec('谎数账本的探针点也在盘内、并且一行三个递进', led.every((p) => inside(p)) && led[1].x > led[0].x && led[2].x > led[1].x && led[0].y === led[1].y, led);
  const cen0 = await CENSUS();
  rec('盘上真的有东西被画出来（非透明像素以千计、颜色不止一种）', cen0.lit > 2000 && cen0.colours >= 4, cen0);

  // ---- one real click toggles a cell, and the pixels say so ------------------------------------
  // view.pixelOf(id) reads the game's own context at round(cellXY × dpr) with y at 22% of the cell.
  // cellXY is pure integer arithmetic on geom{ox,oy,cell,gap,cols}, so the driver can rebuild the
  // exact device coordinate from geom alone and read the same pixel out of the scratch copy: if the
  // dpr math or the box math disagreed, the two reads would land on different pixels.
  const dprNow = back.dpr;
  const devOf = (g, id, dpr) => {
    const c0 = (id - 1) % g.cols, r0 = Math.floor((id - 1) / g.cols);
    const bx = g.ox + c0 * (g.cell + g.gap), by = g.oy + r0 * (g.cell + g.gap);
    return { x: Math.round((bx + g.cell / 2) * dpr), y: Math.round((by + g.cell * 0.22) * dpr), cssCenter: { x: bx + g.cell / 2, y: by + g.cell / 2 } };
  };
  const d4 = devOf(geo, 4, dprNow);
  rec('cellPoint(4) 减 boardBox() 就是 geom 的 cellXY 中心（探针、盒子、网格算术三件事说同一个点）', Math.abs(pts[3].x - box.x - d4.cssCenter.x) <= 1 && Math.abs(pts[3].y - box.y - d4.cssCenter.y) <= 1, { p: pts[3], box, want: d4.cssCenter, dev: [d4.x, d4.y], dpr: dprNow });
  const pxOff = await runJS(`window.__px(${d4.x}, ${d4.y})`);
  await click(pts[3]);
  st = await S();
  rec('真鼠标点一格：draft 里多了一个 4（不只是内部标志）', st.draft.join(',') === '4' && st.asked === 0, { draft: st.draft, asked: st.asked, line: st.line.slice(0, 60) });
  const pxOn = await runJS(`window.__px(${d4.x}, ${d4.y})`);
  rec('亮起来的格子在像素里真的换了颜色（同一个设备坐标，点前点后不同）', JSON.stringify(pxOff) !== JSON.stringify(pxOn), { at: [d4.x, d4.y], off: pxOff, on: pxOn });
  const probePx = await runJS('window.ulam.pixelOf(4)');
  rec('view.pixelOf(4) 读的就是那个设备像素：它的 dpr 换算与 geom/boardBox 算出来的坐标逐通道相同', JSON.stringify(probePx) === JSON.stringify(pxOn) && probePx.length === 4 && probePx[3] > 0 && probePx[3] <= 255, { pixelOf: probePx, scratch: pxOn, at: [d4.x, d4.y], dpr: dprNow });
  await click(pts[3]);
  st = await S();
  rec('再点一下熄灭（一个格子一个手势，toggle 可逆）', st.draft.length === 0, st.draft);
  await click(pts[0]); await click(pts[1]);
  st = await S();
  rec('两次点击亮两格：draft 是升序的两个 id', st.draft.join(',') === '1,2', st.draft);

  // ---- a real drag brushes a range -------------------------------------------------------------
  await runJS('window.ulam.clear()'); await sleep(90);
  await mouse('mousePressed', pts[1].x, pts[1].y, 1);
  await sleep(40);
  await mouse('mouseMoved', pts[4].x, pts[4].y, 1);
  await sleep(60);
  await mouse('mouseReleased', pts[4].x, pts[4].y, 0);
  await sleep(150);
  st = await S();
  rec('按住拖过三格就刷亮一整段（onBrush 走的是真指针路径）', st.draft.join(',') === '2,3,4,5', { draft: st.draft, line: st.line.slice(0, 60) });

  // ---- the buttons are real, at the points the driver computed ----------------------------------
  const askP = await runJS('window.ulam.buttonPoint("ask")');
  const beforeAsk = await S();
  await click(askP);
  st = await S();
  rec('在「问出去」的探针点上真点一下：一问出去了', st.asked === beforeAsk.asked + 1 && st.asked === 1, { asked: st.asked, before: beforeAsk.asked, vec: st.vec });
  const proofRows = await runJS('document.getElementById("prooflog").children.length');
  rec('证明抽屉多了一行，页脚把权重向量念出来', st.proof === 1 && proofRows === 1 && /候选/.test(await runJS('document.getElementById("prooffoot").textContent')), { proof: st.proof, rows: proofRows, foot: await runJS('document.getElementById("prooffoot").textContent').then((t) => t.slice(0, 80)) });
  const undoP = await runJS('window.ulam.buttonPoint("undo")');
  await click(undoP);
  st = await S();
  rec('「退回」按钮真能退：已问数与权重向量一起回到上一问之前', st.asked === 0 && JSON.stringify(st.vec) === JSON.stringify(beforeAsk.vec) && st.proof === 0, { asked: st.asked, vec: st.vec, want: beforeAsk.vec, proof: st.proof });
  const hintP = await runJS('window.ulam.buttonPoint("hint")');
  await click(hintP);
  st = await S();
  rec('「提示」按钮真在提示：hints 计数上去了、话落在 hintline', st.hints === 1 && /策略表|表外|指认/.test(st.line) && st.line.length > 4, { hints: st.hints, line: st.line.slice(0, 90) });
  const clearP = await runJS('window.ulam.buttonPoint("clear")');
  await click(pts[6]);
  await click(clearP);
  st = await S();
  rec('「清空」按钮把这一问的亮格熄干净（局面没动）', st.draft.length === 0 && st.asked === 0 && st.left === 7, { draft: st.draft, asked: st.asked, left: st.left });
  const restartP = await runJS('window.ulam.buttonPoint("restart")');
  await click(restartP);
  st = await S();
  rec('「重开」按钮把局回到干净开局（已问 0、亮格空、phase=ask、提示计数归零、结案幕布没拉起来）', st.asked === 0 && st.draft.length === 0 && st.phase === 'ask' && st.veil === false && st.hints === 0 && st.left === 7, { asked: st.asked, draft: st.draft, phase: st.phase, veil: st.veil, hints: st.hints, left: st.left });

  // ---- input that lands outside the board -------------------------------------------------------
  const outside = { x: box.x - 40, y: box.y + 20 };
  const before = await S();
  await click(outside);
  st = await S();
  rec('盘外坐标不动局面（draft/已问/向量全还原）', st.draft.join(',') === before.draft.join(',') && st.asked === before.asked && JSON.stringify(st.vec) === JSON.stringify(before.vec), { outside, draft: st.draft, asked: st.asked });
  const header = await runJS('(() => { const e = document.getElementById("totals"); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()');
  await click(header);
  st = await S();
  rec('点页眉也不算指认：局面一根手指都没动', st.draft.join(',') === before.draft.join(',') && st.phase === before.phase && st.asked === before.asked, { header, phase: st.phase });
  const gap = { x: pts[0].x, y: pts[0].y + geo.cell + Math.round(geo.gap / 2) + 2 };
  await click(gap);
  st = await S();
  rec('格间距里点一下只算一格（gap/2 的容差不双计：一次手势最多翻一个 id）', st.draft.length === 1 && st.draft[0] === 4, { gap, draft: st.draft, cell: geo.cell, gapSize: geo.gap });
  const pastLast = { x: pts[6].x, y: pts[6].y + Math.round(geo.cell / 2) + Math.round(geo.gap / 2) + 6 };
  await click(await runJS('window.ulam.buttonPoint("clear")'));
  await click(pastLast);
  st = await S();
  rec('最后一格下沿之外 6px 什么都不亮（canvas 之内、cellAt 的容差之外）', st.draft.length === 0 && st.asked === 0, { pastLast, draft: st.draft, box });
  rec('鼠标事件没有把搜索计数器弄起来（真点击路径 0 节点）', await runJS('window.ulam.searchNodes()') === 0, { nodes: await runJS('window.ulam.searchNodes()') });

  // ---- narrow mobile viewport, then a real reload under it --------------------------------------
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
  await sleep(340);
  const narrow = await runJS('(() => { const cv = document.getElementById("board"); const r = cv.getBoundingClientRect(); const g = window.ulam.geom(); const s = document.documentElement;'
    + ' return { rect: { w: Math.round(r.width), h: Math.round(r.height) }, geom: g, back: { w: cv.width, h: cv.height },'
    + ' dpr: Math.max(1, Math.min(3, window.devicePixelRatio || 1)),'
    + ' overflowX: s.scrollWidth - s.clientWidth, innerW: window.innerWidth,'
    + ' buttons: [...document.querySelectorAll("#ask,#clear,#undo,#hint,#restart")].map((b) => { const q = b.getBoundingClientRect(); return { id: b.id, w: Math.round(q.width), h: Math.round(q.height) }; }) }; })()');
  rec('窄屏 390×844：画布有真实 CSS 尺寸且不超宽', narrow.rect.w > 100 && narrow.rect.w <= 390 && narrow.geom.w === narrow.rect.w, { rect: narrow.rect, geom: { w: narrow.geom.w, h: narrow.geom.h, cell: narrow.geom.cell }, dpr: narrow.dpr });
  rec('窄屏按 dpr 2 放大 backing store（横纵像素＝CSS 尺寸×2）', narrow.dpr === 2 && narrow.back.w === narrow.geom.w * 2 && narrow.back.h === narrow.geom.h * 2 && narrow.back.w > 400, { back: narrow.back, geom: { w: narrow.geom.w, h: narrow.geom.h }, dpr: narrow.dpr });
  rec('窄屏不横向溢出（滚动宽度 == 客户宽度）', narrow.overflowX <= 1, { overflowX: narrow.overflowX, innerW: narrow.innerW });
  rec('窄屏下格宽不低于 view 的下限 18px、间距不低于 4px', narrow.geom.cell >= 18 && narrow.geom.gap >= 4, { cell: narrow.geom.cell, gap: narrow.geom.gap, cols: narrow.geom.cols, rows: narrow.geom.rows });
  rec('窄屏下五个按钮都还有可点尺寸', narrow.buttons.length === 5 && narrow.buttons.every((b) => b.w > 0 && b.h >= 24), narrow.buttons);
  const npts = await runJS('[1,7].map((i) => window.ulam.cellPoint(i))');
  const nbox = await runJS('window.ulam.boardBox()');
  rec('窄屏上探针中心仍然落在盘内', npts.every((p) => p.x >= nbox.x && p.x <= nbox.x + nbox.w && p.y >= nbox.y && p.y <= nbox.y + nbox.h), { npts, nbox });
  await click(await runJS('window.ulam.buttonPoint("restart")'));
  st = await S();
  rec('换屏幅之后先按真鼠标的「重开」清场（窄屏那段从干净开局起步）', st.draft.length === 0 && st.asked === 0 && st.hints === 0, { draft: st.draft, asked: st.asked, hints: st.hints });
  await click(npts[0]);
  st = await S();
  rec('窄屏上一格也照样点得亮', st.draft.join(',') === '1', { draft: st.draft, line: st.line.slice(0, 60) });
  // At 390x844 the button row can sit under the fold; CDP mouse coordinates are viewport-relative,
  // so the honest driver scrolls the control into view and re-reads its point before clicking.
  await runJS('window.ulam.els.ask.scrollIntoView({ block: "center" }); 1');
  await sleep(140);
  const askNarrow = await runJS('window.ulam.buttonPoint("ask")');
  const vp = await runJS('({ w: window.innerWidth, h: window.innerHeight })');
  rec('窄屏滚动之后「问出去」真的在视口里（按钮不被折叠藏掉）', askNarrow.x > 0 && askNarrow.x < vp.w && askNarrow.y > 0 && askNarrow.y < vp.h, { askNarrow, vp });
  await click(askNarrow);
  st = await S();
  rec('窄屏上一问也照样问得出去', st.asked === 1 && st.left <= 7 && st.draft.length === 0, { asked: st.asked, left: st.left, vec: st.vec, draft: st.draft, line: st.line.slice(0, 70), askDisabled: await runJS('window.ulam.els.ask.disabled') });
  const cenNarrow = await CENSUS();
  rec('窄屏上盘依然画得出来（不是空白 canvas）', cenNarrow.lit > 1200 && cenNarrow.colours >= 4, cenNarrow);

  // A reload UNDER the narrow override: the only proof that the backing store is measured again
  // instead of inheriting the previous layout's zeros.
  await cdp.send('Page.navigate', { url: BASE + '?ptr=narrow#/lot/7-1' }, sessionId);
  rec('窄屏重载：waitShell 过了（外壳在新文档里重新量了盘）', await waitShell(300) === true, null);
  await install();
  await runJS(INSTALL_CENSUS);
  await sleep(280);
  const after = await runJS('(() => { const cv = document.getElementById("board"); const g = window.ulam.geom(); const r = cv.getBoundingClientRect();'
    + ' return { w: cv.width, h: cv.height, geom: g, css: { w: Math.round(r.width), h: Math.round(r.height) }, innerW: window.innerWidth,'
    + ' dpr: Math.max(1, Math.min(3, window.devicePixelRatio || 1)), box: window.ulam.boardBox() }; })()');
  rec('窄屏重载之后 backing store 的宽仍然 > 0（不是 0×0 的死 canvas）', after.w > 0 && after.h > 0 && after.w >= after.css.w, { w: after.w, h: after.h, css: after.css });
  rec('窄屏重载后 geom / boardBox / CSS 盒三者一致，dpr 仍是 2', after.geom.w === after.box.w && after.geom.w === after.css.w && after.dpr === 2 && after.w === after.geom.w * 2, { geom: { w: after.geom.w, h: after.geom.h }, dpr: after.dpr, back: { w: after.w, h: after.h }, box: after.box, css: after.css });
  const nd4 = devOf(after.geom, 1, after.dpr);
  const pxScratch = await runJS(`window.__px(${nd4.x}, ${nd4.y})`);
  const pxReload = await runJS('window.ulam.pixelOf(1)');
  rec('窄屏重载后 pixelOf(1) 落在新 backing store 的真像素上：与 geom×dpr2 算出的设备坐标逐通道相同（不是 0×0 的死画布）', pxReload.length === 4 && pxReload[3] > 0 && JSON.stringify(pxReload) === JSON.stringify(pxScratch) && nd4.x < after.w && nd4.y < after.h, { pixelOf: pxReload, scratch: pxScratch, at: [nd4.x, nd4.y], back: { w: after.w, h: after.h }, dpr: after.dpr });
  await click(await runJS('window.ulam.cellPoint(3)'));
  st = await S();
  rec('窄屏重载后手指仍然能玩', st.draft.join(',') === '3' && st.id === '7-1', { draft: st.draft, id: st.id });
  rec('窄屏重载这一趟没有页内异常', (await runJS('window.__ulamErrors.length')) === 0, { errors: await runJS('window.__ulamErrors') });

  // ---- restore: the desktop layout comes back without a reload ----------------------------------
  await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
  await sleep(320);
  const wide = await runJS('(() => { const g = window.ulam.geom(); const cv = document.getElementById("board");'
    + ' return { geom: { w: g.w, h: g.h, cell: g.cell }, dpr: Math.max(1, Math.min(3, window.devicePixelRatio || 1)),'
    + ' css: Math.round(cv.getBoundingClientRect().width), back: cv.width }; })()');
  rec('撤掉设备覆盖后布局长回去（geom 重新量了 CSS 盒、backing store 跟着缩）', wide.css > narrow.rect.w && wide.css >= 300 && wide.css === wide.geom.w && wide.back === Math.round(wide.geom.w * wide.dpr) && wide.dpr === 1, wide);
  await runJS('window.ulam.store.reset(); 1');
  await sleep(80);

  return { rows };
}

main().catch((err) => {
  console.error('playtest failed: ' + ((err && err.stack) || err));
  process.exit(1);
});
