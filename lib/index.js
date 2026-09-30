/**
 * dsh-houhuiyao —— node 半边（宿主侧）。
 *
 * 两条同源受限的 POST 路由：
 *  1. `/dsh-houhuiyao/turns` —— **只读**：把一条会话的「真实轮次」交回客户端。
 *     客户端自己只有后 50 条 user/assistant 消息的窗口（0.1.6 的 `paginate`，
 *     `dsh-api-session-controller/lib/types/history.js:388-411`），工具密集的长轮次
 *     会把「上一轮的 turn/start」挤出窗口，客户端便凑不出两轮、整排按钮静默消失。
 *     宿主读的是**完整日志**，判据不再受窗口裁剪影响；这条路由不写任何东西。
 *  2. `/dsh-houhuiyao/keep-question` —— 「只删回答（保留提问，不重新生成）」。
 *
 * 「保留提问、不重新生成」之所以必须由宿主做：它要求子会话的 seed **正好切在提问的
 * `user/message`**，而客户端拿不到完整事件日志。
 *
 * 为什么不能用「发一次 prompt 再立即 cancel」糊过去（用户明确否掉的方案）：
 * 那会有模型调用、会落一个「已停止」标记，并且存在「部分回答已经落盘」的竞态。
 * 这里的做法是纯事件构造：切前缀 + 合成收尾事件，**零模型调用**。
 *
 * 用到的公开宿主 API（均已核对）：
 *  - ctx.webServer.register({kind,path,handler})   packages/host/webserver/src/index.ts:144, :165, :42
 *  - ctx.sessionQuery.observeSession(id)           packages/session-query/session-query/src/index.ts:95, :121
 *      官方 fork 读源日志用的就是它（packages/api/session-controller/src/commands.ts:194），
 *      内部自己区分 live/prepared；比 ctx.sessions.get().events / sessionPersistence.load 都正确。
 *  - ctx.agents.create({sessionId,seed,meta,agentOptions,setup})
 *                                                  packages/core/agent/src/index.ts:396；选项 :70-123
 *      其中 seed 的契约写死在 :92-99：「contiguous from seq 0」「no open turn/step or dangling tool call」。
 *  - ctx.agentDefaultModel.currentSelection()      packages/core/agent-default-model/src/index.ts:73
 *  - ctx.get('agentPresets').resolve/mount         packages/preset/agent-presets/src/index.ts:219, :343, :405
 *  - ctx.workspaceRegistry.list() / .archiveSession()
 *                                                  packages/workspace/workspace/src/index.ts:115, :244
 *  - workspace.attachSession(id)                   镜像 packages/api/session-controller/src/commands.ts:266, :493
 *  - seed 校验 / 不变量                            packages/core/session/src/index.ts:506-535；
 *                                                  packages/core/session/src/invariant.ts:60, :71-113
 *  - 合成收尾事件的先例                            packages/core/session/src/repair.ts:79-131
 *
 * @module dsh-houhuiyao
 */

import { randomUUID } from 'node:crypto'

/** 插件名（与 package.json / cordis.patch.yml 的 row name 一致）。 */
export const name = 'dsh-houhuiyao'

/** 真正用到的服务：路由、建 agent、读源日志、找工作区、默认模型。 */
export const inject = ['webServer', 'agents', 'sessionQuery', 'workspaceRegistry', 'agentDefaultModel']

/** 路由路径按包名走，避免和别人撞路径。 */
const ROUTE_KEEP_QUESTION = '/dsh-houhuiyao/keep-question'

/** 只读路由：把该会话的真实轮次（读全量日志）交回客户端。 */
const ROUTE_TURNS = '/dsh-houhuiyao/turns'

/** 请求体上限：只带两个标识，4KB 足够。 */
const MAX_BODY_BYTES = 4 * 1024

/** 会话 id 形状校验（与客户端/宿主一致：字母数字加连字符）。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/

/**
 * 同源校验：请求必须来自本 GUI 页面（Origin/Referer 的 host 等于 Host）。
 * 没有 Origin（同源导航 / 非浏览器）放行；`Origin: null`（sandbox iframe）拒绝。
 * 形状与 dsh-easyrewrite 的 guard 一致。
 * @param req - Node 请求。
 * @returns 是否放行。
 */
