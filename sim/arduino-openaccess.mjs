#!/usr/bin/env node
// A faithful simulator of the legacy Open Access Arduino door controller
// (zyphlar/Open_Access_Control_Ethernet). It reproduces the board's HTTP query
// protocol, EEPROM slot model, privileged-mode login with auto-logout, the status
// JSON, and the circular event log (G/g split on % 32767) closely enough that the
// door-api openaccess adapter and the members app's legacy path cannot tell it
// from the real board. Plus a few clearly-namespaced /sim/* control endpoints so
// tests can present cards and read internal state.
//
// Replies, login, lockout and log entries follow src/main.cpp of the firmware
// (door-controller-platformio) and were checked against the real binary running
// under simavr (sim/avr, DIFFERENCES.md). It does not model timing: the board
// answers one connection per loop() pass (80 to 160 ms) and blocks for seconds
// while it chirps; use sim/avr for anything where that matters.
//
// Usage: node sim/arduino-openaccess.mjs   (PORT, PASSWORD, NUM_USERS, LOG_SIZE, DEBUG, DOORDELAY)
import http from 'node:http'

const PORT = Number(process.env.PORT ?? 9099)
const PASSWORD = Number.parseInt(process.env.PASSWORD ?? '1234', 16) // priv password, hex
const NUM_USERS = Number(process.env.NUM_USERS ?? 200) // slots 0..NUM_USERS-1
const LOG_SIZE = Number(process.env.LOG_SIZE ?? 40)
const DEBUG = Number(process.env.DEBUG ?? 2)
const EMPTY = 0xffffffff
const DIVISOR = 32767
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000
const DOORDELAY = Number(process.env.DOORDELAY ?? 5000) // firmware DOORDELAY, ms
const CRLF = '\r\n'

// ---- board state ----
const users = Array.from({ length: NUM_USERS }, () => ({ tag: EMPTY, mask: 0xff }))
// locked: what the board reports (door1Locked). open: the relay right now.
const doors = { 1: { locked: true, open: false }, 2: { locked: true, open: false } }
const relockTimers = { 1: null, 2: null }
// A fresh EEPROM holds 0 in the alarm bytes. The lab's board reports 255/255
// (its bytes 0 and 1 were overwritten by a slot-200 write); ARMED/ACTIVATED set that.
const alarm = { armed: Number(process.env.ARMED ?? 0), activated: Number(process.env.ACTIVATED ?? 0) }
const sensors = { alarm_3: Number(process.env.ALARM_3 ?? 0), alarm_2: Number(process.env.ALARM_2 ?? 0) }
let logKeys = new Array(LOG_SIZE).fill(0)
let logData = new Array(LOG_SIZE).fill(0)
let logCursor = 0
let privmode = false
let consoleFail = 0
let consoleFailTimer = 0

// The firmware's log level 2 (its default): only these entries are written.
function addToLog(type, data) {
  logKeys[logCursor] = type
  logData[logCursor] = data
  logCursor = (logCursor + 1) % LOG_SIZE
}

function doorUnlock(d) {
  doors[d].open = true
  addToLog('U', d)
}

function doorLock(d) {
  doors[d].open = false
  addToLog('L', d)
}

// Momentary open (`?o`, a granted card): unlock now; DOORDELAY later loop()
// sets the relay back to the reported state and logs it again.
function pulseDoor(d) {
  doorUnlock(d)
  if (relockTimers[d]) clearTimeout(relockTimers[d])
  relockTimers[d] = setTimeout(() => {
    relockTimers[d] = null
    if (doors[d].locked) doorLock(d)
    else doorUnlock(d)
  }, DOORDELAY)
  relockTimers[d].unref()
}

function checkUser(tag) {
  // returns the mask of the FIRST slot holding this tag, else -1
  for (const u of users) {
    if (u.tag === tag && tag !== EMPTY && tag !== 0) return u.mask
  }
  return -1
}

