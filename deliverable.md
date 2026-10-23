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
| node 断言台（`test/ok/eq/throws/run`，打 `rows / asserts / fail`） | `tools/harness.mjs` | 九套共用 |
| CDP 驱动 + 5 个浏览器场景 | `tools/playtest.mjs` | 读真 DOM、真 canvas 命中、真 localStorage |
| 端口 → 起服务 → 起 Chrome → 5 场景 → 收摊 | `tools/verify.sh` | 占 5222 / 9372 |
| 画布几何与绘制（同一份几何既画也做命中测试） | `js/view.js` | 只画像素，不下判断 |
| 路由与外壳（`#/c/<i> #/lot/<id> #/daily #/random/<tier>/<key> #/pick/<n>/<k> #/menu`、谎账本、证明抽屉、总账、`window.ulam`） | `js/main.js` + `index.html` + `css/game.css` | 判定一律查表 |
| 零依赖静态服务器（Electron 复用同一份） | `server.cjs` | `npm run dev` → 5222 |
| 桌面壳 | `electron/main.cjs` | `nodeIntegration:false / contextIsolation:true`，无 preload |

## 2. 验收（本机 2026-09-27 实测）

| 闸 | 结果 |
| --- | --- |
| `npm run check` | OK（资产 IHDR 闸门 + js / server / electron / tools / test 逐文件 + manifest JSON 解析） |
| `npm test`（九套） | 141 行 / 56 708 条断言 / **fail: 0** |
| `npm run verify`（真 Chrome） | `@boot 26 · @play 36 · @routes 33 · @save 63 · @pointer 46` = **204 行 / fail: []** |
| 同一批场景换成 Pages 的 URL 形态（仓库挂在 `/z-biz-game-ulam-cos/` 这一段下面） | **204 行 / fail: []**；已部署站点上单跑 `@save` 也是 **63 行 / fail: []**（改之前那一趟只落到 44 行、红 6 条，见 DESIGN 8） |
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

## 4. 并线收口（2026-10-22）

并线提交 `b5a5c5e`（父：`2d03da3` 本地侧 / `3f1880a` 远端侧）把两侧各做过的精修合到一起，
合出一批**整局不可玩**的破坏。两侧各自自洽，合起来不自洽——按「以自洽的那一侧为基线，再把另一侧
独有的能力并进来」收口。

### 4.1 坏在哪（都是并线裁出来的，不是原仓的）

| 症状 | 位置 | 机理 |
| --- | --- | --- |
| 存档一读就 ReferenceError | `js/core/storage.js` | 并线保留了 `load()` 里的 `corruptDropped = 0;`，却把同侧的 `let corruptDropped` 与 `export function corruptCount()` 裁掉了 ⇒ 未声明赋值（ESM 严格模式） |
| 点第一格就 ReferenceError | `js/view.js` | 并线把另一侧的闪光块接进 `setGame()` / `reset()`，它调的 `tick` 在这一侧叫 `frame`（`js/view.js:159`）⇒ 名字不存在；同一块还带进一条内层 `const FLASH_MS = 208`，把模块级的 `FLASH_MS = 460`（`js/view.js:31`）遮住，两套闪光语义（毫秒余量 vs 0..1 比例）混在一个文件里 |
| 按一次 F 键净效果为零 | `js/main.js` | 两份全屏实现同时在：HUD 的 `#fullscreen`（本侧）与并线接进来的 `#btn-fullscreen` IIFE，各挂一个 `keydown` ⇒ 一次按键进一次出一次；两个按钮、三个 `fullscreenchange` 监听 |
| 社交卡与 PWA 头全丢 | `index.html` | 并线把 head 换成了另一侧：canonical / og:url / 1200×630 的 og 卡 / apple-touch-icon / 一排图标链接全没了；剩下的 og:image 指着一张 512 图标，资产闸门认的是 1200×630 的卡 |
| 资产闸门无靶子 | `manifest.webmanifest` | 清单被换成另一侧（图标指向 `icons/`），而资产闸门认的是 `assets/icons/` 下的 192/512/maskable |
| 存档测试自相矛盾 | `test/storage.test.mjs` | 并线取了另一侧的断言体（`half` 留成默认记录、`daily` 的坏键原样透传），载荷却是这一侧的（多出 `nul` / `list` / `wild`）⇒ 期望值 `solved: 1` 从一开始就不对；它调的 `corruptCount()` 在并线后的 storage.js 里也不存在 |
| 文档数字回退 | `README.md` | 并线取了另一侧的旧行（七套 124 行 / 56 259 条断言），实际是九套 141 行 |

### 4.2 收口办法

- **回到自洽的那一侧**：`js/core/storage.js`、`js/view.js`、`js/main.js`、`index.html`、
  `manifest.webmanifest` 全部取回 `2d03da3` 那一版（它自带 HUD、玩法遮罩、暂停角标、定步长
  仿真时钟、盘底纹理与秘密环、1200×630 社交卡、PWA 清单与全套图标）。
