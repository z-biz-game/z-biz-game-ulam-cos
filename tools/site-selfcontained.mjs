#!/usr/bin/env node
// 产物自洽闸：pages.yml 上线前那一步的全部逻辑搬到这里；CI 与本地整闸调同一支脚本。
//
// 为什么要有这一支：这些断言以前只活在 pages.yml 的 `run:` 里，本仓的每一道本地闸一次都没跑过
// 它们。它们于是连续红了三次推送而没人知道——build job 一红就没有 artifact，deploy job 无事可做，
// 线上站点冻在最后一次成功的那份产物上：后面的 commit 只存在于 git 里，不存在于线上。
// ci.yml 的 W4 早就为「只有部署时才查」道过歉，这一条是同一种坏法的另一半：只有 Pages 才查。
//
// 五条断言，各管一种 deploy-set 看不见的坏法（引用可达、本站前缀、位图尺寸由那一道闸负责，
// 这里一条都不重抄）：
//   S-MOD   产物里的模块说明符只许自相对（`./`、`../` 打头）。一个裸包名或 `npm:` 前缀就说明
//           「零依赖」在发货形态下是假的；deploy-set 的 SELF_REL 只认带点的写法，裸名从它眼皮
//           底下过去，而本仓根跑的是同一份代码，本地永远发现不了。
//   S-夹带  产物里不许有 server.cjs / tools / electron。清单只要多一行 `cp -r .` 就把它们一起
//           上线，而 deploy-set 只问「页面要的东西在不在」，从不问「不该在的东西在不在」。
//   S-页面  产物里那份 index.html 必须还带着 <canvas>：取径全齐的空壳页也是"部署成功"。
//   S-接线  Pages、CI、本地整闸三条路都要调到本闸。这一闸的出身问题就是"只有 Pages 才跑"，
//           所以它最怕的坏法是自己又变回只在某一条路上跑。
//   S-外链  页面字节里不许出现 http(s) 资源。唯一豁免：og:image / twitter:image 里那一条，且
//           它必须落在 README 声明的本站前缀下、且那张图真在产物里——抓取器读的是别人页面上的
//           字符串，没有 base URI 可补，所以那句话只能写成绝对 URL（它是否合格由 R7 负责，
//           这里只承认这一种形状，别的一种都不认）。
//
// 用法：node tools/site-selfcontained.mjs            # 自己按清单拷一份临时产物（本地/CI 单元作业）
//       node tools/site-selfcontained.mjs _site      # 查即将上传的那一份（pages.yml）
//       node tools/site-selfcontained.mjs --selftest # 当场把每一类打红一次，证明这三条会咬人
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSEMBLE = 'tools/assemble-site.sh';
// 全绿时实际跑的断言条数。钉住它，「解析口径被改坏到什么都不查」就不可能是绿的：
// S-MOD 与 S-外链 的条数由产物自己决定（每份文本、每条说明符一行），所以产物没变而条数掉了，
// 只能是读它的那只手坏了。改页面会改这个数——那正是要它变的时候，由 --selftest 的基线跑当场
// 报出实际值，不必靠记性。
const EXPECT_ROWS = 46;

// 只查文本字节：位图不是"外链"，它由 deploy-set 的 P 段按 IHDR 量。
const TEXT_EXT = ['.js', '.mjs', '.cjs', '.css', '.html', '.webmanifest', '.json'];
const CARRIED = ['server.cjs', 'tools', 'electron'];

const readIf = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const files = [];
const walk = (d, base) => {
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n);
    const rel = base ? base + '/' + n : n;
    if (fs.statSync(p).isDirectory()) walk(p, rel);
    else if (TEXT_EXT.some((e) => n.endsWith(e))) files.push(rel);
  }
};

// Pages 的项目站点挂在 https://<org>.github.io/<slug>/ 下面。前缀的来源只认仓里那一份声明
// （README），与 deploy-set 的 R7 用同一把尺子——两处各自硬编一次 slug，就是又抄了一份会漂的副本。
const PAGES = ((readIf(path.join(ROOT, 'README.md')) || '')
  .match(/https?:\/\/[A-Za-z0-9._-]+\.github\.io\/[A-Za-z0-9._-]+/) || [])[0] || '';

let rows = 0;
const fails = [];
const ok = (cond, label, detail) => {
  rows += 1;
  if (!cond) fails.push(`${label}${detail ? '  ' + detail : ''}`);
};

