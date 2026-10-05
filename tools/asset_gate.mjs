#!/usr/bin/env node
// 资产闸门：node tools/asset_gate.mjs —— 不启浏览器、不联网，只回答一个问题：
// 「index.html / manifest / sw.js 里承诺给玩家的每一张图，盘上是不是真的、是不是真位图、尺寸对不对」。
//
// 为什么要有它：占位符资产（0 字节、SVG 冒充 PNG、写着 192 实际 64）在字符串扫描里和真资产长得
// 一模一样，只有读 IHDR 才分得开。商店截图与 iOS 添加主屏就死在这一条上。
// 这里刻意不 import 任何三方包：PNG 的 IHDR 是固定偏移的两个 big-endian uint32，手读即可。
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const problems = [];
const checked = [];

function png(path) {
  const abs = resolve(ROOT, path);
  if (!existsSync(abs)) { problems.push(`${path}: 盘上没有这个文件（被 HTML/manifest/SW 引用）`); return null; }
  const size = statSync(abs).size;
  if (size === 0) { problems.push(`${path}: 0 字节占位符`); return null; }
  const buf = readFileSync(abs);
  const magic = buf.subarray(0, 8).toString('hex');
  if (magic !== '89504e470d0a1a0a') {
    const head = buf.subarray(0, 64).toString('utf8').replace(/\s+/g, ' ').slice(0, 40);
    problems.push(`${path}: 不是 PNG（magic=${magic}，开头 "${head}"）——SVG/文本冒充位图就是这么露馅的`);
    return null;
  }
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  checked.push({ path, size, w, h });
  return { w, h, size };
}

// 1) index.html 里引用的每一条本地资源：link href / script src / og:image / twitter:image
const html = read('index.html');
const refs = new Set();
// content= 里的 og:image 是部署后的绝对 URL，所以两种写法都要收，并归一化回仓内相对路径。
function rel(v) {
  // 绝对 URL（社交卡必须是绝对的）剥掉协议+域名后按仓内路径校验；相对路径直接收。
  if (/^(?:https?:)?\/\//.test(v)) {
    const m = /\/((?:assets|css|js)\/[^"']+|favicon\.ico|manifest\.webmanifest|sw\.js)$/.exec(v.replace(/^(?:https?:)?\/\/[^/]+/, ''));
    return m ? m[1] : null;
  }
  const m = /^((?:assets|css|js)\/[^"']+|favicon\.ico|manifest\.webmanifest|sw\.js)$/.exec(v);
  return m ? m[1] : null;
}
for (const m of html.matchAll(/(?:href|src|content)="([^"]+)"/g)) { const r = rel(m[1]); if (r) refs.add(r); }
// 2) manifest 的 icons/shortcuts 与 sw.js 的 SHELL 预缓存清单
const manifest = JSON.parse(read('manifest.webmanifest'));
for (const i of manifest.icons || []) refs.add(i.src.replace(/^\.\//, ''));
for (const s of manifest.shortcuts || []) for (const i of s.icons || []) refs.add(i.src.replace(/^\.\//, ''));
const shell = (read('sw.js').match(/const SHELL = \[([\s\S]*?)\];/) || [, ''])[1]
  .split('\n').map((l) => (l.match(/'([^']+)'/) || [])[1]).filter(Boolean)
  .map((p) => p.replace(/^\.\//, '')).filter((p) => p.startsWith('assets/'));
for (const p of shell) refs.add(p);
// 3) 画布里真的 drawImage / createPattern 的那两张
for (const m of read('js/view.js').matchAll(/grab\('([^']+)'/g)) refs.add(m[1]);

const byPath = {};   // 谓词按路径下标读，所以是普通对象不是 Map
for (const p of [...refs].sort()) {
  if (!p.endsWith('.png')) continue;
  const info = png(p);
  if (info) byPath[p] = info;
}

// 逐条硬要求：不是「存在」，而是「够用」
const need = [
  ['apple-touch-icon ≥180', (c) => (c['assets/icons/apple-touch-icon.png'] || { w: 0 }).w >= 180],
  ['favicon 有 ≥180 的真 PNG', (c) => [...Object.entries(c)].some(([p, i]) => /favicon/.test(p) && i.w >= 180)],
  ['PWA 192', (c) => (c['assets/icons/icon-192.png'] || { w: 0 }).w === 192],
  ['PWA 512', (c) => (c['assets/icons/icon-512.png'] || { w: 0 }).w === 512],
  ['maskable 512', (c) => (c['assets/icons/maskable-512.png'] || { w: 0 }).w === 512],
  ['og 社交卡 1200x630', (c) => { const i = c['assets/art/og-card.png'] || { w: 0, h: 0 }; return i.w === 1200 && i.h === 630; }],
  ['游戏内纹理/精灵各至少一张被 view 引到', (c) => Object.keys(c).filter((p) => p.startsWith('assets/art/')).length >= 2],
];
for (const [label, ok] of need) if (!ok(byPath)) problems.push(`${label} —— 实测不满足`);

// favicon.ico：ICO 容器不是 PNG，单独验它确实打包了多尺寸
const ico = resolve(ROOT, 'favicon.ico');
if (existsSync(ico)) {
  const b = readFileSync(ico);
  const n = b.readUInt16LE(4);
  if (b.subarray(0, 4).toString('hex') !== '00000100' || n < 2) problems.push(`favicon.ico: 不是多尺寸 ICO（reserved/type/count 读出来 ${b.subarray(0, 4).toString('hex')} / ${n}）`);
  else checked.push({ path: 'favicon.ico', size: b.length, w: `${n} sizes`, h: 'ico' });
} else problems.push('favicon.ico: 盘上没有（浏览器会去要它，404 脏 console 闸门）');

// 声称的尺寸要和 IHDR 一致，不然 manifest 在骗安装器
for (const i of manifest.icons || []) {
  const info = byPath[i.src.replace(/^\.\//, '')];
  if (info && i.sizes !== `${info.w}x${info.h}`) problems.push(`manifest 声明 ${i.src} 为 ${i.sizes}，IHDR 实测 ${info.w}x${info.h}`);
}
// 社交卡要绝对 URL：爬虫不跑 JS，相对路径在 og:image 上等于没有图
if (/<meta property="og:image" content="[^"]*\/?assets\/art\/og-card\.png"/.test(html) && !/content="https?:\/\//.test(html.match(/property="og:image"[^>]*/)?.[0] || '')) {
  problems.push('og:image 是相对路径：社交爬虫不解析 JS，卡片会没有图（需要绝对 URL）');
}

const bytes = checked.reduce((a, c) => a + (c.size || 0), 0);
console.log(`asset_gate: 检查 ${checked.length} 个资产 / ${bytes} 字节，被引用面 = index.html + manifest(${(manifest.icons || []).length} icons, ${(manifest.shortcuts || []).length} shortcuts) + sw SHELL(${shell.length}) + view.js grab()`);
for (const c of checked) console.log(`  OK  ${c.path} ${c.w}x${c.h} ${c.size}B`);
if (problems.length) { for (const p of problems) console.log(`  FAIL ${p}`); console.log(`asset_gate: ${problems.length} 项不成立`); process.exit(1); }
console.log('asset_gate: 全部成立（真 PNG、尺寸对得上声明、无 0 字节、无 SVG 冒充）');
