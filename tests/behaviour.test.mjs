/**
 * dsh-houhuiyao 客户端半边行为测试（离线，无浏览器）。
 * 伪造 window.__ModuleLoader__ / require('react','react-dom') / localStorage / ctx。
 *
 * 跑法：node tests/behaviour.test.mjs
 */
import { readFileSync } from 'node:fs'

const SRC = new URL('../client/client.js', import.meta.url)

let failures = 0
function check(label, cond, extra) {
  if (cond) { console.log('  ok  ' + label) } else { failures += 1; console.log('  FAIL ' + label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))) }
}
function eq(label, actual, expected) {
  check(label + ' = ' + JSON.stringify(expected), JSON.stringify(actual) === JSON.stringify(expected), actual)
}

const store = new Map()
let registration = null
globalThis.window = {
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: k => { store.delete(k) },
  },
  location: { search: '' },
  __ModuleLoader__: { load: r => { registration = r } },
}

const reactStub = {
  useState: v => [v, () => {}],
  useEffect: () => {},
  useRef: v => ({ current: v }),
  useCallback: f => f,
  createElement: (type, props, ...children) => ({ type, props, children }),
}
const reactDomStub = { createPortal: (node, target) => ({ type: 'portal', node, target }) }

new Function('window', readFileSync(SRC, 'utf8'))(globalThis.window)
check('bundle 注册了 __ModuleLoader__', registration !== null)
eq('注册 id', registration.id, 'dsh-houhuiyao')
const exported = registration.factory(spec => {
  if (spec === 'react') return reactStub
  if (spec === 'react-dom') return reactDomStub
  throw new Error('unexpected require ' + spec)
})
eq('导出 name', exported.name, 'dsh-houhuiyao')
eq('导出 inject', exported.inject, ['slots', 'sessions', 'workspaces'])

// ── 伪造会话事件窗口 ──────────────────────────────────────────────────────
const ev = (seq, type, data) => ({ type: 'event', event: { type, seq, time: 1000 + seq, data } })
const userMsg = (seq, text) => ev(seq, 'user/message', { role: 'user', id: 'u' + seq, content: [{ type: 'text', text }], source: { kind: 'user' }, surfaceOp: 'append' })
const asstMsg = (seq, id) => ev(seq, 'assistant/message', { turn: 1, step: 1, message: { id, role: 'assistant', content: [], source: { kind: 'model' } } })

