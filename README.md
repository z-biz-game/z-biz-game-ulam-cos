# 谎话藏数 · ULAM（二十问 · 允许对手撒谎 · Rényi–Ulam 谎话游戏）

心里想好 1..n 里的一个数，对手知道它是几，并且**最多可以撒 k 次谎**。你每问一次就刷亮一批格子，
问：「秘密在亮着的格子里吗？」（亮空集、亮全集都算合法的一问。）你最多问 q 问，然后必须**点一个格子指认**。

屏幕上永远并排印着两个数：**体积界**（教科书 Berlekamp 算出来的"至少几问"）与**精确值**
（极小极大 DP 量出来的"几问必中"）。这两个数不相等的格子，就是这关真正的难度所在 ——
**界会说谎，DP 不会**。本仓的头条是它连 k=1 都不充分：3 个数、1 个谎，界说 4 问，真值 5 问。

三条硬保证，都由仓库自带的三条互不信任的实现现场算出来，不是文案：

1. **判定只查表，不搜索**。`js/data/lots.js` 是构建期烘出来的（`tools/bake.mjs`），页面读它是
   一次 `Map.get`。整局用真鼠标点完之后 `ulam.searchNodes()` 仍然是 **0** —— 这条由
   `tools/verify.sh` 在真 Chrome 里数着节点的计数器钉死，不是"我们相信用得上表"。
2. **表里的每个 par 都被三条独立路线对过**：`solve.js` 的权重向量 DP、`volume.js` 的体积界、
   `brute.js` 的**具体候选集**路线（不聚合成权重向量，所以"可以合并成 k+1 格"这个假设一旦被
   推翻就会被它抓到）。Σa≤32 的全量对照里 **disagreement 0**（`BRUTE.compared = 62 148`，
   其中 1 353 局是 DP 胜）。
3. **界只有一个方向是定理**：可胜 ⟹ V ≤ 2^q。反过来不成立。所以扫描里那些"界说可行、DP 说必败"
   的格子被当作**结论**记下来（858 520 个权重向量里 31 231 个），而不是被当成 bug 抹平；
   反过来如果哪天真出现 V > 2^q 而 DP 判胜，构建直接失败 —— 那才是定理被推翻。

## 快速开始

零运行时依赖（`package.json` 的 `dependencies` 是空的，也没有 lockfile）；`node_modules` 里
不存在游戏逻辑，`npm install` 不是任何一步的前提，CI 里同样没有它。

```bash
npm run check     # 逐文件 node --check
npm test          # 七套 node 断言（本机 124 行 / 56 259 条断言，0 失败）
npm run bake      # 重烘 js/data/lots.js（默认 SAMPLE 档；FULL=1 才跑最贵的两条全量扫描）
npm run verify    # 真 headless Chrome：5 个场景 @boot @play @routes @save @pointer
npm start         # http://127.0.0.1:5222/         （npm run dev 同义，显式写端口）
npm run electron  # 桌面壳（唯一的 devDependency 是 electron，只有这条路需要它）
```

本仓占 **5222**（web）与 **9372**（CDP）。端口被别的进程占着时脚本硬停而不换端口 ——
换端口测到的是别人仓的页面；机器上有别的 agent 的 Chrome 时，`ALLOW_ORPHAN_CHROME=1` 让它
**自己起一个**并绑到空闲端口，仍然不 attach 别人的端点（唯一 `--user-data-dir` 指纹要出现在
监听者命令行里才算数）。

## 玩法

- **战役 14 关**、每日一题、随机档（`热身 n∈[3,8] k≤1`、`正常 n∈[8,16]`、`烧脑 n∈[16,24]`、
  `不留情 n∈[24,32] k=3`）。除热身外 `slack: 0` —— 问数上限就是量出来的精确值，**必须打得完美**。
- 每答一次，格子换色：与"这个数是秘密"相矛盾的答案条数就是它的颜色深度，到 **k+1 就出局**。
- 顶部**谎账本**点亮的是你能证明的谎数**下界**；对手实际撒了几个要到结案才摊开。
- 结案时与全部答案相容的候选如果多于一个，那一指就是**蒙的** —— 屏幕会这么写，不给你记成赢。
- 提示给的是"这一问把剩余难度压到多少"，来自表，不来自搜索；成绩只存在这台设备的浏览器里
  （单键 `ulam.save.v1`：`best` 只降不升、`unlocked` 只升、日胜粘住）。

## 数从哪来

`npm test` 七套（同一台机器 2026-09-27）：

| 套件 | 行数 | 断言 |
| --- | --- | --- |
| brute | 14 | 304 |
| game | 25 | 47 629 |
| library | 14 | 5 532 |
| solve | 19 | 370 |
| state | 17 | 91 |
| storage | 19 | 224 |
| volume | 16 | 2 109 |

