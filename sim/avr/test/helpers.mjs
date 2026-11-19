// Helpers for the AVR door-board emulator tests.
//
// By default a container is started from DOOR_SIM_IMAGE (door-sim-avr) on
// random localhost ports. To use an instance that is already running, set
// BOARD_URL (e.g. http://127.0.0.1:8080) and CONTROL_URL (http://127.0.0.1:9199).
// PASSWORD is the console password as typed after ?e= (default 1234).
import { execFileSync } from 'node:child_process'
import net from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'

export const PASSWORD = (process.env.PASSWORD ?? '1234').replace(/^0x/i, '').padStart(4, '0')
export const IMAGE = process.env.DOOR_SIM_IMAGE ?? 'door-sim-avr'
export { sleep }

let board = null // { host, port }
let control = null // base URL
let container = null

export function boardAddress() {
  return board
}

export function containerName() {
  return container
}

export async function startSim() {
  if (process.env.BOARD_URL && process.env.CONTROL_URL) {
    const u = new URL(process.env.BOARD_URL)
    board = { host: u.hostname, port: Number(u.port || 80) }
    control = process.env.CONTROL_URL.replace(/\/$/, '')
  } else {
    container = `door-sim-test-${process.pid}`
    execFileSync('docker', ['run', '-d', '--rm', '--name', container,
      '-p', '127.0.0.1::80', '-p', '127.0.0.1::9199', IMAGE], { stdio: 'pipe' })
    const port = (p) => Number(execFileSync('docker', ['port', container, p]).toString().trim().split('\n')[0].split(':').pop())
    board = { host: '127.0.0.1', port: port('80/tcp') }
    control = `http://127.0.0.1:${port('9199/tcp')}`
  }
  for (let i = 0; i < 100; i++) {
    try {
      await health()
      break
    } catch {
      await sleep(100)
    }
  }
  await waitReady()
}

export async function stopSim() {
  if (container) {
    try { execFileSync('docker', ['rm', '-f', container], { stdio: 'pipe' }) } catch { /* already gone */ }
    container = null
  }
}

// ---- the board's own HTTP port -------------------------------------------

// One request over a raw socket, so we see the exact bytes and who closed.
// Returns { raw, head, body, ms, serverClosed, error }.
export function get(path, { headers = 'Host: board\r\nUser-Agent: door-sim-test\r\nAccept: */*\r\n', timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const chunks = []
    let serverClosed = false
    let error = null
    const s = net.connect(board, () => s.write(`GET /${path} HTTP/1.1\r\n${headers}\r\n`))
    s.setTimeout(timeout, () => { error = 'timeout'; s.destroy() })
    s.on('data', (d) => chunks.push(d))
    s.on('end', () => { serverClosed = true; s.end() })
    s.on('error', (e) => { error = e.code ?? e.message })
    s.on('close', () => {
      const raw = Buffer.concat(chunks)
      const text = raw.toString('latin1')
      const split = text.indexOf('\r\n\r\n')
      resolve({
        raw,
        head: split >= 0 ? text.slice(0, split + 4) : text,
        body: split >= 0 ? text.slice(split + 4) : '',
        ms: performance.now() - t0,
        serverClosed,
        error
      })
    })
  })
}

// Privileged command with the door-api style login-and-logout suffix.
export const authed = (cmd) => get(`?${cmd}&e=${PASSWORD}`)

export const HEADER = 'HTTP/1.1 200 OK\r\nCache-Control: no-store\r\nContent-Type: text/html\r\n\r\n'

// Parse ?z output into [[key, value], ...] in buffer order.
export function parseLog(body) {
  const pre = body.slice(body.indexOf('<pre>\r\n') + 7, body.indexOf('</pre>'))
  return pre.split('\r\n').filter((l) => l.length).map((l) => {
    const i = l.lastIndexOf(': ')
    return [l.slice(0, i), Number(l.slice(i + 2))]
  })
}

// Log entries that are set (key not NUL), as "K:v" strings.
export async function logEntries() {
  const r = await authed('z')
  return parseLog(r.body).filter(([k]) => k !== '\0').map(([k, v]) => `${k}:${v}`)
}

export async function clearLog() {
  const r = await authed('y')
  if (!r.body.endsWith('y\r\n')) throw new Error(`?y failed: ${JSON.stringify(r.body)}`)
}

// ---- control API ------------------------------------------------------------

export async function ctl(method, path, body) {
  const res = await fetch(control + path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000)
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export const health = () => ctl('GET', '/health')
export const pins = (since = 0) => ctl('GET', `/pins?since=${since}`)
export const simNow = async () => (await health()).simMs
export const swipe = (tag, reader = 1, extra = {}) => ctl('POST', '/swipe', { reader, tag, ...extra })
export const setSpeed = (speed) => ctl('POST', '/speed', { speed })

export async function eeprom() {
  const r = await ctl('GET', '/eeprom?format=json')
  return Buffer.from(r.hex, 'hex')
}

// Board answers ?9 again (boot takes ~0.6 s: W5100 init delay + boot chirp).
export async function waitReady() {
  for (let i = 0; i < 200; i++) {
    const r = await get('?9', { timeout: 2000 })
    if (r.body.includes('door_1_locked')) return
    await sleep(50)
  }
  throw new Error('board did not come up')
}

// Power-cycle. eeprom: 'keep' or 'default'. uptimeMs: wait until the
// firmware's millis() passes this (swipes in the first 5 s after boot hit the
// keypad-window quirk, see README).
export async function resetBoard({ eeprom: mode = 'default', uptimeMs = 0 } = {}) {
  await ctl('POST', '/reset', { eeprom: mode })
  await waitReady()
  const now = await simNow()
  if (now < uptimeMs) await sleep((uptimeMs - now) / ((await health()).speed || 1) + 50)
}

// Edges on one Arduino pin since a simulated time: [[t, value], ...]
export async function edges(pin, since) {
  return (await pins(since)).timeline.filter((e) => e.pin === pin).map((e) => [e.t, e.value])
}

// Wait (simulated time) until `ms` have passed since `since`.
export async function waitSim(since, ms) {
  for (;;) {
    const now = await simNow()
    if (now >= since + ms) return
    const speed = (await health()).speed || 8
    await sleep(Math.max(10, (since + ms - now) / speed))
  }
}

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

// The firmware logs card numbers split as value % 32767 and value / 32767.
export const split = (tag) => [tag % 32767, Math.floor(tag / 32767)]
