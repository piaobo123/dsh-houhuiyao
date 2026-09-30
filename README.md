# dsh-houhuiyao —— DSH Web「版本 / 后悔药」插件

名字取拼音 **houhuiyao = 后悔药**（点了重新生成又想要回上一版 —— 就是它）。
曾用名：`dsh-answer-versions`（最初的英文名）、`dsh-banben`（2026-10-01 当天短暂用过几十分钟）。
两代旧名都留有 localStorage 迁移链，改名不丢版本历史。

给 DeepSeek Harness Web GUI 加一个 Doubao / deepseek.com 风格的「回复版本」体验：

- **↻ 重新生成** —— 在**最后一条回答**上，原地把同一个问题重问一遍。
- **✏️ 编辑提问** —— 在**最后一条回答**上改上一句话，然后从同一个锚点分叉、用新问题重问（deepseek.com 的「编辑并重发」）。
- **🗑 删除这轮** —— 在**最后一条回答**上，弹出确认框问**提问要不要一起删**，三个明确选项 + 取消：
  - 「提问和回答一起删」——整轮消失、不再提问；
  - 「只删回答（保留提问并重新生成）」——保留提问，重新生成一条回答（会再调用一次模型）；
  - 「只删回答（保留提问，不重新生成）」——保留提问、去掉回答，**零模型调用**（宿主侧纯事件构造的 seed，见下）。
- **‹ i/N › 版本翻页器** —— 重新生成 / 编辑过至少一次之后，每条回答都显示版本数，左右箭头在版本之间切换（**切换不归档任何东西**）。
- **不可操作时说清原因** —— 以前判据不足就整排静默消失，现在原地给一行中文（例：*第一轮没有上一版可以分叉，暂不能重新生成*）。

零核心补丁：客户端只用公开的扩展点（slot / sessions / workspaces），宿主只用公开服务
（webServer / agents / sessionQuery / workspaceRegistry / agentDefaultModel / agentPresets），
不改 harness 一行源码。「不重新生成」那一项需要宿主侧一条同源受限的 HTTP 路由（`lib/index.js`）。

---

## v0.2.0（2026-10-01）改了什么

用户报的现象：**「这个可以重新生成重新提交的插件经常失效，很多情况下会话结束都没有它」**。
取证（把插件判据在 251 条真实会话日志上跑一遍）：**145 条会渲染、106 条不会（42%）**。
本轮修掉其中两类真 bug（+ 一条新发现的必然 500），其余改成「说清原因」：

| # | 问题 | 根因 | 修法 |
|---|---|---|---|
| 1 | **窗口裁剪（29 条）** | 客户端只拿得到后 50 条 `user/assistant` 消息（0.1.6 `paginate`）。一轮里每个 step 都有一条 assistant/message —— 工具密集的长任务单轮就 60~100 条，于是「上一轮的 turn/start」被挤出窗口，`analyzeWindow` 凑不出两轮 → `return null` → 整排静默消失。旧文写的「上一轮 `turn/end` 在窗口内即可」**是错的**，实际还需要上一轮的 `turn/start` 也在窗口里。 | 新增**只读**宿主路由 `/dsh-houhuiyao/turns`：读**全量日志**，把 `anchorSeq / 提问 / 本轮答案 id / 轮号` 交回客户端；客户端一律以它为准，拿不到时才退回窗口（老运行时 / 宿主还没重启）。 |
| 2 | **槽位挂错（8 条）** | 挂在 `conversation.chat.assistant-actions`，官方只在该轮 closing 节点是 `assistant/message` 时渲染它（`dsh-client-ui-chat/lib/client.js:3683`）。一轮结束在工具节点上（被中断、纯工具收尾）时整排控件跟着消失。 | 改挂 `conversation.chat.turnTail`（同文件 `:3671`，**无条件渲染**，并且直接给得到 `turn`）；归属判定从 messageId 改成**轮号**。 |
| 3 | **静默消失** | 判据不足时返回 `EMPTY_VIEW`，什么都不渲染，用户只能猜「插件坏了？」 | 不可操作时渲染一行中文原因（首轮没有分叉点 / 上一轮没正常结束 / 该轮由系统注入触发）。正在生成时不显示（免得在流式过程中闪字）。 |
| 4 | **「只删回答（保留提问，不重新生成）」在 0.1.6 上必然 500**（新发现） | 0.1.6 快照模式硬校验 `inheritedEventCount === seed.length`（`dsh-session/lib/index.js:1145`：*seeded session constructor seed must equal its inherited prefix*）。插件以前只报「真实继承前缀」，而 seed 里还有 2 条**合成**收尾事件（step/end + turn/end）→ `agents.create` 直接抛错。离线测试当时还把这个错误假设断言成「正确行为」。 | `inheritedEventCount` 改为 `seed.length`（合成收尾也算进继承前缀）。代价只有一处：那 2 条合成事件不可被地址化（`history.js:366` 拒绝 `seq < inheritedEventCount` 的地址）—— 它们本来就是纯构造物。**沙箱用真实会话端到端验证：现在能建出「只有提问、没有回答」的子会话。** |
| 5 | 改名迁移 | 插件从 `dsh-answer-versions` → `dsh-banben` → `dsh-houhuiyao`（最终名，拼音「后悔药」）改过两次 | localStorage 三张登记表（`versions`/`viewed`/`member`）与调试开关按 **houhuiyao → banben → answer-versions** 的顺序自动迁移，已有的版本家族不丢。 |