const WINDOW_TWO_TURNS = [
  ev(0, 'turn/start', { turn: 1 }),
  userMsg(1, '问题一'),
  asstMsg(2, 'm1'),
  ev(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ev(4, 'turn/start', { turn: 2 }),
  userMsg(5, '问题二'),
  asstMsg(6, 'm2'),
  ev(7, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
]
const WINDOW_MULTI_STEP = [
  ev(0, 'turn/start', { turn: 1 }),
  userMsg(1, '问题一'),
  asstMsg(2, 'm1'),
  ev(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ev(4, 'turn/start', { turn: 2 }),
  userMsg(5, '问题二'),
  asstMsg(6, 'text-answer'),
  asstMsg(7, 'trailing-tool-only'),
  ev(8, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
]
const WINDOW_FIRST_TURN_ONLY = WINDOW_TWO_TURNS.slice(0, 4)
const WINDOW_OPEN_TURN = WINDOW_TWO_TURNS.slice(0, 7)

const win = entries => ({ entries, hasMore: false, revision: 1, change: { kind: 'replace', entries } })
const windows = new Map([
  ['s1', win(WINDOW_TWO_TURNS)],
  ['multi', win(WINDOW_MULTI_STEP)],
  ['first', win(WINDOW_FIRST_TURN_ONLY)],
  ['open', win(WINDOW_OPEN_TURN)],
])
const listState = {
  ids: ['s1', 'multi', 'first', 'open'],
  byId: { s1: { id: 's1', displayTitle: 's1', running: false, blank: false, updatedAt: 0 } },
  current: 's1',
  phase: 'ready',
}

const calls = []
const promptCalls = []
const usingCalls = []
/** open() 时刻的登记表快照 —— 回归测试用：登记必须早于导航。 */
const registryAtOpen = []
let registered = null
let nextChildId = 'c1'

/**
 * 0.1.6 客户端会话服务的真实形状（本次线上故障就是照它对齐的）：
 *  - **没有** `ctx.sessions.open()`（`ClientSessions implements ISessions` 里没有这个方法，
 *    注释原话「navigation belongs to view owners」），导航在 `ctx.uiWorkspace.openSession()`；
 *  - `binding(id)` 只借用**已经被 retain** 的绑定，没被视图打开过的会话返回 undefined；
 *  - 发 prompt 的正确入口是 `ctx.sessions.using(id, {source}, fn)`。
 * 旧代码写死 `ctx.sessions.open()` + `binding(childId).session.prompt()`，在这个形状下
 * 必然抛错/拿不到 binding → fork 出来了、源会话归档了，但新问题永远发不出去
 * （线上表现：点编辑保存 → 新开界面 → 卡住）。
 */
const retained = new Set()
/** 归档集（宿主 workspace 控制器权威）：ui-workspace 会因为「主会话被归档」清空视图。 */
const archivedIds = new Set()
const catalog = id => { if (!listState.ids.includes(id)) listState.ids.push(id) }
function bindingOf(id) {
  const w = windows.get(id)
  if (w === undefined) return undefined
  return {
    sessionId: id,
    eventSource: { getSnapshot: () => w, subscribe: () => () => {} },
    session: {
      prompt: (content, mode) => {
        promptCalls.push({ id, content, mode })
        return Promise.resolve({ ok: true, value: { accepted: true } })
      },
    },
  }
}
const uiWorkspace = {
  openSession: id => {
    if (!listState.ids.includes(id)) throw new Error('unknown session "' + id + '"')
    retained.add(id)
    registryAtOpen.push({
      id,
      versions: JSON.parse(store.get('dsh-houhuiyao:versions') || '{}'),
      member: JSON.parse(store.get('dsh-houhuiyao:member') || '{}'),
    })
    calls.push(['open', id])
    listState.current = id
  },
  unarchiveSession: id => {
    calls.push(['unarchive', id])
    archivedIds.delete(id)
    return Promise.resolve()
  },
}

const ctx = {
  get: name => (name === 'uiWorkspace' ? uiWorkspace : undefined),
  slots: {
    inject: (key, cb) => { calls.push(['slots.inject', key]); const d = cb(); return () => { d && d() } },
    register: (options, component) => {
      calls.push(['slots.register', options.name, options.id, options.order])
      registered = { options, component }
      return () => {}
    },
  },
  sessions: {
    binding: id => (retained.has(id) ? bindingOf(id) : undefined),
    using: (id, options, fn) => {
      usingCalls.push({ id, source: options && options.source })
      const wasRetained = retained.has(id)
      retained.add(id)
      const reference = { sessionId: id, binding: bindingOf(id), ready: Promise.resolve() }
      return Promise.resolve(fn(reference)).finally(() => { if (!wasRetained) retained.delete(id) })
    },
    list: { getSnapshot: () => listState },
    fork: opts => {
      calls.push(['fork', opts])
      const childId = nextChildId
      catalog(childId)
      listState.byId[childId] = {
        id: childId, displayTitle: 's1', parentId: opts.sessionId,
        running: false, blank: false, updatedAt: 0,
      }
      windows.set(childId, windows.get(opts.sessionId))
      return Promise.resolve(childId)
    },
  },
  workspaces: {
    list: { getSnapshot: () => ({ archivedSessionIds: [...archivedIds] }) },
    archiveSession: id => { calls.push(['archive', id]); archivedIds.add(id); return Promise.resolve() },
    unarchiveSession: id => { calls.push(['unarchive', id]); archivedIds.delete(id); return Promise.resolve() },
  },
}

const dispose = exported.apply(ctx)
check('slots.inject 用了正确的 slot', calls[0][0] === 'slots.inject' && calls[0][1] === 'conversation.chat.turnTail', calls[0])
eq('注册 id/order', [registered.options.id, registered.options.order], ['houhuiyao', 20])

// 视图打开会话时由 ui-workspace 的 replaceMain 做 retain（这里手工模拟）。
const faceOf = id => { retained.add(id); return registered.options.inject(id) }
const viewOf = id => faceOf(id).hooks.answerVersions.getSnapshot()

// ── 视图解析 ────────────────────────────────────────────────────────────────
const v1 = viewOf('s1')
eq('可操作', v1.ready, true)
eq('归属最后一条回答', v1.messageIds, ['m2'])
eq('原问题文本', v1.question, '问题二')
eq('fork 锚点 = 上一轮 turn/end 的 seq', v1.anchorSeq, 3)
eq('家族 key', v1.familyKey, 's1#3')
eq('尚未登记时只有 1 版', [v1.versions.length, v1.index], [1, 0])

const vMulti = viewOf('multi')
eq('多 step 轮次归属全部答案 id', vMulti.messageIds, ['text-answer', 'trailing-tool-only'])
eq('多 step 轮次锚点', vMulti.anchorSeq, 3)

eq('首轮（无前置 turn/end）不可操作', viewOf('first').ready, false)
eq('未结束的轮次不可操作', viewOf('open').ready, false)

// ── 重新生成 ────────────────────────────────────────────────────────────────
await faceOf('s1').regenerate('m2')
eq('fork 参数', calls.find(c => c[0] === 'fork')[1], { sessionId: 's1', atSeq: 3 })
check('归档源会话', calls.some(c => c[0] === 'archive' && c[1] === 's1'))
check('打开子会话', calls.some(c => c[0] === 'open' && c[1] === 'c1'))
eq('把原问题重新发给子会话', promptCalls[0], { id: 'c1', content: [{ type: 'text', text: '问题二' }], mode: 'queue' })
// 顺序：fork → 导航到子会话 → prompt → 归档源会话。
// 导航必须早于归档：源会话往往正是当前主视图，先归档会让 ui-workspace 的
// clearArchivedCurrent() 清空主视图（用户看到「界面自己跳走」）。
// prompt 失败时不归档（见下面的回归用例）。
eq('动作顺序 = fork → open → archive',
  calls.filter(c => ['fork', 'open', 'archive'].includes(c[0])).map(c => c[0]),
  ['fork', 'open', 'archive'])
// ★ 回归：0.1.6 的 binding() 需要先被 retain；子会话刚 fork 出来还没被视图打开，
//   所以必须走 sessions.using 自己租引用，不能靠 binding(childId)。
check('★ 回归：prompt 走 sessions.using（binding 未 retain 也能送出去）',
  usingCalls.some(c => c.id === 'c1' && c.source === 'houhuiyao'), usingCalls)

// ★ 回归测试（本轮修的 pager bug）：导航到 child 的那一刻登记表必须已经完整。
eq('open 时版本表已含两版', registryAtOpen[0].versions, { 's1#3': ['s1', 'c1'] })
eq('open 时归属表已含父子两会话', registryAtOpen[0].member, { s1: 's1#3', c1: 's1#3' })
eq('open 时最后浏览版本已是子会话', JSON.parse(store.get('dsh-houhuiyao:viewed')), { 's1#3': 'c1' })

// 子会话第一帧就算视图 —— 必须直接看到 2 版（修复前这里会是 1 版 → 翻页器不出现）
const v2 = viewOf('c1')
eq('子会话家族 key 与父一致', v2.familyKey, 's1#3')
eq('子会话共有 2 版且停在第 2 版', [v2.versions.length, v2.index], [2, 1])

// 非归属消息 → 拒绝
const forksBefore = calls.filter(c => c[0] === 'fork').length
eq('非最后一条回答被拒绝', (await faceOf('s1').regenerate('m1')).ok, false)
eq('被拒绝时不 fork', calls.filter(c => c[0] === 'fork').length, forksBefore)

// ── 编辑提问（同一锚点、同一编排，只换文字） ──────────────────────────────
nextChildId = 'e1'
await faceOf('c1').editQuestion('m2', '  问题二（改）  ')
eq('编辑提问 fork 在同一锚点', calls.filter(c => c[0] === 'fork')[1][1], { sessionId: 'c1', atSeq: 3 })
eq('编辑提问发送改过的文字（已 trim）', promptCalls[1], { id: 'e1', content: [{ type: 'text', text: '问题二（改）' }], mode: 'queue' })
check('编辑提问也归档源会话', calls.some(c => c[0] === 'archive' && c[1] === 'c1'))
eq('编辑提问登记为第 3 版', JSON.parse(store.get('dsh-houhuiyao:versions'))['s1#3'], ['s1', 'c1', 'e1'])
eq('空文本被拒绝', (await faceOf('e1').editQuestion('m2', '   ')).ok, false)

// ── 翻页 ────────────────────────────────────────────────────────────────────
const v3 = viewOf('e1')
eq('第三版：3 版，停在最后一版', [v3.versions.length, v3.index], [3, 2])
const promptsBefore = promptCalls.length
const archivesBefore = calls.filter(c => c[0] === 'archive').length
const paged = await faceOf('e1').openVersion('s1')
eq('翻页成功', paged, { ok: true })
check('翻页调用 open(s1)', calls.some(c => c[0] === 'open' && c[1] === 's1'))
eq('翻页不发 prompt', promptCalls.length, promptsBefore)
eq('翻页记住 viewed', JSON.parse(store.get('dsh-houhuiyao:viewed')), { 's1#3': 's1' })
// ★ 回归测试（DEFECT A）：归档是单向的，
//   所以切换**绝不能**归档任何会话 —— 否则用户刚看的/想回去的版本会被抹掉。
eq('切换不对任何会话归档', calls.filter(c => c[0] === 'archive').length, archivesBefore)
// 回程也必须可用：再 ‹ / › 往返一次，依然不归档
await faceOf('e1').openVersion('c1')
await faceOf('c1').openVersion('s1')
eq('往返切换仍然零归档', calls.filter(c => c[0] === 'archive').length, archivesBefore)
check('往返切换都调用了 open', calls.filter(c => c[0] === 'open').length >= 3, calls.filter(c => c[0] === 'open').length)

// ★ 回归（2026-09-22 用户报的「箭头回不到上一次答案」）：
//   0.1.6 的 ui-workspace 只要发现**当前主会话在归档集里**就 clearArchivedCurrent() → clearMain()，
//   所以直接导航到被归档的旧版本 = 视图下一秒被清空。必须先取消归档再导航。
{
  archivedIds.add('s1') // 旧版本被 fork 取代时被归档（真实链路就是这样）
  const before = calls.length
  const switched = await faceOf('e1').openVersion('s1')
  eq('归档过的旧版本也能切换成功', switched, { ok: true })
  const seq = calls.slice(before).map(c => c[0] + (c[1] === undefined ? '' : ':' + c[1]))
  eq('先取消归档、再导航（顺序不能反）', seq, ['unarchive:s1', 'open:s1'])
  eq('取消归档之后它不再在归档集里', archivedIds.has('s1'), false)
  eq('切换依旧不归档任何版本', calls.filter(c => c[0] === 'archive').length, archivesBefore)
}

// 目标会话已被删除 → 摘除 + 自愈，不抛错
store.set('dsh-houhuiyao:versions', JSON.stringify({ 's1#3': ['s1', 'c1', 'e1', 'ghost'] }))
const dead = await faceOf('e1').openVersion('ghost')
eq('已删除的兄弟版本：返回失败而不是抛错', dead.ok, false)
eq('已删除的兄弟版本：从登记表摘除', JSON.parse(store.get('dsh-houhuiyao:versions'))['s1#3'], ['s1', 'c1', 'e1'])

// ── 归属表优先 + 家族自愈（用全新的会话，避免读到缓存视图） ────────────────
// x1：登记表说它属于 s1#3，但 parentId 指向别处 —— 归属表必须赢。
// x2：没有归属记录，parentId=s1，推导出 s1#3；它不在版本表里 → 应被追加，不塌回 1 版。
windows.set('x1', win(WINDOW_TWO_TURNS))
windows.set('x2', win(WINDOW_TWO_TURNS))
listState.ids.push('x1', 'x2')
listState.byId.x1 = { id: 'x1', displayTitle: 'x1', parentId: 'other-root', running: false, blank: false, updatedAt: 0 }
listState.byId.x2 = { id: 'x2', displayTitle: 'x2', parentId: 's1', running: false, blank: false, updatedAt: 0 }

store.set('dsh-houhuiyao:versions', JSON.stringify({ 's1#3': ['s1', 'x1'] }))
store.set('dsh-houhuiyao:member', JSON.stringify({ x1: 's1#3' }))

const vMember = viewOf('x1')
eq('归属表优先于 parentId 推导', vMember.familyKey, 's1#3')
eq('归属表命中：2 版，当前是第 2 版', [vMember.versions.length, vMember.index], [2, 1])

store.set('dsh-houhuiyao:versions', JSON.stringify({ 's1#3': ['s1', 'c1'] }))
store.set('dsh-houhuiyao:member', JSON.stringify({}))
const vHeal = viewOf('x2')
eq('无归属记录时退回推导 key', vHeal.familyKey, 's1#3')
eq('不在版本表里的会话被追加为最后一版', [vHeal.versions.length, vHeal.index], [3, 2])

// ── 删除这轮的两个选项（DEFECT B） ─────────────────────────────────────────
// (1) 「提问和回答一起删」= choice 'both' = 纯删除编排：fork → 归档 → open，不发 prompt
nextChildId = 'd1'
const promptsBeforeRemove = promptCalls.length
const removed = await faceOf('c1').removeTurn('m2', 'both')
windows.set('d1', win(WINDOW_FIRST_TURN_ONLY))
eq('「提问和回答一起删」成功', removed, { ok: true })
eq('删除同一锚点 fork', calls.filter(c => c[0] === 'fork').at(-1)[1], { sessionId: 'c1', atSeq: 3 })
check('删除后打开子会话', calls.some(c => c[0] === 'open' && c[1] === 'd1'))
eq('「一起删」不发任何 prompt', promptCalls.length, promptsBeforeRemove)
eq('登记表已作废版本家族', JSON.parse(store.get('dsh-houhuiyao:versions'))['s1#3'], undefined)
eq('登记表已作废归属', JSON.parse(store.get('dsh-houhuiyao:member'))['c1'], undefined)
eq('删除后剩下的首轮不可操作', viewOf('d1').ready, false)

// (2) 「只删回答（保留提问并重新生成）」= choice 'regenerate' = regenerate 的同一套编排
//     dsh 里提问和回答同属一个 turn、中间没有分界，所以这一支必须重新提问。
nextChildId = 'a1'
windows.set('a1', win(WINDOW_TWO_TURNS))
const promptsBeforeAnswerOnly = promptCalls.length
const answerOnly = await faceOf('c1').removeTurn('m2', 'regenerate')
eq('「只删回答」成功', answerOnly, { ok: true })
eq('「只删回答」fork 在同一锚点', calls.filter(c => c[0] === 'fork').at(-1)[1], { sessionId: 'c1', atSeq: 3 })
check('「只删回答」也归档源会话', calls.some(c => c[0] === 'archive' && c[1] === 'c1'))
check('「只删回答」打开子会话', calls.some(c => c[0] === 'open' && c[1] === 'a1'))
eq('「只删回答」用原问题重新提问（不是纯删除）', promptCalls.length, promptsBeforeAnswerOnly + 1)
eq('「只删回答」发的是原问题文本', promptCalls.at(-1), { id: 'a1', content: [{ type: 'text', text: '问题二' }], mode: 'queue' })
eq('「只删回答」登记为新版本', JSON.parse(store.get('dsh-houhuiyao:versions'))['s1#3'] !== undefined, true)

// 缺失/未识别的 choice 必须落回「一起删」这个安全默认，而不是静默不做事
nextChildId = 'safe1'
windows.set('safe1', win(WINDOW_FIRST_TURN_ONLY))
const promptsBeforeDefault = promptCalls.length
const defaulted = await faceOf('c1').removeTurn('m2')
eq('缺省 choice 落回「一起删」并成功', defaulted, { ok: true })
eq('缺省 choice 不发 prompt', promptCalls.length, promptsBeforeDefault)

// ── 运行时兼容：导航不可用 / 老运行时 ──────────────────────────────────────
// ★ 回归（线上故障的正面用例）：导航接口整个不在时，prompt 依然必须送出去。
//   旧代码 `ctx.sessions.open(childId)` 一抛错，fork 之后的链条全断，
//   结果就是「新会话建出来了，新问题永远不发」。
{
  const calls2 = []
  const prompts2 = []
  const retained2 = new Set()
  let reg2 = null
  let child2 = 'n1'
  const win2 = win(WINDOW_TWO_TURNS)
  const ctx2 = {
    // 既没有 uiWorkspace，也没有 ctx.sessions.open —— 最坏的运行时
    slots: {
      inject: (k, cb) => { const d = cb(); return () => { d && d() } },
      register: (o, c) => { reg2 = { o, c }; return () => {} },
    },
    sessions: {
      binding: id => (retained2.has(id)
        ? { eventSource: { getSnapshot: () => win2, subscribe: () => () => {} }, session: { prompt: (content, mode) => { prompts2.push({ id, content, mode }); return Promise.resolve({ ok: true }) } } }
        : undefined),
      using: (id, options, fn) => {
        retained2.add(id)
        return Promise.resolve(fn({ sessionId: id, binding: { session: { prompt: (content, mode) => { prompts2.push({ id, content, mode }); return Promise.resolve({ ok: true }) } } }, ready: Promise.resolve() }))
      },
      list: { getSnapshot: () => ({ ids: ['s2', child2], byId: { s2: {}, [child2]: {} }, phase: 'ready' }) },
      fork: opts => { calls2.push(['fork', opts]); return Promise.resolve(child2) },
    },
    workspaces: { archiveSession: id => { calls2.push(['archive', id]); return Promise.resolve() } },
  }
  const exported3 = registration.factory(spec => { if (spec === 'react') return reactStub; if (spec === 'react-dom') return reactDomStub; throw new Error('unexpected require ' + spec) })
  exported3.apply(ctx2)
  retained2.add('s2')
  const face2 = reg2.o.inject('s2')
  const result = await face2.regenerate('m2')
  check('★ 回归：没有任何导航接口时重新生成仍然成功', result.ok === true, result)
  eq('★ 回归：没有任何导航接口时 prompt 照样送到子会话', prompts2[0], { id: child2, content: [{ type: 'text', text: '问题二' }], mode: 'queue' })
  check('★ 回归：没有任何导航接口时仍然归档源会话（prompt 已送达）', calls2.some(c => c[0] === 'archive' && c[1] === 's2'), calls2)
}

// 老运行时（0.1.2 源码版）：只有 ctx.sessions.open()，没有 using / uiWorkspace。
{
  const calls3 = []
  const prompts3 = []
  const retained3 = new Set()
  let reg3 = null
  let child3 = 'L1'
  const win3 = win(WINDOW_TWO_TURNS)
  const binding3 = id => (retained3.has(id)
    ? { eventSource: { getSnapshot: () => win3, subscribe: () => () => {} }, session: { prompt: (content, mode) => { prompts3.push({ id, content, mode }); return Promise.resolve({ ok: true }) } } }
    : undefined)
  const ctx3 = {
    slots: {
      inject: (k, cb) => { const d = cb(); return () => { d && d() } },
      register: (o, c) => { reg3 = { o, c }; return () => {} },
    },
    sessions: {
      binding: binding3,
      list: { getSnapshot: () => ({ ids: ['s3', child3], byId: { s3: {}, [child3]: {} }, phase: 'ready' }) },
      fork: opts => { calls3.push(['fork', opts]); return Promise.resolve(child3) },
      open: id => {
        if (!['s3', child3].includes(id)) throw new Error('unknown session "' + id + '"')
        retained3.add(id)
        calls3.push(['open', id])
      },
    },
    workspaces: { archiveSession: id => { calls3.push(['archive', id]); return Promise.resolve() } },
  }
  const exported4 = registration.factory(spec => { if (spec === 'react') return reactStub; if (spec === 'react-dom') return reactDomStub; throw new Error('unexpected require ' + spec) })
  exported4.apply(ctx3)
  retained3.add('s3')
  const face3 = reg3.o.inject('s3')
  const result3 = await face3.regenerate('m2')
  check('老运行时（只有 sessions.open）仍然成功', result3.ok === true, result3)
  eq('老运行时仍然走 sessions.open 导航', calls3.find(c => c[0] === 'open')[1], child3)
  eq('老运行时 prompt 照样送到子会话', prompts3[0], { id: child3, content: [{ type: 'text', text: '问题二' }], mode: 'queue' })
}

// ── 改名迁移：两代旧名（dsh-banben:* / dsh-answer-versions:*）的登记表都必须被认下来 ──
// 插件改过两次名，用户的版本家族存在 localStorage 里，改名不能把翻页器弄丢。
// 迁移是一条链：新键 → dsh-banben → dsh-answer-versions。
for (const legacyName of ['dsh-banben', 'dsh-answer-versions']) {
  const legacyStore = new Map()
  legacyStore.set(legacyName + ':versions', JSON.stringify({ 's1#3': ['s1', 'c1'] }))
  legacyStore.set(legacyName + ':member', JSON.stringify({ c1: 's1#3' }))
  legacyStore.set(legacyName + ':viewed', JSON.stringify({ 's1#3': 'c1' }))
  let reg4 = null
  globalThis.window = {
    localStorage: {
      getItem: k => (legacyStore.has(k) ? legacyStore.get(k) : null),
      setItem: (k, v) => { legacyStore.set(k, String(v)) },
    },
    location: { search: '' },
    __ModuleLoader__: { load: r => { reg4 = r } },
  }
  new Function('window', readFileSync(SRC, 'utf8'))(globalThis.window)
  const exported5 = reg4.factory(spec => spec === 'react' ? reactStub : reactDomStub)
  let registered5 = null
  exported5.apply({
    slots: {
      inject: (k, cb) => { const d = cb(); return () => { d && d() } },
      register: (o, c) => { registered5 = { o, c }; return () => {} },
    },
    sessions: ctx.sessions,
    workspaces: ctx.workspaces,
  })
  const viewLegacy = registered5.o.inject('s1').hooks.answerVersions.getSnapshot()
  eq(`旧名 ${legacyName} 的版本登记表被认下来（c1 仍在家族里）`, viewLegacy.versions, ['s1', 'c1'])
  eq(`旧名 ${legacyName} 家族里当前会话就是第 1 版`, viewLegacy.index, 0)
  check(`旧名 ${legacyName}：迁移后新键已经写进 localStorage`, legacyStore.has('dsh-houhuiyao:versions'), [...legacyStore.keys()])
}

// ── 调试开关（刻意用**旧名**的键，顺带守住「改名后老键仍然认」）────────────────
const logs = []
const realLog = console.log
console.log = (...args) => { logs.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')) }
const debugStore = new Map(store)
debugStore.set('dsh-answer-versions:debug', '1')
let registration2 = null
globalThis.window = {
  localStorage: {
    getItem: k => (debugStore.has(k) ? debugStore.get(k) : null),
    setItem: (k, v) => { debugStore.set(k, String(v)) },
  },
  location: { search: '' },
  __ModuleLoader__: { load: r => { registration2 = r } },
}
new Function('window', readFileSync(SRC, 'utf8'))(globalThis.window)
const exported2 = registration2.factory(spec => spec === 'react' ? reactStub : reactDomStub)
let registered2 = null
exported2.apply({
  slots: {
    inject: (k, cb) => { const d = cb(); return () => { d && d() } },
    register: (o, c) => { registered2 = { o, c }; return () => {} },
  },
  sessions: ctx.sessions,
  workspaces: ctx.workspaces,
})
registered2.o.inject('s1')
console.log = realLog
const debugLines = logs.filter(l => l.startsWith('[houhuiyao]'))
check('调试开启后打印 [houhuiyao] 日志（用的是旧键，证明老键仍然认）', debugLines.length > 0, logs.slice(0, 2))
check('调试日志含 anchorSeq', debugLines.some(l => l.includes('anchorSeq')), debugLines.slice(0, 2))
check('调试日志含家族 key', debugLines.some(l => l.includes('s1#3')), debugLines.slice(0, 2))

dispose()
check('卸载不抛错', true)

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)