function addUser(slot, mask, tag) {
  if (slot < 0 || slot > NUM_USERS) return addToLog('i', slot)
  if (slot < NUM_USERS) users[slot] = { tag: tag >>> 0, mask: mask & 0xff } // 200 wraps onto the alarm bytes on the chip
  addToLog('a', slot)
}

function deleteUser(slot) {
  if (slot < 0 || slot > NUM_USERS) return addToLog('I', slot)
  if (slot < NUM_USERS) users[slot] = { tag: EMPTY, mask: 0xff }
  addToLog('d', slot)
}

// Arduino println(x, HEX): uppercase, no leading zeros, no 0x.
function hex(n) {
  return (n >>> 0).toString(16).toUpperCase()
}

// dumpUser(client, byte usernum): with DEBUG below 2 an empty slot prints no
// tag and no line break.
function dumpUser(slot) {
  const n = slot & 0xff
  if (n > 199) return 'Bad user number!' + CRLF
  const u = users[n]
  let out = `${n}\t${u.mask}\t`
  if (DEBUG === 2) out += hex(u.tag) + CRLF
  else if (u.tag !== EMPTY) out += '********' + CRLF
  return out
}

function status() {
  // printStatus(), byte for byte.
  return (
    '{' + CRLF +
    `"armed":${alarm.armed},"activated":${alarm.activated}` + CRLF +
    `,"alarm_3":${sensors.alarm_3}` + CRLF +
    `,"alarm_2":${sensors.alarm_2}` + CRLF +
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

// login(): a wrong password (and the logout, which is login(0)) counts as a
// failure; 5 failures within 5 minutes of the FIRST one refuse every login.
function login(pass) {
  const now = Date.now()
  if (consoleFail >= 5 && now - consoleFailTimer < LOGIN_LOCKOUT_MS) {
    addToLog('F', 1)
    return false
  }
  if (pass === PASSWORD) {
    consoleFail = 0
    privmode = true
    return true
  }
  privmode = false
  if (consoleFail === 0) consoleFailTimer = now
  consoleFail += 1
  return false
}

// A card at a reader (processTagAccess at log level 2: no R/r entries).
function swipe(tag, doorNum = 1) {
  const mask = checkUser(tag)
  let granted = false
  if (mask === 255) {
    addToLog('f', 255) // locked-out user
  } else if (mask >= 0) {
    addToLog('G', tag % DIVISOR)
    addToLog('g', Math.floor(tag / DIVISOR))
    if (mask !== 0) {
      alarm.activated = 0
      alarm.armed = 0
      pulseDoor(doorNum)
      granted = true
      addToLog('C', 0) // the keypad window closes at once (firmware bug: a shadowed timer)
      addToLog('c', 0)
    }
  } else {
    addToLog('D', tag % DIVISOR) // this simulates the 2013 build; a modern-gcc build grants unknown cards
    addToLog('d', Math.floor(tag / DIVISOR))
  }
  return { granted, mask }
}

// ---- the firmware HTTP handler (loop() in main.cpp) ----
const HELP = "<h2>Open Access Control</h2><hr/>See help[] source for command syntax (https://github.com/zyphlar/Open_Access_Control_Ethernet)."

function handleQuery(query) {
  const q = '?' + query
  if (query === '' ) return HELP
  let body = ''

  if (q.indexOf('?e=') >= 0 || q.indexOf('&e=') >= 0) {
    const e = q.indexOf('e=')
    if (login(Number.parseInt(q.slice(e + 2, e + 6), 16))) body += 'authok' + CRLF
    else return 'authfail' + CRLF // break: no command, no logout
  }

  if (privmode) {
    const cmd = q[q.indexOf('?') + 1]
    switch (cmd) {
      case 's': {
        const at = q.indexOf('?s')
        body += '<pre>' + CRLF + 'UserNum: Usermask: TagNum:' + CRLF + dumpUser(Number.parseInt(q.slice(at + 2, at + 5), 10) || 0) + '</pre>' + CRLF
        break
      }
      case 'm': {
        const at = q.indexOf('?m')
        const slot = Number.parseInt(q.slice(at + 2, at + 5), 10) || 0
        const pAt = q.indexOf('&p')
        const tAt = q.indexOf('&t')
        if (tAt - at === 10) {
          body += '<pre>' + CRLF + 'prev:' + CRLF + dumpUser(slot)
          addUser(slot, Number.parseInt(q.slice(pAt + 2, pAt + 5), 10) || 0, Number.parseInt(q.slice(tAt + 2, tAt + 10), 16) || 0)
          body += 'cur:' + CRLF + dumpUser(slot) + '</pre>' + CRLF
        } else {
          body += 'err:query' + CRLF
        }
        break
      }
      case 'a': {
        body += '<pre>' + CRLF + 'UserNum: Usermask: TagNum:' + CRLF
        for (let i = 0; i < NUM_USERS; i += 1) body += dumpUser(i)
        body += '</pre>' + CRLF
        break
      }
      case 'r': {
        const at = q.indexOf('?r')
        const slot = Number.parseInt(q.slice(at + 2, at + 5), 10) || 0
        body += 'r' + CRLF + '<pre>' + CRLF + 'prev:' + CRLF + dumpUser(slot)
        deleteUser(slot)
        body += 'cur:' + CRLF + dumpUser(slot)
        break
      }
      case 'o': {
        const d = q[q.indexOf('?o') + 2]
        if (d === '1' || d === '2') {
          alarm.activated = 0
          alarm.armed = 4
          pulseDoor(Number(d))
          body += `Opened ${d}.`
        } else {
          body += 'err:door#' + CRLF
        }
        break
      }
      case 'u': {
        const eq = q.indexOf('?u=')
        if (eq > 0 || eq === 0) {
          const d = q[eq + 3]
          if (d === '1' || d === '2') {
            if (relockTimers[d]) { clearTimeout(relockTimers[d]); relockTimers[d] = null }
            doorUnlock(Number(d))
            alarm.activated = 0
            alarm.armed = 4
            doors[d].locked = false
            body += `Unlocked ${d}.`
          } else {
            body += 'err:door#' + CRLF
          }
        } else {
          body += 'Unlocked all.'
          for (const d of [1, 2]) { doorUnlock(d); doors[d].locked = false }
          alarm.activated = 0
          alarm.armed = 4
        }
        body += status()
        break
      }
      case 'l': {
        const eq = q.indexOf('?l=')
        const d = eq >= 0 ? q[eq + 3] : null
        if (d === '1' || d === '2') {
          doorLock(Number(d)) // no message, only the status; chirps 3 times
          doors[d].locked = true
        } else {
          for (const n of [1, 2]) { doorLock(n); doors[n].locked = true }
          body += 'Locked all.'
        }
        body += status()
        break
      }
      case '1':
        alarm.armed = 0
        alarm.activated = 0
        body += status()
        break
      case '2':
        alarm.armed = 1
        body += status()
        break
      case '3':
        alarm.armed = 0
        alarm.activated = 0
        for (let i = 0; i < 4; i += 1) addToLog('t', 0)
        body += status()
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
        break // ?e= alone (stays logged in), ?w, ?x, ?v
    }
  } else if (q.indexOf('?9') > 0 || q.indexOf('?9') === 0) {
    body += status()
  } else {
    body += "<a href='/'>Not logged in.</a>"
    addToLog('F', 2)
  }

  if (q.indexOf('&e=') >= 0) login(0) // the logout: a failed login, like the firmware
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
    for (const d of [1, 2]) {
      if (relockTimers[d]) clearTimeout(relockTimers[d])
      relockTimers[d] = null
      doors[d].locked = true
      doors[d].open = false
    }
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
  // The firmware's exact header block, no length, and it closes the connection.
  req.socket.end('HTTP/1.1 200 OK\r\nCache-Control: no-store\r\nContent-Type: text/html\r\n\r\n' + body, 'latin1')
})

function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

server.listen(PORT, () => {
  console.log(`arduino-openaccess simulator on http://127.0.0.1:${PORT} (password 0x${PASSWORD.toString(16)}, ${NUM_USERS} slots)`)
})
