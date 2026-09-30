/**
 * dsh-houhuiyao —— 浏览器半边（DSH Web 客户端插件，零构建、纯 JS）。
 *
 * 名字：拼音「版本」（bǎnběn），中文就叫「版本」。
 *
 * 机制（见文件底部注释里的两套 file:line 引用：0.1.6 发布包 / 0.1.2 源码版）：
 *   会话日志是 append-only 的，所以「原地重来」用 fork + archive + prompt 组合实现：
 *     1. ctx.sessions.fork({ sessionId, atSeq }) —— atSeq 取「目标轮之前最后一个
 *        turn/end」的 seq。宿主的切点是「第一个 seq >= atSeq 的 turn/end」，
 *        seed = events.slice(0, cut)，所以子会话的历史恰好停在该 turn/end 之后、
 *        目标轮 turn/start 之前。
 *     2. 登记版本家族（localStorage）—— 必须早于导航，否则子会话第一帧只看到 1 版。
 *     3. navigateTo(childId) —— **0.1.6 起导航是 ctx.uiWorkspace.openSession(id)**，
 *        ctx.sessions 上已经没有 open() 了（老运行时才退回 ctx.sessions.open）。
 *     4. 发 prompt —— 用公开的 ctx.sessions.using(childId, { source }, fn) 自己租一次
 *        引用再 prompt（0.1.6 的 binding(id) 只借用「已经被 retain 的」绑定，
 *        刚 fork 出来、还没被视图打开的会话拿不到 binding）。
 *     5. ctx.workspaces.archiveSession(sessionId) —— 归档源会话，侧边栏不再多一行。
 *        只在 prompt 送达之后归档：prompt 没送出去就归档 = 用户既没有新回答又丢了原版本。
 *   「重新生成」用原问题 / 「编辑提问」用改过的文字 / 「删除这轮」什么都不发。
 *   「版本」= 同一 root 会话、同一 fork 锚点下的一串真实会话，登记在 localStorage。
 *
 * 判据来自哪：**宿主侧 `/dsh-houhuiyao/turns`（全量日志）优先**，拿不到时退回客户端
 * 事件窗口。客户端窗口只有最后 50 条 user/assistant 消息（0.1.6 的 paginate），
 * 工具密集的长轮次会把「上一轮的 turn/start」挤出窗口 —— 那时窗口里凑不出两轮，
 * 插件会整排静默消失（用户报的「很多情况下会话结束都没有它」就是这个）。宿主读的是
 * 完整日志，所以轮次事实一律以宿主为准；窗口只作为「路由还没上线」时的降级路径。
 *
 * 调试开关：localStorage['dsh-houhuiyao:debug'] = '1'（老键
 * 'dsh-answer-versions:debug' 仍然认；URL 带 ?houhuiyao-debug 也行），
 * 控制台会打印 [houhuiyao] 前缀的完整链路日志。
 *
 * 全部文案为简体中文。
 */