**没有修、也不打算修的**（用户明确说无所谓）：末轮是**系统注入**触发的（定时/续跑/分身消息）——那一轮没有人类提问可重发，插件只显示原因。

**首轮（55/251 条）仍是结构限制**：fork 的切点是「第一个 `seq >= atSeq` 的 `turn/end`」
（`dsh-api-session-controller/.../commands.js:212-214`），首轮之前没有可用切点，
所以首轮不能重新生成 / 编辑 / 删除。本轮**不实现**首轮支持（要用宿主 seed 构造替代 fork，改动最大）。

---

## 安装

在 profile 里加一个本地依赖并让它成为 bundle 层（`dsh.bundle.patch` 会让 `dsh plugin` 自动把包名写进 `dsh.profile.bundles`）：

```powershell
# 本机 harness 是发布包安装（0.1.6-alpha.2），所以直接用它的 bin.js：
node "F:\dsh-016\node_modules\@deepseek-ai\dsh\lib\bin.js" plugin --profile web add link:F://dsh-plugins//dsh-houhuiyao
```

如果 `dsh` 已经在 PATH 上，等价的形式是：

```powershell
dsh plugin --profile web add link:F://dsh-plugins//dsh-houhuiyao
```

装完**重启 Web 服务**（客户端插件表与宿主半边都在启动时装配），然后刷新页面。

> **改名注意**：从 `dsh-answer-versions` 换到 `dsh-houhuiyao` 是一次**替换**，不是并存。
> 先 `remove dsh-answer-versions`（或手工把 package.json 的 `dependencies` 与 `dsh.profile.bundles`
> 里的旧名换成新名），再 `add dsh-houhuiyao`，最后重启。
> **重启之前不要删 `profiles/web/node_modules/dsh-answer-versions/` 那个目录** —— 运行中的服务还在
> 用旧的内容哈希组装组合 bundle（`/plugins/??…`），文件没了会让整页客户端脚本 404（界面变白）。
> 重启之后再删是安全的。

### 改了插件代码之后怎么让它生效

**重要：`file:` 装的是一个「拷贝」，不是链接。** 所以**只改源目录 `F:\dsh-plugins\dsh-houhuiyao` + 刷新页面是不会生效的**。

