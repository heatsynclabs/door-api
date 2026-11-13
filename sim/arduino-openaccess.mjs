#!/usr/bin/env node
// A faithful simulator of the legacy Open Access Arduino door controller
// (zyphlar/Open_Access_Control_Ethernet). It reproduces the board's HTTP query
// protocol, EEPROM slot model, privileged-mode login with auto-logout, the status
// JSON, and the circular event log (G/g split on % 32767) closely enough that the
// door-api openaccess adapter and the members app's legacy path cannot tell it
// from the real board. Plus a few clearly-namespaced /sim/* control endpoints so
// tests can present cards and read internal state.
//
// Verified against the firmware: card = raw 26-bit Wiegand tag stored as hex;
// mask 1 -> grant, 255 -> locked out; `?9` needs no login; `?cmd&e=PW` logs in,
// runs, and auto-logs-out; `?z` dumps the whole buffer with no cursor; a swipe
// logs R(read) then G or D, each split into low (% 32767) and high (/ 32767).
//
// Usage: node sim/arduino-openaccess.mjs   (PORT, PASSWORD, NUM_USERS, LOG_SIZE, DEBUG)
import http from 'node:http'

const PORT = Number(process.env.PORT ?? 9099)
const PASSWORD = Number.parseInt(process.env.PASSWORD ?? '1234', 16) // priv password, hex
const NUM_USERS = Number(process.env.NUM_USERS ?? 200) // slots 0..NUM_USERS-1
const LOG_SIZE = Number(process.env.LOG_SIZE ?? 100)
const DEBUG = Number(process.env.DEBUG ?? 2)
const EMPTY = 0xffffffff
const DIVISOR = 32767
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000
const CRLF = '\r\n'

// ---- board state ----
const users = Array.from({ length: NUM_USERS }, () => ({ tag: EMPTY, mask: 0xff }))
const doors = { 1: { locked: true }, 2: { locked: true } }
const alarm = { armed: 255, activated: 255 }
let logKeys = new Array(LOG_SIZE).fill(0)
let logData = new Array(LOG_SIZE).fill(0)
let logCursor = 0
let privmode = false
let consoleFail = 0
let lockoutUntil = 0

function addToLog(type, data) {
  logKeys[logCursor] = type
  logData[logCursor] = data
  logCursor = (logCursor + 1) % LOG_SIZE
}

function checkUser(tag) {
  // returns mask if a non-empty slot holds this tag, else -1
  for (const u of users) {
    if (u.tag === tag && tag !== EMPTY && tag !== 0) return u.mask
  }
  return -1
}

function addUser(slot, mask, tag) {
  if (slot < 0 || slot > NUM_USERS) return
  users[slot] = { tag, mask }
}

function deleteUser(slot) {
  if (slot < 0 || slot > NUM_USERS) return
  users[slot] = { tag: EMPTY, mask: 0xff }
}

// Arduino println(x, HEX): uppercase, no leading zeros, no 0x.
function hex(n) {
  return (n >>> 0).toString(16).toUpperCase()
}

function dumpUser(slot) {
  const u = users[slot]
  if (slot < 0 || slot > 199) return 'Bad user number!' + CRLF
  let out = `${slot}\t${u.mask}\t`
  out += DEBUG === 2 ? hex(u.tag) + CRLF : (u.tag !== EMPTY ? '********' + CRLF : CRLF)
  return out
}

function status() {
  // Matches printStatus() field-for-field (JSON ignores the newlines).
  return (
    '{' + CRLF +
    `"armed":${alarm.armed},"activated":${alarm.activated}` + CRLF +
    `,"alarm_3":1` + CRLF +
    `,"alarm_2":1` + CRLF +
    `,"door_1_locked":${doors[1].locked ? 1 : 0}` + CRLF +
    `,"door_2_locked":${doors[2].locked ? 1 : 0}` + CRLF +
    '}' + CRLF
  )
}

function printLog() {
  let out = '<pre>' + CRLF
  for (let i = 0; i < LOG_SIZE; i += 1) {
    const key = logKeys[i] === 0 ? '\x00' : logKeys[i]
    out += `${key}: ${logData[i]}` + CRLF
  }
  out += '</pre>' + CRLF
  return out
}

// A card presented to a reader: log R(ead), then G(ranted) or D(enied), each
// split low/high on DIVISOR, exactly like the firmware.
function swipe(tag, doorNum = 1) {
  addToLog('R', tag % DIVISOR)
  addToLog('r', Math.floor(tag / DIVISOR))
  const mask = checkUser(tag)
  const granted = mask >= 0 && mask !== 255
  if (granted) {
    addToLog('G', tag % DIVISOR)
    addToLog('g', Math.floor(tag / DIVISOR))
    doors[doorNum].locked = false // firmware unlocks on grant
  } else {
    addToLog('D', tag % DIVISOR)
    addToLog('d', Math.floor(tag / DIVISOR))
  }
  return { granted, mask }
}