function run(site) {
  files.length = 0;
  walk(site, '');
  const present = (r) => fs.existsSync(path.join(site, r)) && fs.statSync(path.join(site, r)).size > 0;
  const html = readIf(path.join(site, 'index.html')) || '';

  // ---- S-夹带 ----
  for (const c of CARRIED) {
    ok(!fs.existsSync(path.join(site, c)), `S-夹带 产物里没有 ${c}`,
      `产物里有 ${c}：它只该跑在开发机上，上线就是把自己的源码目录摊给访客`);
  }

  // ---- S-页面：产物里那份 index.html 仍是会画东西的页面 ----
  // 「文件在不在」不在这里重抄：上一步 pages.yml 已经拿同一个 _site 跑过 deploy-set 的取径图，
  // 每条引用都要在产物里且非 0 字节。这里只补那一道闸不问的一句：它是个页面，不是一份空壳。
  ok(/<canvas/.test(html), 'S-页面 产物的 index.html 里有 <canvas>',
    '上线的 index.html 没有画板：404 -shaped success 的另一种写法——一切取径都齐，玩家看到的是一片空白');

  // ---- S-接线：这一闸必须同时被 Pages、CI 与本地整闸调到 ----
  // 这一闸的全部理由就是"它只在 Pages 跑"，所以它最怕的坏法是自己又变回只在某一条路上跑。
  // 认的是**调用那一行**，注释里出现脚本名不算——那条假路径的教训写在 deploy-set 的 W2 里。
  const called = (rel, re) => {
    const t = readIf(path.join(ROOT, rel)) || '';
    return t.split('\n').some((l) => !/^\s*#/.test(l) && re.test(l));
  };
  ok(called('.github/workflows/pages.yml',
    /^[ \t]*run:[ \t]*node[ \t]+tools\/site-selfcontained\.mjs[ \t]+\S/),
    'S-接线 pages.yml 调的是本闸', 'Pages 上线前没有 node tools/site-selfcontained.mjs <dir>：这一步被手抄的 shell 顶替了');
  ok(called('.github/workflows/ci.yml',
    /^[ \t]*run:[ \t]*node[ \t]+tools\/site-selfcontained\.mjs[ \t]*$/),
    'S-接线 ci.yml 调的是本闸（无参形态：自己按清单拷）',
    'ci.yml 没有这一步：坏产物要等到 push 到 main、Pages 才开始报红，而那时 merge 已经过了');
  // 认的是**行首就是这条命令**：`  : # node tools/…` 这种把调用埋进行尾注释的写法必须不算调过。
  // 只 grep 字符串的接线断言会被一句散文喂绿——那条假路径的教训写在 deploy-set 的 W2 里。
  const vlines = (readIf(path.join(ROOT, 'tools/verify.sh')) || '')
    .split('\n').filter((l) => /^[ \t]*node tools\/site-selfcontained\.mjs\b/.test(l));
  ok(vlines.some((l) => !l.includes('--selftest')),
    'S-接线 本地整闸 verify.sh 跑的是这一闸（不是它的台架）',
    'verify.sh 没有 node tools/site-selfcontained.mjs：这道闸又变成只有 CI 才跑，而 CI 独有的门正是这一支脚本的出身问题');
  ok(vlines.some((l) => l.includes('--selftest')),
    'S-接线 本地整闸跑的是这一闸的台架',
    'verify.sh 没有 node tools/site-selfcontained.mjs --selftest：钉住的 45 条没人再证明它们真的会红');


  // ---- S-MOD：模块说明符只许自相对 ----
  let specs = 0;
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    const code = readIf(path.join(site, f)) || '';
    for (const m of code.matchAll(/from\s+['"]([^'"\n]+)['"]/g)) {
      specs += 1;
      const s = m[1];
      ok(/^[./]/.test(s), `S-MOD ${f} 的说明符 ${s} 是自相对写法`,
        '产物里没有 node_modules：裸包名说明符意味着这份产物要先装依赖（零依赖承诺作废），' +
        '而打头是 / 或域名的那条在 Pages 的 /<slug>/ 前缀下会跳出站点');
    }
  }
  ok(specs > 0, `S-MOD 至少解析出一条说明符（0 条=没读到，不是全都齐）`, '实际 ' + specs + ' 条');

  // ---- S-外链：整份产物只许自给自足 ----
  const exempt = new Set();
  for (const m of html.matchAll(/<meta\s+(?:property="og:image"|name="twitter:image")\s+content="(https?:\/\/[^"]+)"/g)) {
    const v = m[1];
    const tail = decodeURIComponent(v.slice(PAGES.length + 1));
    if (PAGES && v.startsWith(PAGES + '/') && tail && present(tail)) exempt.add(v);
    else ok(false, 'S-外链 社交卡那条绝对 URL 不成立', `${v} · 本站前缀 ${PAGES || '(README 里解析不到)'} · 产物里没有它指的图`);
  }
  let urls = 0;
  for (const f of files) {
    const t = readIf(path.join(site, f)) || '';
    for (const m of t.matchAll(/https?:\/\/[^\s"'<>()]+/g)) {
      const u = m[0];
      // 命名空间声明不是取径：`xmlns='http://www.w3.org/2000/svg'` 没有一次网络请求。
      // 认的是**它挂在哪**，不是它含不含 w3.org——按子串放行会让 `url(https://www.w3.org/x.png)`
      // 这种真的远程图一起过关，而那条子串正是旧 pages.yml 里那一行的写法。
      if (/xmlns(?::[A-Za-z]+)?\s*=\s*["']?$/.test(t.slice(Math.max(0, m.index - 24), m.index))) continue;
      urls += 1;
      ok(exempt.has(u), `S-外链 ${f} 里没有远程资源`, `${u}：访客在飞机上打开也要能画图，一条外链就是一次白屏`);
    }
  }
  ok(files.length > 0, 'S-外链 至少扫到一份文本（0 份=产物是空的）', '实际 ' + files.length + ' 份');
}

const argv = process.argv.slice(2);

if (argv[0] === '--selftest') {
  // 阴性自证：把仓拷进临时目录，每一类各下一一刀，要求闸**点名**吃掉那一刀；再来一刀不该
  // 生效的（把 w3.org 的命名空间声明写成外链的样子），要求它按不生效算——豁免不是一条后门，
  // 它自己有靶子。刀都打在副本上，原仓只读。
  const skip = (rel) => rel.split('/').some((s) => s === '.git' || s === 'node_modules' ||
    s === '.qoder' || s.startsWith('_tmp-') || s === '_scratch');
  const work = [];
  const fresh = () => {
    const w = fs.mkdtempSync(path.join(os.tmpdir(), 'site-self-knife-'));
    work.push(w);
    const dst = path.join(w, 'repo');
    fs.cpSync(ROOT, dst, { recursive: true, filter: (src) => !skip(path.relative(ROOT, src) || '') });
    execFileSync('bash', [path.join(dst, ASSEMBLE), path.join(dst, 'site')], { stdio: 'pipe' });
    return dst;
  };
  const gate = (dir) => {
    let out = '';
    try {
      out = execFileSync(process.execPath, ['tools/site-selfcontained.mjs', 'site'],
        { cwd: dir, stdio: 'pipe' }).toString();
      return { rc: 0, out };
    } catch (e) {
      return { rc: e.status === undefined ? 1 : e.status,
        out: ((e.stdout || '') + (e.stderr || '')).toString() };
    }
  };
  const plant = (dir, rel, needle, repl) => {
    const p = path.join(dir, rel);
    const t = fs.readFileSync(p, 'utf8');
    const hits = t.split(needle).length - 1;
    if (hits !== 1) throw new Error(`针 ${JSON.stringify(needle).slice(0, 60)} 在 ${rel} 里命中 ${hits} 次（要 1 次）`);
    fs.writeFileSync(p, t.replace(needle, repl));
  };
  let bad = 0;
  const knife = (name, apply, expect) => {
    const dir = fresh();
    apply(dir);
    const r = gate(dir);
    const named = r.out.split('\n').some((l) => l.startsWith('  FAIL') && l.includes(expect));
    if (r.rc === 0) { console.log(`  BAD ${name}：刀打下去闸还是绿的`); bad = 1; }
    else if (!named) { console.log(`  BAD ${name}：红了但没点名 ${expect}\n${r.out}`); bad = 1; }
    else console.log(`  ok  ${name} → rc=${r.rc} · ${expect}`);
  };
  // 基线：副本没挨刀时必须全绿，否则下面每一刀都可能是搭了别人的红。
  const base = fresh();
  const b = gate(base);
  if (b.rc !== 0) { console.log('  BAD 基线副本不绿，台架没有起点\n' + b.out); bad = 1; }
  else console.log('  ok  基线 ' + (b.out.match(/rows: \d+ fail: 0/) || [''])[0]);
  knife('K1 裸包名说明符', (d) => plant(d, 'site/js/main.js', "from './core/game.js'", "from 'game'"), 'S-MOD');
  knife('K2 产物夹带服务器', (d) => fs.writeFileSync(path.join(d, 'site', 'server.cjs'),
    'module.exports = 1;\n'), 'S-夹带');
  knife('K2b 上线的 index.html 没有画板', (d) => plant(d, 'site/index.html', '<canvas', '<div'), 'S-页面');
  knife('K3 样式里的远程图', (d) => fs.appendFileSync(path.join(d, 'site', 'css', 'game.css'),
    '\n.bg-hack { background: url(https://cdn.example.com/x.png); }\n'), 'S-外链');
  // 两条社交卡各下一刀。针各自必须唯一：og:image 与 twitter:image 的 content 串在这一仓里长得
  // 一模一样，不带上各自的属性名就打不准——而"打不准"在台架里等于"这一类没人证明过"。
  knife('K4 og:image 的本站前缀抄错', (d) => plant(d, 'site/index.html',
    'property="og:image" content="https://z-biz-game.github.io/z-biz-game-ulam-cos/icons/icon-512.png"',
    'property="og:image" content="https://z-biz-game.github.io/z-biz-game-ulam-xos/icons/icon-512.png"'), 'S-外链');
  knife('K4b twitter:image 指的图不在产物里', (d) => plant(d, 'site/index.html',
    'name="twitter:image" content="https://z-biz-game.github.io/z-biz-game-ulam-cos/icons/icon-512.png"',
    'name="twitter:image" content="https://z-biz-game.github.io/z-biz-game-ulam-cos/icons/nope.png"'), 'S-外链');
  // 反空转（一）：命名空间声明真的存在，而且闸确实放行它——往产物里再加一条内联 SVG 的 xmlns，
  // rc 必须还是 0。这条若红了，说明放行规则根本没生效，K6 的"会咬"也就无从谈起。
  const green = (name, apply) => {
    const dir = fresh();
    apply(dir);
    const r = gate(dir);
    if (r.rc !== 0) { console.log(`  BAD ${name}：不该红的刀红了\n${r.out}`); bad = 1; }
    else console.log(`  ok  ${name} → 按不生效算`);
  };
  green('K5 内联 SVG 的 xmlns 不是外链', (d) => fs.appendFileSync(path.join(d, 'site', 'index.html'),
    "<svg xmlns='http://www.w3.org/2000/svg' width='0' height='0'></svg>\n"));
  // 反空转（二）：w3.org 这个主机名本身不是通行证。旧 pages.yml 用的是 `grep -v w3.org`，
  // 这一刀打的是它放过去的那一种——真取径的远程图，主机名恰好是 w3.org。
  knife('K6 拿 w3.org 当幌子的远程图', (d) => fs.appendFileSync(path.join(d, 'site', 'css', 'game.css'),
    '\n.bg-w3 { background: url(https://www.w3.org/Icons/water.png); }\n'), 'S-外链');
  // 这一闸的出身问题就是"只有 Pages 才跑"，所以接线本身要有刀：把本地整闸那一句注释掉，
  // S-接线 必须点名。没有这一刀，三条接线断言只是三句对当前文本的转述，改天删掉一步没人拦。
  knife('K7 本地整闸不再调这一闸', (d) => plant(d, 'tools/verify.sh',
    '  node tools/site-selfcontained.mjs || FAILED=1',
    '  : # node tools/site-selfcontained.mjs || FAILED=1'), 'S-接线');
  knife('K7b 本地整闸只跑台架、不跑闸', (d) => plant(d, 'tools/verify.sh',
    '  node tools/site-selfcontained.mjs --selftest || FAILED=1',
    '  : # node tools/site-selfcontained.mjs --selftest || FAILED=1'), 'S-接线');
  for (const w of work) fs.rmSync(w, { recursive: true, force: true });
  process.exit(bad ? 1 : 0);
}

let site;
let tmp = null;
if (argv[0]) {
  site = path.resolve(argv[0]);
  if (!fs.existsSync(path.join(site, 'index.html'))) {
    console.log('FATAL 传进来的产物目录里没有 index.html：' + site);
    console.log('rows: 0');
    process.exit(1);
  }
} else {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-self-'));
  site = tmp;
  try {
    execFileSync('bash', [path.join(ROOT, ASSEMBLE), site], { stdio: 'pipe' });
  } catch (e) {
    console.log('FATAL assemble 失败：' + (e.stderr || e.message).toString().trim());
    console.log('rows: 0');
    process.exit(1);
  }
}
try {
  run(site);
} finally {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}

for (const f of fails) console.log('  FAIL ' + f);
console.log(`产物自洽：${rows} 条断言，扫描 ${files.length} 份文本 · 产物 ${tmp ? '本闸按清单现拷的临时副本' : path.relative(ROOT, site)}`);
console.log('rows: ' + rows + ' fail: ' + fails.length);
if (rows !== EXPECT_ROWS) {
  console.log(`  FAIL 断言条数 ${rows} 与钉住的 ${EXPECT_ROWS} 不一致`);
  process.exit(1);
}
process.exit(fails.length ? 1 : 0);
