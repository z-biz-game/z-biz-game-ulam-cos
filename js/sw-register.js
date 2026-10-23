'use strict';
// service worker 注册：只在 http/https 下做。
//
// file:// 直接打开（双击 index.html、或把仓库 zip 解开看）时 navigator.serviceWorker
// 要么不存在、要么 register 必抛 SecurityError。那不是玩家的错，不该在控制台上留一条
// 红字，更不该让后面真正该跑的 main.js 因为这条未捕获异常被中断。
//
// 三条实测约束钉在这里——
//   1) file:// 下不注册（SW 在 file: 上必然 reject，抛出来的未捕获异常会脏了 console 闸门）；
//   2) 路径按文档解析（相对 'sw.js'），因为 Pages 把仓挂在 /<repo>/ 前缀下，绝对路径会 404；
//   3) 注册失败静默降级：不能安装不等于不能玩。
//
// 为什么它住在自己的文件里而不是内联在 index.html 的 <script> 块里：部署集闸的引用走查
// 从 index.html 的 href/src 出发，凡解析出来是 .js 的就把那一站也扫一遍。注册语句作为独立
// 一站，"sw.js 在不在产物里"才会被真的量到；内联的那段走查读不到，sw.js 掉了也没有一条
// 断言会红。
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => {
    try {
      navigator.serviceWorker.register('sw.js', { scope: './' })
        .catch(() => { /* 离线能力是附加物 */ });
    } catch (err) { /* 老浏览器没有 serviceWorker.register */ }
  });
}