- **另一侧独有的能力并进来**（能力取并集，实现只留一份）：
  - 存档版本门（`SAVE_VERSION`，写档带 `v`、读档校验）并进 `js/core/storage.js:16/120`；
  - `ms` 前缀与「不支持也要给个说法」并进 `js/main.js:537/615/994`；
  - 部署集闸 / 产物自洽闸 / CI / workflow / 文档层（`tools/deploy-set*.mjs`、
    `tools/site-selfcontained.mjs`、`.github/workflows/*`、`tools/assemble-site.sh`）**整层保留**；
  - safe-area 兜底与 44px 命中下限（中央分发那一段 CSS）保留在 `css/game.css` 尾部。
- **一份实现 + 一个状态源**：全屏只留 HUD 的 `#fullscreen` 一份（并线的 `#btn-fullscreen`
  IIFE 整块删掉），F 键只挂一个监听；service worker 注册只留 `js/sw-register.js` 一份
  （index.html 里那段内联注册删掉）——**注册作为独立一站，部署集闸才量得到「sw.js 在不在产物里」**。
- **部署名单即 allowlist**：`favicon.ico` 是页面引着的（`<link rel="icon" href="favicon.ico">`），
  `tools/assemble-site.sh` 原来不收它 ⇒ 补进拷贝清单。
- **两套图标收成一套**：并线带来的 `icons/`（6 张，另一侧的母本）在改用本侧清单后无人引用，
  按本仓自己的规矩「盘上有图但页面不引用 = 死资产」删掉；图标统一住 `assets/icons/`（13 张，
  含 1024 / favicon-180 / maskable）。

### 4.3 闸的改动（断言一条没改，改的是实数钉与一处量具盲区）

| 闸 | 改动 | 理由 |
| --- | --- | --- |
| `tools/deploy-set.mjs` | `EXPECT_CHECKS` 40 → **59**、`EXPECT_ROWS` 59 → **81** | 钉的是实数，强度不变：head 恢复成自洽的那一份后引用从 40 条涨到 59 条（canonical / og:url / 一整排图标 / apple-touch-icon / favicon.ico 回到引用面里）。R12/R13 两句断言一个字没动 |
| `tools/site-selfcontained.mjs` | `EXPECT_ROWS` 46 → **49** | 同上，实数钉 |
| `tools/site-selfcontained.mjs` | S-外链 的豁免从「只有 og:image / twitter:image」扩到「canonical / og:url 也算元信息」 | 量具盲区：canonical / og:url 是**给爬虫读的字符串，浏览器不会去取**，与样式表/脚本/图片那种真取径不是一回事。豁免仍要求落在 README 声明的本站前缀下；资源面一条没松（样式表/脚本/图片里出现任何 http(s) 仍然逐条点名） |
| `tools/site-selfcontained.mjs` | `--selftest` 的 K4 / K4b 两根针改指社交卡的新地址 | 针必须打在真实的页面上；台架的刀口跟着页面走 |

### 4.4 读数（本机实测）

| 项 | 结果 |
| --- | --- |
| `npm run check` | OK（资产闸门 12 个资产 / 240 830 B，真 PNG、尺寸对得上声明、无 0 字节、无 SVG 冒充） |
| `npm run unit`（九套） | **141 行 / 56 709 条断言 / fail: 0**（storage 21 行 / 297 条） |
| `node tools/deploy-set.mjs` | 59 条引用（含 4 张位图尺寸核对）/ **81 行 / fail: 0** |
| `node tools/deploy-set-selftest.mjs` | 十一刀全咬 + 阴性对照不发威，**rc=0**（条数仍 59 / rows 仍 81） |
| `node tools/site-selfcontained.mjs` | **49 行 / fail: 0**（扫 21 份文本） |
| `node tools/site-selfcontained.mjs --selftest` | 九刀全咬 + 两把反空转，**rc=0** |
| `bash tools/verify.sh`（根形态，真 headless Chrome） | `@boot 26 · @play 36 · @routes 33 · @save 63 · @pointer 46` = **204 行 / fail: []**，console 干净 |
| 同一批场景换成 Pages 的 URL 形态 | **ALL GREEN**（204 行 / fail: []） |
| 点击路径的搜索节点 | 整局打完 `ulam.searchNodes()` = **0** |
| 整局不可玩量具（`cos_load_sweep`） | **LOADED**（并线后是 STUB-GAP：`corruptDropped is not defined`） |

### 4.5 留给人的两件事

1. **删掉的那套图标**：另一侧带来的 `icons/`（6 张，512 那张 104 KB）在改用本侧清单后无人引用，
   已按「死资产」删掉。若组织希望社交卡用 512 图标而不是 1200×630 的 `assets/art/og-card.png`，
   要改的是 `index.html` 的 og:image + 资产闸门那一条 og 卡的硬要求——那不是本次能单方面定的。
2. **S-外链 的豁免面**：canonical / og:url 这次被认成「元信息」而不是「远程资源」。资源面一条没松，
   但这确实动了闸的判定面，若不接受，退路是删掉页面里那两句（功能上损失 SEO 声明）。
