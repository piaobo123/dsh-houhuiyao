/**
 * 决定性检查：客户端初始历史窗口只有 PAGE_MESSAGES=50 条「消息」
 * （session.ts:44）。算出「上一轮 turn/end 是否落在尾部窗口内」。
 * 只读。
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const BASE = 'C:/Users/22297/.dsh/sessions/--F-deepseek~0020harness--/'
const FILES = {
  SOURCE: BASE + 'session-05daa0f6-929c-4886-8ceb-983b3aa769ed/session.jsonl.zstd',
  CHILD: BASE + 'session-fc27e8d0-c45f-46b4-b2cc-9977a8eeb73e/session.jsonl.zstd',
}

function allEvents(path) {
  const buf = readFileSync(path)
  const offsets = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) offsets.push(i)
  }
  const text = offsets
    .map((offset) => { try { return zstdDecompressSync(buf.subarray(offset)).toString('utf8') } catch { return '' } })
    .join('\n')
  const events = []
  let bad = 0
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try {
      const r = JSON.parse(t)
      if (r && typeof r.seq === 'number' && typeof r.type === 'string') events.push(r)
    } catch { bad += 1 }
  }
  events.sort((a, b) => a.seq - b.seq)
  return { events, bad }
}

const SURFACE = new Set(['user/message', 'assistant/message', 'tool/result'])

for (const [label, path] of Object.entries(FILES)) {
  const { events, bad } = allEvents(path)
  console.log('=== ' + label + ' === events', events.length, 'badLines', bad, 'seq', events[0]?.seq, '..', events.at(-1)?.seq)

  // analyzeWindow 在「完整日志」上的结果（上次已确认两边一致 → 115011）
  const surface = events.filter(e => SURFACE.has(e.type))
  const anchor = 115011
  const after = surface.filter(e => e.seq > anchor)
  console.log('  surface messages total:', surface.length)
  console.log('  surface messages with seq > anchor(' + anchor + '):', after.length)
  console.log('  → 尾部 50 条消息的起点 seq =', surface.length > 50 ? surface[surface.length - 50].seq : surface[0]?.seq)
  const windowStart = surface.length > 50 ? surface[surface.length - 50].seq : surface[0]?.seq
  console.log('  anchor 是否落在尾部 50 消息窗口内:', windowStart <= anchor, '(windowStart=' + windowStart + ')')

  // turn/start, turn/end 与 surface 消息在 anchor 之后的数量
  const tail = events.filter(e => e.seq > 115011)
  const tailSurface = tail.filter(e => SURFACE.has(e.type))
  console.log('  事件数 > anchor:', tail.length, ' 其中 surface 消息:', tailSurface.length)
  console.log('  最后 12 个 surface 消息:', surface.slice(-12).map(e => e.type + '@' + e.seq).join(' '))
  console.log('  最后 10 个 turn 边界:', events.filter(e => e.type === 'turn/start' || e.type === 'turn/end').slice(-10).map(e => e.type + '@' + e.seq).join(' '))
}