`npm run verify` 的浏览器断言：`@boot 26 · @play 36 · @routes 33 · @save 63 · @pointer 46`
= **204 行，0 失败**。它们读的是真 DOM、真 canvas 命中、真 localStorage，不读任何内部开关。

构建期扫描（`tools/bake.mjs` 的 stdout，`js/data/lots.js` 里 `MEASURED.claims` 共 **19 条、
held 全为真**）：Σa≤32 / k≤3 / q≤12 的 universe 扫过 **858 520** 个权重向量、**66 040** 个位置，
其中 **149 804** 个体积界说"可行"，**31 231** 个被 DP 判败（界不充分的地方），**176** 个还是
V = 2^q 的**刚好塞满**型反例；`unmeasured = 0`（没有一格是因为搜索耗尽而"大概对"的），
`beyondDepth = 24` 是**范围边界**而非失败：那些 `fresh(n,k)` 需要的问数超过本次扫描的 qMax。
`MINQ` 表量到 128 个 (n,k) 格，其中 **34** 格 par ≠ bound（问数 ≤ 12、也就是一关真用得到的
那 **20** 格是它的子集）。

上面这些数的**复现命令、每列的口径、以及 SAMPLE/FULL 两档为什么会落出同一份字节**写在
`DESIGN.md`；「点一次不许花一个 DP 节点」这条预算的完整定义在 `DESIGN.md` 第 4 节。

## 目录

```
index.html                 单页壳：战役 / 每日 / 随机 / 规则 / 续局 / 成绩 / 关卡库
css/game.css               版式与主题（无框架）
js/main.js                 路由与外壳：判定一律查表，结案走 store.solve 门面
js/view.js                 画布几何与绘制（同一份几何既画也做命中测试）
js/core/state.js           一局的权重状态：total / formatState / describeState / fresh
js/core/solve.js           精确 DP：win(a,q) 递归与 par（构建期与测试，不在点击路径）
js/core/volume.js          Berlekamp 体积界 V(a,q)=Σ aᵢ·Σ_{j≤q−i}C(q,j)，余量唯一打印口径
js/core/brute.js           第三路线：具体候选集（不聚合成权重向量），用来反证"可合并"假设
js/core/greedy.js          基线策略：给"这关有多难"一个可比的参照
js/core/adversary.js       对手策略：把剩余难度尽量顶高（只用表与界，不 import solve.js）
js/core/table.js           烘焙侧扫描：volumeOk/disagree/pack/unmeasured/beyondDepth 的定义在此
js/core/library.js         关卡库、档位窗口、按候选数分带；全部走表查询
js/core/make.js            战役/每日/随机出题：只在量出来的 par 落进档位窗口时才出货
js/core/storage.js         localStorage 单键：records/stats/daily/unlocked，坏载荷降级不抛
js/data/lots.js            生成的发货数据（`wc -l` 9 603 行 / 80 KiB）：棋书 + 战役 + MINQ + claims
server.cjs                 零依赖静态服务器（带路径越界防护）
electron/main.cjs          桌面壳（nodeIntegration:false / contextIsolation:true）
tools/bake.mjs             重烘 + 全部 census 打印（SAMPLE 默认，FULL=1 上全量）
tools/harness.mjs          node 断言台：rows / asserts / fail
tools/playtest.mjs           CDP 驱动：attach、注入 5 个场景、取 RESULT
tools/verify.sh            端口 → 起服务 → 起 Chrome → 5 场景 → 收摊
test/*.test.mjs            七套：brute game library solve state storage volume
tools/assemble-site.sh  部署产物的唯一清单（pages.yml 与本地闸调同一支）
tools/deploy-set.mjs  部署集闸：检查即将上传的那份产物
tools/deploy-set-selftest.mjs  部署集闸的阴性自证（每一类断言当场打红一次）
tools/site-selfcontained.mjs   产物自洽闸：pages.yml 上线前那一步的全部逻辑（本地整闸调同一支）
```

## 许可

MIT，见 `LICENSE`。谎话游戏（Rényi–Ulam / Berlekamp 的搜索博弈）是公开数学，代码、文案与
这套"三条路线互相反证"的验证实现是本协议下的原创。

## 上线的到底是哪一批文件

这个仓没有打包器：站点=一次文件拷贝。以前「拷哪些」写在 `pages.yml` 的 `run:` 里（手抄的几行
`cp`）。本地 `index.html` 直读仓库根，永远自洽；线上却按那份清单拷，于是页面后来引用的
`manifest.webmanifest`、`sw.js`、`icons/*` 可能一个都没上去——线上 404，而仓里的引擎测试与
真浏览器闸全绿，因为它们跑的都是仓库根，没有任何一步在「按清单拷」的那个环境下加载过页面。

