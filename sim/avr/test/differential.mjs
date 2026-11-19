// Sends the same request sequence to the AVR emulator (the real firmware) and to
// the JavaScript simulator (sim/arduino-openaccess.mjs) and prints every
// difference as Markdown. Does not modify either simulator.
//   node sim/avr/test/differential.mjs > /tmp/diff.md
// Starts the JS simulator itself (PORT 9098, PASSWORD 1234, DOORDELAY 5000)
// and the AVR container (or uses BOARD_URL/CONTROL_URL).
import { spawn } from 'node:child_process'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { PASSWORD, boardAddress, ctl, pins, resetBoard, simNow, startSim, stopSim } from './helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const JS_PORT = Number(process.env.JS_SIM_PORT ?? 9098)
const pw = PASSWORD
const REQ = (path) => `GET /${path} HTTP/1.1\r\nHost: board\r\nUser-Agent: door-api/0.1\r\nConnection: close\r\n\r\n`

function raw(target, path) {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const chunks = []
    let how = 'server closed'
    const s = net.connect(target, () => s.write(REQ(path)))
    s.setTimeout(20000, () => { how = 'timeout'; s.destroy() })
    s.on('data', (d) => chunks.push(d))
    s.on('error', (e) => { how = e.code })
    s.on('close', () => resolve({ text: Buffer.concat(chunks).toString('latin1'), ms: performance.now() - t0, how }))
  })
}

