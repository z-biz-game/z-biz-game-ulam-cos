# 设计说明 · 谎话藏数 ULAM

README 讲玩法和数字，这份文件讲**这些数字的口径、判定住在哪、点击路径的预算、以及踩过的坑**。
源码注释里凡是写「见 DESIGN」「DESIGN 4」的地方，指的就是下面的编号小节。

## 1. 三条路线，互不信任

同一个问题 —— 「权重状态 `(a₀..a_k)`、还剩 q 问，玩家必胜吗？」—— 由三份**互不 import**
的实现各自回答：

| 路线 | 实现 | 它凭什么信得过 |
| --- | --- | --- |
| 精确值 | `js/core/solve.js` 的 `win(a,q)` 递归 + `par(a)` | 极小极大 DP，把状态聚合成权重向量后穷举分支 |
| 下界 | `js/core/volume.js` 的 `V(a,q) = Σᵢ aᵢ·Σ_{j≤q−i}C(q,j)` | 教科书 Berlekamp 体积界，纯算术、无搜索 |
| 第三族 | `js/core/brute.js` 的**具体候选集** | 完全不聚合：每个候选数字各自带谎数计数 |

第三条路线存在的唯一理由，是给「同一层的答案可以把候选聚合成权重向量」这个**假设**留一个
反证器：如果聚合丢了什么，`brute` 与 DP 就会在某格上 disagree。构建期全量对照的结果是
`BRUTE = { compared: 62 148, dpWins: 1 353, disagreementCount: 0 }`（`verifiedIn: "full"`，
n≤8 / k≤2 / q≤5）。

DP 与体积界之间**故意**留着的分歧，见第 2 节。

## 2. 体积界只有一个方向是定理

可胜 ⟹ `V ≤ 2^q`。反过来不成立 —— 这不是本仓的修辞，是它的数据结构：屏幕上并排印
`par`（DP 量出来的必中题数）与 `bound`（界给的），两者不等的格子就是关卡难度本身。

`js/core/table.js` 的扫描里，每一格只有三种下场，口径写死在源码里：

- `volumeOk`：`V ≤ 2^q`，界说"还可能赢"；
- `disagree`：其中 DP 判**败** —— 界不充分的地方。Σa≤32 / k≤3 / q≤12 的全量扫描里
  149 804 个 volumeOk 中有 **31 231** 个 disagree，其中 **176** 个满足 `V = 2^q` —— 体积被
  **刚好塞满**却仍然必败（`pack`）。每层最小的那一格随 `lots.js` 一起发布：k=1 是
  `a=[3,0], q=4, V=15`（也就是 n=3 三个候选、允许 1 个谎：界说 4 问够，真值要 5 问），
  k=1 最小的塞满型是 `a=[3,1], q=4, V=16 = 2⁴`；
- 反过来 `V > 2^q` 而 DP 判胜 —— **构建直接抛** (`体积界被推翻`)。定理被推翻不是"数据有点吵"，
  是整个发货停下来。

`MINQ` 表（`lots.js`）量到 128 个 `(n,k)` 格，其中 34 格 `par ≠ bound`；一关真用得上的
（`par ≤ qMax = 12`）是其中 20 格，这个数字由 `test/library.test.mjs` 按**逐格顺序**核过，
不是手抄的常量。

## 3. 发货数据是生成的，两个档位要落出同一份字节

`js/data/lots.js` 不许手改：它由 `tools/bake.mjs` 生成，里面 19 条 `MEASURED.claims` 每条都带
`held`，bake 逐条算过才允许写（本次发货 **19/19 held**）。CI 的 `book` job 会重烘一次再
`cmp`，但**先掩掉两类天生不稳定的字节**（并且把掩掉的条数打进日志，掩码的爆破半径可见）：

- `"ms": …` —— 跑出来那台机器的墙钟，唯一会随机器变的字段；
- `BRUTE` 那块的 `nMax/kMax/qMax/compared` —— SAMPLE 档故意只扫一半宇宙。

其余每一字节（整张棋书、14 关战役、`MINQ`）必须完全一致。SAMPLE 档不重跑的两块（Σa≤32 头条
扫描、n≤8 第三族对表）从**现有** `lots.js` 里搬，所以 `FULL=1` 烘出来的数据不会被一次
SAMPLE 烘掉。反过来说清楚：一次 SAMPLE 烘**会**把 `BRUTE` 那块写成 SAMPLE 的规模（我本地
实测过：`nMax 8→6`、`compared 62 148→6 120`），那一块因此就在掩码名单里 —— 这不是漏洞，
是"降级只会把话说小、不会把话说大"的方向性。

## 4. 点击路径不许花搜索节点

这一条是本仓标题（"点一次的成本是一个 `Map.get`，不是一个 DP 节点"）唯一的证明方式，
所以它由**真浏览器**把节点计数器读出来，而不是由代码审查担保：

- 判定读 `lots.js` 的棋书：一次 `Map.get`；谎数记账是 `O(n≤40)` 的计数器增量；
- `solve.js` 的 DP 守卫里有一个节点计数器，`window.ulam.searchNodes()` 就是它；
- `tools/playtest.mjs` 打完一整关（真鼠标点画布、真按问出去）之后断言它仍然是 **0**。
  唯一允许推动它的是 `recomputeTable()` —— 那是个没人会误点的测试入口。

顺带的硬约束：`adversary.js` **不 import `solve.js`**（它只能用 `volume` / `boundPar` 这两个
纯算术量给分支排序），否则对手一动就会在点击路径上偷偷搜起来。

## 5. 对手那台机器，以及一处对任务书的反向修正

