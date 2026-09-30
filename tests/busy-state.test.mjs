/**
 * dsh-answer-versions 忙碌态 / 两个对话框的结构与路由 / 错误态测试。
 *
 * 重点：
 *  - 对话框必须是「视口居中的模态层」（DSH 页面不滚动，按 rect 摆位的浮层会把
 *    提交按钮推到视口外，永远点不到）。
 *  - 「删除这轮」有四个控件（三个选择 + 取消），第三项走宿主路由、
 *    不发 prompt、不 fork。
 *
 * 跑法：node tests/busy-state.test.mjs
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

function texts(node, out) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (Array.isArray(node)) { for (const child of node) texts(child, out); return out }
  if (node.type === 'portal') { texts(node.node, out); return out }
  texts(node.children, out)
  return out
}

function buttonCount(node) {
  if (node === null || node === undefined || typeof node !== 'object') return 0
  if (Array.isArray(node)) return node.reduce((sum, child) => sum + buttonCount(child), 0)
  if (node.type === 'portal') return buttonCount(node.node)
  return (node.type === 'button' ? 1 : 0) + buttonCount(node.children)
}

/** 最近一次 loadWith 注册的 document keydown 处理器（模拟 Ctrl+Enter / Esc）。 */
let docKeyHandler = null

/**
 * 用给定的 useState 初值载入插件。
 * useState 顺序固定为 [busy, error, dialog]，dialog 取值
 * null | { kind:'edit', text } | { kind:'delete' }。
 */