// ---- the firmware HTTP handler ----
function handleQuery(query) {
  // query is everything after "?" (may be empty)
  const q = '?' + query
  let body = ''

  // login: ?e= or &e=
  const eIdx = q.indexOf('e=')
  const hasLogin = q.indexOf('?e=') >= 0 || q.indexOf('&e=') >= 0
  const ampLogin = q.indexOf('&e=') >= 0
  if (hasLogin) {
    const pass = q.slice(eIdx + 2, eIdx + 6) // 4 chars
    const now = Date.now()
    if (consoleFail >= 5 && now - lockoutUntil < 0) {
      return 'authfail' + CRLF // locked out
    }
    if (Number.parseInt(pass, 16) === PASSWORD) {
      consoleFail = 0
      privmode = true
      body += 'authok' + CRLF
    } else {
      consoleFail += 1
      if (consoleFail >= 5) lockoutUntil = now + LOGIN_LOCKOUT_MS
      return 'authfail' + CRLF // break: no command processing
    }
  }

  const cmd = q[q.indexOf('?') + 1]

  if (privmode) {
    switch (cmd) {
      case 's': {
        const slot = Number.parseInt(q.slice(q.indexOf('?s') + 2, q.indexOf('?s') + 5), 10)
        body += '<pre>' + 'UserNum: Usermask: TagNum:' + CRLF + dumpUser(slot) + '</pre>' + CRLF
        break
      }
      case 'm': {
        const m = q.match(/\?m(\d{3})&p(\d{3})&t([0-9A-Fa-f]{8})/)
        if (m) {
          const slot = Number.parseInt(m[1], 10)
          body += '<pre>' + 'prev:' + CRLF + dumpUser(slot)
          addUser(slot, Number.parseInt(m[2], 10), Number.parseInt(m[3], 16))
          body += 'cur:' + CRLF + dumpUser(slot) + '</pre>' + CRLF
        } else {
          body += 'err:query' + CRLF
        }
        break
      }
      case 'a': {
        body += '<pre>' + 'UserNum: Usermask: TagNum:' + CRLF
        for (let i = 0; i < NUM_USERS; i += 1) body += dumpUser(i)
        body += '</pre>' + CRLF
        break
      }
      case 'r': {
        const slot = Number.parseInt(q.slice(q.indexOf('?r') + 2, q.indexOf('?r') + 5), 10)
        body += 'r' + CRLF + '<pre>' + 'prev:' + CRLF + dumpUser(slot)
        deleteUser(slot)
        body += 'cur:' + CRLF + dumpUser(slot)
        break
      }
      case 'o': {
        const d = q[q.indexOf('?o') + 2] === '2' ? 2 : 1
        addToLog('U', d)
        doors[d].locked = false
        break
      }
      case 'u': {
        const eq = q.indexOf('?u=')
        if (eq >= 0) {
          const d = q[eq + 3] === '2' ? 2 : 1
          doors[d].locked = false
          addToLog('U', d)
        } else {
          doors[1].locked = false
          doors[2].locked = false
          addToLog('U', 3)
        }
        break
      }
      case 'l': {
        const eq = q.indexOf('?l=')
        if (eq >= 0) {
          const d = q[eq + 3] === '2' ? 2 : 1
          doors[d].locked = true
          addToLog('L', d)
        } else {
          doors[1].locked = true
          doors[2].locked = true
          addToLog('L', 3)
        }
        break
      }
      case '1':
        alarm.armed = 255
        break
      case '2':
        alarm.armed = 1
        break
      case 'z':
        body += printLog()
        break
      case 'y':
        logKeys = new Array(LOG_SIZE).fill(0)
        logData = new Array(LOG_SIZE).fill(0)
        logCursor = 0
        body += 'y' + CRLF
        break
      case '9':
        body += status()
        break
      default:
        break // e.g. '?e=' login with no command
    }
  } else if (q.indexOf('?9') >= 0) {
    body += status()
  } else {
    body += "<a href='/'>Not logged in.</a>"
  }

  // auto-logout only on the ampersand form (?cmd&e=PW)
  if (ampLogin) privmode = false

  return body
}

// ---- server ----
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://sim')

  // simulator-only control endpoints (not part of the firmware)
  if (url.pathname === '/sim/swipe') {
    const tag = Number.parseInt(url.searchParams.get('card') ?? '0', 16)
    const door = Number(url.searchParams.get('door') ?? 1)
    const result = swipe(tag, door)
    return json(res, { swiped: hex(tag), ...result })
  }
  if (url.pathname === '/sim/state') {
    return json(res, {
      cards: users
        .map((u, slot) => ({ slot, tag: hex(u.tag), mask: u.mask }))
        .filter((u) => u.tag !== 'FFFFFFFF' && u.tag !== '0'),
      doors,
      privmode,
      log: logKeys
        .map((k, i) => ({ key: k === 0 ? null : k, data: logData[i] }))
        .filter((e) => e.key !== null)
    })
  }
  if (url.pathname === '/sim/reset') {
    users.forEach((_, i) => deleteUser(i))
    doors[1].locked = true
    doors[2].locked = true
    logKeys = new Array(LOG_SIZE).fill(0)
    logData = new Array(LOG_SIZE).fill(0)
    logCursor = 0
    privmode = false
    consoleFail = 0
    return json(res, { reset: true })
  }

  // everything else is the firmware: GET /?<query>
  const query = (req.url.split('?')[1] ?? '')
  const body = handleQuery(query)
  res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html' })
  res.end(body)
})

function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

server.listen(PORT, () => {
  console.log(`arduino-openaccess simulator on http://127.0.0.1:${PORT} (password 0x${PASSWORD.toString(16)}, ${NUM_USERS} slots)`)
})
