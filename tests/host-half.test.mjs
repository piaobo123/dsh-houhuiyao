/**
 * dsh-houhuiyao node 半边（宿主路由）离线测试。
 *
 * 用一个假 ctx 抓住路由，再喂一个真实形状的事件日志，断言：
 *  - seed 正好切在提问的 user/message，回答不在里面；
 *  - 合成的收尾事件满足 Session 的 seed 契约（seq 连续、step/end 先于 turn/end）；
 *  - 交给 agents.create 的 meta 完整（cwd / parentSession / isSeeded / agentPreset，
 *    外加顶层 inheritedEventCount —— 0.1.6 的字段形状）；
 *  - setup 真的会 mount preset；
 *  - 挂工作区 + 归档父会话都被调用；
 *  - 同源 guard 生效；
 *  - 全程不发 prompt、不 cancel。
 *
 * 跑法：node tests/host-half.test.mjs
 */
import { EventEmitter } from 'node:events'

const SRC = new URL('../lib/index.js', import.meta.url)

let failures = 0
function check(label, cond, extra) {
  if (cond) { console.log('  ok  ' + label) } else { failures += 1; console.log('  FAIL ' + label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))) }
}
function eq(label, actual, expected) {
  check(label + ' = ' + JSON.stringify(expected), JSON.stringify(actual) === JSON.stringify(expected), actual)
}

const mod = await import(SRC)
eq('导出 name', mod.name, 'dsh-houhuiyao')
eq('导出 inject', mod.inject, ['webServer', 'agents', 'sessionQuery', 'workspaceRegistry', 'agentDefaultModel'])

// ── 真实形状的事件日志（照 SOURCE 会话的最后两轮，seq 从 0 连续） ──────────
const BASE_TIME = 1_700_000_000_000
const EV = (seq, type, data) => ({ type, seq, time: BASE_TIME + seq, data })
const userMessage = (seq, text) => EV(seq, 'user/message', {
  role: 'user',
  id: 'u' + seq,
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
  surfaceOp: 'append',
})
const EVENTS = [
  EV(0, 'turn/start', { turn: 1 }),
  EV(1, 'step/start', { turn: 1, step: 1 }),
  userMessage(2, '问题一'),
  EV(3, 'assistant/message', { turn: 1, step: 1, message: { id: 'm1' } }),
  EV(4, 'step/end', { turn: 1, step: 1 }),
  EV(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  // 第二轮：提问 seq = 9
  EV(6, 'turn/start', { turn: 2 }),
  EV(7, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [] }),
  EV(8, 'step/start', { turn: 2, step: 1 }),
  userMessage(9, '问题二'),
  EV(10, 'request/header', { header: {}, reason: 'initial' }),
  EV(11, 'assistant/chunk', { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: '答' } }),
  EV(12, 'assistant/message', { turn: 2, step: 1, message: { id: 'm2' } }),
  EV(13, 'step/end', { turn: 2, step: 1 }),
  EV(14, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
]
const QUESTION_SEQ = 9

