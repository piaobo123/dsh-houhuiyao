/**
 * dsh-houhuiyao 组件「出不出按钮 / 说哪句中文」冒烟测试（离线，无浏览器）。
 *
 * 为什么不再用真 React：旧版从这里解析
 * `F:\deepseek harness\deepseek-harness-master\apps\web` 下的 react/react-dom，
 * 而那个目录 2026-09-22 已删除 —— 这条「按钮到底渲染不渲染」的冒烟测试自那时起
 * 就一直跑不起来（本机也再没有任何 react/react-dom 安装）。现在改用与
 * busy-state.test.mjs 同一套极简 React 桩：只关心给定视图下组件渲染出什么。
 *
 * 覆盖本轮改动的四条：
 *  1. 判据来自宿主全量日志（长轮次被 50 条窗口裁掉时按钮照样出现）；
 *  2. 槽位挂在 conversation.chat.turnTail，归属按**轮号**判；
 *  3. 该轮还在跑 → 什么都不显示；
 *  4. 不可操作 → 渲染一行中文原因，不再静默消失。
 *
 * 跑法：node tests/render.test.mjs
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
/** 动作行里出现绝对/固定定位 = 会被视口裁掉（DSH 页面不滚动），一律不允许。 */
function absolutelyPositioned(node, out) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) absolutelyPositioned(child, out); return out }
  if (node.type === 'portal') return absolutelyPositioned(node.node, out)
  const style = node.props === undefined ? undefined : node.props.style
  if (style !== undefined && typeof style.position === 'string' && (style.position === 'absolute' || style.position === 'fixed')) out.push(node.type)
  return absolutelyPositioned(node.children, out)
}

/** 夹具：两轮问答（与 behaviour/busy-state 用同一份形状）。 */
const EV = (seq, type, data) => ({ type: 'event', event: { type, seq, time: 1, data } })
const ENTRIES = [
  EV(0, 'turn/start', { turn: 1 }),
  EV(1, 'user/message', { content: [{ type: 'text', text: '问题一' }], source: { kind: 'user' } }),
  EV(2, 'assistant/message', { turn: 1, step: 1, message: { id: 'm1' } }),
  EV(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  EV(4, 'turn/start', { turn: 2 }),
  EV(5, 'user/message', { content: [{ type: 'text', text: '问题二' }], source: { kind: 'user' } }),
  EV(6, 'assistant/message', { turn: 2, step: 1, message: { id: 'm2' } }),
  EV(7, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
]

/**
 * 载入插件并返回 { face, view, Component }。
 * @param options.host 宿主 /turns 的返回体；null = 路由失败（模拟宿主还没重启）。
 * @param options.entries 客户端事件窗口（默认两轮夹具）；[] = 空窗口。
 * @param options.versions 预置的版本登记表。
 */
async function load(options = {}) {
  let registration = null
  const store = new Map()
  if (options.versions !== undefined) store.set('dsh-houhuiyao:versions', JSON.stringify(options.versions))
  const entries = options.entries === undefined ? ENTRIES : options.entries
  const windowState = { entries, hasMore: false, revision: 1, change: { kind: 'replace', entries } }
  const listState = {
    ids: ['s1', 'c1'],
    byId: { s1: { id: 's1', displayTitle: 's1' }, c1: { id: 'c1', displayTitle: 's1', parentId: 's1' } },
    current: 's1',
    phase: 'ready',
  }
  const fetchCalls = []
  const DEFAULT_HOST = {
    ok: true,
    sessionId: 's1',
    turnCount: 2,
    anchorSeq: 3,
    lastTurn: { turn: 2, startSeq: 4, endSeq: 7, closed: true, question: '问题二', questionSeq: 5, answerIds: ['m2'] },
  }
  globalThis.document = { addEventListener: () => {}, removeEventListener: () => {} }
  globalThis.window = {
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)) },
    },
    location: { search: '' },
    setTimeout: fn => { fn(); return 0 },
    clearTimeout: () => {},
    fetch: (url, init) => {
      fetchCalls.push({ url, body: JSON.parse(init?.body ?? '{}') })
      if (options.host === null) return Promise.reject(new Error('no route'))
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve(options.host === undefined ? DEFAULT_HOST : options.host),
      })
    },
    __ModuleLoader__: { load: r => { registration = r } },
  }
  const reactStub = {
    useState: () => [null, () => {}],
    useEffect: fn => { const cleanup = fn(); void cleanup },
    useRef: v => ({ current: v }),
    useCallback: f => f,
    createElement: (type, props, ...children) => ({ type, props, children }),
  }
  const reactDomStub = { createPortal: (node, target) => ({ type: 'portal', node, target }) }
  new Function('window', readFileSync(SRC, 'utf8'))(globalThis.window)
  const exported = registration.factory(spec => {
    if (spec === 'react') return reactStub
    if (spec === 'react-dom') return reactDomStub
    throw new Error('unexpected require ' + spec)
  })
  let registered = null
  exported.apply({
    slots: {
      inject: (k, cb) => { const d = cb(); return () => { d && d() } },
      register: (o, c) => { registered = { o, c }; return () => {} },
    },
    sessions: {
      binding: () => ({
        eventSource: { getSnapshot: () => windowState, subscribe: () => () => {} },
        session: { prompt: () => Promise.resolve({ ok: true }) },
      }),
      list: { getSnapshot: () => listState },
      fork: () => Promise.resolve('c1'),
      open: () => {},
    },
    workspaces: { archiveSession: () => Promise.resolve() },
  })
  check('注册的槽位是 turnTail（无条件渲染的那条）', registered.o.name === 'conversation.chat.turnTail', registered.o.name)
  const face = registered.o.inject('s1')
  // 宿主信息是异步到的：等一轮微任务。
  await new Promise(resolve => setTimeout(resolve, 0))
  return { face, view: face.hooks.answerVersions.getSnapshot(), Component: registered.c, fetchCalls }
}

