# 交付说明 · 谎话藏数 ULAM

一句话：20 问猜数、对手可以撒 k 次谎；屏幕上并排印"体积界"和"精确值"，玩家打的正是这两者
不相等的那道缝。判定全部来自构建期烘好的表，点击路径不花一个 DP 节点。

## 1. 功能 → 文件

| 功能 | 文件 | 说明 |
| --- | --- | --- |
| 权重状态、答案记账、`realizable`、`formatState/describeState/fresh` | `js/core/state.js` | 一局的事实只有这份结构；不 import 求解器 |
| 精确 DP：`win(a,q)` 递归、`par(a)`、节点计数器、`BudgetError` | `js/core/solve.js` | 路线 1；构建期与测试，发货页面里永不调用 |
| Berlekamp 体积界 `V(a,q)`、`boundPar`、余量打印口径 `printMargin(Value)` | `js/core/volume.js` | 路线 2；纯算术 |
| 具体候选集暴力（不聚合权重向量） | `js/core/brute.js` | 路线 3；用来反证"可合并成 k+1 格"这个假设 |
| 下棋用的应答机（全函数 / 不破可实现性 / 确定性；剩余难度尽量大） | `js/core/adversary.js` | 不 import `solve.js`（DESIGN 4） |
| 基线策略（贪心等），给难度一个可比参照 | `js/core/greedy.js` | 构建期度量 `measureStrategies` |
| 扫描计数：`volumeOk / disagree / pack / unmeasured / beyondDepth / smallest / smallestPack` | `js/core/table.js` | 口径的唯一定义处，浏览器开机重跑一次 |
| 关卡库、档位窗口、按候选数分带、`minqTable`、`greedyReport` | `js/core/library.js` | 全部表查询 |
| 战役 14 关 / 每日一题 / 随机档出题（只在量出的 par 落进窗口时出货） | `js/core/make.js` | `gentle/standard/hard/brutal` |
| 存档单键 `ulam.save.v1`（`best` 只降、`unlocked` 只升、日胜粘住、坏载荷降级、`requireBackend` 抛） | `js/core/storage.js` | `js/core` 里唯一允许碰 `window` 的模块；结案走门面 `store.solve` |
| 发货数据：棋书 + 战役 + `MINQ` + `MEASURED.claims(19)` + `BRUTE` + `BUDGET` | `js/data/lots.js` | 由 bake 生成，`wc -l` 9 603 行 / 80 KiB，手改会在 `@boot` 上炸 |
| 重烘 + 全部 census 打印（SAMPLE / FULL 两档） | `tools/bake.mjs` | 确定性；只有 `ms` 与 `BRUTE` 规模两块随档位变 |
| node 断言台（`test/ok/eq/throws/run`，打 `rows / asserts / fail`） | `tools/harness.mjs` | 七套共用 |
| CDP 驱动 + 5 个浏览器场景 | `tools/playtest.mjs` | 读真 DOM、真 canvas 命中、真 localStorage |
| 端口 → 起服务 → 起 Chrome → 5 场景 → 收摊 | `tools/verify.sh` | 占 5222 / 9372 |
| 画布几何与绘制（同一份几何既画也做命中测试） | `js/view.js` | 只画像素，不下判断 |
| 路由与外壳（`#/c/<i> #/lot/<id> #/daily #/random/<tier>/<key> #/pick/<n>/<k> #/menu`、谎账本、证明抽屉、总账、`window.ulam`） | `js/main.js` + `index.html` + `css/game.css` | 判定一律查表 |
| 零依赖静态服务器（Electron 复用同一份） | `server.cjs` | `npm run dev` → 5222 |
| 桌面壳 | `electron/main.cjs` | `nodeIntegration:false / contextIsolation:true`，无 preload |

## 2. 验收（本机 2026-09-27 实测）

| 闸 | 结果 |
| --- | --- |
| `npm run check` | OK（js / server / electron / tools / test 逐文件） |
| `npm test`（七套） | 124 行 / 56 258 条断言 / **fail: 0** |
| `npm run verify`（真 Chrome） | `@boot 26 · @play 36 · @routes 33 · @save 63 · @pointer 46` = **204 行 / fail: []** |
| 点击路径的搜索节点 | 整局打完 `ulam.searchNodes()` = **0** |
| 重烘一致性 | SAMPLE 重烘与发货文件只差 `ms` × 1 + `BRUTE` 规模 × 4，其余逐字节相同（CI 的 `book` job 同一口径） |
| 发货声明 | `MEASURED.claims` 19 条 `held` 全真；`unmeasured = 0`；`BRUTE.disagreementCount = 0` |

## 3. 边界与已知不做

- **表外不给近似值**：`parOf(n,k) === null` 时屏幕明说"这一格没量出来"，随机/每日只从已复验的
  战役池里选（`make.js` 头注）。
- **`beyondDepth = 24`** 是范围边界不是失败：那些 `fresh(n,k)` 需要的问数超过本次扫描的 qMax，
  与"搜索耗尽"（`unmeasured`，必须为 0）分得清清楚楚（`table.js:126` 按异常信息把两者拆开）。
- **连击没有实现成函数**：`storage.js` 无 `streak()`、`rng.js` 无 `shiftDay()`，连续性只能由
  `daily` 的日历键推（DESIGN 8 里那条断言把跨日界 / 跨月 / 闰日钉住）。
- **对手"让剩余难度尽量大"是对任务书的反向修正**，理由与影响写在 DESIGN 5。
- 成绩只在这台设备的浏览器里，没有后端、没有遥测、没有账号。