现在清单只有一份，住在 `tools/assemble-site.sh`：CI 调它拷 `_site`，本地闸调它拷临时目录，
然后**对拷出来的产物**提要求（`tools/deploy-set.mjs`）：

- **W 清单与页面同源**：`pages.yml` 里必须真有 `run: bash tools/assemble-site.sh <dir>` 这一行，
  `ci.yml` 里必须真有 `run: node tools/deploy-set.mjs`。认的是调用那一行，不是文件里出现过这个
  路径——注释里本来就会写它，只 grep 字符串会被一句散文喂绿。
- **R 引用可达**：引用不靠手打名单。从 `index.html` 的 `href/src` 出发，凡解析出来是 `.js`/`.css`
  的就把那一站也扫一遍（CSS 的 `url()`、JS 去掉注释后的 `'./…'` 字面量、`new URL(x, base)` 的两种
  基、`navigator.serviceWorker.register`、`scope`），`manifest` 的 icons/screenshots/shortcuts 各自
  的 `src` 也算引用。取径上读不到的那一站本身就是红（读不到＝这一站根本没扫）。每条引用都必须在
  产物里且非 0 字节；绝对路径单列一条红，因为 Pages 挂在 `/<repo>/` 前缀下会跳出去。
- **P 位图不许说谎**：`manifest` 声明的 `sizes` 必须等于 PNG IHDR 的真实宽高——文件图标读文件头，
  内联成 base64 的图标先解码再读同一段。后一条不是可选项：图标可能住在清单里而不是盘上的 `.png`
  （有的仓另有一条"零二进制文件"的承诺，那条只约束"有没有 .png 这个文件"）；如果 P 段只筛文件名，
  声明写 512 而真图 192 就一路放行。
- **钉住两个数**：R 段实际检查的路径条数（`40`）与这一次跑的断言条数（`59`），两个数
  都钉在 `tools/deploy-set.mjs` 顶部的那对常量里。没改页面却掉了，说明解析断了；删掉一张图标会同时
  少一条 R10 与那张的 P1/P2，所以两个数一起钉，断言条数能漂就是闸在缩水的信号。这一节故意只写数值、
  不写那对常量的名字，也不写别仓文档闸的编号：有的仓的文档闸会拿"文档里出现过的同名标识号"回数它
  自己的条数，还有的会把文档里点到的每个组编号逐个核对"这一轮真的发过"——两道闸共用一个名字，
  或者在本仓的文档里出现一个本仓没有的组编号，打红的都是不相干的那一边。

`tools/deploy-set-selftest.mjs` 是这两颗钉的阳性证明：它把仓库复制到临时目录，照着每一类断言
各下一刀（X1 清单不收位图目录 / X2 模块边改名 / X3 CSS 写绝对路径 / X4 `start_url` 绝对 /
X5 删光 >=512 图标 / X6 少一个必填字段 / X7 声明尺寸与真图不符 / X8 workflow 不调脚本 /
X9 CI 不跑闸 / X10 是阴性对照——往入口 JS 追加一行只写在注释里的假路径，闸必须仍然绿、条数仍然
`40`、断言仍然 `59`；X11 og:image 退回相对路径 / X12 og:image 的前缀指向别的 slug /
X13 内联位图谎报尺寸——只在有靶子时下：X11/X12 要页面上那句 og:image，X13 要清单里真有一段 base64
图标，没有就打印 SKIP；反过来 X1 没有位图目录可砍时改砍 css，P 段一位都不核时台架直接报靶子不够），
要求每一刀都让闸**点名**变红。靶子从 `DEPLOY_SET_DUMP=1`
的出处表现挑（取径真的会读的那支 JS / 那一张 CSS，不写死某一个仓的入口名），所以页面改了、仓与仓
不同，台架跟着走。

`node tools/deploy-set.mjs` 与 `node tools/deploy-set-selftest.mjs` 就是 CI 跑的那两条命令本身
（package.json 里的 `deploy-set` / `deploy-set:selftest` 只是同一支脚本的 npm 入口）；本仓的整闸在 `tools/verify.sh` 的 `=== deploy-set ===` 那一段也各跑一次。它们红的时候并进本仓那条出口的退出码——这一条是这么证的：
把 ci.yml 里那行 `run: node tools/deploy-set.mjs` 砍掉，本仓整闸必须点名红且退出码非 0。
所以「本地全绿、线上 404 自己的 manifest / sw.js / 图标」这一类坏法在本地就会红。

## 上线前那一步以前只有 Pages 会跑

`pages.yml` 在 upload 之前有一步叫 `The artifact is self-contained`，body 是手抄的七行 shell。
它不在 `ci.yml`、不在 `tools/verify.sh`、也不在任何一道本仓的闸里——**本仓没有任何一条路能把它跑红**。
于是它红了三次推送没人知道：