function render(Component, view, face, props) {
  return Component(Object.assign({
    turn: view.turnNumber,
    useAnswerVersions: () => view,
    regenerate: face.regenerate,
    editQuestion: face.editQuestion,
    removeTurn: face.removeTurn,
    keepQuestion: face.keepQuestion,
    openVersion: face.openVersion,
  }, props))
}

// ── 1) 正常一轮：三个动作、没有翻页器 ────────────────────────────────────────
{
  const { face, view, Component } = await load()
  eq('判据来源 = 宿主（全量日志）', view.source, 'host')
  eq('视图可操作', view.ready, true)
  eq('轮号来自宿主', view.turnNumber, 2)
  eq('锚点来自宿主', view.anchorSeq, 3)
  const tree = render(Component, view, face)
  const html = texts(tree, []).join('|')
  check('渲染出「重新生成」', html.includes('重新生成'), html)
  check('渲染出「编辑提问」', html.includes('编辑提问'), html)
  check('渲染出「删除这轮」', html.includes('删除这轮'), html)
  check('单版本不渲染翻页器', !/1\/1/.test(html), html)
  eq('恰好三个 button', buttonCount(tree), 3)
  eq('动作行没有绝对/固定定位', absolutelyPositioned(tree, []), [])
}

// ── 2) 多版本：翻页器出现（‹ 1/2 ›）─────────────────────────────────────────
{
  const { face, view, Component } = await load({ versions: { 's1#3': ['s1', 'c1'] } })
  eq('识别为 2 版第 1 版', [view.versions.length, view.index], [2, 0])
  const tree = render(Component, view, face)
  const html = texts(tree, []).join('|')
  check('翻页器显示 1/2', html.includes('1/2'), html)
  check('翻页器有 ‹ 与 ›', html.includes('\u2039') && html.includes('\u203A'), html)
  eq('三个动作 + 左右箭头 = 5 个 button', buttonCount(tree), 5)
}

// ── 3) 不是最后一轮 / 该轮还在跑 → 什么都不渲染 ─────────────────────────────
{
  const { face, view, Component } = await load()
  eq('别的轮号不渲染', render(Component, view, face, { turn: 1 }), null)
  const running = await load({
    host: {
      ok: true, sessionId: 's1', turnCount: 2, anchorSeq: 3,
      lastTurn: { turn: 3, startSeq: 20, endSeq: null, closed: false, question: null, questionSeq: null, answerIds: [] },
    },
  })
  eq('该轮还在跑：running = true', running.view.running, true)
  eq('正在生成时什么都不渲染', render(running.Component, running.view, running.face), null)
}

// ── 4) 不可操作 → 渲染一行中文原因（本轮新行为）─────────────────────────────
{
  const first = await load({
    host: {
      ok: true, sessionId: 's1', turnCount: 1, anchorSeq: null,
      lastTurn: { turn: 1, startSeq: 0, endSeq: 3, closed: true, question: '问题一', questionSeq: 1, answerIds: ['m1'] },
    },
  })
  eq('首轮：不可操作', first.view.ready, false)
  eq('首轮：轮号仍然知道（否则说不出话）', first.view.turnNumber, 1)
  check('首轮：给出中文原因', typeof first.view.reason === 'string' && first.view.reason.includes('第一轮'), first.view.reason)
  const tree = render(first.Component, first.view, first.face)
  eq('首轮：渲染的是原因行，不是按钮', buttonCount(tree), 0)
  eq('原因行的 role', tree.props.role, 'note')
  check('原因行写出「第一轮」', texts(tree, []).join('').includes('第一轮'), texts(tree, []))

  const injected = await load({
    host: {
      ok: true, sessionId: 's1', turnCount: 4, anchorSeq: 30,
      lastTurn: { turn: 5, startSeq: 31, endSeq: 40, closed: true, question: null, questionSeq: null, answerIds: [] },
    },
  })
  check('系统触发的那一轮：原因说「没有可重发的提问」',
    typeof injected.view.reason === 'string' && injected.view.reason.includes('系统触发'), injected.view.reason)
  check('原因行真的渲染出来', texts(render(injected.Component, injected.view, injected.face), []).join('').includes('系统触发'))
}

// ── 5) 宿主路由拿不到 → 退回窗口判据（老运行时/宿主还没重启也不会瞎）────────
{
  const fallback = await load({ host: null })
  eq('降级判据来源 = window', fallback.view.source, 'window')
  eq('降级后仍然可操作（窗口里有完整两轮）', fallback.view.ready, true)
  eq('降级后照样渲染三个按钮', buttonCount(render(fallback.Component, fallback.view, fallback.face)), 3)
  const blank = await load({ host: null, entries: [] })
  eq('窗口也没有 + 宿主也没有：什么都不渲染', render(blank.Component, blank.view, blank.face), null)
}

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES')
process.exit(failures === 0 ? 0 : 1)