function requestFromSameOrigin(req) {
  try {
    const origin = req.headers?.origin || req.headers?.referer
    if (!origin) return true
    if (origin === 'null') return false
    const host = req.headers?.host
    if (!host) return false
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 读取并解析 JSON 请求体，带体积上限。
 * @param req - Node 请求。
 * @returns 解析后的对象（非对象一律返回空对象）。
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        if (text === '') { resolve({}); return }
        const parsed = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/**
 * 写出 JSON 响应。
 * @param res - Node 响应。
 * @param status - HTTP 状态码。
 * @param payload - 响应体。
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 客户端可见的中文错误（HTTP 状态码 + 稳定 code）。 */
class RouteError extends Error {
  /**
   * @param status - HTTP 状态码。
   * @param code - 稳定错误码。
   * @param message - 中文说明。
   */
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * 取一条 user/message 的纯文本（只取 text block）——与客户端同一套判定。
 * @param content - user/message 的 content 块数组。
 * @returns 纯文本（已去首尾空白）。
 */
function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * 把一份**完整**事件日志折成轮次表。
 *
 * 状态机与 invariant 一致（packages/core/session/src/invariant.ts:71-113），
 * 规则与客户端 `analyzeWindow` 完全相同 —— 区别只有一个：**这里不设窗口**。
 * 客户端只有最后 50 条 user/assistant 消息（0.1.6 `paginate`），工具密集的长
 * 轮次会把上一轮挤出窗口，于是客户端凑不出两轮、按钮静默消失；宿主读全量日志，
 * 所以「上一轮的 turn/end 是多少」这类事实只有这里问得到。
 *
 * @param events - 会话的完整事件日志（按 seq 升序）。
 * @returns 轮次表：{ turn, startSeq, endSeq, question, questionSeq, answers }。
 */
function foldTurns(events) {
  const turns = []
  let open = null
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    if (event.type === 'turn/start') {
      open = {
        turn: typeof data.turn === 'number' ? data.turn : null,
        startSeq: event.seq,
        endSeq: null,
        question: null,
        questionSeq: null,
        answers: [],
      }
      turns.push(open)
      continue
    }
    if (open === null) continue
    if (event.type === 'user/message') {
      // 只认人类直接输入；agent.inject() 的合成上下文不是「原问题」。
      const source = data.source
      if (open.question === null && source !== null && typeof source === 'object' && source.kind === 'user') {
        const text = textOfContent(data.content)
        if (text !== '') {
          open.question = text
          open.questionSeq = event.seq
        }
      }
      continue
    }
    if (event.type === 'assistant/message') {
      const message = data.message
      if (message !== null && typeof message === 'object' && typeof message.id === 'string') {
        open.answers.push(message.id)
      }
      continue
    }
    if (event.type === 'turn/end') {
      open.endSeq = event.seq
      open = null
    }
  }
  return turns
}

/**
 * 组装 `/turns` 的响应体（客户端视图的唯一真值）。
 *
 * `anchorSeq` 取**上一轮的 turn/end** —— 它就是 fork 锚点：宿主的切点是「第一个
 * seq >= atSeq 的 turn/end」（dsh-api-session-controller/.../commands.js:212-214），
 * 所以锚点必须是「目标轮之前最后一个已闭合的 turn/end」。没有上一轮（首轮）或
 * 上一轮没闭合时给 null，客户端据此显示中文原因而不是静默消失。
 *
 * @param events - 会话的完整事件日志。
 * @returns { turnCount, anchorSeq, lastTurn }。
 */
function turnsPayload(events) {
  const turns = foldTurns(events)
  const last = turns.length === 0 ? null : turns[turns.length - 1]
  const previous = turns.length >= 2 ? turns[turns.length - 2] : null
  return {
    turnCount: turns.length,
    anchorSeq: previous !== null && typeof previous.endSeq === 'number' ? previous.endSeq : null,
    lastTurn: last === null ? null : {
      turn: last.turn,
      startSeq: last.startSeq,
      endSeq: typeof last.endSeq === 'number' ? last.endSeq : null,
      closed: typeof last.endSeq === 'number',
      question: last.question,
      questionSeq: typeof last.questionSeq === 'number' ? last.questionSeq : null,
      answerIds: last.answers,
    },
  }
}

/**
 * 合成让 seed 「闭合」的收尾事件。
 *
 * 形状照抄 packages/core/session/src/repair.ts:79-131：
 *   seq 从最后一条真实事件的 seq + 1 开始，time 复用最后一条的时间戳
 *   （deterministic，且不会凭空造出一个「未来」的时间）。
 *
 * 为什么必须闭合：`ctx.agents.create` 的 seed 契约明确要求
 * 「contiguous from seq 0」「no open turn/step or dangling tool call」
 * （packages/core/agent/src/index.ts:92-99），而 `Session` 的 seed 校验会逐条跑
 * surface 校验并强制 `seq === index`（packages/core/session/src/index.ts:506-535）。
 *
 * step/end 必须在 turn/end 之前：invariant 明写「turn/end while a step is open」
 * 是违规（packages/core/session/src/invariant.ts:87-89）。
 *
 * turn/end 的 reason 选 `{ kind: 'completed' }`，理由见 README：它是唯一
 * 既不渲染任何节点标记、又不会往会话搜索索引里塞词、语义上也最不撒谎的选项。
 *
 * @param last - seed 里最后一条真实事件。
 * @param turn - 该轮的 turn 号。
 * @param step - 该轮当前打开的 step 号，未打开则为 null。
 * @returns 要追加的收尾事件（保持 seq 连续）。
 */
function closersFor(last, turn, step) {
  const closers = []
  const time = last.time
  let seq = last.seq + 1
  if (step !== null) {
    closers.push({ type: 'step/end', seq: seq++, time, data: { turn, step } })
  }
  closers.push({
    type: 'turn/end',
    seq: seq++,
    time,
    data: { turn, reason: { kind: 'completed' } },
  })
  return closers
}

/**
 * 从事件日志里定位提问，并切出「提问存在、没有任何回答」的 seed。
 *
 * 扫描方式和 invariant 的状态机一致（packages/core/session/src/invariant.ts:71-113）：
 * 逐条推进 openTurn/openStep，一路扫到提问那一条为止。
 *
 * @param events - 源会话的完整事件日志。
 * @param questionSeq - 提问 `user/message` 的 seq。
 * @returns seed 与它所在的 turn/step。
 */
function buildSeed(events, questionSeq) {
  const index = events.findIndex(event => event.seq === questionSeq)
  if (index === -1) {
    throw new RouteError(409, 'question-seq-not-found', '在这条会话的日志里找不到这个提问（日志可能已变化，请刷新后重试）')
  }
  const question = events[index]
  if (question.type !== 'user/message') {
    throw new RouteError(409, 'question-seq-not-user-message', '这个位置不是一条提问，无法保留提问')
  }
  const source = question.data?.source
  if (source === null || typeof source !== 'object' || source.kind !== 'user') {
    throw new RouteError(409, 'question-seq-not-human', '这个位置不是人类直接提出的问题，无法保留提问')
  }

  let turn = null
  let step = null
  for (let i = 0; i <= index; i += 1) {
    const event = events[i]
    if (event.type === 'turn/start') { turn = event.data.turn; step = null }
    else if (event.type === 'step/start') step = event.data.step
    else if (event.type === 'step/end') step = null
    else if (event.type === 'turn/end') { turn = null; step = null }
  }
  if (turn === null) {
    throw new RouteError(409, 'question-outside-turn', '这个提问不在一个进行中的轮次里，无法保留提问')
  }

  const head = events.slice(0, index + 1)
  const last = head[head.length - 1]
  const closers = closersFor(last, turn, step)
  return {
    seed: head.concat(closers),
    turn,
    step,
    cutIndex: index,
    /** seed 里「从父会话原样继承」的前缀长度：提问那一条及其之前的全部事件。 */
    prefixLength: index + 1,
    /** 合成的收尾事件条数（0/1 个 step/end + 1 个 turn/end）。 */
    closerCount: closers.length,
  }
}

/**
 * 找到源会话所属的工作区（镜像 commands.ts:493-503 的 direct 查找）。
 * 子会话必须落在和父会话同一个工作区里，否则工作区视图里看不见它。
 * @param ctx - 宿主 context。
 * @param source - 源会话头。
 * @returns 工作区，找不到则为 undefined（此时和 fork 一样不做挂载）。
 */
function findWorkspace(ctx, source) {
  const workspaces = ctx.workspaceRegistry.list()
  return workspaces.find(workspace => workspace.sessionIds.includes(source.id))
}

/**
 * node 半边入口：注册两条同源受限的 POST 路由。
 *
 * ① `/turns`（只读）：真实轮次。客户端只有 50 条消息的窗口，判据会漏；这条路由
 *    读全量日志，把 anchorSeq / 提问 / 本轮答案 id 交回客户端。
 * ② `/keep-question`：切出「只有提问、没有回答」的 seed 建子会话（零模型调用）。
 *
 * @param ctx - 宿主 context。
 * @returns 卸载时撤销两条路由。
 */
export function apply(ctx) {
  // ① 只读：真实轮次（不写盘、不建会话、不调用模型）。
  const disposeTurns = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_TURNS,
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: '只接受 POST' })
          return
        }
        if (!requestFromSameOrigin(req)) {
          sendJson(res, 403, { ok: false, code: 'cross-origin', message: '只允许来自本界面同源的请求' })
          return
        }
        const body = await readJsonBody(req)
        const sessionId = body.sessionId
        if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 128
          || !SESSION_ID_PATTERN.test(sessionId)) {
          sendJson(res, 400, { ok: false, code: 'bad-session-id', message: '会话 id 不合法' })
          return
        }

        // observeSession 是官方 fork 读源日志的同一入口，拿到的是**完整**日志。
        let observation
        try {
          observation = await ctx.sessionQuery.observeSession(sessionId)
        } catch (error) {
          sendJson(res, 404, {
            ok: false,
            code: 'session-not-found',
            message: `找不到这条会话：${error instanceof Error ? error.message : String(error)}`,
          })
          return
        }
        let payload
        try {
          payload = turnsPayload(observation.events)
        } finally {
          if (typeof observation?.[Symbol.dispose] === 'function') observation[Symbol.dispose]()
        }
        sendJson(res, 200, { ok: true, sessionId, ...payload })
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          code: 'internal',
          message: `读取轮次失败：${error instanceof Error ? error.message : String(error)}`,
        })
      }
    },
  })

  // ② 「只删回答、保留提问、不重新生成」：切 seed + 建子会话。
  const disposeRoute = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_KEEP_QUESTION,
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: '只接受 POST' })
          return
        }
        if (!requestFromSameOrigin(req)) {
          sendJson(res, 403, { ok: false, code: 'cross-origin', message: '只允许来自本界面同源的请求' })
          return
        }
        const body = await readJsonBody(req)
        const sessionId = body.sessionId
        const questionSeq = body.questionSeq
        if (typeof sessionId !== 'string' || sessionId === '' || sessionId.length > 128
          || !SESSION_ID_PATTERN.test(sessionId)) {
          sendJson(res, 400, { ok: false, code: 'bad-session-id', message: '会话 id 不合法' })
          return
        }
        if (!Number.isSafeInteger(questionSeq) || questionSeq < 0) {
          sendJson(res, 400, { ok: false, code: 'bad-question-seq', message: '提问位置不合法' })
          return
        }

        // 1) 读源日志。observeSession 是官方 fork 用的同一入口，内部自己区分
        //    live / prepared，并且是 Disposable。
        let observation
        try {
          observation = await ctx.sessionQuery.observeSession(sessionId)
        } catch (error) {
          sendJson(res, 404, {
            ok: false,
            code: 'session-not-found',
            message: `找不到这条会话：${error instanceof Error ? error.message : String(error)}`,
          })
          return
        }
        let seed
        let source
        let inheritedEventCount
        try {
          source = observation.header
          // 2) 切出 seed（提问保留、回答不存在），3) 合成闭合事件。
          const built = buildSeed(observation.events, questionSeq)
          seed = built.seed
          // ⚠️ 0.1.6 的快照模式硬校验（dsh-session/lib/index.js:1145）：
          //     seeded 会话「seed 必须整条等于继承前缀」（inheritedEventCount === log.length，
          //     即 seed.length）。所以这里**不能**只报真实继承的 prefixLength ——
          //     合成出来的那两条收尾事件也必须算进继承前缀，否则 agents.create 直接抛
          //     `seeded session constructor seed must equal its inherited prefix`
          //     （2026-10-01 在沙箱用真实会话实测到的线上故障：这一项功能一直是坏的）。
          //     代价只有一处：这 2 条合成事件被标成「继承」，于是不可被地址化
          //     （history.js:366 会拒绝 seq < inheritedEventCount 的地址）—— 它们本来就是
          //     纯构造物，没有被地址化的需求。
          inheritedEventCount = seed.length
        } catch (error) {
          sendJson(res, error instanceof RouteError ? error.status : 500, {
            ok: false,
            code: error instanceof RouteError ? error.code : 'seed-build-failed',
            message: error instanceof Error ? error.message : String(error),
          })
          return
        } finally {
          // 租约在读到需要的数据后立刻释放。
          if (typeof observation?.[Symbol.dispose] === 'function') observation[Symbol.dispose]()
        }

        // 4) 解析 agent preset（公开服务；与 commands.ts:240-256 的 composeAgent 等价，
        //    只是不碰私有的 installSelection —— 模型由 agentOptions 给出）。
        const presets = ctx.get('agentPresets')
        let agentPreset = source.agentPreset
        let setup
        if (presets !== undefined) {
          const resolved = await presets.resolve(source.agentPreset)
          agentPreset = resolved.id
          setup = async (agentCtx) => { await presets.mount(agentCtx, resolved.id) }
        }

        const childId = `session-${randomUUID()}`
        const { provider, model } = ctx.agentDefaultModel.currentSelection()
        try {
          // 5) 建子会话：纯事件构造，零模型调用（agent 建好后没有任何待办输入，
          //    不会自己跑轮次）。
          await ctx.agents.create({
            sessionId: childId,
            seed,
            // 0.1.6 的 create 选项：`inheritedEventCount` 是顶层字段（不是 meta.seedLength），
            // 且 meta 必须带 `isSeeded: true` —— 官方 fork 就是这么写的
            // （@deepseek-ai/dsh-api-session-controller/lib/.../commands：`inheritedEventCount: cut` +
            // `meta: { cwd, parentSession, isSeeded: true, agentPreset }`）。
            // 少了它，客户端/投影会把这条子会话当成「普通新会话」，fork 血统与
            // token 计量都会失真；而官方 fork 的 cut 恰好等于 seed.length（它切在 turn/end 上，
            // 不需要合成收尾事件），我们这条要算上合成的收尾事件 —— 见上面 prefixLength 的说明。
            inheritedEventCount,
            meta: {
              ...(source.cwd === undefined ? {} : { cwd: source.cwd }),
              parentSession: source.id,
              isSeeded: true,
              ...(agentPreset === undefined ? {} : { agentPreset }),
            },
            agentOptions: { provider, model },
            ...(setup === undefined ? {} : { setup }),
          })
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            code: 'create-failed',
            message: `创建子会话失败：${error instanceof Error ? error.message : String(error)}`,
          })
          return
        }

        // 6) 挂到和父会话同一个工作区（镜像 commands.ts:264-274）。
        const workspace = findWorkspace(ctx, source)
        if (workspace !== undefined) {
          try {
            await workspace.attachSession(childId)
          } catch (error) {
            // 子会话已经建好，挂载失败只降级：它仍在会话列表里，只是不在工作区分组下。
            ctx.logger?.warn?.(`dsh-houhuiyao: child "${childId}" attach failed: ${String(error)}`)
          }
        }

        // 7) **有意不归档父会话**（与「重新生成 / 编辑 / 一起删」那三条路径不同）。
        //
        //    理由（结构性，不是偷懒）：
        //    这个子会话的最后一轮只有提问、没有 assistant/message。客户端那条
        //    `conversation.chat.assistant-actions` 行只在「该轮有最后一条有内容的回答」时
        //    才渲染（packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx:26,32-35；
        //    turn-tail.ts:131-134 的 hasText 也要求有文本回答）。所以在这个「只有提问」
        //    的版本上，插件的按钮和翻页器**都不可能渲染**。
        //    而宿主没有任何 unarchive（WorkspaceRegistry 只有 archiveSession，
        //    packages/workspace/workspace/src/index.ts:244），归档是单向的。
        //    两者相叠：一旦归档父会话，用户就落在「没有回答、没有翻页器、上一版被永久
        //    藏起来」的死角里。因此这里保留父会话，让侧边栏那一行成为回得去的退路。
        //    代价是侧边栏会多一行（新版本 + 原版本），这是刻意取舍，README 已写明。

        // 8) 把子会话 id 交回客户端，由客户端 open + 登记版本家族。
        sendJson(res, 200, {
          ok: true,
          sessionId: childId,
          seedLength: seed.length,
          archived: false,
          attachedWorkspace: workspace === undefined ? null : workspace.id,
        })
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          code: 'internal',
          message: `操作失败：${error instanceof Error ? error.message : String(error)}`,
        })
      }
    },
  })

  return () => { disposeTurns(); disposeRoute() }
}