| 改了什么 | 需要什么 |
|---|---|
| `client/client.js` | 把文件同步到 `profiles\web\node_modules\dsh-houhuiyao\`（或改用 `link:` 依赖）→ 刷新页面（客户端插件按内容哈希失效） |
| `lib/index.js`（宿主半边） | 同步 + **重启 Web 服务**（路由在启动时装配） |
| `package.json` / `cordis.patch.yml` | 重新 `dsh plugin --profile web add …` + 重启 |

两条同步路径，任选一条：

1. **改用本地链接（推荐，以后改代码免同步）**
   ```powershell
   node "F:\dsh-016\node_modules\@deepseek-ai\dsh\lib\bin.js" plugin --profile web add link:F://dsh-plugins//dsh-houhuiyao
   ```
2. **手工拷贝（快，不动 profile 的依赖声明）**
   ```powershell
   Copy-Item "F:\dsh-plugins\dsh-houhuiyao\client\client.js" `
             "C:\Users\22297\.dsh\profiles\web\node_modules\dsh-houhuiyao\client\client.js" -Force
   Copy-Item "F:\dsh-plugins\dsh-houhuiyao\lib\index.js" `
             "C:\Users\22297\.dsh\profiles\web\node_modules\dsh-houhuiyao\lib\index.js" -Force   # 这条要重启服务
   ```

- 卸载：`dsh plugin --profile web remove dsh-houhuiyao`。
- 本插件有**两条**宿主路由（`/dsh-houhuiyao/turns` 只读 + `/dsh-houhuiyao/keep-question` 建子会话），都在 `lib/index.js` 里。

---

## ⚠️ 0.1.6 兼容层（2026-09-22 修的线上故障）

本插件是按 **0.1.2 源码版** 的客户端 API 写的。2026-09-22 本机 harness 升级到
**0.1.6-alpha.2**（发布包 `F:\dsh-016`）之后，「重新生成 / 编辑提问 / 删除这轮 / 版本翻页器」
全部失效，症状就是用户报的那句：**点「保存并重发」→ 界面直接跳到一个新会话 → 卡住不动**。

### 根因：0.1.6 收窄了客户端会话服务

`dsh-api-session-controller` 的 `ISessions` / `ClientSessions` 与 0.1.2 不同：

| 旧代码（0.1.2） | 0.1.6 的真相 |
|---|---|
| `ctx.sessions.open(id)` | **这个方法不存在了**。接口注释原话：*navigation belongs to view owners*；导航改成 `ctx.uiWorkspace.openSession(id)`（官方 ui-chat 的 `forkAt` 正是这么做的） |
| `ctx.sessions.binding(id)` 当“存在性判断 / 取会话面”用 | `binding(id)` 只借用**已经被 retain 的**绑定；没被任何视图打开过的会话返回 `undefined`。要自己租引用：`ctx.sessions.using(id, { source }, fn)`（回调前先 `await reference.ready`） |
| `ctx.sessions.open()` 之后就算“已打开” | 归档当前会话会触发 `ui-workspace` 的 `clearArchivedCurrent()` → `clearMain()` + `selectPanel(null)`，界面自己跳走 |

于是 `swapToChild` 里的 `ctx.sessions.open(childId)` 抛
`TypeError: ctx.sessions.open is not a function`：**fork 出来的新会话已经存在、源会话也已经归档，
但导航和 prompt 全部没执行** —— 用户看到的就是「新开一个界面，然后卡住」。
（取证：`session_projcache` 里那条子会话 `isSeeded=true / inheritedEventCount=77`，
日志停在 `session/end-seed`，之后再没有任何 `user/message` —— prompt 从未发出。）

### 现在的写法（`client/client.js`）

1. **`navigateTo(id)`**：优先 `ctx.uiWorkspace.openSession(id)`；老运行时退回
   `ctx.sessions.open(id)`；两者都没有时只 `warn`，**绝不抛错**。
2. **`promptChild(id, text, mode)`**：走 `ctx.sessions.using(id, { source: 'answerVersions' }, …)`
   → `await reference.ready` → `reference.binding.session.prompt(...)`；只有老运行时才退回 `binding`。
3. **动作顺序 = fork → 登记 → 导航 → prompt → 归档源会话**：
   - 登记仍然必须早于导航（子会话第一帧就要看到完整版本表，否则翻页器不出现）；
   - 导航必须早于归档（先归档会清空主视图，和我们的导航打架）；
   - 归档必须在 prompt **送达之后**（prompt 没送出去就归档 = 用户既没有新回答、又丢了原版本）。
4. **`waitForSession`** 的判据从 `binding(id) !== undefined` 换成
   `ctx.sessions.list.getSnapshot().byId[id] !== undefined`：用 binding 当存在性检查在 0.1.6 下
   永远为假，「保留提问」那一项必然在 8 次重试后失败。
5. **`openVersion`** 同样是 `listed()` + `navigateTo()`（切换版本依旧零归档）。
6. 宿主半边 **`lib/index.js`** 的 `agents.create` 参数对齐 0.1.6：继承前缀长度是**顶层**
   `inheritedEventCount`（不再是 `meta.seedLength`），并且 meta 里要带 `isSeeded: true`
   （0.1.6 会把它写进会话头与投影；照抄官方 fork 的写法）。
7. **切回旧版本要先「取消归档」**（第二个线上症状：*翻页器记得 N 版，但 ‹ 回不到上一次的答案*）。
   0.1.6 的 ui-workspace 多了一条导航守卫：

   ```js
   const reconcile = () => {
     if (this.clearArchivedCurrent()) return   // ← 当前主会话在归档集里就 clearMain()
     …
   }
   this.workspaces.list.subscribe(reconcile)
   this.sessions.list.subscribe(reconcile)     // 任何一次会话列表刷新都会跑
   ```

   而本插件「重新生成」时会归档被取代的源会话 —— 于是导航到那个归档版本后，**下一次列表刷新
   就把主视图清空了**（`clearMain()`：主会话置空 + `selection.set({})` + `selectPanel(null)`），
   表现正是「箭头点了没用、回不到上一版」。现在 `openVersion` 会先
   `ctx.uiWorkspace.unarchiveSession(target)`（退回 `ctx.workspaces.unarchiveSession`）再导航，
   **只取消归档目标那一条**，其它版本一律不动、也绝不归档任何东西。
   代价（刻意）：你回看过的那一版会在侧边栏重新出现 —— 这是无法避免的，因为 0.1.6 里
   「已归档」与「是主会话」互斥。另外 `openVersion` 因此变成异步，组件侧的 `go()` 也改成收 Promise。

### 回归测试

`tests/behaviour.test.mjs` 的 mock ctx 现在**就是 0.1.6 的形状**：**没有** `ctx.sessions.open`、
`binding` 需要先 retain、导航走 `uiWorkspace`。另外补了两个场景：
① 导航接口整个不存在时，prompt 也必须照样送出去（这条直接对着本次故障）；
② 老运行时（只有 `sessions.open`）也照样工作。**旧代码在这两个 mock 下会立刻失败。**

---

## 三个动作怎么实现的

会话日志是 **append-only** 的，「原地」是靠 **fork + archive +（可选）re-prompt** 拼出来的：

| 动作 | 步骤 |
|---|---|
| ↻ 重新生成 | `fork(源会话, 锚点)` → 登记版本 → `archive(源会话)` → `open(子会话)` → `prompt(子会话, 原问题文本)` |
| ✏️ 编辑提问 | 同上，只是 `prompt(子会话, 改过的文本)`；文案在视口居中的模态层里改 |
| 🗑 删除这轮 →「提问和回答一起删」 | `fork(源会话, 锚点)` → 作废登记 → `archive(源会话)` → `open(子会话)`，**不发 prompt** |
| 🗑 删除这轮 →「只删回答（保留提问并重新生成）」 | 与「重新生成」**同一套编排**：登记版本 → `archive` → `open` → `prompt(子会话, 原问题文本)` |
| 🗑 删除这轮 →「只删回答（保留提问，不重新生成）」 | **宿主路由** `POST /dsh-answer-versions/keep-question`：切 seed → 合成收尾 → 建子会话 → 挂工作区；**不归档、不发 prompt**，客户端收到 id 后 `open` + 登记版本 |
| ‹ i/N › 切换 | **只做 `open(某个兄弟版本会话)`**，不归档任何东西；记住「最后浏览的版本」（0.1.6 起：目标若在归档集里，先取消归档再导航，见下） |

### 「保留提问、不重新生成」的宿主实现

客户端拿不到事件日志，所以这一项只能由宿主做（`lib/index.js`）：

1. **读源日志**：`ctx.sessionQuery.observeSession(sessionId)`
   —— 官方 `fork` 用的同一入口（`packages/api/session-controller/src/commands.ts:194`），
   内部自己区分 live / prepared，返回 `{ header, events, cursor }` 且是 `Disposable`
   （`packages/session-query/session-query/src/index.ts:95, :121`；形状 `.../observation.ts:14-32`）。
   比 `ctx.sessions.get(id).events` 或 `sessionPersistence.load(id)` 都更正确 —— 前者拿不到冷会话，后者绕过官方口径。
2. **定位提问**：`events.find(e => e.seq === questionSeq && e.type === 'user/message' && e.data.source.kind === 'user')`，
   并用与 invariant 一致的状态机（`packages/core/session/src/invariant.ts:71-113`）推出它所在的 turn 和打开的 step。
3. **切 seed**：`events.slice(0, questionIndex + 1)` —— 提问保留，回答不存在。
4. **合成收尾**：`step/end`（若 step 打开着）→ `turn/end`。
   形状照抄 `packages/core/session/src/repair.ts:79-131`：seq 从最后一条真实事件 +1 开始、time 复用最后一条的时间戳。
   必须闭合，因为 `ctx.agents.create` 的 seed 契约写明
   「contiguous from seq 0」「no open turn/step or dangling tool call」（`packages/core/agent/src/index.ts:92-99`），
   `Session` 的 seed 校验还会逐条跑 surface 校验并强制 `seq === index`（`packages/core/session/src/index.ts:506-535`）；
   `step/end` 必须在 `turn/end` 之前（invariant `:87-89`）。
5. **建子会话**：`ctx.agents.create({ sessionId, seed, meta: { cwd, parentSession, seedLength, agentPreset }, agentOptions, setup })`
   （`packages/core/agent/src/index.ts:396`）；`agentOptions` 取自 `ctx.agentDefaultModel.currentSelection()`，
   `agentPreset` 用公开的 `ctx.get('agentPresets').resolve/mount` 解析并挂载
   （`packages/preset/agent-presets/src/index.ts:219, :343, :405`）。
   agent 建好后没有任何待办输入，**不会跑轮次**。
6. **挂工作区**：`ctx.workspaceRegistry.list()` 里按 `sessionIds.includes(父id)` 找到同一个工作区，
   再 `workspace.attachSession(子id)`（镜像 `commands.ts:493-503, :266`）。
7. **不归档父会话**（见「已知限制」第 3 条，这是刻意的）。
8. 返回 `{ ok: true, sessionId }`；客户端 `refresh` 会话列表（必要时重试）→ `open(子会话)` → 登记版本家族。**全程不发 prompt、不 cancel。**

### 合成的 `turn/end` 用哪个 reason，为什么

用 **`{ kind: 'completed' }`**：

- **不会渲染任何标记**：客户端只有 `turn-error`（只认 `reason.kind === 'error'`，`ui-chat/src/client/conversation-nodes/turn-error.ts:33, :62`）
  和 `turn-max-tokens`（只认 `'max-tokens'`，`.../turn-max-tokens.ts:43`）两种按 reason 渲染的节点；`completed` 两者都不匹配。
  用户最反感的「已停止」标记其实来自 `assistant/message.interrupted === true`
  （`ui-conversation/src/client/contract/records.ts:80`、`ui-chat/src/client/locale.ts:76`），
  而本 seed **完全没有 assistant/message**，所以那个标记在结构上就不可能出现。
- **不会污染会话搜索**：`packages/session-query/session-query/src/extraction.ts:46-58` 会把
  `aborted` / `interrupted` / `max-tokens` 本身当成可搜索文本入索引，只有 `completed` 返回空串。
- **语义最不撒谎**：`aborted` 的文档语义是「用户取消了正在跑的轮次」（`server/core/session/src/types.ts:157-158`），
  `interrupted` 是「持久化后端在重载时关闭了崩溃遗留的轮次，loop 永不产生该标记」（`:169-173`），
  两者都会把一次刻意的用户操作说成别的意思。
- `accountsForClaim`（`packages/core/agent/src/consumed-work.ts:42-58`）根本不会被问到：本轮进过 step，
  `foldConsumedWork` 走的是 `stepped.delete(turn)` 那一支。

### 改完之后怎么生效

| 改了什么 | 需要什么 |
|---|---|
| 只改 `client/client.js` | 刷新页面（客户端 bundle 按内容哈希失效） |
| 改了 `lib/index.js`（node 半边） | **必须重启 Web 服务** —— 路由/服务在启动时装配 |
| 改了 `package.json` / `cordis.patch.yml` | 重新 `dsh plugin … add` + 重启 |

**为什么「切换」绝不能顺带归档**（本插件早期版本干过，是真 bug）：宿主**没有任何 unarchive/restore**
（`WorkspaceRegistry` 只有 `archiveSession`，`packages/workspace/workspace/src/index.ts:244`；
全仓库唯一的 "unarchive" 字样是 `packages/client/ui-workspace/tests/workspaces-service.client.spec.ts:209` 的一条测试标题），
所以归档是**单向**的。在切换时归档「其他版本」= 把用户刚看的、以及之后想回去的版本永久从侧边栏抹掉，
表现就是「一点翻页器就归档，再也看不到上一句」。归档只发生在 **fork 那一刻**（被取代的源会话）——
那一步才是「重新生成不会让侧边栏长出重复行」的来源。

**归档会话仍然可以打开**：归档集合只被展示层消费（`packages/client/ui-workspace/src/client/tree.ts:274,316,352`
的侧边栏分组/搜索、`navigation.ts:100,207` 的选中态清理），会话列表本身不过滤它
（`packages/api/session-controller/src/list.ts:138` 直接来自 `sessionQuery.listSessions`，全文件没有 archive 逻辑），
`sessions.open()` 只要求目标在列表里（`.../client/sessions/manager.ts:167`）。所以 `open(归档会话)` 正常。

**锚点**：`ctx.sessions.fork({ atSeq })` 的切点是「第一个 `seq >= atSeq` 的 `turn/end`」，seed 是 `events.slice(0, cut)`。所以锚点取**目标轮之前最后一个 `turn/end` 的 seq**，子会话的历史就正好停在那一轮的终点、目标轮 `turn/start` 之前。于是：

- 重新生成 / 编辑提问 / 只删回答：子会话 = 历史 + （原问题 | 改过的问题）+ 新回答。
- 提问和回答一起删：子会话 = 历史（问题那一轮整体消失）。

**为什么「只删回答、保留提问」必须重新提问**：dsh 里一轮是
`turn/start → step/start → user/message → assistant/message → step/end → turn/end`——
**提问和回答同属一个 turn，中间没有任何分界**，而 fork 只能切在 `turn/end` 上。
所以不存在「留下提问、单独丢掉回答」的切点；唯一实现方式就是用原问题重新生成一次。
删除确认框里把这句话原样说给用户听，不把这一项伪装成纯删除。

**版本家族**：同一条问题在同一个 `root` 会话、同一个锚点下 fork 出来的一串真实会话。fork 会原样复制事件，所以 `seq` 在整条链上是稳定的，锚点 seq 不变。`localStorage` 里存三张表：

- `dsh-answer-versions:versions` —— `{ "root#anchor": [sessionId, …] }`（版本顺序）
- `dsh-answer-versions:viewed` —— `{ "root#anchor": sessionId }`（最后浏览的版本）
- `dsh-answer-versions:member` —— `{ [sessionId]: "root#anchor" }`（**显式归属**，优先于任何推导）

**登记必须在 `open(子会话)` 之前完成**：子会话第一帧渲染时就会算一次版本视图，如果那时登记表还是空的，它会把自己缓存成「只有 1 版」，翻页器就不出现。这条顺序是硬约束，改动 `swapToChild` 时不要调换。

**自愈**：如果某个会话发现自己的家族已经存在、但自己不在版本表里，它会被**追加**到末尾（`N/N`），而不是把 `N` 塌回 1。目标版本已被删除时，切换会返回失败并把该 id 从登记表摘除，不会抛错。

**两个对话框（编辑提问 / 删除这轮）都是视口居中的模态层，不是贴着气泡的浮层**
（`position: fixed; inset: 0` 的遮罩 + 居中卡片，共用 `overlayFor()` / `cardFor()` 外壳）。
原因：DSH Web 是全高应用，页面本身不滚动（document 没有可滚动溢出），任何按
`getBoundingClientRect()` 摆位的浮层只要往下超出视口，下半部分（包括提交按钮）就永远点不到。
结构约束（改动时不要破坏）：卡片 `max-height: 80vh; display: flex; flex-direction: column; overflow: hidden`，
内部是「标题 → 主体 → footer」三个直接子元素；主体（编辑面板是 textarea，删除确认是选项列表）用
`flex: 1 1 auto; min-height: 0; overflow: auto` **自己滚动**，footer 用 `flex: 0 0 auto` **永不被挤出去**。
快捷键：`Esc` 取消、点遮罩取消、编辑态 `Ctrl+Enter` / `Cmd+Enter` 提交、`Tab` 可以走到「保存并重发」/「取消」。
z-index 用 1000，和 shell 自己的 Modal（`packages/client/ui-primitives/src/Modal.module.css`）同层，
遮罩用 `--dsw-alias-bg-mask-1`，卡片用 `--dsw-alias-bg-layer-2` + `--dsw-shadow-lv3`。

**动作行本身没有任何绝对/固定定位**：三个按钮和翻页器都是普通 `inline-flex` 子元素，
跟着消息行一起滚动，不存在被视口裁掉的问题（`tests/render.test.mjs` 有断言守着这条）。

**动作行本身没有任何绝对/固定定位**：三个按钮和翻页器都是普通 `inline-flex` 子元素，
跟着消息行一起滚动，不存在被视口裁掉的问题（`tests/render.test.mjs` 有断言守着这条）。

**调试开关**：`localStorage['dsh-houhuiyao:debug'] = '1'`（旧键 `dsh-answer-versions:debug` 仍然认；URL 带 `?houhuiyao-debug` 也行），
控制台会打印 `[houhuiyao]` 前缀的链路日志：判据来源（host/window）、锚点 seq、轮号、提问 seq、
家族 key（以及它来自归属表还是推导）、版本表全量、最后浏览版本、窗口事件数，以及
`fork 开始 → fork 成功 → 版本家族已登记 → 源会话已归档 → 已打开子会话 → 向子会话发送 prompt → prompt 已被接受`
每一步。关掉开关时只在出错时打 console.error，没有额外开销。

在控制台里打开/关闭：

```js
localStorage.setItem('dsh-houhuiyao:debug', '1')   // 开启，然后刷新页面
localStorage.removeItem('dsh-houhuiyao:debug')     // 关闭
```

---

## 已知限制

1. **只有最后一轮可以操作**，而且**首轮永远不能重新生成 / 删除 / 编辑**：fork 锚点需要一个「目标轮之前的 `turn/end`」，首轮之前没有。v0.2.0 起这种情况渲染一行中文原因（*第一轮没有上一版可以分叉，暂不能重新生成*），不再整排静默消失。
2. **原问题里的图片不会被重发**。重发走的是 `PromptContentPart[]`，只带 text；会话里的图片是持久化的 attachment 引用，不是浏览器可以再次上传的文件。**编辑提问会丢掉原问题里的图片。**
3. **没有「取消归档」按钮级的依赖，而且切换不会去归档任何东西**。归档是单向的（宿主 `WorkspaceRegistry`
   只有 `archiveSession`/`unarchiveSession`；0.1.6 起多了一个 `dsh-client-ui-settings-unarchive-sessions`
   的「取消归档」入口，那是给用户的补救手段，插件不该依赖它）。所以：每次重新生成 / 编辑 / 只删回答并重新生成都会把**被取代的那个源会话**归档（侧边栏不再多一行），
   而被归档的版本在侧边栏里**永远是隐藏的**；它本身仍然在会话列表里，翻页器 `‹ ›` 可以正常打开和阅读它。
   切换**刻意不做任何归档**——否则用户刚看的、想回去的版本会被永久抹掉（这正是早期版本的真 bug）。
   代价：从旧版本再重新生成一次，侧边栏会多出一行（新版本与被替换的那一行），这是刻意的取舍，不是遗漏。

   **「只删回答（保留提问，不重新生成）」同样不归档父会话**（保守取舍，不是技术必需）：
   v0.2.0 起插件挂在 `conversation.chat.turnTail` 上（无条件渲染），所以「只有提问」的那个版本
   **也有完整的按钮和翻页器**（它的 lastTurn 有提问、已闭合、锚点也在）—— 旧版挂在
   `assistant-actions` 上时那里确实一个控件都没有，这条限制因此过时了。现在保留父会话
   只是为了让用户在侧边栏有一条回得去的退路。
4. **「只删回答」两个选项都不是纯删除**：dsh 里提问和回答同属一个 turn、中间没有分界，
   fork 只能切在 `turn/end` 上，所以「并重新生成」那一项实际是重新提问一次（会再调用模型，确认框已写明）；
   而「不重新生成」那一项是宿主直接切日志（零模型调用），代价是那个版本没有回答。
5. **版本登记表在浏览器 localStorage 里**，键名 `dsh-houhuiyao:versions` / `:viewed` / `:member`（改名后新键；读不到新键时会从旧名 `dsh-answer-versions:*` 自动迁移一次）。清站点数据、换浏览器、换端口（origin 变）都会丢失翻页器 —— 但版本本身是真实会话，历史不会丢。localStorage 被禁用或写满时会退回**内存登记表**：当前页面会话内一切正常，刷新后翻页器会退化（控制台有报错）。
6. **归档失败不回滚**：fork 已经成功，此时放弃反而会让用户看到两份会话，所以只降级为「侧边栏多一行」并在 console 里报错。
7. **轮次还没结束时按钮不出现**（没有「最后一条回答」可言）。这是刻意的：正在流式生成时不该出现一排会被点坏的操作。
8. **标题不递增**：fork 时没有传 `increaseTitle`，所以侧边栏里那一行保持原标题，不会出现 `(1)`、`(2)` 尾巴。
9. **子会话是真实的新会话**：它继承源会话的 seed（历史 + cwd）。但 fork 时 **agent preset 与模型路由是按「当前」重新组合的**，不一定等于原会话当时用的那套。
10. **判据来源两路**：宿主路由 `/dsh-houhuiyao/turns`（读**全量日志**，v0.2.0 起的主路）与客户端事件窗口（降级路，读 `ctx.sessions.binding(id).eventSource`，初始只有 `PAGE_MESSAGES = 50` 条 user/assistant 消息）。
    - 窗口这一路只在**宿主路由拿不到**时用（老运行时，或宿主还没重启）：它需要「上一轮 + 最后一轮」的 `turn/start` 都在窗口内，工具密集的长轮次会被裁掉 —— 这正是 v0.2.0 修的 29 条。
    - `SessionEventSource` 虽是公开导出的，但文档写着「reserved for Conversation assembly」；将来若收紧这个入口，降级路就失效（主路不受影响）。
11. **没有 i18n**：按需求全部文案是简体中文，硬编码。
12. **上一轮缺 `turn/end` 时不能操作**（v0.2.0 起会明说原因，而不是消失）：`turn/start` 与 `turn/end` 不总是配对的 —— 实测有会话是 5 个 `turn/start`、4 个 `turn/end`（被中断/重启留下的未闭合轮次）。fork 的切点是「第一个 `seq >= atSeq` 的 `turn/end`」，而锚点只能取**目标轮之前那个已闭合的 `turn/end`**；它不存在时无法 fork（退而取更早的 `turn/end` 会把未闭合轮次整段带进 seed，违反 seed 契约）。这时显示：*上一轮没有正常结束，暂时没有分叉点*。
13. **系统注入触发的轮次不能操作**：该轮只有 `source.kind !== 'user'` 的消息（定时任务、续跑、分身消息等），没有「原问题」可重发。显示：*这一轮由系统触发，没有可重发的提问*。

---

## 文件

```
package.json          包的 dsh 清单：dsh.bundle.patch + dsh.client{platform:web} + exports（"." / "./client"）
cordis.patch.yml      bundle patch 层：一行 insert（id 与 name 都是包名 dsh-houhuiyao）
lib/index.js          node 半边：两条同源受限的 POST 路由
                        /dsh-houhuiyao/turns         只读，读全量日志交回真实轮次（v0.2.0 新增）
                        /dsh-houhuiyao/keep-question 切 seed 建「只有提问」的子会话（零模型调用）
