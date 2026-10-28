// 离线与可安装的那一半。两条不变式写死在这里，因为它们各自对应一个真出过的事故：
//
//   1) **同源子资源网络优先，失败才退缓存。** 手工 VERSION + cache-first 会把 js/css 永久钉死在
//      旧版：出新 HTML 配旧 JS，页面直接鬼状态（本农场另一仓实测踩过）。所以 fetch 处理器对
//      同源 GET 一律先问网络，只有网络失败（离线）才回缓存命中。
//   2) **cache 名带 VERSION，activate 清掉所有旧桶。** 版本换了还不清，缓存会越积越大且永远命中旧壳。
//
// file:// 下这段代码根本不会被注册（index.html 的注册脚本按 protocol 挡掉了），所以这里不需要
// 再对 file: 特判；WorkerGlobalScope 里没有 document，也不许引用。
const VERSION = 'ulam-v2026.10.05-1';
const CACHE = `ulam-cache-${VERSION}`;

// 装不上全部资源也没关系：addAll 失败只记一次，不阻塞 install（否则一个 404 就把可安装性整个废掉）
const SHELL = [
  './',
  './index.html',
  './css/game.css',
  './css/studio.css',
  './js/main.js',
  './js/sw-register.js',
  './js/haptics.js',
  './js/view.js',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/favicon-180.png',
  './assets/icons/favicon-48.png',
  './assets/icons/favicon-32.png',
  './favicon.ico',
  './assets/art/board-grain.png',
  './assets/art/secret-seal.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      await Promise.all(SHELL.map(async (href) => {
        try { await cache.add(new Request(href, { cache: 'reload' })); } catch (err) { /* 少一个不致命 */ }
      }));
    } catch (err) {
      /* 缓存打不开（配额 / 隐私模式）：仍然让 SW 装上，页面走纯网络 */
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) { try { await caches.delete(key); } catch (err) { /* 已被别的版本清掉 */ } }
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (!req || req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;      // 第三方一律不代理、不缓存
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res && res.ok && res.type === 'basic') {
      try { await cache.put(req, res.clone()); } catch (err) { /* 不能缓存的响应（blob / 太大）忽略 */ }
    }
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    if (req.mode === 'navigate' || req.destination === 'document') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    throw err;                                          // 离线且没兜底：让页面自己报错，不假绿
  }
}