// ── 假 ctx ────────────────────────────────────────────────────────────────
/** path -> 路由（插件现在注册两条：只读的 /turns 与建会话的 /keep-question）。 */
const routes = new Map()
const created = []
const archived = []
const attached = []
let observeCalls = 0
let disposed = 0
const HEADER = {
  type: 'session', version: 0, id: 'session-parent', createdAt: 1,
  cwd: 'F:\\deepseek harness', agentPreset: 'standard',
}
const workspace = {
  id: 'ws-1',
  path: 'F:\\deepseek harness',
  sessionIds: ['session-parent'],
  attachSession: (id) => { attached.push(id); return Promise.resolve() },
}
const presets = {
  calls: [],
  resolve: (id) => { presets.calls.push(['resolve', id]); return Promise.resolve({ id: id === undefined ? 'default-preset' : id }) },
  mount: (agentCtx, id) => { presets.calls.push(['mount', id]); return Promise.resolve({ id }) },
}
const ctx = {
  logger: { warn: () => {} },
  get: (name) => (name === 'agentPresets' ? presets : undefined),
  webServer: { register: (r) => { routes.set(r.path, r); return () => {} } },
  sessionQuery: {
    observeSession: () => {
      observeCalls += 1
      return Promise.resolve({
        source: 'live',
        header: HEADER,
        events: EVENTS,
        cursor: EVENTS.length - 1,
        retain() { return this },
        [Symbol.dispose]() { disposed += 1 },
      })
    },
  },
  agents: {
    create: async (options) => {
      created.push(options)
      // 真跑 setup：证明 preset 确实会被 mount（真实现里 factory 也是这么调的）。
      if (typeof options.setup === 'function') await options.setup({ agent: { session: {} } })
      return {}
    },
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
  workspaceRegistry: {
    list: () => [workspace],
    archiveSession: (id) => { archived.push(id); return Promise.resolve() },
  },
}
const dispose = mod.apply(ctx)
check('注册了两条路由', routes.size === 2, [...routes.keys()])
const turnsRoute = routes.get('/dsh-houhuiyao/turns')
const keepRoute = routes.get('/dsh-houhuiyao/keep-question')
eq('只读路由类型/路径', [turnsRoute?.kind, turnsRoute?.path], ['exact', '/dsh-houhuiyao/turns'])
eq('保留提问路由类型/路径', [keepRoute?.kind, keepRoute?.path], ['exact', '/dsh-houhuiyao/keep-question'])

// ── 假 req/res ────────────────────────────────────────────────────────────
function fakeRes() {
  const res = new EventEmitter()
  res.status = null
  res.body = null
  res.writeHead = (status) => { res.status = status }
  res.end = (body) => { res.body = body; res.emit('done') }
  return res
}
function fakeReq(method, body, headers = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = { host: '127.0.0.1:3080', 'content-type': 'application/json', ...headers }
  req.destroy = () => {}
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}
async function callOn(target, method, body, headers) {
  const res = fakeRes()
  await target.handler(fakeReq(method, body, headers), res)
  return { status: res.status, json: res.body === null ? null : JSON.parse(res.body) }
}
/** 默认打「保留提问」那条路由（下面绝大多数断言都是它的）。 */
async function call(method, body, headers) {
  return callOn(keepRoute, method, body, headers)
}
/** 打只读的轮次路由。 */
async function callTurns(method, body, headers) {
  return callOn(turnsRoute, method, body, headers)
}
const POST = '/dsh-houhuiyao/keep-question'

// ── 只读轮次路由（本轮新增：判据不再受客户端 50 条窗口裁剪影响）─────────────
{
  const info = await callTurns('POST', { sessionId: 'session-parent' })
  eq('轮次路由 200', info.status, 200)
  eq('轮次路由 ok', info.json.ok, true)
  // 夹具 EVENTS：两轮，第一轮 turn/end 在 seq 5，第二轮 turn/end 在 seq 14，
  // 第二轮提问在 seq 9（source.kind === 'user'）。
  eq('轮次总数', info.json.turnCount, 2)
  eq('锚点 = 上一轮的 turn/end', info.json.anchorSeq, 5)
  eq('最后一轮的轮号', info.json.lastTurn.turn, 2)
  eq('最后一轮已闭合', info.json.lastTurn.closed, true)
  eq('最后一轮的 turn/end', info.json.lastTurn.endSeq, 14)
  eq('最后一轮的人类提问 seq', info.json.lastTurn.questionSeq, 9)
  eq('最后一轮的原问题文本', info.json.lastTurn.question, '问题二')
  eq('最后一轮的答案 id 全交回客户端', info.json.lastTurn.answerIds, ['m2'])
  eq('只读路由不建任何会话', created.length, 0)
  eq('轮次路由也拒绝跨源', (await callTurns('POST', { sessionId: 'session-parent' }, { origin: 'http://evil.test' })).status, 403)
  eq('轮次路由也拒绝 GET', (await callTurns('GET')).status, 405)
  eq('轮次路由校验 sessionId', (await callTurns('POST', { sessionId: 'bad id!' })).status, 400)
}

// ── guard ─────────────────────────────────────────────────────────────────
eq('GET 被拒绝', (await call('GET')).status, 405)
eq('跨源被拒绝', (await call('POST', { sessionId: 'session-parent', questionSeq: QUESTION_SEQ }, { origin: 'http://evil.test' })).status, 403)
eq('Origin: null 被拒绝', (await call('POST', { sessionId: 'session-parent', questionSeq: QUESTION_SEQ }, { origin: 'null' })).status, 403)
eq('同源放行的请求进到了业务逻辑',
  (await call('POST', { sessionId: 'session-parent', questionSeq: 12 }, { origin: 'http://127.0.0.1:3080' })).json.code,
  'question-seq-not-user-message')
eq('错误 sessionId 被拒绝', (await call('POST', { sessionId: 'bad id!', questionSeq: 1 })).status, 400)
eq('错误 questionSeq 被拒绝', (await call('POST', { sessionId: 'session-parent', questionSeq: -1 })).status, 400)
eq('定位不到提问 → 409', (await call('POST', { sessionId: 'session-parent', questionSeq: 999 })).json.code, 'question-seq-not-found')
eq('指向 step/start → 409', (await call('POST', { sessionId: 'session-parent', questionSeq: 8 })).json.code, 'question-seq-not-user-message')
eq('指向 tool/插件消息 → 409', (await call('POST', { sessionId: 'session-parent', questionSeq: 7 })).json.code, 'question-seq-not-user-message')

// ── 正常路径 ──────────────────────────────────────────────────────────────
const disposedBefore = disposed
const ok = await call('POST', { sessionId: 'session-parent', questionSeq: QUESTION_SEQ })
eq('成功状态码', ok.status, 200)
check('返回新的子会话 id', ok.json.ok === true && /^session-[0-9a-f-]{36}$/.test(ok.json.sessionId), ok.json)
eq('每次 observeSession 都释放了租约', disposed, disposedBefore + 1)

eq('只调用了一次 agents.create', created.length, 1)
const options = created[0]
eq('子会话 id 与响应一致', options.sessionId, ok.json.sessionId)
eq('meta.cwd 继承父会话', options.meta.cwd, HEADER.cwd)
eq('meta.parentSession 指向父会话', options.meta.parentSession, 'session-parent')
// 0.1.6 的 create 契约（镜像官方 fork）：继承前缀长度是**顶层** `inheritedEventCount`，
// meta 里是 `isSeeded: true`；老代码写的是 meta.seedLength，0.1.6 不认这个字段。
eq('meta.isSeeded 标出这是 fork 血统', options.meta.isSeeded, true)
eq('meta 不再带 0.1.2 时代的 seedLength', options.meta.seedLength, undefined)
// ★ 2026-10-01 沙箱实测的线上故障：0.1.6 快照模式硬校验
//   「seeded session constructor seed must equal its inherited prefix」
//   （dsh-session/lib/index.js:1145：inheritedEventCount 必须等于 seed.length）。
//   以前这里报的是「真实继承前缀」（seed.length - 2），于是「只删回答（保留提问、
//   不重新生成）」在 0.1.6 上必然 500 —— 离线测试当时还把它当成正确行为断言了。
eq('★ inheritedEventCount 必须整条等于 seed（含合成的收尾事件）',
  options.inheritedEventCount, options.seed.length)
eq('★ 真实继承前缀只有「提问及之前」（= QUESTION_SEQ + 1，比 inheritedEventCount 少两条合成收尾）',
  QUESTION_SEQ + 1, options.seed.length - 2)
eq('meta.agentPreset 已解析', options.meta.agentPreset, 'standard')
eq('agentOptions 来自当前默认模型', options.agentOptions, { provider: 'deepseek', model: 'deepseek-chat' })
eq('preset 被 resolve + mount（公开 agentPresets 服务）', presets.calls.map(c => c[0] + ':' + c[1]), ['resolve:standard', 'mount:standard'])

// ── seed 内容 ─────────────────────────────────────────────────────────────
const seed = options.seed
eq('seed 里只有两条提问（都在切点之前）', seed.filter(e => e.type === 'user/message').map(e => e.seq), [2, 9])
eq('seed 的最后一条真实事件就是那条提问', seed[seed.length - 3], EVENTS[QUESTION_SEQ])
eq('seed 里不含第二轮的助手消息/分片', seed.filter(e => e.type === 'assistant/message' || e.type === 'assistant/chunk').map(e => e.seq), [3])
check('seed 不含任何 seq >= 提问之后的事件', seed.every(e => e.seq <= QUESTION_SEQ + 2), seed.map(e => e.seq))
check('seed 不含 request/header（它在提问之后）', !seed.some(e => e.type === 'request/header'), seed.map(e => e.type))

// 合成收尾
const closers = seed.slice(-2)
eq('合成两个收尾事件', closers.map(e => e.type), ['step/end', 'turn/end'])
eq('step/end 关闭提问所在的那一步', closers[0].data, { turn: 2, step: 1 })
eq('turn/end 关闭提问所在的那一轮', closers[1].data, { turn: 2, reason: { kind: 'completed' } })
// Session.create 的硬校验：seq 必须从 0 连续（packages/core/session/src/index.ts:523）
eq('seed seq 从 0 连续', seed.every((e, i) => e.seq === i), true)
eq('seed 里没有打开的 turn/step', (() => {
  let turn = null; let step = null
  for (const e of seed) {
    if (e.type === 'turn/start') { turn = e.data.turn; step = null }
    else if (e.type === 'step/start') step = e.data.step
    else if (e.type === 'step/end') step = null
    else if (e.type === 'turn/end') { turn = null; step = null }
  }
  return turn === null && step === null
})(), true)
check('收尾事件只带合法 envelope 键',
  closers.every(e => Object.keys(e).every(k => ['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs'].includes(k))),
  closers.map(e => Object.keys(e)))
eq('收尾事件复用最后一条真实事件的时间戳', closers[0].time, EVENTS[QUESTION_SEQ].time)
eq('收尾事件 seq 紧接提问', closers.map(e => e.seq), [QUESTION_SEQ + 1, QUESTION_SEQ + 2])

// ── 不发 prompt / 不 cancel ───────────────────────────────────────────────
// 宿主路由根本没有 prompt/cancel 调用面：这里用「created 只有 seed/meta」证伪。
check('create 参数里没有任何 prompt/cancel 指令',
  !('prompt' in options) && !('cancel' in options) && !('content' in options), Object.keys(options))

// ── 工作区 + 归档 ─────────────────────────────────────────────────────────
eq('子会话挂到父会话的工作区', attached, [ok.json.sessionId])
// 有意不归档：这个版本没有回答行 → 插件的按钮/翻页器在那边渲染不出来，
// 而宿主没有 unarchive，归档父会话会把用户锁死在死角里。
eq('有意不归档父会话', archived, [])
check('响应报告 archived=false', ok.json.archived === false)
eq('响应带 workpace 信息', ok.json.attachedWorkspace, 'ws-1')

// ── 卸载 ──────────────────────────────────────────────────────────────────
dispose()
check('卸载不抛错', true)

void POST
console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)