function loadWith(scriptedStates) {
  let registration = null
  const store = new Map()
  docKeyHandler = null
  const setterLog = []
  const fetchCalls = []
  const openCalls = []
  const refreshCalls = []
  /** 宿主路由返回的子会话 id；null 表示让路由失败。 */
  let hostedChildId = 'h1'
  /** true = 宿主返回后才把子会话放进列表（逼客户端走 refresh 路径）。 */
  let childNeedsRefresh = false

  globalThis.document = {
    body: { tag: 'body' },
    addEventListener: (type, fn) => { if (type === 'keydown') docKeyHandler = fn },
    removeEventListener: () => {},
  }
  globalThis.window = {
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)) },
    },
    location: { search: '' },
    setTimeout: (fn) => { fn(); return 0 },
    fetch: (url, init) => {
      fetchCalls.push({ url, method: init?.method, headers: init?.headers, body: JSON.parse(init?.body ?? '{}') })
      // 只读的「真实轮次」路由：返回与夹具窗口一致的全量日志结论。
      if (url === '/dsh-houhuiyao/turns') {
        return Promise.resolve({
          status: 200,
          json: () => Promise.resolve({
            ok: true,
            sessionId: 's1',
            turnCount: 2,
            anchorSeq: 3,
            lastTurn: {
              turn: 2, startSeq: 4, endSeq: 7, closed: true,
              question: '问题二', questionSeq: 5, answerIds: ['m2'],
            },
          }),
        })
      }
      if (hostedChildId === null) {
        return Promise.resolve({ status: 500, json: () => Promise.resolve({ ok: false, message: '宿主拒绝了这个请求' }) })
      }
      if (!childNeedsRefresh) catalog(hostedChildId)
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ ok: true, sessionId: hostedChildId, seedLength: 12, archived: true }),
      })
    },
    __ModuleLoader__: { load: r => { registration = r } },
  }
  let stateIndex = 0
  const reactStub = {
    useState: () => {
      const index = stateIndex
      const value = scriptedStates[index] === undefined ? null : scriptedStates[index]
      stateIndex += 1
      return [value, (next) => { setterLog.push({ index, value: next }) }]
    },
    // 真跑 effect：这样才能断言快捷键监听确实装上了。
    useEffect: (fn) => { const cleanup = fn(); void cleanup },
    useRef: v => ({ current: v }),
    useCallback: f => f,
    createElement: (type, props, ...children) => ({ type, props, children }),
  }
  const reactDomStub = { createPortal: (node, target) => ({ type: 'portal', node, target }) }
  new Function('window', readFileSync(SRC, 'utf8'))(globalThis.window)
  const exported = registration.factory(spec => {
    if (spec === 'react') return reactStub
    if (spec === 'react-dom') return reactDomStub
    throw new Error('unexpected ' + spec)
  })

  const EV = (seq, type, data) => ({ type: 'event', event: { type, seq, time: 1, data } })
  const entries = [
    EV(0, 'turn/start', { turn: 1 }),
    EV(1, 'user/message', { content: [{ type: 'text', text: '问题一' }], source: { kind: 'user' } }),
    EV(2, 'assistant/message', { turn: 1, step: 1, message: { id: 'm1' } }),
    EV(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    EV(4, 'turn/start', { turn: 2 }),
    EV(5, 'user/message', { content: [{ type: 'text', text: '问题二' }], source: { kind: 'user' } }),
    EV(6, 'assistant/message', { turn: 2, step: 1, message: { id: 'm2' } }),
    EV(7, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
  ]
  const windowState = { entries, hasMore: false, revision: 1, change: { kind: 'replace', entries } }
  const listState = { ids: ['s1'], byId: { s1: { id: 's1' } }, current: 's1', phase: 'ready' }
  /**
   * 模拟 0.1.6 的客户端会话服务：
   *  - `binding(id)` **只在会话被某个视图 retain 之后**才有值（真实实现里
   *    `SessionBinding` 是「借用已经 retain 过的绑定」）；
   *  - 导航在 uiWorkspace.openSession()，不在 ctx.sessions 上（ctx.sessions.open
   *    在 0.1.6 里根本不存在 —— 这正是线上「点编辑保存 → 新开界面 → 卡住」的根因，
   *    所以这里刻意**不提供** sessions.open，逼插件走正确的那条路）。
   *  - 发 prompt 用公开的 sessions.using(id, {source}, fn)，自己租一次引用。
   */
  const retained = new Set()
  const catalog = (id, extra) => {
    if (!listState.ids.includes(id)) listState.ids.push(id)
    listState.byId[id] = { id, ...extra }
  }
  const bindingOf = id => {
    if (listState.byId[id] === undefined) return undefined
    return {
      sessionId: id,
      eventSource: { getSnapshot: () => windowState, subscribe: () => () => {} },
      session: {
        prompt: (content, mode) => { promptCalls.push({ id, content, mode }); return Promise.resolve({ ok: true }) },
      },
    }
  }
  const uiWorkspace = {
    openSession: id => {
      if (listState.byId[id] === undefined) throw new Error('unknown session "' + id + '"')
      retained.add(id)
      openCalls.push(id)
      listState.current = id
    },
  }
  let registered = null
  const forkCalls = []
  const promptCalls = []
  let childSeq = 0
  exported.apply({
    get: name => (name === 'uiWorkspace' ? uiWorkspace : undefined),
    uiWorkspace,
    slots: {
      inject: (k, cb) => { const d = cb(); return () => { d && d() } },
      register: (o, c) => { registered = { o, c }; return () => {} },
    },
    sessions: {
      binding: id => (retained.has(id) ? bindingOf(id) : undefined),
      using: (id, options, fn) => {
        const wasRetained = retained.has(id)
        retained.add(id)
        const reference = { sessionId: id, binding: bindingOf(id), ready: Promise.resolve() }
        return Promise.resolve(fn(reference)).finally(() => { if (!wasRetained) retained.delete(id) })
      },
      list: { getSnapshot: () => listState },
      fork: opts => {
        forkCalls.push(opts)
        childSeq += 1
        const childId = 'c' + String(childSeq)
        catalog(childId, { parentId: opts.sessionId })
        return Promise.resolve(childId)
      },
      refresh: () => {
        refreshCalls.push(true)
        if (childNeedsRefresh && hostedChildId !== null) {
          catalog(hostedChildId)
          childNeedsRefresh = false
        }
        return Promise.resolve()
      },
    },
    workspaces: { archiveSession: () => Promise.resolve() },
  })
  // 视图打开会话时会 retain 它（真实 UI 由 ui-workspace 的 replaceMain 做）。
  retained.add('s1')
  const face = registered.o.inject('s1')
  const view = face.hooks.answerVersions.getSnapshot()
  const tree = registered.c({
    // turnTail 槽位给的就是轮号（不是 messageId）。
    turn: view.turnNumber,
    useAnswerVersions: () => view,
    regenerate: face.regenerate,
    editQuestion: face.editQuestion,
    removeTurn: face.removeTurn,
    keepQuestion: face.keepQuestion,
    openVersion: face.openVersion,
  })
  return {
    tree, view, forkCalls, promptCalls, setterLog, fetchCalls, openCalls, refreshCalls,
    /** 只挑打给「保留提问」路由的调用（/turns 是每次挂载都会有的只读请求）。 */
    keepCalls: () => fetchCalls.filter(c => c.url === '/dsh-houhuiyao/keep-question'),
    turnsCalls: () => fetchCalls.filter(c => c.url === '/dsh-houhuiyao/turns'),
    setHostedChild: (id, needsRefresh) => { hostedChildId = id; childNeedsRefresh = needsRefresh === true },
  }
}

/** 从组件树里取出对话框的遮罩层 / 卡片。 */
function dialogParts(tree) {
  const portal = tree.children.find(child => child && child.type === 'portal')
  if (portal === undefined) return null
  const overlay = portal.node
  const card = overlay.children[0]
  return {
    portal, overlay, card,
    title: card.children[0], body: card.children[1], footer: card.children[2],
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

// ── 空闲态（useState 顺序：busy / error / dialog） ─────────────────────────
const idle = loadWith([null, null, null])
check('空闲态渲染三个按钮', buttonCount(idle.tree) === 3, buttonCount(idle.tree))
check('空闲态没有对话框', dialogParts(idle.tree) === null)

idle.tree.children[0][2].props.onClick()
eq('点「删除这轮」打开删除对话框',
  idle.setterLog[idle.setterLog.length - 1], { index: 2, value: { kind: 'delete' } })
idle.tree.children[0][1].props.onClick()
eq('点「编辑提问」打开编辑对话框并带原始草稿',
  idle.setterLog[idle.setterLog.length - 1], { index: 2, value: { kind: 'edit', text: '问题二' } })

// ── 忙碌态 ────────────────────────────────────────────────────────────────
const busy = loadWith(['regenerate', null, null])
const busyText = texts(busy.tree, []).join('')
check('忙碌态：没有任何按钮', buttonCount(busy.tree) === 0, buttonCount(busy.tree))
check('忙碌态显示「正在重新生成…」', busyText.includes('正在重新生成…'), busyText)
check('忙碌态是 status 元素', busy.tree.props.role === 'status' && busy.tree.props['aria-live'] === 'polite')
check('编辑忙碌态显示「正在按新提问重来…」',
  texts(loadWith(['edit', null, null]).tree, []).join('').includes('正在按新提问重来…'))
check('「只删回答并重新生成」忙碌态显示「正在重新生成…」',
  texts(loadWith(['remove-regenerate', null, null]).tree, []).join('').includes('正在重新生成…'))
check('「一起删」忙碌态显示「正在删除…」',
  texts(loadWith(['remove-both', null, null]).tree, []).join('').includes('正在删除…'))
check('「只删回答不重新生成」忙碌态显示「正在只删回答…」',
  texts(loadWith(['keep', null, null]).tree, []).join('').includes('正在只删回答…'))

// ── 编辑对话框（视口居中模态层） ──────────────────────────────────────────
const editing = loadWith([null, null, { kind: 'edit', text: '改过的提问' }])
const editKeyHandler = docKeyHandler
const parts = dialogParts(editing.tree)
check('编辑态渲染出对话框', parts !== null)
const { overlay, card } = parts

eq('遮罩层 position=fixed', overlay.props.style.position, 'fixed')
eq('遮罩层 inset=0（铺满视口）', overlay.props.style.inset, '0')
eq('遮罩层两轴居中', [overlay.props.style.alignItems, overlay.props.style.justifyContent], ['center', 'center'])
check('遮罩层用 shell 的 scrim token --dsw-alias-bg-mask-1',
  String(overlay.props.style.background).includes('--dsw-alias-bg-mask-1'), overlay.props.style.background)
eq('遮罩层 z-index 与 shell Modal 同层（1000）', overlay.props.style.zIndex, 1000)
check('点遮罩可取消（onPointerDown 存在）', typeof overlay.props.onPointerDown === 'function')
check('portal 挂到 document.body', parts.portal.target === globalThis.document.body)
check('卡片 role=dialog / aria-modal=true', card.props.role === 'dialog' && card.props['aria-modal'] === 'true')
eq('卡片 maxHeight=80vh', card.props.style.maxHeight, '80vh')
eq('卡片 flexDirection=column', card.props.style.flexDirection, 'column')
eq('卡片 overflow=hidden', card.props.style.overflow, 'hidden')
check('卡片 maxWidth 约束在 560px 以内', String(card.props.style.maxWidth).includes('560px'), card.props.style.maxWidth)
check('卡片用 shell 的 bg-layer-2 / shadow-lv3 token',
  String(card.props.style.background).includes('--dsw-alias-bg-layer-2')
  && String(card.props.style.boxShadow).includes('--dsw-shadow-lv3'), card.props.style.boxShadow)

eq('卡片子元素顺序 = 标题 / 主体 / footer', card.children.map(child => child.type), ['p', 'textarea', 'div'])
eq('标题文案', texts(parts.title, []), ['编辑这条提问'])
eq('textarea flex = 1 1 auto（承担收缩）', parts.body.props.style.flex, '1 1 auto')
eq('textarea minHeight = 0（允许收缩到 0）', parts.body.props.style.minHeight, '0')
eq('textarea overflow = auto（自己滚动）', parts.body.props.style.overflow, 'auto')
eq('footer flex = 0 0 auto（永不被挤出去）', parts.footer.props.style.flex, '0 0 auto')
const editActions = parts.footer.children[1]
eq('footer 动作 = 取消 + 保存并重发', texts(editActions, []), ['取消', '保存并重发'])
check('两个动作都是 button（可 Tab 到）', editActions.children.every(child => child.type === 'button'))
check('编辑对话框没有任何依赖 rect 的绝对定位',
  overlay.props.style.left === undefined && overlay.props.style.top === undefined)

// ── 删除对话框：三个选择 + 取消（DEFECT B + 新增第三项） ──────────────────
const deleting = loadWith([null, null, { kind: 'delete' }])
const del = dialogParts(deleting.tree)
check('删除态渲染出对话框', del !== null)
eq('删除对话框标题', texts(del.title, []), ['删除这轮'])
eq('删除对话框卡片结构与编辑一致（标题/主体/footer）', del.card.children.map(c => c.type), ['p', 'div', 'div'])
eq('主体 flex = 1 1 auto 且可滚动',
  [del.body.props.style.flex, del.body.props.style.minHeight, del.body.props.style.overflow], ['1 1 auto', '0', 'auto'])
eq('footer flex = 0 0 auto', del.footer.props.style.flex, '0 0 auto')
check('删除对话框也是 fixed + inset 0 的居中遮罩',
  del.overlay.props.style.position === 'fixed' && del.overlay.props.style.inset === '0'
  && del.overlay.props.style.alignItems === 'center', del.overlay.props.style)
check('删除对话框点遮罩也能取消', typeof del.overlay.props.onPointerDown === 'function')
check('删除对话框 Esc 也能取消', typeof docKeyHandler === 'function')

const options = del.body.children
eq('主体 = 说明 + 三个选择', options.length, 4)
const explain = texts(options[0], []).join('')
check('说明文案点明「同一个 turn / 没有分界」这个结构性约束',
  explain.includes('同一个 turn') && explain.includes('没有分界'), explain)
check('说明文案讲清两种做法', explain.includes('重新问一次') && explain.includes('切在提问那一句上'), explain)
eq('选择一 = 提问和回答一起删', texts(options[1], [])[0], '提问和回答一起删')
check('选择一说明是「整轮消失、不再提问」', texts(options[1], [])[1].includes('不会再提问'), texts(options[1], []))
eq('选择二 = 只删回答（保留提问并重新生成）', texts(options[2], [])[0], '只删回答（保留提问并重新生成）')
check('选择二说明写明会再调用一次模型', texts(options[2], [])[1].includes('再调用一次模型'), texts(options[2], []))
eq('选择三 = 只删回答（保留提问，不重新生成）', texts(options[3], [])[0], '只删回答（保留提问，不重新生成）')
check('选择三说明写明不调用模型、无「已停止」标记',
  texts(options[3], [])[1].includes('不调用模型') && texts(options[3], [])[1].includes('已停止'), texts(options[3], []))
check('三个选择都是 button', options.slice(1).every(o => o.type === 'button'))
eq('取消是 footer 里的第四个控件', texts(del.footer, []), ['取消'])
eq('卡片内恰好 4 个控件（三个选择 + 取消）', buttonCount(del.card), 4, buttonCount(del.card))

// 选择一路由：纯删除编排 —— fork + 归档，不发 prompt
const bothRun = loadWith([null, null, { kind: 'delete' }])
dialogParts(bothRun.tree).body.children[1].props.onClick()
await flush()
eq('「一起删」fork 一次', bothRun.forkCalls.length, 1)
eq('「一起删」fork 锚点 = 上一轮 turn/end', bothRun.forkCalls[0], { sessionId: 's1', atSeq: 3 })
eq('「一起删」不发 prompt', bothRun.promptCalls.length, 0)
eq('「一起删」不碰「保留提问」路由', bothRun.keepCalls().length, 0)

// 选择二路由：与「重新生成」同一套编排
const answerRun = loadWith([null, null, { kind: 'delete' }])
dialogParts(answerRun.tree).body.children[2].props.onClick()
await flush()
eq('「只删回答并重新生成」fork 一次', answerRun.forkCalls.length, 1)
eq('「只删回答并重新生成」用原问题重新提问', answerRun.promptCalls[0].content, [{ type: 'text', text: '问题二' }])
eq('「只删回答并重新生成」不碰「保留提问」路由', answerRun.keepCalls().length, 0)

// 选择三路由：走宿主路由，不 fork、不发 prompt
const keepRun = loadWith([null, null, { kind: 'delete' }])
dialogParts(keepRun.tree).body.children[3].props.onClick()
await flush()
await flush()
eq('「只删回答不重新生成」不 fork（客户端不做任何 fork）', keepRun.forkCalls.length, 0)
eq('「只删回答不重新生成」不发 prompt', keepRun.promptCalls.length, 0)
eq('「只删回答不重新生成」只调用一次「保留提问」路由', keepRun.keepCalls().length, 1)
eq('★ 每次挂载只问一次「真实轮次」（只读路由）', keepRun.turnsCalls().length, 1)
eq('宿主路由路径', keepRun.keepCalls()[0].url, '/dsh-houhuiyao/keep-question')
eq('宿主路由方法', keepRun.keepCalls()[0].method, 'POST')
eq('宿主路由 content-type', keepRun.keepCalls()[0].headers['content-type'], 'application/json')
eq('★ 客户端把宿主需要的身份都发过去了（sessionId + questionSeq）',
  keepRun.keepCalls()[0].body, { sessionId: 's1', questionSeq: 5 })
eq('打开宿主返回的子会话', keepRun.openCalls, ['h1'])
// 登记发生在导航之前（与其他路径同一条硬约束）：子会话必须已经在家族里
eq('宿主建的子会话被登记进版本家族',
  JSON.parse(globalThis.window.localStorage.getItem('dsh-houhuiyao:versions'))['s1#3'], ['s1', 'h1'])
eq('宿主建的子会话也进了归属表',
  JSON.parse(globalThis.window.localStorage.getItem('dsh-houhuiyao:member')).h1, 's1#3')
check('宿主路径不需要 refresh 也能打开（列表已含子会话）', keepRun.refreshCalls.length === 0, keepRun.refreshCalls.length)

// 宿主返回后才出现：客户端必须 refresh 一次再导航
const lateRun = loadWith([null, null, { kind: 'delete' }])
lateRun.setHostedChild('h2', true)
dialogParts(lateRun.tree).body.children[3].props.onClick()
await flush()
await flush()
await flush()
check('子会话晚到时客户端会 refresh 会话列表', lateRun.refreshCalls.length >= 1, lateRun.refreshCalls.length)
eq('refresh 之后才打开子会话', lateRun.openCalls, ['h2'])

// 宿主失败 → 中文错误，不导航，不 fork
const failRun = loadWith([null, null, { kind: 'delete' }])
failRun.setHostedChild(null)
dialogParts(failRun.tree).body.children[3].props.onClick()
await flush()
await flush()
eq('宿主失败时不打开任何会话', failRun.openCalls.length, 0)
eq('宿主失败时不 fork', failRun.forkCalls.length, 0)
eq('宿主失败时把宿主的中文错误冒出来（走 error 状态第 2 个 setter）',
  failRun.setterLog.filter(s => s.index === 1).map(s => s.value), [null, '宿主拒绝了这个请求'])

// ── 快捷键（编辑态） ──────────────────────────────────────────────────────
const editKeys = editKeyHandler
check('编辑态装了 document keydown 监听', typeof editKeys === 'function')
const forksBefore = editing.forkCalls.length
editKeys({ key: 'Enter', ctrlKey: true, metaKey: false, preventDefault: () => {} })
check('Ctrl+Enter 触发提交（走 fork 链路）', editing.forkCalls.length === forksBefore + 1, editing.forkCalls.length)
await flush()
check('Ctrl+Enter 提交的是编辑后的文字',
  editing.promptCalls.length === 1 && editing.promptCalls[0].content[0].text === '改过的提问',
  editing.promptCalls)
check('Ctrl+Enter 用的是同一个 fork 锚点', editing.forkCalls[forksBefore].atSeq === 3, editing.forkCalls[forksBefore])
editKeys({ key: 'Escape', preventDefault: () => {} })
check('Escape 处理不抛错', true)

const meta = loadWith([null, null, { kind: 'edit', text: '改过的提问' }])
const metaKeys = docKeyHandler
const metaForks = meta.forkCalls.length
metaKeys({ key: 'Enter', ctrlKey: false, metaKey: true, preventDefault: () => {} })
check('Cmd+Enter 也触发提交', meta.forkCalls.length === metaForks + 1, meta.forkCalls.length)

// 删除对话框不是编辑态：Ctrl+Enter 不应误触发任何动作
const noEnter = loadWith([null, null, { kind: 'delete' }])
const noEnterKeys = docKeyHandler
noEnterKeys({ key: 'Enter', ctrlKey: true, preventDefault: () => {} })
await flush()
eq('删除对话框中 Ctrl+Enter 不触发任何动作', noEnter.forkCalls.length, 0)

// ── 错误态 ────────────────────────────────────────────────────────────────
const failed = loadWith([null, 'fork 失败：会话不存在', null])
check('错误态仍显示按钮', buttonCount(failed.tree) === 3, buttonCount(failed.tree))
check('错误态显示错误文案', texts(failed.tree, []).join('|').includes('fork 失败：会话不存在'), texts(failed.tree, []))

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)
