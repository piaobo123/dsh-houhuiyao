/**
 * 取证：dump 真实会话日志里「一轮」的完整事件序列，确认 seed 该切在哪、
 * 需要补哪些 closer。只读。
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const BASE = 'C:/Users/22297/.dsh/sessions/--F-deepseek~0020harness--/'
const SRC = BASE + 'session-05daa0f6-929c-4886-8ceb-983b3aa769ed/session.jsonl.zstd'
const CHILD = BASE + 'session-fc27e8d0-c45f-46b4-b2cc-9977a8eeb73e/session.jsonl.zstd'

function allEvents(path) {
  const buf = readFileSync(path)
  const offsets = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) offsets.push(i)
  }
  const text = offsets.map((o) => { try { return zstdDecompressSync(buf.subarray(o)).toString('utf8') } catch { return '' } }).join('\n')
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try { const r = JSON.parse(t); if (r && typeof r.seq === 'number') out.push(r) } catch { /* skip */ }
  }
  out.sort((a, b) => a.seq - b.seq)
  return out
}

for (const [label, path] of [['SOURCE', SRC], ['CHILD', CHILD]]) {
  const events = allEvents(path)
  // 找到最后一个 user/message 所属的 turn，dump 它前面 turn/start 到 turn/end 的全部事件
  const lastUser = [...events].reverse().find(e => e.type === 'user/message' && e.data?.source?.kind === 'user')
  console.log('=== ' + label + ' 最后一个人类提问 user/message@' + lastUser.seq + ' ===')
  let startIdx = events.findIndex(e => e.seq === lastUser.seq)
  while (startIdx > 0 && events[startIdx].type !== 'turn/start') startIdx--
  let endIdx = events.findIndex(e => e.seq === lastUser.seq)
  while (endIdx < events.length && events[endIdx].type !== 'turn/end') endIdx++
  for (let i = startIdx; i <= Math.min(endIdx, startIdx + 12); i++) {
    const e = events[i]
    const extra = e.type === 'user/message'
      ? ' source=' + JSON.stringify(e.data.source) + ' contentTypes=' + JSON.stringify((e.data.content || []).map(c => c.type))
      : e.type === 'turn/end' ? ' reason=' + JSON.stringify(e.data.reason)
        : e.type === 'turn/start' || e.type === 'step/start' || e.type === 'step/end' ? ' ' + JSON.stringify(e.data)
          : ''
    console.log('   ' + String(e.seq).padStart(7) + '  ' + e.type + extra)
  }
  if (endIdx > startIdx + 12) console.log('   ... (' + (endIdx - startIdx - 12) + ' more) ... ' + events[endIdx].type + '@' + events[endIdx].seq + ' reason=' + JSON.stringify(events[endIdx].data.reason))
  console.log()
}

// 全事件类型频次，帮助判断一轮里都有什么
const all = allEvents(SRC)
const counts = new Map()
for (const e of all) counts.set(e.type, (counts.get(e.type) || 0) + 1)
console.log('SOURCE 事件类型分布:', [...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => k + '×' + v).join('  '))

// turn/end reason 分布
const reasons = new Map()
for (const e of all) if (e.type === 'turn/end') { const k = JSON.stringify(e.data.reason); reasons.set(k, (reasons.get(k) || 0) + 1) }
console.log('turn/end reason 分布:', [...reasons].map(([k, v]) => k + '×' + v).join('  '))
