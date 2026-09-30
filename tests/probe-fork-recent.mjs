/**
 * 取证：最近被改动的会话里，哪些是 answer-versions 的 fork 子会话？
 * 打印 header / meta / 事件计数 / 最后几条事件。只读。
 *
 * 用法：node tests/probe-fork-recent.mjs [工作目录片段] [最近 N 个]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'

const BASE = 'C:/Users/22297/.dsh/sessions/--F-deepseek~0020harness--'
const WANT = process.argv[2] || 'harness'
const TOP = Number(process.argv[3] || 10)

function allEvents(path) {
  const buf = readFileSync(path)
  const offsets = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) offsets.push(i)
  }
  let text = ''
  for (const offset of offsets) {
    try { text += zstdDecompressSync(buf.subarray(offset)).toString('utf8') + '\n' } catch { /* 尾部残帧 */ }
  }
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
  return { events, bad, frames: offsets.length }
}

const dirs = readdirSync(BASE)
  .map((name) => ({ name, path: join(BASE, name) }))
  .filter((d) => { try { return statSync(d.path).isDirectory() } catch { return false } })
  .map((d) => {
    const file = join(d.path, 'session.v3.jsonl.zstd')
    let mtime = 0
    try { mtime = statSync(file).mtimeMs } catch { /* 无新格式文件 */ }
    return { ...d, file, mtime }
  })
  .filter((d) => d.mtime > 0)
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, TOP)

for (const d of dirs) {
  const { events, bad, frames } = allEvents(d.file)
  const header = events.find((e) => e.type === 'session/header') || events[0]
  const meta = {}
  for (const key of ['parentSession', 'parentSessionId', 'cwd', 'seedLength', 'agentPreset', 'title']) {
    const value = header?.data?.[key]
    if (value !== undefined) meta[key] = value
  }
  const users = events.filter((e) => e.type === 'user/message' && e.data?.source?.kind === 'user')
  const assistants = events.filter((e) => e.type === 'assistant/message')
  console.log('=== ' + d.name + ' ===')
  console.log('  mtime', new Date(d.mtime).toISOString(), 'frames', frames, 'events', events.length, 'bad', bad, 'seq', events[0]?.seq, '..', events.at(-1)?.seq)
  console.log('  header type', header?.type, JSON.stringify(meta))
  console.log('  用户提问', users.length, '回答', assistants.length)
  if (users.length > 0) console.log('  最后一条提问:', JSON.stringify(users.at(-1).data?.content ?? users.at(-1).data).slice(0, 160))
  const tail = events.slice(-8).map((e) => e.type + '@' + e.seq)
  console.log('  尾部事件:', tail.join(' '))
}