```
2026-10-04 4928a46  pages build success      ← 线上产物停在这一份
2026-10-06 6733a82  pages build failure      ← og:image 改成本站绝对 URL
2026-10-06 b1a6c6f  pages build failure      ← 只动了 .gitignore
2026-10-06 0464978  pages build failure      ← 只动了 ci.yml
```

红的原因是两道闸互相矛盾，而不是哪一道写错：`tools/deploy-set.mjs` 的 **R7** 要求 `og:image`
必须是**本站绝对 URL**（抓取器读的是别人页面上的字符串，不会替 Pages 补 `/<slug>/`，相对写法
等于社交卡没有图）；同一次 run 里下一步那条 `grep -v w3.org` 却禁止产物里出现任何绝对 URL。
一个 job、前后两步、要求互为反面——**没有任何一棵树能同时满足它们**，于是 Pages 从那天起再没
部署过任何东西，`main` 上的后续提交只存在于 git 里。这一句不是推断：修之前抓线上
`https://z-biz-game.github.io/z-biz-game-ulam-cos/`（200，7 171 B），`grep -c 'og:image\|twitter:card'`
得 `0`——首页是 `4928a46` 那一份，社交卡那一句在 git 里、不在网上。这一支脚本的提交上线之后再抓
是 7 778 B、两句都在，`icons/icon-512.png` 回到 200 / 104 740 B：那一步重新有 artifact 可传了。

修法是把那一步的 body 整个搬进 `tools/site-selfcontained.mjs`，然后让三条路都调它
（`pages.yml` 传即将上传的那份 `_site`，`ci.yml` 与 `tools/verify.sh` 用无参形态——本闸自己按
`tools/assemble-site.sh` 拷一份临时产物再查）。矛盾在闸里落成一条有主人的豁免：**绝对 URL 只
允许出现在 `og:image` / `twitter:image` 的 `content` 上**，且它必须落在 README 声明的本站前缀
下、且那张图真在产物里；这句话本身合格与否归 R7，本闸只承认这一种形状。命名空间的豁免也从
`grep -v w3.org` 那种"主机名当通行证"改成认它挂在哪个属性上——旧写法会连
`url(https://www.w3.org/Icons/water.png)` 这种真取径的远程图一起放行，台架里 K6 打的就是这一刀。

`node tools/site-selfcontained.mjs` 跑 46 条断言（`S-MOD` 说明符只许自相对 / `S-夹带` 不许带
server.cjs、tools、electron 上线 / `S-页面` 产物里那份 index.html 必须还带 `<canvas` /
`S-接线` Pages+CI+本地三条路都要调到本闸，认的是行首就是那条命令 / `S-外链` 上面那条豁免一种
都不许多），条数钉在脚本顶部；`--selftest` 把每一类当场打红一次，另两把是反空转（K5 证明豁免
真的有对象、K7b 证明"只剩台架、没有闸"也算没接线）：

```
$ node tools/site-selfcontained.mjs | tail -2
产物自洽：46 条断言，扫描 20 份文本 · 产物 本闸按清单现拷的临时副本
rows: 46 fail: 0
GATE_RC=0

$ node tools/site-selfcontained.mjs --selftest | tail -11
  ok  基线 rows: 46 fail: 0
  ok  K1 裸包名说明符 → rc=1 · S-MOD
  ok  K2 产物夹带服务器 → rc=1 · S-夹带
  ok  K2b 上线的 index.html 没有画板 → rc=1 · S-页面
  ok  K3 样式里的远程图 → rc=1 · S-外链
  ok  K4 og:image 的本站前缀抄错 → rc=1 · S-外链
  ok  K4b twitter:image 指的图不在产物里 → rc=1 · S-外链
  ok  K5 内联 SVG 的 xmlns 不是外链 → 按不生效算
  ok  K6 拿 w3.org 当幌子的远程图 → rc=1 · S-外链
  ok  K7 本地整闸不再调这一闸 → rc=1 · S-接线
  ok  K7b 本地整闸只跑台架、不跑闸 → rc=1 · S-接线
RIG_RC=0

$ # K3 那一刀闸实际打印的两行（副本里往 css/game.css 追加一条远程 background）
  FAIL S-外链 css/game.css 里没有远程资源  https://cdn.example.com/x.png：访客在飞机上打开也要能画图，一条外链就是一次白屏
rows: 47 fail: 1
```

没有覆盖的：这一闸查的是**产物字节**，不是网络。抓取器（Facebook / Twitter）到底把那条绝对 URL
读成什么样子，得有人真的拿它们的调试接口问一次本站——本仓没有那一步，`R7` 也只量到"那句话
写得对、那张图在产物里"为止。

## 在线试玩

<https://z-biz-game.github.io/z-biz-game-ulam-cos/>（`main` 分支推送即自动部署）