`js/core/adversary.js` 实现的是**下棋用的**应答机，三条性质被 `test/game.test.mjs` 每一问之后
逐条按在机器上：全函数（真话那一支永远把 `s` 留着，所以 Σ ≥ 1，合法支非空）、从不破坏可实现性
（只从合法支里挑）、确定性（回放一局只需要重放问题序列）。

任务书原本写的是"有任何可实现支是败局就递给玩家败局，否则让剩余 par 尽量**小**"。前半句照抄，
后半句**反着做**：剩余 par 是玩家还要问的题数，把它做小等于替玩家收拾残局 —— 那是帮助不是对抗。
所以实现取"否则让剩余难度尽量**大**"。这处偏离在这里明说，因为它会改变玩家看到的难度，
不是实现细节。

`boundPar` 排序器与真 DP 排序器在同一批分支上有多不一致，由 `tools/bake.mjs` 注入排序器量出来
随 `lots.js` 一起发布；浏览器里没有注入，也就永远不会去搜。

## 6. 耗时（本机 2026-09-27，只有这一节是机器相关的）

`node tools/bake.mjs`（默认 SAMPLE 档）stdout 的实测合计 **17 351 ms**，主要几段：

| 段 | ms |
| --- | --- |
| minQ table | 10 045 |
| scanUniverse(play) | 2 542 |
| measureAdversary | 1 722 |
| checkIdentities | 2 007 |
| measureStrategies | 655 |
| 最贵的一格棋书 policy 16/3 | 120 |
| bruteAgreement(n≤6,k≤2,q≤4) | 232 |

FULL 档最贵的那条（Σa≤32 头条 universe）随数据发布在 `MEASURED.universe.totals.ms = 26 486`。
node 七套与浏览器五场景的耗时会随机器和负载浮动，所以**不写进 `lots.js`**（那文件的头注就是
这么规定的）：只有会被断言的事实才进数据，墙钟关在 bake 的 stdout 里。

## 7. 复现清单

```bash
npm run check && npm test          # 语法 + 七套断言
npm run verify                     # 真 Chrome 五场景（@boot @play @routes @save @pointer）
node tools/bake.mjs                # SAMPLE 重烘（注意：会改写 js/data/lots.js）
FULL=1 node tools/bake.mjs         # 全量：头条 universe + 第三族对表
node --input-type=module -e "import {MEASURED,BRUTE} from './js/data/lots.js';
  console.log(MEASURED.universe.totals, BRUTE, MEASURED.claims.filter(c=>!c.held));"
```

最后一行是"发货声明有没有变得不成立"的最短查法：`unmeasured` 必须 0，`claims` 里不许有
`held: false`，`disagreementCount` 必须 0。

## 8. 踩过的坑

### 门面上少一个名字，结案整条路静默断掉

`js/main.js:391` 调 `store.solve(...)`，而 `solve` 当时只是 `storage.js` 的**模块级导出**，
`store` 门面（`record/unlock/markDaily/totals/…`）上没有这个名字。浏览器里每次结案都
`TypeError`，而且**node 七套全绿看不出任何事** —— 测试调的是模块级那个入口，一直好得很。
后果是玩家打赢一关之后：纪录不落盘、解锁前沿不动、页眉停在 0/14、结案卡片根本不浮起、
每日一题也钉不进 daily。

修法是门面补一行 `solve,`（同一个函数对象，不是第二份实现），并且 `@save` 场景现在钉
`store.solve === solve`：两个名字必须指向一份实现，谁也不能悄悄变成两份。**教训不是"多测一行"，
而是"外壳调的接口和存档层导出的接口之间，没有任何一个自动东西在管"** —— 名字对上与否，
最后由真浏览器点一次才算数。

### 存档的第一笔可能写下字符串 `'null'`

冷模块里 `cache === null`，`persist()` 直接序列化它就落出 `'null'`。本仓没有任何路径会踩到它
（第一次落盘一定发生在 `load()` 之后），但这条被 `test/storage.test.mjs` 按事实钉住而不是"顺手
清洗"：`'null'` 读回来必须是空白而不是坏档。同一套里还钉着 10 种烂载荷（`'{'`、`'[]'`、
`'"a string"'`、`'NaN'`…）各自都必须**降级**而不是抛 —— 「被拒绝」和「是空的」两件事必须分得开，
所以 `requireBackend()` 是抛异常的探针。

### 连击没有 `streak()`，就不许假装它存在

`storage.js` 里没有 `streak()`，`rng.js` 里只有 `todayKey`，没有 `shiftDay()` / `dayDistance()`。
于是"连续几天"只能由 `daily` 的**日历键**推出来，测试按 UTC 历法自推加减天数，并把跨日界、
跨月、闰日三处边界当断言对象 —— 因为"按日历键而不是按 `at` 时间戳差"正是 `markDaily` 的
实现方式（`at` 只是写进去的时间戳，从不参与判定）。

### 余量比的是四位小数，那就两边都过同一个函数

表里写的 `margin` 是 `toFixed(4)`。曾经一处用全精度去比这个四位小数，于是**好数据被读成坏数据**：
`validate()` 和浏览器侧 `recomputeTable()` 各报一串假的 mismatch。现在 `printMargin` /
`printMarginValue` 是唯一口径（`volume.js`），烘焙、校验、页面重算三处都走它。口径要有一个
函数装着，不能散在三个 `if` 里 —— 散着的时候它们一定会各自漂走。

### 画布是 `#board`，不是 `#canvas`

`@boot` 之前差点按 `#canvas` 去找画布：DOM 里没有那个 id，而"元素不存在"在一些查询写法里只是
`undefined`，不报错。现在场景先钉住 `canvas#board` 有真实 CSS 尺寸、且 `#canvas` **确实不存在**
（`playtest.mjs:239`），再往下测几何与像素。