window.__ModuleLoader__.load({
  id: 'dsh-houhuiyao',
  factory: function (require) {
    'use strict'

    var React = require('react')
    var ReactDOM = require('react-dom')

    var NAME = 'dsh-houhuiyao'
    /**
     * 曾用名，按时间倒序：`dsh-banben`（2026-10-01 当天短暂用过）、
     * `dsh-answer-versions`（最初的英文名）。改名不丢版本历史 ——
     * localStorage 的三张登记表与调试开关都会顺着这条链迁移。
     */
    var LEGACY_NAMES = ['dsh-banben', 'dsh-answer-versions']
    /**
     * 槽位：'conversation.chat.turnTail'（kind list、scope session）。
     *
     * 为什么不再挂 'conversation.chat.assistant-actions'：官方只在「该轮 closing 节点
     * 是 assistant/message」时才渲染那一行（dsh-client-ui-chat/lib/client.js:3683），
     * 而一轮完全可能结束在工具节点上（被中断、纯工具收尾）—— 那时插件整排控件跟着
     * 消失。turnTail 是无条件渲染的（同文件 :3671），而且它拿得到 `turn`，
     * 归属判定比 messageId 更直接。
     */
    var SLOT = 'conversation.chat.turnTail'
    var LOG_PREFIX = '[houhuiyao]'
    var DEBUG_KEY = NAME + ':debug'
    var DEBUG_KEYS = [DEBUG_KEY].concat(LEGACY_NAMES.map(function (legacy) { return legacy + ':debug' }))
    var VERSIONS_KEY = NAME + ':versions'
    var VIEWED_KEY = NAME + ':viewed'
    /** sessionId -> familyKey 的显式归属表；比任何推导都可靠。 */
    var MEMBER_KEY = NAME + ':member'
    /** 「登记表种类 → 曾用名的同名键」：读不到新键时按顺序回退。 */
    function legacyKeysOf(kind) {
      return LEGACY_NAMES.map(function (legacy) { return legacy + ':' + kind })
    }
    var LEGACY_VERSIONS_KEYS = legacyKeysOf('versions')
    var LEGACY_VIEWED_KEYS = legacyKeysOf('viewed')
    var LEGACY_MEMBER_KEYS = legacyKeysOf('member')
    /** 宿主侧「保留提问」路由（纯事件构造的 seed，零模型调用）。 */
    var KEEP_QUESTION_ROUTE = '/dsh-houhuiyao/keep-question'
    /**
     * 宿主侧「真实轮次」只读路由（读全量日志，不受 50 条窗口裁剪影响）。
     * 拿不到它（老运行时 / 宿主还没重启）时自动退回窗口判据，不报错刷屏。
     */
    var TURNS_ROUTE = '/dsh-houhuiyao/turns'
    /** 窗口一变就重新问一次宿主，但要防抖：一次工具调用会连着推好几条事件。 */
    var HOST_REFRESH_DEBOUNCE_MS = 400
    /**
     * `ctx.sessions.using(id, { source })` 的引用标签。
     * 官方把这个标签声明成可扩展的联合类型（`SessionReferenceSourceMap`），
     * 运行时不做校验，所以插件用自己的名字，引用计数里能认出是谁租的。
     */
    var REFERENCE_SOURCE = 'houhuiyao'
    /** 迁移开关：0.1.6 把「打开会话」从 ctx.sessions 搬到了 uiWorkspace。 */
    var UI_WORKSPACE_SERVICE = 'uiWorkspace'

    var TEXT = {
      regenerate: '重新生成',
      regenerating: '正在重新生成…',
      remove: '删除这轮',
      removing: '正在删除…',
      edit: '编辑提问',
      editing: '正在按新提问重来…',
      editTitle: '编辑这条提问',
      editHint: '保存后会从这轮之前分叉，用新问题重问一遍；原会话归档。',
      save: '保存并重发',
      cancel: '取消',
      placeholder: '编辑你的提问…',
      deleteTitle: '删除这轮',
      deleteExplain: '在 dsh 里提问和回答属于同一个 turn（问题与回答之间没有分界），分叉只能切在 turn 结束处。所以「只删回答、保留提问」有两种做法：重新问一次，或由宿主直接把日志切在提问那一句上。',
      deleteBoth: '提问和回答一起删',
      deleteBothNote: '这一问一答整轮从对话里消失，不会再提问。',
      deleteAnswerOnly: '只删回答（保留提问并重新生成）',
      deleteAnswerOnlyNote: '保留提问，重新生成一条回答；会再调用一次模型。',
      deleteKeepQuestion: '只删回答（保留提问，不重新生成）',
      deleteKeepQuestionNote: '保留提问、去掉回答：宿主把日志切在提问那一句上，不调用模型，也没有「已停止」标记。这一项不归档原会话（保守取舍），原版本会继续留在侧边栏。',
      keeping: '正在只删回答…',
      prev: '上一版本',
      next: '下一版本',
      version: '回答版本',
      failed: '操作失败',
      forkFailed: '无法新建版本会话',
      unavailable: '该回答目前不可重新生成',
      emptyQuestion: '提问不能为空',
      deadVersion: '这个版本会话已经不存在了，已从版本列表里移除',
      keepUnavailable: '找不到这条提问的位置，无法保留提问',
      childNotListed: '子会话已经创建，但会话列表还没刷新出来，请稍后再试',
      // ── 不可操作时给用户看的中文原因（宁可说清楚，也不静默消失）──────────
      reasonFirstTurn: '第一轮没有上一版可以分叉，暂不能重新生成',
      reasonNoAnchor: '上一轮没有正常结束，暂时没有分叉点',
      reasonNoQuestion: '这一轮由系统触发，没有可重发的提问'
    }

    // ── 调试日志 ──────────────────────────────────────────────────────────
    var debugEnabled = null
    function isDebug() {
      if (debugEnabled !== null) return debugEnabled
      debugEnabled = false
      try {
        for (var i = 0; i < DEBUG_KEYS.length; i += 1) {
          if (window.localStorage.getItem(DEBUG_KEYS[i]) === '1') { debugEnabled = true; break }
        }
      } catch (error) { /* 存储不可用：调试开关退回 URL 参数 */ }
      try {
        if (/\?.*(houhuiyao|answer-versions|banben)-debug/.test(window.location.search || '')) debugEnabled = true
      } catch (error) { /* location 不可读 */ }
      return debugEnabled
    }
    function dlog(message, payload) {
      if (!isDebug()) return
      if (payload === undefined) console.log(LOG_PREFIX + ' ' + message)
      else console.log(LOG_PREFIX + ' ' + message, payload)
    }

    // ── 存储层（localStorage，失败时退回内存） ─────────────────────────────
    // localStorage 可能被禁用或写满；那时不能让整条链静默失效，所以内存兜底，
    // 至少当前页面会话内的版本切换仍然可用。
    var memory = {}
    var storageBroken = false
    /** 读一处 JSON：空值/坏值返回 undefined（以此区别于「读到一个空对象」）。 */
    function parseStored(key) {
      try {
        var raw = window.localStorage.getItem(key)
        if (raw !== null && raw !== '') {
          var parsed = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object') return parsed
        }
      } catch (error) {
        if (!storageBroken) { storageBroken = true; console.error(NAME + '：读取 localStorage 失败，改用内存登记表', error) }
      }
      return undefined
    }
    /**
     * 读登记表。新键为空时顺着**曾用名**（dsh-banben → dsh-answer-versions）逐个回退，
     * 命中就迁移到新键 —— 插件改过两次名，用户已有的版本家族（哪个会话属于哪一串版本）不能丢。
     * @param key - 新键。
     * @param legacyKeys - 曾用名的同名键数组（可省略）。
     * @returns 登记表对象（永不返回 undefined）。
     */
    function readStore(key, legacyKeys) {
      var parsed = parseStored(key)
      if (parsed !== undefined) return parsed
      var chain = legacyKeys === undefined ? [] : legacyKeys
      for (var i = 0; i < chain.length; i += 1) {
        var inherited = parseStored(chain[i])
        if (inherited === undefined) continue
        memory[key] = inherited
        try {
          window.localStorage.setItem(key, JSON.stringify(inherited))
          dlog('登记表已从旧键迁移', { from: chain[i], to: key })
        } catch (error) { /* 写不进去也不影响本次读取 */ }
        return inherited
      }
      return memory[key] === undefined ? {} : memory[key]
    }
    function writeStore(key, value) {
      memory[key] = value
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
        dlog('存储写入成功', { key: key, value: value })
      } catch (error) {
        if (!storageBroken) { storageBroken = true; console.error(NAME + '：写入 localStorage 失败，改用内存登记表（刷新后会丢）', error) }
        dlog('存储写入失败，已退回内存', { key: key, error: String(error && error.message) })
      }
    }

    function familyKeyOf(rootSessionId, anchorSeq) {
      return rootSessionId + '#' + String(anchorSeq)
    }
    function readVersions(key) {
      var all = readStore(VERSIONS_KEY, LEGACY_VERSIONS_KEYS)
      var list = all[key]
      if (!Array.isArray(list)) return []
      var out = []
      for (var i = 0; i < list.length; i++) {
        if (typeof list[i] === 'string' && list[i] !== '' && out.indexOf(list[i]) === -1) out.push(list[i])
      }
      return out
    }
    function writeVersions(key, list) {
      var all = readStore(VERSIONS_KEY, LEGACY_VERSIONS_KEYS)
      all[key] = list
      writeStore(VERSIONS_KEY, all)
    }
    function removeVersion(key, sessionId) {
      var list = readVersions(key)
      var at = list.indexOf(sessionId)
      if (at === -1) return list
      list.splice(at, 1)
      writeVersions(key, list)
      return list
    }
    function writeViewed(key, sessionId) {
      var all = readStore(VIEWED_KEY, LEGACY_VIEWED_KEYS)
      all[key] = sessionId
      writeStore(VIEWED_KEY, all)
    }
    function forgetFamily(key) {
      var versions = readStore(VERSIONS_KEY, LEGACY_VERSIONS_KEYS)
      if (Object.prototype.hasOwnProperty.call(versions, key)) { delete versions[key]; writeStore(VERSIONS_KEY, versions) }
      var viewed = readStore(VIEWED_KEY, LEGACY_VIEWED_KEYS)
      if (Object.prototype.hasOwnProperty.call(viewed, key)) { delete viewed[key]; writeStore(VIEWED_KEY, viewed) }
      var members = readStore(MEMBER_KEY, LEGACY_MEMBER_KEYS)
      var changed = false
      for (var id in members) {
        if (members[id] === key) { delete members[id]; changed = true }
      }
      if (changed) writeStore(MEMBER_KEY, members)
    }
    /** 显式归属：sessionId 属于哪个版本家族。 */
    function memberOf(sessionId) {
      var members = readStore(MEMBER_KEY, LEGACY_MEMBER_KEYS)
      var key = members[sessionId]
      return typeof key === 'string' && key !== '' ? key : null
    }
    function writeMember(sessionId, key) {
      var members = readStore(MEMBER_KEY, LEGACY_MEMBER_KEYS)
      members[sessionId] = key
      writeStore(MEMBER_KEY, members)
    }
    function dropMember(sessionId) {
      var members = readStore(MEMBER_KEY, LEGACY_MEMBER_KEYS)
      if (!Object.prototype.hasOwnProperty.call(members, sessionId)) return
      delete members[sessionId]
      writeStore(MEMBER_KEY, members)
    }

    // ── 事件窗口解析 ──────────────────────────────────────────────────────
    /** 取一条 user/message 的纯文本（只取 text block）。 */
    function textOfContent(content) {
      if (!Array.isArray(content)) return ''
      var parts = []
      for (var i = 0; i < content.length; i++) {
        var block = content[i]
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text)
        }
      }
      return parts.join('\n').trim()
    }

    /**
     * 把会话事件窗口折成「最后一轮问答」。
     * @returns null 表示这一轮不可操作（首轮无前置 turn/end、轮次未结束、无人类提问等）。
     */
    function analyzeWindow(entries) {
      var turns = []
      var open = null
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i]
        if (entry === null || typeof entry !== 'object' || entry.type !== 'event') continue
        var event = entry.event
        if (event === null || typeof event !== 'object' || event.data === null || typeof event.data !== 'object') continue
        var data = event.data
        if (event.type === 'turn/start') {
          open = {
            turn: typeof data.turn === 'number' ? data.turn : null,
            startSeq: event.seq,
            endSeq: undefined,
            question: null,
            questionSeq: -1,
            answers: [],
          }
          turns.push(open)
          continue
        }
        if (open === null) continue
        if (event.type === 'user/message') {
          // 只认人类直接输入；agent.inject() 的合成上下文不是「原问题」。
          if (open.question === null && data.source !== null && typeof data.source === 'object'
            && data.source.kind === 'user') {
            var text = textOfContent(data.content)
            if (text !== '') { open.question = text; open.questionSeq = event.seq }
          }
          continue
        }
        if (event.type === 'assistant/message') {
          if (data.message !== null && typeof data.message === 'object' && typeof data.message.id === 'string') {
            open.answers.push(data.message.id)
          }
          continue
        }
        if (event.type === 'turn/end') {
          open.endSeq = event.seq
          open = null
        }
      }
      if (turns.length === 0) return null
      var lastIndex = turns.length - 1
      var last = turns[lastIndex]
      if (last.answers.length === 0) return null
      if (typeof last.endSeq !== 'number') return null
      if (last.question === null) return null
      if (lastIndex === 0) return null
      var previous = turns[lastIndex - 1]
      if (typeof previous.endSeq !== 'number') return null
      return {
        // 一轮可能有多个 step、多个 assistant/message；消息行渲染的是
        // 「该轮最后一个有内容的回答」，未必是最后一个 assistant/message，
        // 所以把该轮全部答案 id 都交给组件做归属判定。
        messageIds: last.answers,
        question: last.question,
        anchorSeq: previous.endSeq,
        turnCount: turns.length,
        // turnTail 归属判定用：slot 给的 props.turn 就是这个轮号。
        turnNumber: typeof last.turn === 'number' ? last.turn : null,
        turnStartSeq: last.startSeq,
        turnEndSeq: last.endSeq,
        questionSeq: last.questionSeq,
        prevTurnEndSeq: previous.endSeq
      }
    }

    /**
     * 该消息/该轮是否归本组件管。
     *
     * slot 给的是轮号（turnTail 的 `props.turn`）就用轮号判；老运行时只给 messageId
     * 就退回答案 id 判。**这里刻意不要求 ready** —— 不可操作的那一轮也要被认领，
     * 否则连「为什么没有按钮」都说不出来（用户要的是原因，不是静默消失）。
     *
     * @param view - 版本视图。
     * @param ref - 轮号（number）或回答消息 id（string）。
     * @returns 是否归本组件。
     */
    function ownsRef(view, ref) {
      if (view === undefined || view === null) return false
      if (typeof ref === 'number') return view.turnNumber === ref
      return view.ready === true && typeof ref === 'string' && view.messageIds.indexOf(ref) !== -1
    }

    /** 顺着 parentId 走到家族根会话（仅在显式归属表缺失时兜底）。 */
    function rootOf(listState, sessionId) {
      var byId = listState !== null && typeof listState === 'object' && listState.byId !== null ? listState.byId : {}
      var id = sessionId
      var seen = {}
      for (var guard = 0; guard < 512; guard += 1) {
        var summary = byId[id]
        var parent = summary === undefined || summary === null ? undefined : summary.parentId
        if (typeof parent !== 'string' || parent === '' || seen[parent] === true) return id
        seen[id] = true
        id = parent
      }
      return id
    }

    var EMPTY_VIEW = {
      ready: false,
      /** 该轮还在跑：什么都不显示（正在生成时没有「最后一条回答」可言）。 */
      running: false,
      /** 最后那一轮的轮号（turnTail 归属判定）；判不出来时为 null。 */
      turnNumber: null,
      /** 不可操作时的中文原因；可操作或还在跑时为 null。 */
      reason: null,
      /** 判据来源：'host'（全量日志，正解）/ 'window'（50 条窗口，降级）/ 'none'。 */
      source: 'none',
      messageIds: [],
      anchorSeq: -1,
      questionSeq: -1,
      question: '',
      familyKey: null,
      versions: [],
      index: -1,
      editing: false
    }

    function sameList(a, b) {
      if (a.length !== b.length) return false
      for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
      return true
    }

    function sameView(a, b) {
      return a.ready === b.ready
        && a.running === b.running
        && a.turnNumber === b.turnNumber
        && a.reason === b.reason
        && a.source === b.source
        && sameList(a.messageIds, b.messageIds)
        && a.anchorSeq === b.anchorSeq
        && a.questionSeq === b.questionSeq
        && a.question === b.question
        && a.familyKey === b.familyKey
        && a.index === b.index
        && sameList(a.versions, b.versions)
    }

    // ── 插件主体 ──────────────────────────────────────────────────────────
    function apply(ctx) {
      /** sessionId -> { snapshot, listeners:Set, source, face, unsubscribe, host, hostToken, hostTimer, hostFailed } */
      var states = new Map()

      function notify(state) {
        var listeners = []
        state.listeners.forEach(function (listener) { listeners.push(listener) })
        for (var i = 0; i < listeners.length; i++) {
          try {
            listeners[i]()
          } catch (error) {
            console.error(NAME + '：订阅者抛错', error)
          }
        }
      }

      function publish(state, next) {
        if (sameView(state.snapshot, next)) return
        state.snapshot = next
        notify(state)
      }

      /** 登记表变了：把所有会话的视图重算一遍，让翻页器立刻跟上。 */
      function republishAll() {
        states.forEach(function (state, sessionId) {
          publish(state, computeView(sessionId))
        })
      }

      /**
       * 判据来源（basis）：**优先宿主全量日志，退回客户端事件窗口**。
       *
       * 为什么必须有宿主这一路：客户端拿到的只有最后 50 条 user/assistant 消息
       * （0.1.6 `paginate`），而一轮里每个 step 都有一条 assistant/message ——
       * 工具密集的长任务，单轮就 60~100 条消息，于是「上一轮的 turn/start」被挤出
       * 窗口，窗口里凑不出两轮，analyzeWindow 直接返回 null，整排按钮静默消失。
       * 宿主读的是完整日志（`/dsh-houhuiyao/turns`），所以轮次事实以它为准。
       *
       * @param sessionId - 会话 id。
       * @returns basis：{ source, operable, running, turnNumber, reason, messageIds,
       *                   anchorSeq, questionSeq, question, turnCount }。
       */
      function basisFor(sessionId) {
        var state = states.get(sessionId)
        var host = state === undefined || state === null ? null : state.host
        if (host !== null && typeof host === 'object' && host.ok === true
          && host.lastTurn !== null && typeof host.lastTurn === 'object') {
          var last = host.lastTurn
          var anchor = typeof host.anchorSeq === 'number' ? host.anchorSeq : null
          var question = typeof last.question === 'string' ? last.question : ''
          var turnCount = typeof host.turnCount === 'number' ? host.turnCount : 0
          var closed = last.closed === true
          var operable = closed && anchor !== null && question !== ''
          var reason = null
          if (closed && !operable) {
            if (anchor === null) reason = turnCount <= 1 ? TEXT.reasonFirstTurn : TEXT.reasonNoAnchor
            else reason = TEXT.reasonNoQuestion
          }
          return {
            source: 'host',
            operable: operable,
            // 该轮还在跑：什么都不显示（也没有可操作的对象）。
            running: !closed,
            turnNumber: typeof last.turn === 'number' ? last.turn : null,
            reason: reason,
            messageIds: Array.isArray(last.answerIds) ? last.answerIds : [],
            anchorSeq: anchor === null ? -1 : anchor,
            questionSeq: typeof last.questionSeq === 'number' ? last.questionSeq : -1,
            question: question,
            turnCount: turnCount
          }
        }
        var binding = ctx.sessions.binding(sessionId)
        var windowState = binding === undefined ? undefined : binding.eventSource.getSnapshot()
        var entries = windowState !== undefined && Array.isArray(windowState.entries) ? windowState.entries : []
        var analysis = analyzeWindow(entries)
        if (analysis === null) {
          // 降级路径也判不出来：说不出轮号，只能什么都不显示（老行为）。
          return {
            source: 'window', operable: false, running: false, turnNumber: null, reason: null,
            messageIds: [], anchorSeq: -1, questionSeq: -1, question: '', turnCount: 0, entries: entries.length
          }
        }
        return {
          source: 'window',
          operable: true,
          running: false,
          turnNumber: analysis.turnNumber,
          reason: null,
          messageIds: analysis.messageIds,
          anchorSeq: analysis.anchorSeq,
          questionSeq: analysis.questionSeq,
          question: analysis.question,
          turnCount: analysis.turnCount,
          entries: entries.length,
          window: analysis
        }
      }

      /** 纯读取：由判据 + 登记表算出该会话当前的版本视图，不写盘。 */
      function computeView(sessionId) {
        var basis = basisFor(sessionId)
        var base = {
          ready: false,
          running: basis.running === true,
          turnNumber: basis.turnNumber === undefined ? null : basis.turnNumber,
          reason: basis.reason === undefined ? null : basis.reason,
          source: basis.source,
          messageIds: basis.messageIds === undefined ? [] : basis.messageIds,
          anchorSeq: basis.anchorSeq === undefined ? -1 : basis.anchorSeq,
          questionSeq: basis.questionSeq === undefined ? -1 : basis.questionSeq,
          question: basis.question === undefined ? '' : basis.question,
          familyKey: null,
          versions: [],
          index: -1,
          editing: false
        }
        if (basis.operable !== true) {
          dlog('视图：这一轮不可操作', {
            sessionId: sessionId,
            判据来源: basis.source,
            还在跑: basis.running === true,
            原因: basis.reason === undefined ? null : basis.reason,
            窗口事件数: basis.entries === undefined ? null : basis.entries
          })
          return base
        }
        // 归属表优先；只有从未由本插件 fork 过的会话才退回去推导。
        var memberKey = memberOf(sessionId)
        var derivedKey = familyKeyOf(rootOf(ctx.sessions.list.getSnapshot(), sessionId), basis.anchorSeq)
        var key = memberKey === null ? derivedKey : memberKey
        var versions = readVersions(key)
        var index = versions.indexOf(sessionId)
        if (index === -1) {
          if (versions.length === 0) {
            // 全新家族：当前会话就是第 1 版（只在视图里体现，不落盘）。
            versions = [sessionId]
            index = 0
          } else {
            // 家族存在但当前会话不在里面（例如登记表写晚了、或换了 key）：
            // 追加到末尾自愈，绝不让 N 塌回 1。
            versions = versions.concat([sessionId])
            index = versions.length - 1
            dlog('视图：当前会话不在家族里，已追加自愈', { sessionId: sessionId, key: key })
          }
        }
        dlog('视图计算完成', {
          sessionId: sessionId,
          判据来源: basis.source,
          anchorSeq: basis.anchorSeq,
          提问seq: basis.questionSeq,
          本轮轮号: basis.turnNumber,
          轮次总数: basis.turnCount,
          家族key来源: memberKey === null ? '推导' : '归属表',
          家族key: key,
          派生key: derivedKey,
          版本表: versions,
          当前序号: index,
          登记表全量: readStore(VERSIONS_KEY, LEGACY_VERSIONS_KEYS)[key] === undefined ? null : readStore(VERSIONS_KEY, LEGACY_VERSIONS_KEYS)[key],
          归属表命中: memberKey,
          最后浏览: readStore(VIEWED_KEY, LEGACY_VIEWED_KEYS)[key] === undefined ? null : readStore(VIEWED_KEY, LEGACY_VIEWED_KEYS)[key],
          窗口事件数: basis.entries === undefined ? null : basis.entries
        })
        base.ready = true
        base.familyKey = key
        base.versions = versions
        base.index = index
        return base
      }

      /**
       * 向宿主要「真实轮次」（全量日志）。只读、幂等。
       *
       * 拿到之后重算视图 —— 长轮次会话的按钮/翻页器就是在这里被救回来的。
       * 路由不存在（老运行时、宿主还没重启）时只记一次 dlog，**不报错也不重试风暴**，
       * 视图继续走窗口判据。
       *
       * @param state - 会话状态。
       * @param sessionId - 会话 id。
       */
      function refreshHostInfo(state, sessionId) {
        if (typeof window.fetch !== 'function') return
        var token = state.hostToken + 1
        state.hostToken = token
        var pending
        try {
          pending = window.fetch(TURNS_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId })
          })
        } catch (error) {
          state.hostFailed = true
          dlog('宿主真实轮次请求发不出去', String(error && error.message))
          return
        }
        Promise.resolve(pending).then(function (response) {
          if (response === undefined || response === null || response.status !== 200) {
            throw new Error('http ' + String(response === undefined || response === null ? 'no-response' : response.status))
          }
          return response.json()
        }).then(function (payload) {
          // 有更新的请求在飞：丢弃这次的结果，避免旧数据覆盖新数据。
          if (token !== state.hostToken) return
          state.host = payload !== null && typeof payload === 'object' && payload.ok === true ? payload : null
          if (state.host === null) state.hostFailed = true
          dlog('宿主真实轮次已到', {
            sessionId: sessionId,
            轮次总数: state.host === null ? null : state.host.turnCount,
            锚点: state.host === null ? null : state.host.anchorSeq
          })
          publish(state, computeView(sessionId))
        }, function (error) {
          if (token !== state.hostToken) return
          state.hostFailed = true
          dlog('宿主真实轮次拿不到，继续用窗口判据', String(error && error.message))
        })
      }

      /** 窗口一变就问一次宿主（防抖）：一次工具调用会连着推好几条事件。 */
      function scheduleHostRefresh(state, sessionId) {
        if (state.hostFailed === true) return
        // 用布尔闸门而不是定时器句柄：宿主环境里 setTimeout 的返回值可能是 0，
        // 拿句柄当「有没有装上」会让防抖永久卡住。
        if (state.hostPending === true) return
        state.hostPending = true
        var arm = window.setTimeout === undefined ? setTimeout : window.setTimeout
        state.hostTimer = arm(function () {
          state.hostPending = false
          state.hostTimer = null
          refreshHostInfo(state, sessionId)
        }, HOST_REFRESH_DEBOUNCE_MS)
      }

      function stateFor(sessionId) {
        var state = states.get(sessionId)
        if (state !== undefined) return state
        state = {
          snapshot: EMPTY_VIEW,
          listeners: new Set(),
          source: null,
          face: null,
          unsubscribe: null,
          /** 宿主侧真实轮次（全量日志）；null = 还没拿到。 */
          host: null,
          /** 在途请求序号：只认最后一次。 */
          hostToken: 0,
          /** 防抖定时器。 */
          hostTimer: null,
          /** 防抖在途闸门（布尔，不依赖定时器句柄）。 */
          hostPending: false,
          /** 宿主路由不可用（老运行时）：不再重试，静默降级到窗口判据。 */
          hostFailed: false
        }
        state.source = {
          getSnapshot: function () { return state.snapshot },
          subscribe: function (listener) {
            state.listeners.add(listener)
            return function () { state.listeners.delete(listener) }
          }
        }
        states.set(sessionId, state)
        subscribeWindow(state, sessionId)
        publish(state, computeView(sessionId))
        refreshHostInfo(state, sessionId)
        return state
      }

      /**
       * 订阅该会话的事件窗口。绑定在首帧可能还不存在，所以订阅是可重入的：
       * 每次 faceFor 都会补一次，避免「订阅没装上 → 视图永远停在空」。
       */
      function subscribeWindow(state, sessionId) {
        if (state.unsubscribe !== null) return
        var binding = ctx.sessions.binding(sessionId)
        if (binding === undefined || binding.eventSource === undefined) {
          dlog('事件窗口绑定暂不可用，稍后重试', { sessionId: sessionId })
          return
        }
        state.unsubscribe = binding.eventSource.subscribe(function () {
          // 窗口先给一版「即时答案」，再问宿主要全量真值（轮次结束后按钮就会出现）。
          publish(state, computeView(sessionId))
          scheduleHostRefresh(state, sessionId)
        })
        dlog('已订阅事件窗口', { sessionId: sessionId })
      }

      // ── fork / archive / open 链条 ───────────────────────────────────────
      function registerVersion(view, parentSessionId, childId) {
        var versions = readVersions(view.familyKey)
        if (versions.indexOf(parentSessionId) === -1) versions.push(parentSessionId)
        if (versions.indexOf(childId) === -1) versions.push(childId)
        writeVersions(view.familyKey, versions)
        writeViewed(view.familyKey, childId)
        writeMember(parentSessionId, view.familyKey)
        writeMember(childId, view.familyKey)
        dlog('版本家族已登记', { familyKey: view.familyKey, versions: versions })
      }

      /**
       * 打开/导航到某条会话。
       *
       * ⚠️ 0.1.6 起 `ISessions` **没有** `open()` 了（`ClientSessions` 里也不存在这个
       * 方法，注释原话：navigation belongs to view owners），导航迁到了
       * `ctx.uiWorkspace.openSession(id)`（官方 ui-chat 的 forkAt 就是这么做的：
       * `dsh-client-ui-chat/lib/client.js` 里 `forkAt` → `ctx.uiWorkspace.openSession`）。
       * 老运行时（0.1.2 源码版）只有 `ctx.sessions.open(id)`，所以这里按能力探测，
       * 两条都保留 —— 之前写死 `ctx.sessions.open()`，在 0.1.6 上必然抛
       * `TypeError: ctx.sessions.open is not a function`，把 fork 之后的整条链
       * （导航 + 发 prompt）全炸掉：新会话建出来了、源会话也归档了，但新问题永远
       * 不会发出去 —— 表现就是「点编辑保存 → 新开一个界面 → 卡住」。
       *
       * @param sessionId - 目标会话。
       * @returns 是否真的导航成功（失败只降级，绝不抛错）。
       */
      function navigateTo(sessionId) {
        var ui
        try {
          ui = typeof ctx.get === 'function' ? ctx.get(UI_WORKSPACE_SERVICE) : undefined
          if (ui === undefined) ui = ctx[UI_WORKSPACE_SERVICE]
        } catch (error) {
          ui = undefined
        }
        if (ui !== undefined && ui !== null && typeof ui.openSession === 'function') {
          try {
            ui.openSession(sessionId)
            dlog('已导航到会话（uiWorkspace.openSession）', { sessionId: sessionId })
            return true
          } catch (error) {
            console.error(NAME + '：uiWorkspace.openSession 失败', error)
            dlog('uiWorkspace 导航抛错', String(error && error.message))
          }
        }
        if (typeof ctx.sessions.open === 'function') {
          try {
            ctx.sessions.open(sessionId)
            dlog('已导航到会话（sessions.open，旧运行时）', { sessionId: sessionId })
            return true
          } catch (error) {
            console.error(NAME + '：sessions.open 失败', error)
            dlog('sessions.open 抛错', String(error && error.message))
          }
        }
        console.warn(NAME + '：当前运行时没有可用的会话导航接口，新会话已经建好，请手动在侧边栏打开它')
        return false
      }

      /** 子会话是否已经在客户端会话列表里（0.1.6 的 binding() 需要被 retain，不能当存在性判断用）。 */
      function listed(sessionId) {
        try {
          var state = ctx.sessions.list.getSnapshot()
          return state !== undefined && state !== null && state.byId !== undefined
            && state.byId[sessionId] !== undefined
        } catch (error) {
          return false
        }
      }

      /** 借用 binding 里的会话面（没有本地 retain 时会是 undefined）。 */
      function sessionFaceOf(sessionId) {
        var binding = ctx.sessions.binding(sessionId)
        return binding === undefined || binding === null ? undefined : binding.session
      }

      /** 取 uiWorkspace 服务（0.1.6 的导航/取消归档入口），没有就返回 undefined。 */
      function uiWorkspaceFace() {
        var ui
        try {
          ui = typeof ctx.get === 'function' ? ctx.get(UI_WORKSPACE_SERVICE) : undefined
          if (ui === undefined) ui = ctx[UI_WORKSPACE_SERVICE]
        } catch (error) {
          ui = undefined
        }
        return ui === undefined || ui === null ? undefined : ui
      }

      /** 当前被归档的会话 id 集合（宿主权威，来自 workspace 控制器）。 */
      function archivedIds() {
        try {
          var state = ctx.workspaces === undefined || ctx.workspaces === null
            ? undefined
            : ctx.workspaces.list.getSnapshot()
          return state !== undefined && state !== null && Array.isArray(state.archivedSessionIds)
            ? state.archivedSessionIds
            : []
        } catch (error) {
          return []
        }
      }

      /**
       * 要打开一条**被归档**的旧版本时，先把它取消归档。
       *
       * 为什么必须这么做（0.1.6 的真行为，翻页器「点箭头回不到上一版」的根因）：
       * ui-workspace 的导航守卫里有
       *   `reconcile()` 第一句就是 `if (this.clearArchivedCurrent()) return`
       * 而 `clearArchivedCurrent()` 一旦发现**当前主会话在归档集里**就 `clearMain()`
       * （主会话置空 + `selection.set({})` + `selectPanel(null)`）。
       * `reconcile` 同时订阅了 sessions.list 与 workspaces.list，任何一次列表刷新都会跑，
       * 所以「导航到归档版本」的下一秒视图就被清空 —— 用户看到的就是箭头点了没用、
       * 回不到上一次的答案。切换只取消归档**目标**那一条，不动其它版本。
       *
       * @param sessionId - 目标版本会话。
       * @returns 完成信号（拿不到取消归档接口时也不抛错）。
       */
      function restoreArchived(sessionId) {
        if (archivedIds().indexOf(sessionId) === -1) return Promise.resolve()
        var ui = uiWorkspaceFace()
        var workspaces = ctx.workspaces
        var call
        if (ui !== undefined && typeof ui.unarchiveSession === 'function') {
          call = function () { return ui.unarchiveSession(sessionId) }
        } else if (workspaces !== undefined && workspaces !== null && typeof workspaces.unarchiveSession === 'function') {
          call = function () { return workspaces.unarchiveSession(sessionId) }
        }
        if (call === undefined) {
          dlog('目标版本已归档，但当前运行时没有「取消归档」接口，只能直接导航（可能被清空）', { sessionId: sessionId })
          return Promise.resolve()
        }
        dlog('目标版本已归档 → 先取消归档再导航', { sessionId: sessionId })
        return Promise.resolve(call()).then(
          function () {
            dlog('已取消归档', { sessionId: sessionId })
            return waitForSession(sessionId)
          },
          function (error) {
            console.error(NAME + '：取消归档失败', error)
            dlog('取消归档失败，仍然尝试导航', String(error && error.message))
          }
        )
      }

      /**
       * fork → 登记（必须在导航之前）→ 导航到子会话。
       *
       * 顺序上两处讲究：
       *  1. 登记早于导航：子会话第一帧渲染时登记表就已经是完整的，否则它的视图
       *     会被缓存成「只有 1 版」，翻页器就不出现。
       *  2. 导航早于归档：源会话往往正是当前主视图，先归档会让 ui-workspace 的
       *     `clearArchivedCurrent()` 把主视图清空（`clearMain()` 会
       *     `selectPanel(null)`），和我们的导航打架，用户看到的就是「界面自己跳了」。
       *     先导航到子会话，主视图就不再是源会话，归档只影响侧边栏那一行。
       *
       * @param sessionId - 源会话。
       * @param anchorSeq - fork 锚点（目标轮之前最后一个 turn/end 的 seq）。
       * @param register - 同步登记回调。
       * @returns 子会话 id。
       */
      function swapToChild(sessionId, anchorSeq, register) {
        dlog('fork 开始', { sessionId: sessionId, atSeq: anchorSeq })
        return Promise.resolve(ctx.sessions.fork({ sessionId: sessionId, atSeq: anchorSeq }))
          .then(function (childId) {
            dlog('fork 成功', { childId: childId })
            register(childId)
            navigateTo(childId)
            return childId
          })
      }

      /**
       * 归档源会话；失败只降级为「侧边栏多一行」，不回滚（子会话已经建好）。
       * 服务缺失/抛错都不许把已经送出去的 prompt 变成一次「操作失败」。
       * @param sessionId - 源会话。
       * @returns 完成信号。
       */
      function archiveSource(sessionId) {
        var workspaces = ctx.workspaces
        if (workspaces === undefined || workspaces === null || typeof workspaces.archiveSession !== 'function') {
          dlog('当前运行时没有 workspaces.archiveSession，跳过归档（侧边栏会多一行）')
          return Promise.resolve()
        }
        return Promise.resolve(workspaces.archiveSession(sessionId)).then(
          function () { dlog('源会话已归档', { sessionId: sessionId }) },
          function (error) {
            console.error(NAME + '：归档源会话失败', error)
            dlog('归档失败，降级为侧边栏多一行', String(error && error.message))
          }
        )
      }

      function fail(message) {
        return { ok: false, message: message }
      }

      /** 把 prompt 的返回判成插件自己的结果形状。 */
      function judgePrompt(result, childId) {
        if (result !== undefined && result !== null && result.ok === true) {
          dlog('prompt 已被接受', { childId: childId })
          return { ok: true }
        }
        var message = result !== undefined && result !== null && result.error !== undefined && result.error !== null
          ? String(result.error.message)
          : TEXT.failed
        dlog('prompt 被拒绝', { childId: childId, message: message })
        return fail(message)
      }

      /** 真正调用会话面上的 prompt。 */
      function callPrompt(face, childId, text, mode) {
        if (face === undefined || face === null || typeof face.prompt !== 'function') {
          dlog('子会话不可寻址', { childId: childId })
          return Promise.resolve(fail(TEXT.forkFailed))
        }
        dlog('向子会话发送 prompt', { childId: childId, mode: mode, text: text.slice(0, 80) })
        return Promise.resolve(face.prompt([{ type: 'text', text: text }], mode))
      }

      /**
       * 给子会话发一条 prompt。
       *
       * 为什么不能只写 `ctx.sessions.binding(childId).session.prompt(...)`：
       * 0.1.6 的 `binding(id)` 是「借用**已经 retain 过的**绑定」，没被任何视图
       * retain 的会话返回 undefined；子会话是刚 fork 出来的，视图还没打开它，
       * 于是 binding 是 undefined —— 老代码据此直接返回「无法新建版本会话」，
       * 新问题一样发不出去。
       * 正确姿势是公开的 `ctx.sessions.using(id, { source }, fn)`：它自己
       * retain 一次引用、等 initial open 完成（`reference.ready`）再回调，用完释放。
       * 老运行时没有 using 时才退回 binding。
       *
       * @param childId - 子会话。
       * @param text - 要发送的文本。
       * @param mode - 'queue'（追加一轮）。
       * @returns 插件的结果形状。
       */
      function promptChild(childId, text, mode) {
        if (typeof ctx.sessions.using === 'function') {
          return Promise.resolve(ctx.sessions.using(childId, { source: REFERENCE_SOURCE }, function (reference) {
            var binding = reference === undefined || reference === null ? undefined : reference.binding
            var face = binding === undefined || binding === null ? sessionFaceOf(childId) : binding.session
            return callPrompt(face, childId, text, mode)
          })).then(
            function (result) { return judgePrompt(result, childId) },
            function (error) {
              dlog('prompt 通道抛错', { childId: childId, error: String(error && error.message) })
              return fail(String(error !== undefined && error !== null && error.message !== undefined ? error.message : error))
            }
          )
        }
        return callPrompt(sessionFaceOf(childId), childId, text, mode)
          .then(function (result) { return judgePrompt(result, childId) })
      }

      /**
       * prompt 成功之后才归档源会话：prompt 没送出去就归档，用户会既看不到新回答、
       * 又丢了原来那一版（这正是 0.1.6 下坏掉时的观感）。
       * @param sessionId - 源会话。
       * @param result - prompt 的结果。
       * @returns 原结果。
       */
      function archiveAfterPrompt(sessionId, result) {
        if (result === undefined || result === null || result.ok !== true) {
          dlog('prompt 未送达，保留源会话不归档', { sessionId: sessionId })
          return Promise.resolve(result)
        }
        return archiveSource(sessionId).then(function () { return result })
      }

      /** 「重新生成」= 用原问题重问。 */
      function regenerate(sessionId, view) {
        return swapToChild(sessionId, view.anchorSeq, function (childId) {
          registerVersion(view, sessionId, childId)
        }).then(function (childId) {
          republishAll()
          return promptChild(childId, view.question, 'queue')
            .then(function (result) { return archiveAfterPrompt(sessionId, result) })
        })
      }

      /** 「编辑提问」= 同一个锚点、同一套编排，只是把文字换成改过的。 */
      function editQuestion(sessionId, view, text) {
        var next = typeof text === 'string' ? text.trim() : ''
        if (next === '') return Promise.resolve(fail(TEXT.emptyQuestion))
        return swapToChild(sessionId, view.anchorSeq, function (childId) {
          registerVersion(view, sessionId, childId)
        }).then(function (childId) {
          republishAll()
          return promptChild(childId, next, 'queue')
            .then(function (result) { return archiveAfterPrompt(sessionId, result) })
        })
      }

      /** 「删除这轮」= 同一个锚点，不发 prompt（所以这里可以直接归档源会话）。 */
      function removeTurn(sessionId, view) {
        return swapToChild(sessionId, view.anchorSeq, function () {
          // 这一轮已经从子会话里消失，登记表里的版本家族也随之作废。
          // 子会话剩下的最后一轮是更早的一轮，它的家族 key 与本 key 不同。
          forgetFamily(view.familyKey)
        }).then(function () {
          republishAll()
          return archiveSource(sessionId).then(function () { return { ok: true } })
        })
      }

      /**
       * 等子会话出现在客户端会话列表里。
       * 宿主路由是异步建会话的：POST 返回时客户端列表可能还没收到 added 帧 /
       * 还没重新拉取，这时导航会因为「unknown session」失败。
       * 所以先 refresh（官方 ISessions.refresh），必要时重试几次。
       *
       * 判据必须是**列表**（`list.byId`）：0.1.6 的 `binding(id)` 只在会话被某个
       * 视图 retain 之后才有值，用它当存在性判断会永远等不到（老代码就是这样，
       * 于是「保留提问」这一项必然在 8 次重试后报「列表还没刷新出来」）。
       * @param sessionId - 子会话 id。
       * @returns 是否可见。
       */
      function waitForSession(sessionId) {
        var attempts = 0
        var attempt = function () {
          if (listed(sessionId)) return Promise.resolve(true)
          attempts += 1
          if (attempts > 8) return Promise.resolve(false)
          var delay = function () {
            return new Promise(function (resolve) { window.setTimeout(resolve, 120) }).then(attempt)
          }
          return Promise.resolve(ctx.sessions.refresh()).then(function () {
            return listed(sessionId) ? true : delay()
          }, delay)
        }
        return attempt()
      }

      /**
       * 「只删回答（保留提问，不重新生成）」—— 走宿主路由。
       *
       * 客户端拿不到事件日志，无法自己切出「只剩提问」的 seed；宿主的
       * sessionQuery + agents.create 是唯一的公开路径。宿主做完
       * 「切 seed → 合成闭合事件 → 建子会话 → 挂工作区 → 归档父会话」，
       * 把子会话 id 交回来。**不发 prompt，也不用 cancel()**。
       * @param sessionId - 当前会话。
       * @param view - 当前版本视图（要带 questionSeq）。
       * @returns 结果。
       */
      function keepQuestion(sessionId, view) {
        if (typeof view.questionSeq !== 'number' || view.questionSeq < 0) {
          return Promise.resolve(fail(TEXT.keepUnavailable))
        }
        var body = JSON.stringify({ sessionId: sessionId, questionSeq: view.questionSeq })
        dlog('保留提问：调用宿主路由', { route: KEEP_QUESTION_ROUTE, body: body })
        return Promise.resolve(window.fetch(KEEP_QUESTION_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body
        })).then(
          function (response) {
            return Promise.resolve(response.json()).then(
              function (payload) { return { status: response.status, payload: payload } },
              function () { return { status: response.status, payload: null } }
            )
          },
          function (error) {
            return { status: 0, payload: { message: String(error && error.message ? error.message : error) } }
          }
        ).then(function (result) {
          var payload = result.payload
          if (payload === null || typeof payload !== 'object' || payload.ok !== true
            || typeof payload.sessionId !== 'string') {
            var message = payload !== null && typeof payload === 'object' && payload.message
              ? String(payload.message)
              : TEXT.failed
            dlog('保留提问：宿主返回失败', { status: result.status, payload: payload })
            return fail(message)
          }
          var childId = payload.sessionId
          dlog('保留提问：宿主已建好子会话', {
            childId: childId,
            seedLength: payload.seedLength,
            archived: payload.archived
          })
          // 登记必须先于导航（与其他路径同一条硬约束）。
          registerVersion(view, sessionId, childId)
          republishAll()
          return waitForSession(childId).then(function (visible) {
            if (!visible) {
              dlog('保留提问：子会话迟迟没出现在列表里', { childId: childId })
              return fail(TEXT.childNotListed)
            }
            navigateTo(childId)
            dlog('保留提问：已导航到子会话（未发送任何 prompt）', { childId: childId })
            republishAll()
            return { ok: true }
          })
        })
      }

      function openVersion(familyKey, target) {
        var versions = familyKey === null ? [] : readVersions(familyKey)
        dlog('切换版本', { familyKey: familyKey, target: target, versions: versions })
        // 切换**只做「取消归档（仅在目标被归档时）+ 导航」**，绝不再归档任何东西。
        //
        // 为什么不能「顺手把家族其余成员归档掉」（本插件早期版本干过，是真 bug）：
        // 归档是单向的。在切换时归档「其他版本」= 把用户刚刚看的、以及之后想回去的
        // 版本从侧边栏抹掉 —— 表现就是「一点翻页器就归档，再也看不到上一句」。
        // 归档只发生在 fork 那一刻（被取代的源会话），那一步才是「侧边栏不会因为
        // 重新生成而长出重复行」的来源。
        //
        // 目标会话是否还在：用列表判断（binding 需要 retain，不能当存在性用）。
        // 「不在列表里但确实被归档」不算删除——归档行可能被列表层过滤，那种情况下面会
        // 先取消归档再打开；只有「既不在列表、也不在归档集」才当作真没了，摘除自愈。
        var isArchived = archivedIds().indexOf(target) !== -1
        if (!listed(target) && !isArchived) {
          console.error(NAME + '：目标版本会话已不在列表里', target)
          dlog('目标会话不存在，已从登记表摘除', { target: target })
          if (familyKey !== null) removeVersion(familyKey, target)
          dropMember(target)
          republishAll()
          return Promise.resolve(fail(TEXT.deadVersion))
        }
        // 归档过的版本不能当主会话（ui-workspace 会 clearArchivedCurrent），所以先取消归档。
        return restoreArchived(target).then(function () {
          if (!navigateTo(target)) return fail(TEXT.deadVersion)
          if (familyKey !== null) writeViewed(familyKey, target)
          dlog('已切换到目标版本（只取消归档了目标，没归档任何会话）', { target: target })
          republishAll()
          return { ok: true }
        })
      }

      function faceFor(sessionId) {
        var state = stateFor(sessionId)
        subscribeWindow(state, sessionId)
        if (state.face !== null) return state.face
        state.face = {
          hooks: { answerVersions: state.source },
          // 归属参数 ref：turnTail 给的是轮号（number），老槽位给的是 messageId（string）。
          regenerate: function (ref) {
            var view = state.snapshot
            if (!ownsRef(view, ref)) return Promise.resolve(fail(TEXT.unavailable))
            return regenerate(sessionId, view)
          },
          editQuestion: function (ref, text) {
            var view = state.snapshot
            if (!ownsRef(view, ref)) return Promise.resolve(fail(TEXT.unavailable))
            return editQuestion(sessionId, view, text)
          },
          /**
           * 「删除这轮」的选择（两个客户端侧编排）：
           * - 'both'（默认）：提问 + 回答整轮删掉，不再提问 = 纯删除编排。
           * - 'regenerate'：保留提问、重做回答 —— 复用 regenerate 的同一套编排
           *   （dsh 里提问和回答同属一个 turn、中间没有分界，fork 只能切在
           *   turn/end 上，所以这一支必须重新提问）。
           * 「只删回答但不重新生成」不走这里，走 keepQuestion（宿主路由）。
           */
          removeTurn: function (ref, choice) {
            var view = state.snapshot
            if (!ownsRef(view, ref)) return Promise.resolve(fail(TEXT.unavailable))
            dlog('删除这轮：用户选择', { choice: choice })
            if (choice === 'regenerate') return regenerate(sessionId, view)
            return removeTurn(sessionId, view)
          },
          keepQuestion: function (ref) {
            var view = state.snapshot
            if (!ownsRef(view, ref)) return Promise.resolve(fail(TEXT.unavailable))
            return keepQuestion(sessionId, view)
          },
          openVersion: function (id) {
            return openVersion(state.snapshot.familyKey, id)
          }
        }
        return state.face
      }

      var disposeSlot = ctx.slots.inject(SLOT, function () {
        return ctx.slots.register({
          name: SLOT,
          id: 'houhuiyao',
          order: 20,
          inject: function (sessionId) { return faceFor(sessionId) }
        }, AnswerVersionsActions)
      })

      dlog('插件已挂载', { slot: SLOT, debug: isDebug() })

      return function () {
        disposeSlot()
        states.forEach(function (state) {
          if (state.unsubscribe !== null) state.unsubscribe()
          if (state.hostTimer !== null) {
            var cancel = window.clearTimeout === undefined ? clearTimeout : window.clearTimeout
            cancel(state.hostTimer)
            state.hostTimer = null
          }
        })
        states.clear()
      }
    }

    // ── 组件 ──────────────────────────────────────────────────────────────
    var BUTTON_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      height: '24px',
      padding: '0 8px',
      border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.32))',
      borderRadius: '12px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, inherit)',
      font: 'inherit',
      fontSize: '12px',
      lineHeight: '1',
      whiteSpace: 'nowrap',
      cursor: 'pointer'
    }
    var PAGER_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '2px',
      height: '24px',
      color: 'var(--dsw-alias-label-tertiary, inherit)',
      fontSize: '12px',
      lineHeight: '1',
      whiteSpace: 'nowrap'
    }
    var ARROW_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '20px',
      height: '20px',
      padding: '0',
      border: 'none',
      borderRadius: '10px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, inherit)',
      font: 'inherit',
      fontSize: '14px',
      lineHeight: '1',
      cursor: 'pointer'
    }
    var BUSY_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      height: '24px',
      padding: '0 8px',
      color: 'var(--dsw-alias-label-tertiary, inherit)',
      fontSize: '12px',
      lineHeight: '1',
      whiteSpace: 'nowrap'
    }
    var ERROR_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      height: '24px',
      padding: '0 8px',
      color: 'var(--dsw-state-error, #d94b4b)',
      fontSize: '12px',
      lineHeight: '1',
      whiteSpace: 'nowrap'
    }
    /**
     * 不可操作时的那行中文原因。
     *
     * 为什么要有它：以前判据不足（首轮没有分叉点、窗口把上一轮挤出去、该轮由系统
     * 注入触发）时整排控件**静默消失**，用户只能猜「插件坏了？」。现在至少把原因
     * 写在原地，并且说明是结构限制还是暂时状态。
     */
    var REASON_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      height: '24px',
      padding: '0 8px',
      color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.9))',
      fontSize: '12px',
      lineHeight: '1',
      whiteSpace: 'nowrap'
    }

    // ── 编辑面板：视口居中的模态层 ────────────────────────────────────────
    // 为什么不是贴着按钮的 popover：DSH Web 是全高应用，页面本身不滚动
    // （document 没有可滚动溢出），任何按 getBoundingClientRect 摆位的浮层
    // 只要往下超出视口，下半部分就永远点不到 —— 提交按钮会消失在屏幕外。
    // 所以改成 fixed + inset:0 的居中层，卡片 maxHeight:80vh，卡片内部
    // textarea 自己滚动，footer 永远是可见的 flex 子项。
    // 数值对齐 shell 自己的 Modal（packages/client/ui-primitives/src/Modal.module.css）：
    // z-index 1000、mask 用 --dsw-alias-bg-mask-1、卡片用 bg-layer-2 + shadow-lv3。
    var OVERLAY_STYLE = {
      position: 'fixed',
      inset: '0',
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      boxSizing: 'border-box',
      background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.32))',
      backdropFilter: 'var(--dsw-mask-blur, blur(2px))'
    }
    var CARD_STYLE = {
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      gap: '12px',
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: 'min(560px, 92vw)',
      maxHeight: '80vh',
      padding: '18px',
      overflow: 'hidden',
      border: '1px solid var(--dsw-alias-border-inverted, rgba(128,128,128,0.28))',
      borderRadius: '16px',
      background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, #1e1e1e))',
      color: 'var(--dsw-alias-label-primary, inherit)',
      boxShadow: 'var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,0.35))'
    }
    var TITLE_STYLE = {
      flex: '0 0 auto',
      margin: 0,
      fontSize: '15px',
      fontWeight: 500,
      lineHeight: '22px',
      color: 'var(--dsw-alias-label-primary, inherit)'
    }
    // 卡片里「会滚动的那一块」。编辑面板是 textarea，删除确认是两个选项；
    // 两者共用这一组 flex 约束：flex:1 1 auto 吃掉剩余空间并 min-height:0 允许收缩，
    // footer 因此永远是可见的。
    var BODY_FLEX = {
      flex: '1 1 auto',
      minHeight: '0',
      overflow: 'auto'
    }
    var FOOTER_STYLE = {
      flex: '0 0 auto',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px'
    }
    var HINT_STYLE = {
      flex: '1 1 auto',
      minWidth: '0',
      margin: 0,
      fontSize: '11px',
      lineHeight: '1.5',
      color: 'var(--dsw-alias-label-tertiary, inherit)'
    }
    var FOOTER_ACTIONS_STYLE = { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '8px' }
    /** 只有「取消」一个控件时靠右对齐（与编辑面板的 footer 视觉一致）。 */
    var FOOTER_END_STYLE = Object.assign({}, FOOTER_STYLE, { justifyContent: 'flex-end' })
    var PRIMARY_STYLE = Object.assign({}, BUTTON_STYLE, {
      background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.16))'
    })
    var INPUT_STYLE = Object.assign({}, BODY_FLEX, {
      width: '100%',
      boxSizing: 'border-box',
      resize: 'none',
      padding: '10px',
      borderRadius: '8px',
      border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.32))',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: '13px',
      lineHeight: '1.6'
    })
    var EXPLAIN_STYLE = {
      flex: '0 0 auto',
      margin: 0,
      fontSize: '12px',
      lineHeight: '1.7',
      color: 'var(--dsw-alias-label-secondary, inherit)'
    }
    var OPTIONS_STYLE = Object.assign({}, BODY_FLEX, {
      display: 'flex',
      flexDirection: 'column',
      gap: '10px'
    })
    var OPTION_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: '4px',
      width: '100%',
      boxSizing: 'border-box',
      padding: '12px 14px',
      border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,0.32))',
      borderRadius: '10px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary, inherit)',
      font: 'inherit',
      textAlign: 'left',
      cursor: 'pointer'
    }
    var OPTION_LABEL_STYLE = { fontSize: '13px', fontWeight: 500, lineHeight: '20px' }
    var OPTION_NOTE_STYLE = { fontSize: '11px', lineHeight: '1.6', color: 'var(--dsw-alias-label-tertiary, inherit)' }

    /** 遮罩层 + 卡片的重用外壳（编辑面板与删除确认共用，保证结构一致、永不被裁）。 */
    function overlayFor(close, card) {
      return ReactDOM.createPortal(
        React.createElement('div', {
          style: OVERLAY_STYLE,
          // 点背景 = 取消；卡片内部的 pointerdown 不会命中 currentTarget。
          onPointerDown: function (event) {
            if (event.target !== event.currentTarget) return
            close()
          }
        }, card),
        document.body
      )
    }

    /** 卡片外壳：标题 / 会滚动的主体 / 永远可见的 footer。 */
    function cardFor(title, body, footer) {
      return React.createElement(
        'div',
        { style: CARD_STYLE, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        React.createElement('p', { style: TITLE_STYLE }, title),
        body,
        footer
      )
    }

    /** 一个删除选项：加粗的标题 + 一行说明。 */
    function optionButton(key, label, note, onClick) {
      return React.createElement(
        'button',
        { key: key, type: 'button', style: OPTION_STYLE, 'aria-label': label, onClick: onClick },
        React.createElement('span', { style: OPTION_LABEL_STYLE }, label),
        React.createElement('span', { style: OPTION_NOTE_STYLE }, note)
      )
    }

    /**
     * 最后一条回答上的四个控件。始终可见（行内样式，不依赖悬停），
     * 执行期间整排换成忙碌文案，失败时显示一行错误。
     *
     * 归属参数（ref）：挂在 `conversation.chat.turnTail` 上时官方给的是**轮号**
     * `props.turn`；老槽位 `assistant-actions` 给的是 `props.messageId`。两者都认。
     */
    function AnswerVersionsActions(props) {
      var ref = typeof props.turn === 'number' ? props.turn : props.messageId
      var view = props.useAnswerVersions(function (snapshot) { return snapshot })
      var busyPair = React.useState(null)
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      var errorPair = React.useState(null)
      var error = errorPair[0]
      var setError = errorPair[1]
      // 单一对话框状态：null | { kind:'edit', text } | { kind:'delete' }
      var dialogPair = React.useState(null)
      var dialog = dialogPair[0]
      var setDialog = dialogPair[1]
      var inputRef = React.useRef(null)
      /** 键盘快捷键读它，避免把提交函数塞进聚焦 effect 的依赖里。 */
      var submitRef = React.useRef(null)
      var aliveRef = React.useRef(true)
      /** 翻页在途闸门：openVersion 是异步的（可能先取消归档），连点只认第一次。 */
      var switchingRef = React.useRef(false)
      React.useEffect(function () {
        aliveRef.current = true
        return function () { aliveRef.current = false }
      }, [])

      var editing = dialog !== null && dialog.kind === 'edit'
      var confirming = dialog !== null && dialog.kind === 'delete'
      var dialogOpen = dialog !== null
      var draft = editing ? dialog.text : null

      var closeDialog = React.useCallback(function () { setDialog(null) }, [])

      var settle = React.useCallback(function (result) {
        if (!aliveRef.current) return
        setBusy(null)
        if (result !== undefined && result !== null && result.ok === false) {
          setError(result.message !== undefined && result.message !== null ? String(result.message) : TEXT.failed)
        }
      }, [])

      var run = React.useCallback(function (kind, arg) {
        if (busy !== null) return
        setBusy(kind)
        setError(null)
        closeDialog()
        var pending = kind === 'regenerate'
          ? props.regenerate(ref)
          : kind === 'edit'
            ? props.editQuestion(ref, arg)
            : kind === 'remove-regenerate'
              ? props.removeTurn(ref, 'regenerate')
              : kind === 'keep'
                ? props.keepQuestion(ref)
                : props.removeTurn(ref, 'both')
        Promise.resolve(pending).then(settle, function (thrown) {
          if (!aliveRef.current) return
          setBusy(null)
          setError(String(thrown !== null && thrown !== undefined && thrown.message !== undefined ? thrown.message : thrown))
        })
      }, [busy, ref, props.regenerate, props.editQuestion, props.removeTurn, props.keepQuestion, settle, closeDialog])

      var submitEditor = React.useCallback(function () {
        var text = draft === null ? '' : draft.trim()
        if (text === '') { setError(TEXT.emptyQuestion); return }
        if (text === view.question) { run('regenerate'); return }
        run('edit', text)
      }, [draft, view, run])

      // 快捷键读最新提交函数（每次渲染后刷新），监听只随「打开/关闭 + 是否编辑态」重装，
      // 避免每敲一个字都重装监听。
      React.useEffect(function () { submitRef.current = submitEditor })

      React.useEffect(function () {
        if (!dialogOpen) return
        var onKeyDown = function (event) {
          if (event.key === 'Escape') { event.preventDefault(); closeDialog(); return }
          if (editing && (event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault()
            var submit = submitRef.current
            if (submit !== null) submit()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return function () { document.removeEventListener('keydown', onKeyDown) }
      }, [dialogOpen, editing, closeDialog])

      // 聚焦只做一次：依赖是「是否处于编辑态」这个布尔，不是 draft，
      // 否则每敲一个字都会把光标推到末尾。
      React.useEffect(function () {
        if (!editing) return
        var input = inputRef.current
        if (input === null) return
        input.focus()
        // 光标放到末尾（不是 select，用户要接着改）。
        try { input.setSelectionRange(input.value.length, input.value.length) } catch (error) { /* 该输入类型不支持选区 */ }
      }, [editing])

      var openEditor = React.useCallback(function () {
        setError(null)
        setDialog({ kind: 'edit', text: view.question })
      }, [view])

      var openDelete = React.useCallback(function () {
        setError(null)
        setDialog({ kind: 'delete' })
      }, [])

      /**
       * 翻页。openVersion 现在是异步的（目标版本被归档时要先取消归档再导航），
       * 所以结果必须按 Promise 收，否则失败会静默；再加一个在途闸门，避免连点两次
       * 同时取消归档/导航。
       */
      var go = React.useCallback(function (delta) {
        var target = view.versions[view.index + delta]
        if (target === undefined) return
        if (busy !== null || switchingRef.current) return
        setError(null)
        switchingRef.current = true
        var finish = function (result) {
          switchingRef.current = false
          if (!aliveRef.current) return
          if (result !== undefined && result !== null && result.ok === false) setError(result.message)
        }
        Promise.resolve(props.openVersion(target)).then(finish, function (thrown) {
          finish({
            ok: false,
            message: String(thrown !== null && thrown !== undefined && thrown.message !== undefined ? thrown.message : thrown)
          })
        })
      }, [aliveRef, busy, props.openVersion, view, switchingRef])

      // 归属：只在「本会话最后那一轮」上出现。
      // 注意这里**不要求 ready** —— 不可操作的那一轮也要被认领，才能把原因说出来。
      if (!ownsRef(view, ref)) return null
      // 该轮还在跑：本来就没有可操作的对象，安静待着（别在生成过程中闪一行字）。
      if (view.running === true) return null
      // 不可操作：说清原因，不静默消失。
      if (view.ready !== true) {
        return view.reason === null || view.reason === undefined || view.reason === ''
          ? null
          : React.createElement('span', { style: REASON_STYLE, role: 'note' }, view.reason)
      }

      if (busy !== null) {
        var busyText = busy === 'regenerate' || busy === 'remove-regenerate'
          ? TEXT.regenerating
          : busy === 'keep' ? TEXT.keeping
            : busy === 'edit' ? TEXT.editing : TEXT.removing
        return React.createElement(
          'span',
          { style: BUSY_STYLE, role: 'status', 'aria-live': 'polite' },
          busyText
        )
      }

      var children = []
      children.push(React.createElement(
        'button',
        {
          key: 'regenerate',
          type: 'button',
          style: BUTTON_STYLE,
          title: TEXT.regenerate,
          'aria-label': TEXT.regenerate,
          onClick: function () { run('regenerate') }
        },
        '\u21bb ',
        TEXT.regenerate
      ))
      children.push(React.createElement(
        'button',
        {
          key: 'edit',
          type: 'button',
          style: BUTTON_STYLE,
          title: TEXT.editTitle,
          'aria-label': TEXT.edit,
          disabled: dialogOpen,
          onClick: openEditor
        },
        '\u270F\uFE0F ',
        TEXT.edit
      ))
      children.push(React.createElement(
        'button',
        {
          key: 'remove',
          type: 'button',
          style: BUTTON_STYLE,
          title: TEXT.deleteTitle,
          'aria-label': TEXT.remove,
          onClick: openDelete
        },
        '\uD83D\uDDD1 ',
        TEXT.remove
      ))
      if (view.versions.length > 1 && view.index >= 0) {
        children.push(React.createElement(
          'span',
          { key: 'pager', style: PAGER_STYLE },
          React.createElement(
            'button',
            {
              type: 'button',
              style: view.index > 0 ? ARROW_STYLE : Object.assign({}, ARROW_STYLE, { opacity: 0.35, cursor: 'default' }),
              title: TEXT.prev,
              'aria-label': TEXT.prev,
              disabled: view.index <= 0,
              onClick: function () { go(-1) }
            },
            '\u2039'
          ),
          React.createElement(
            'span',
            { 'aria-label': TEXT.version },
            String(view.index + 1) + '/' + String(view.versions.length)
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              style: view.index < view.versions.length - 1
                ? ARROW_STYLE
                : Object.assign({}, ARROW_STYLE, { opacity: 0.35, cursor: 'default' }),
              title: TEXT.next,
              'aria-label': TEXT.next,
              disabled: view.index >= view.versions.length - 1,
              onClick: function () { go(1) }
            },
            '\u203A'
          )
        ))
      }
      if (error !== null) {
        children.push(React.createElement('span', { key: 'error', style: ERROR_STYLE, role: 'status' }, error))
      }

      // 两个对话框共用「遮罩 + 居中卡片 + 标题/主体/footer」外壳：
      // 编辑提问（主体是会自动滚动的 textarea）与删除这轮（主体是两个选项）。
      // 卡片 maxHeight:80vh，主体 flex:1 1 auto + min-height:0，footer flex:0 0 auto
      // —— 所以无论内容多长，footer（取消 / 保存并重发）永远在可见区里。
      var dialogElement = null
      if (editing) {
        dialogElement = overlayFor(closeDialog, cardFor(
          TEXT.editTitle,
          React.createElement('textarea', {
            ref: inputRef,
            style: INPUT_STYLE,
            rows: 5,
            value: draft,
            placeholder: TEXT.placeholder,
            'aria-label': TEXT.editTitle,
            onChange: function (event) { setDialog({ kind: 'edit', text: event.target.value }) }
          }),
          React.createElement(
            'div',
            { style: FOOTER_STYLE },
            React.createElement('p', { style: HINT_STYLE }, TEXT.editHint),
            React.createElement(
              'div',
              { style: FOOTER_ACTIONS_STYLE },
              React.createElement(
                'button',
                { type: 'button', style: BUTTON_STYLE, onClick: closeDialog },
                TEXT.cancel
              ),
              React.createElement(
                'button',
                { type: 'button', style: PRIMARY_STYLE, onClick: submitEditor },
                TEXT.save
              )
            )
          )
        ))
      } else if (confirming) {
        dialogElement = overlayFor(closeDialog, cardFor(
          TEXT.deleteTitle,
          React.createElement(
            'div',
            { style: OPTIONS_STYLE },
            React.createElement('p', { style: EXPLAIN_STYLE }, TEXT.deleteExplain),
            optionButton('both', TEXT.deleteBoth, TEXT.deleteBothNote, function () { run('remove-both') }),
            optionButton('answer-only', TEXT.deleteAnswerOnly, TEXT.deleteAnswerOnlyNote, function () { run('remove-regenerate') }),
            optionButton('keep-question', TEXT.deleteKeepQuestion, TEXT.deleteKeepQuestionNote, function () { run('keep') })
          ),
          React.createElement(
            'div',
            { style: FOOTER_END_STYLE },
            React.createElement(
              'button',
              { type: 'button', style: BUTTON_STYLE, onClick: closeDialog },
              TEXT.cancel
            )
          )
        ))
      }

      return React.createElement(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
        children,
        dialogElement
      )
    }

    // ── 用到的 dsh 客户端 API（均在运行中的 checkout 里核对过） ────────────
    // ctx.slots.inject(key, cb) / ctx.slots.register(options, Component)
    //   packages/client/ui-renderer/src/client/registry.ts:172, :785
    //   list slot 用 id + order 定位；inject(sessionId) 得到当前会话 id（:104-112）
    // slot 声明：'conversation.chat.turnTail'，kind list、scope session，
    //   组件 props = { turn, seq, openFile }（归属判定用 turn）
    //   dsh-client-ui-chat/lib/client.js:3787（SlotMap 声明）、:3671（渲染点，无条件渲染）
    //   为什么不用 'conversation.chat.assistant-actions'（:3791 声明、:3683 渲染）：
    //   那条只有在「该轮 closing 节点是 assistant/message」时才渲染，一轮结束在工具节点上
    //   （被中断 / 纯工具收尾）时整排控件会跟着消失。
    //   （本 checkout 的 SlotMap 里没有 'conversation.chat.user-actions'。）
    // 组件拿到的标准 props：sessionId / useSession（本插件只用注入的 hook + turn）
    //   docs/subsystems/slots.md:85-91
    // 私有可观察源放进 inject 返回值的 hooks 舱，渲染器把它变成
    //   useAnswerVersions(selector)  prop
    //   packages/client/ui-slots/src/renderer.ts:42；ui-renderer/.../bind.ts:21
    // ── 0.1.6-alpha.2（当前线上：F:\dsh-016\node_modules\@deepseek-ai）─────────
    // 导航：ctx.uiWorkspace.openSession(id)     dsh-client-ui-workspace/lib/client.js:72
    //   官方 ui-chat 的 forkAt 同款：dsh-client-ui-chat/lib/client.js:8376-8384
    //   ⚠️ ctx.sessions.open(id) 在 0.1.6 里**不存在**（ISessions 只留对象层与
    //      retain/using；注释原话「navigation belongs to view owners」）
    // 会话引用：ctx.sessions.using(id, { source }, fn) / retain / binding
    //   dsh-api-session-controller/lib/types/client/contract/sessions.d.ts:52, :60, :158
    //   binding(id) 只借用「已经被 retain 的」绑定 → 自己发 prompt 要用 using
    // fork：ctx.sessions.fork({ sessionId, atSeq, increaseTitle })  同上 :129-133
    //   切点/边界语义：dsh-api-session-controller/lib/index.js:684
    // ctx.sessions.list.getSnapshot()（byId[].parentId）—— 列表才是「存在性」的真值
    // session.prompt(content, 'queue'|'steer') → RemoteResult<{accepted:true}>
    //   .../contract/session.d.ts:82-87
    // ctx.workspaces.archiveSession(sessionId)
    //   dsh-api-workspace-controller/lib/types/client/service.js:48（服务名 "workspaces" :315）
    //
    // ── 0.1.2 源码版（本插件最初是对着它写的，file:line 取证保留）───────────────
    // ctx.sessions.binding(sessionId).eventSource  → 裸事件窗口源
    //   packages/api/session-controller/src/client/sessions/service.ts:133, :559
    //   初始窗口只有 PAGE_MESSAGES=50 条消息（client/sessions/session.ts:44）
    // ctx.sessions.fork({ sessionId, atSeq, increaseTitle })
    //   packages/api/session-controller/src/client/contract/sessions.ts:97
    // ctx.sessions.open(id)          contract/sessions.ts:44   ← 0.1.6 已删除
    // session.prompt(content, mode)  contract/session.ts:82-87；实现 session.ts:212
    // ctx.workspaces.archiveSession(sessionId)
    //   packages/api/workspace-controller/src/client/service.ts:64, :114-117
    //   （0.1.6 另有 dsh-client-ui-settings-unarchive-sessions 的「取消归档」，插件不依赖它）
    // 事件词表：'turn/start' / 'turn/end' / 'user/message' / 'assistant/message'
    //   packages/core/session/src/types.ts:228, :237, :249, :262

    return {
      name: NAME,
      inject: ['slots', 'sessions', 'workspaces'],
      apply: apply
    }
  }
})