// Header block and body; a chunked body is decoded so bodies compare by content.
const splitHead = (t) => {
  const i = t.indexOf('\r\n\r\n')
  if (i < 0) return [t, '']
  const head = t.slice(0, i)
  let body = t.slice(i + 4)
  if (/transfer-encoding: chunked/i.test(head)) {
    let out = ''
    for (;;) {
      const nl = body.indexOf('\r\n')
      const n = parseInt(body.slice(0, nl), 16)
      if (!n) break
      out += body.slice(nl + 2, nl + 2 + n)
      body = body.slice(nl + 2 + n + 2)
    }
    body = out
  }
  return [head.replace(/\r\nDate: [^\r]*/, ''), body]
}
const headers = new Set()
const show = (s) => '`' + JSON.stringify(s).slice(1, -1).replace(/`/g, '\\`') + '`'
const clip = (s, n = 600) => (s.length > n ? s.slice(0, n) + `... (${s.length} bytes)` : s)

const out = []
let diffs = 0
function report(step, avr, js, note = '') {
  const [ah, ab] = splitHead(avr.text)
  const [jh, jb] = splitHead(js.text)
  headers.add(`AVR ${show(ah)}`)
  headers.add(`JS ${show(jh)}`)
  if (ab === jb) {
    out.push(`- **${step}**: same body (${ab.length} bytes)${note ? `; ${note}` : ''}`)
    return
  }
  diffs++
  out.push(`- **${step}**${note ? ` (${note})` : ''}`)
  out.push(`  - AVR: ${show(clip(ab))}`)
  out.push(`  - JS:  ${show(clip(jb))}`)
  if (avr.how !== js.how) out.push(`  - close: AVR ${avr.how}, JS ${js.how}`)
}

async function both(step, path, note) {
  const avr = await raw(boardAddress(), path)
  const js = await raw({ host: '127.0.0.1', port: JS_PORT }, path)
  report(step, avr, js, note)
  return { avr, js }
}

// ---- start both -------------------------------------------------------------
const jsSim = spawn(process.execPath, [join(here, '..', '..', 'arduino-openaccess.mjs')], {
  env: { ...process.env, PORT: String(JS_PORT), PASSWORD: pw, DOORDELAY: '5000' },
  stdio: ['ignore', 'pipe', 'inherit']
})
await new Promise((resolve) => jsSim.stdout.once('data', resolve))
await startSim()
await resetBoard({ uptimeMs: 5200 })

try {
  out.push('### Replies, request by request', '')
  await both('GET / (no query)', '')
  await both('?9 (not logged in)', '?9')
  await both('?u (not logged in)', '?u')
  await both('?z&e=PW after the refused ?u', `?z&e=${pw}`, 'event log')
  await both('?e=PW', `?e=${pw}`)
  await both('?z (session from ?e=PW)', '?z')
  await both('?e=0000 (logout)', '?e=0000')
  await both('?z after ?e=0000', '?z')
  await both('?9&e=WRONG', '?9&e=0BAD')
  await both('?m010&p001&t0012ABCD&e=PW', `?m010&p001&t0012ABCD&e=${pw}`)
  await both('?s010&e=PW', `?s010&e=${pw}`)
  await both('?a&e=PW', `?a&e=${pw}`)
  await both('?m200&p001&t12345678&e=PW (slot 200)', `?m200&p001&t12345678&e=${pw}`)
  await both('?9 after slot 200', '?9')
  await both('?r010&e=PW', `?r010&e=${pw}`)
  await both('?m10&p001&t0012ABCD&e=PW (misaligned)', `?m10&p001&t0012ABCD&e=${pw}`)
  await both('?y&e=PW', `?y&e=${pw}`)

  // doors: reply, status, relay timing, log
  let t0 = await simNow()
  await both('?o1&e=PW', `?o1&e=${pw}`)
  await both('?9 right after ?o1', '?9')
  const jsState = async () => (await (await fetch(`http://127.0.0.1:${JS_PORT}/sim/state`)).json()).doors
  const jsOpenNow = (await jsState())[1].open
  await sleep(6000)
  const d6 = (await pins(t0)).timeline.filter((e) => e.pin === 6)
  out.push(`- **?o1 relay**: AVR D6 ${d6.map((e) => `${e.value ? 'high' : 'low'} at +${Math.round(e.t - t0)} ms`).join(', ')}` +
    ` (held ${Math.round(d6[1].t - d6[0].t)} ms); JS door 1 open=${jsOpenNow} then open=${(await jsState())[1].open} after 6 s`)
  await both('?z&e=PW after ?o1 + 6 s', `?z&e=${pw}`)
  await both('?y&e=PW', `?y&e=${pw}`)
  for (const q of ['u=1', 'l', 'l=1', 'u', 'l=2', 'o3', 'u=3', 'l=3']) await both(`?${q}&e=PW`, `?${q}&e=${pw}`)
  await both('?z&e=PW after the door commands', `?z&e=${pw}`)
  for (const q of ['2', '1', '3', '9']) await both(`?${q}&e=PW`, `?${q}&e=${pw}`)
  await both('?w&e=PW', `?w&e=${pw}`)
  out.push(`- **?w side effect**: AVR DS1307 after ?w = ${JSON.stringify((await ctl('GET', '/rtc')).time)} (the fall-through into ?x sets the clock from the wrong characters)`)
  await both('?x26111840900&e=PW', `?x26111840900&e=${pw}`)
  await both('?v=1&e=PW', `?v=1&e=${pw}`)

  // swipes
  out.push('', '### Card swipes (AVR: Wiegand pulses on D2/D3; JS: GET /sim/swipe)', '')
  await both('setup slot 10 mask 1', `?m010&p001&t0012ABCD&e=${pw}`)
  await both('setup slot 11 mask 255', `?m011&p255&t00ABC001&e=${pw}`)
  await both('setup slot 12 mask 0', `?m012&p000&t00ABC002&e=${pw}`)
  for (const [name, tag] of [['mask 1', 0x12ABCD], ['mask 255', 0xABC001], ['mask 0', 0xABC002], ['unknown', 0x777777]]) {
    await both('?y&e=PW', `?y&e=${pw}`)
    t0 = await simNow()
    await ctl('POST', '/swipe', { reader: 1, tag })
    await fetch(`http://127.0.0.1:${JS_PORT}/sim/swipe?card=${tag.toString(16)}&door=1`)
    await sleep(6500)
    const d6s = (await pins(t0)).timeline.filter((e) => e.pin === 6).map((e) => `${e.value}@+${Math.round(e.t - t0)}`)
    await both(`?z&e=PW after swipe ${name} (${tag.toString(16)})`, `?z&e=${pw}`, `AVR D6 edges: ${d6s.join(' ') || 'none'}`)
  }

  // lockout
  out.push('', '### Console lockout', '')
  await resetBoard({ uptimeMs: 1000 })
  for (let i = 1; i <= 5; i++) await both(`wrong password ${i}`, '?e=0BAD')
  await both('correct password after 5 failures', `?e=${pw}`)

  // framing and concurrency
  out.push('', '### Framing and connections', '')
  const conc = async (target) => {
    const r = await Promise.all(Array.from({ length: 5 }, () => raw(target, '?9')))
    return r.map((x) => (x.text.includes('door_1_locked') ? 'served' : `${x.how}/${x.text.length}B`)).join(', ')
  }
  out.push(`- **5 simultaneous ?9**: AVR (through Docker port forwarding): ${await conc(boardAddress())}; JS: ${await conc({ host: '127.0.0.1', port: JS_PORT })}`)
  const long = 'x'.repeat(100)
  await both('request with the query after 97 characters', `${long}?9`)
  const lat = async (target) => {
    const ms = []
    for (let i = 0; i < 5; i++) ms.push((await raw(target, '?9')).ms)
    return Math.round(ms.sort((a, b) => a - b)[2])
  }
  out.push(`- **?9 latency (median of 5)**: AVR ${await lat(boardAddress())} ms, JS ${await lat({ host: '127.0.0.1', port: JS_PORT })} ms`)
} finally {
  jsSim.kill()
  await stopSim()
}
console.log(`${diffs} request bodies differ. Response headers seen (Date removed):\n`)
for (const h of headers) console.log(`- ${h}`)
console.log('')
console.log(out.join('\n'))
