/**
 * 用真实会话日志复现插件的 analyzeWindow / rootOf 家族 key 计算。
 * 只读，不改任何东西。逐 zstd 帧解码（每个 append 一帧）。
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const BASE = 'C:/Users/22297/.dsh/sessions/--F-deepseek~0020harness--/'
const SOURCE = BASE + 'session-05daa0f6-929c-4886-8ceb-983b3aa769ed/session.jsonl.zstd'
const CHILD = BASE + 'session-fc27e8d0-c45f-46b4-b2cc-9977a8eeb73e/session.jsonl.zstd'

/** 每帧独立解码；假 magic 直接跳过。 */
function decodeFrames(path) {
  const buf = readFileSync(path)
  const offsets = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) offsets.push(i)
  }
  const parts = []
  for (const offset of offsets) {
    try { parts.push(zstdDecompressSync(buf.subarray(offset))) } catch { /* 假 magic */ }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: offsets.length, decoded: parts.length }
}

function parseEvents(text) {
  const records = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try { records.push(JSON.parse(t)) } catch { /* 截断行 */ }
  }
  const header = records.find(r => r.type === 'session')
  const events = records.filter(r => typeof r.seq === 'number' && typeof r.type === 'string' && r.type !== 'session')
  return { header, events }
}

function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 插件里的 analyzeWindow 逐字复制。 */
function analyzeWindow(entries) {
  const turns = []
  let open = null
  for (const entry of entries) {
    const event = entry
    if (event === null || typeof event !== 'object' || event.data === null || typeof event.data !== 'object') continue
    const data = event.data
    if (event.type === 'turn/start') { open = { endSeq: undefined, question: null, answers: [] }; turns.push(open); continue }
    if (open === null) continue
    if (event.type === 'user/message') {
      if (open.question === null && data.source && typeof data.source === 'object' && data.source.kind === 'user') {
        const text = textOfContent(data.content)
        if (text !== '') open.question = text
      }
      continue
    }
    if (event.type === 'assistant/message') {
      if (data.message && typeof data.message === 'object' && typeof data.message.id === 'string') open.answers.push(data.message.id)
      continue
    }
    if (event.type === 'turn/end') { open.endSeq = event.seq; open = null }
  }
  if (turns.length === 0) return null
  const lastIndex = turns.length - 1
  const last = turns[lastIndex]
  if (last.answers.length === 0) return null
  if (typeof last.endSeq !== 'number') return null
  if (last.question === null) return null
  if (lastIndex === 0) return null
  const previous = turns[lastIndex - 1]
  if (typeof previous.endSeq !== 'number') return null
  return {
    messageIds: last.answers,
    question: last.question.slice(0, 60),
    anchorSeq: previous.endSeq,
    turnCount: turns.length,
    lastTurnStart: last.startSeq,
    lastTurnEnd: last.endSeq,
  }
}

const result = {}
for (const [label, path] of [['SOURCE', SOURCE], ['CHILD', CHILD]]) {
  const { text, frames, decoded } = decodeFrames(path)
  const { header, events } = parseEvents(text)
  console.log('=== ' + label + ' ===')
  console.log('  frames', frames, 'decoded', decoded, 'events', events.length)
  console.log('  header', JSON.stringify(header))
  console.log('  seq range', events[0]?.seq, '..', events[events.length - 1]?.seq)
  const boundary = events.filter(e => e.type === 'turn/start' || e.type === 'turn/end')
  console.log('  turn events tail:', boundary.slice(-6).map(e => e.type + '@' + e.seq).join(' '))
  const a = analyzeWindow(events)
  console.log('  analyzeWindow ->', JSON.stringify(a))
  result[label] = { header, events, analysis: a }
}

console.log('\n=== 家族 key 对比 ===')
const srcKey = result.SOURCE.header.id + '#' + (result.SOURCE.analysis ? result.SOURCE.analysis.anchorSeq : 'n/a')
const childRoot = result.CHILD.header.parentSession
const childKey = childRoot + '#' + (result.CHILD.analysis ? result.CHILD.analysis.anchorSeq : 'n/a')
console.log('  SOURCE key (root=S, rootOf(S)=S):', srcKey)
console.log('  CHILD  key (root=parentSession):', childKey)
console.log('  MATCH:', srcKey === childKey)
console.log('  CHILD seedLength:', result.CHILD.header.seedLength)
console.log('  CHILD first live event seq:', result.CHILD.events[0]?.seq)

// 逐帧打印 child 最后 40 个事件
const tail = result.CHILD.events.slice(-40)
console.log('\nCHILD 最后 40 个事件:')
for (const e of tail) console.log('   ', e.seq, e.type, JSON.stringify(e.data).slice(0, 90))