client/client.js      浏览器半边：slot 注册（turnTail）+ 组件 + 三条 fork 编排 + 宿主路由调用
                        + 版本登记表（含旧名迁移）+ 调试日志
tests/*.mjs           离线测试（不需要构建，不需要浏览器）
tests/probe-*.mjs     用真实会话日志（zstd 逐帧解码）核对锚点/家族 key/一轮事件的取证脚本
                       probe-fork-recent.mjs：列出最近被改动的会话，标出哪些是 fork 子会话、
                       继承了多长前缀、后面有没有真的发出 prompt（0.1.6 那次故障就是它定的位）
README.md             本文件
```

没有构建步骤：`lib/`、`client/` 就是发给运行时的原样文件。`client/client.js` 是 DSH 客户端 bundle 要求的经典脚本形式（`window.__ModuleLoader__.load({ id, factory })`），只 `require('react')` 与 `require('react-dom')`（都是平台内置），其余全是本文件内的原生 JS。

## 测试

```powershell
node tests/behaviour.test.mjs   # 视图解析、fork 参数与顺序、登记时机、prompt（0.1.6 的 using 路径）、
                                # 翻页（零归档）、编辑、两个删除选择、自愈、调试日志、
                                # 无导航接口 / 老运行时两种兼容场景、旧名登记表迁移
node tests/render.test.mjs      # 组件渲染断言（宿主判据 / turnTail 归属 / 运行中不渲染 / 原因行 / 降级路）
node tests/busy-state.test.mjs  # 忙碌态 / 两个对话框的结构与三个选择的路由 / 错误态
node tests/host-half.test.mjs   # node 半边：两条路由、seed 切割与闭合、
                                # meta(isSeeded/inheritedEventCount 必须整条等于 seed)、
                                # preset mount、工作区挂载、同源 guard、只读路由不建会话
node tests/probe-window.mjs     # 用真实会话日志核对「锚点是否落在 50 条消息的尾部窗口内」
node tests/probe-fork-recent.mjs harness 8   # 最近会话的 fork 血统 / 前缀长度 / prompt 是否送达
```

**`render.test.mjs` 从 2026-09-22 起一直是跑不起来的**：它当时从
`F:\deepseek harness\deepseek-harness-master\apps\web\node_modules` 解析真 React，
而那个目录当天就被删了（本机也再无 react/react-dom 安装）——所以「按钮到底渲染不渲染」
这条冒烟测试**断了两周**，v0.2.0 的 42% 失效就是这么漏掉的。
现在它改用与 `busy-state.test.mjs` 同一套极简 React 桩（不需要任何外部依赖），
任何 checkout 位置都能跑。

`probe-*.mjs` 需要 `C:\Users\22297\.dsh\sessions\` 下的真实会话日志，缺文件时跳过即可。

## 用到的官方 API

下面第一组是 **0.1.6-alpha.2 发布包**（`F:\dsh-016\node_modules\@deepseek-ai`）里实际跑的那套；
第二组是写这个插件时的 **0.1.2 源码版** 的 file:line 取证，**部分已被 0.1.6 改掉**
（见上面「0.1.6 兼容层」），保留作历史记录。

### 0.1.6（当前线上）

- 导航：`ctx.uiWorkspace.openSession(id)` —— `dsh-client-ui-workspace/lib/client.js:72`（`replaceMain` → `sessions.retain(id, { source: 'mainView' })`）；官方 ui-chat 的 `forkAt` 同款 `dsh-client-ui-chat/lib/client.js:8376-8384`
- 归档：`ctx.workspaces.archiveSession(id)` —— `dsh-api-workspace-controller/lib/types/client/service.js:48`；服务名 `super(ctx, "workspaces")` 同文件 `:315`
- 会话引用：`ctx.sessions.using(id, { source }, fn)` / `retain(...)` / `binding(id)`（仅借用已 retain 的绑定）—— `dsh-api-session-controller/lib/types/client/contract/sessions.d.ts:52, :60, :158`
- `ctx.sessions.fork({ sessionId, atSeq, increaseTitle })`（**没有** `open`）—— 同上 `:129-133`；切点语义 `dsh-api-session-controller/lib/index.js:684`
- `session.prompt(content, 'queue'|'steer')` → `RemoteResult<{accepted:true}>` —— `.../contract/session.d.ts:82-87`
- 事件窗口 `binding.eventSource`（`entries` / `subscribe`）—— `.../contract/events.d.ts:56-63`
- 槽位 `conversation.chat.assistant-actions`（`list` + `scope: session` + owner `{ messageId }`）—— `dsh-client-ui-chat/lib/types/client/contract/slots.d.ts:197`；渲染点 `dsh-client-ui-chat/lib/client.js:3683`
- 客户端插件热更新：dsh-client-hmr 每 500ms 轮询 bundle 文件的 mtime+size，变了就 `clientModules.rebuilt(id)` 并推 SSE —— `dsh-client-hmr/lib/index.js:47-90`（**所以 `file:` 装的插件改完客户端文件不用重启服务，浏览器里会自动重载插件**）
- 宿主半边：`ctx.webServer.register({kind,path,handler})`、`ctx.sessionQuery.observeSession(id)`、`ctx.agents.create({sessionId, seed, inheritedEventCount, meta:{cwd,parentSession,isSeeded,agentPreset}, agentOptions, setup})`、`ctx.agentDefaultModel.currentSelection()`、`ctx.get('agentPresets').resolve/mount`、`ctx.workspaceRegistry.list()` / `workspace.attachSession(id)`

### 0.1.2 源码版（历史取证）

- `ctx.slots.inject(key, cb)` / `ctx.slots.register(options, Component)` —— `packages/client/ui-renderer/src/client/registry.ts:172, :785`
- 扩展点 `conversation.chat.assistant-actions` —— `packages/client/ui-chat/src/client/contract/slots.ts:202`；渲染点 `.../chat/TurnTailNodeView.tsx:35`
- inject 的 `hooks` 舱 → 组件侧 `useAnswerVersions` —— `packages/client/ui-slots/src/renderer.ts:42` + `ui-renderer/src/client/bind.ts:21`
- `ctx.sessions.binding(id).eventSource` —— `packages/api/session-controller/src/client/sessions/service.ts:133, :559`；初始窗口 `PAGE_MESSAGES = 50` —— `.../client/sessions/session.ts:44`
- `ctx.sessions.fork({ sessionId, atSeq })` / `ctx.sessions.open(id)`（**0.1.6 已删**） / `ctx.sessions.list` —— `.../contract/sessions.ts:97, :44, :23`；fork 语义 `.../commands.ts:209-228, :245`
- `session.prompt(content, mode)` —— `.../contract/session.ts:82-87`（实现 `.../sessions/session.ts:212`）
- `ctx.workspaces.archiveSession(sessionId)` —— `packages/api/workspace-controller/src/client/service.ts:64, :114-117`
- 事件词表 `turn/start` / `turn/end` / `user/message` / `assistant/message` —— `packages/core/session/src/types.ts:228, :237, :249, :262`
