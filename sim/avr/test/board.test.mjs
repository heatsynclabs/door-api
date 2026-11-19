// Behaviour of the real door firmware running in the AVR emulator.
// Run from the door-api root:  node --test --test-concurrency=1 'sim/avr/test/*.test.mjs'
// Needs the door-sim-avr image (see sim/avr/README.md) or BOARD_URL + CONTROL_URL.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import net from 'node:net'
import { after, before, describe, test } from 'node:test'
import {
  HEADER, PASSWORD, authed, boardAddress, clearLog, containerName, ctl, edges, eeprom, get, health,
  logEntries, parseLog, pins, resetBoard, setSpeed, simNow, sleep, split, startSim, stopSim, swipe, waitReady, waitSim
} from './helpers.mjs'

const STATUS = (armed, activated, d1, d2) =>
  `{\r\n"armed":${armed},"activated":${activated}\r\n,"alarm_3":0\r\n,"alarm_2":0\r\n,"door_1_locked":${d1}\r\n,"door_2_locked":${d2}\r\n}\r\n`
const EMPTY_SLOT = (n) => `${n}\t255\tFFFFFFFF\r\n`
const HELP = "<h2>Open Access Control</h2><hr/>See help[] source for command syntax (https://github.com/zyphlar/Open_Access_Control_Ethernet)."

// D9 chirps (high then low) recorded since a simulated time.
async function chirps(since) {
  return (await edges(9, since)).filter(([, v]) => v === 1).length
}

before(startSim)
after(stopSim)

describe('HTTP framing', () => {
  before(() => resetBoard())

  test('GET / with no query returns the help page', async () => {
    const r = await get('')
    assert.equal(r.head, HEADER)
    assert.equal(r.body, HELP)
  })

  test('?9 without login returns the JSON status', async () => {
    const r = await get('?9')
    assert.equal(r.raw.toString('latin1'), HEADER + STATUS(0, 0, 1, 1))
    assert.deepEqual(JSON.parse(r.body), { armed: 0, activated: 0, alarm_3: 0, alarm_2: 0, door_1_locked: 1, door_2_locked: 1 })
  })

  test('no Content-Length, and the board closes the connection with a FIN', async () => {
    for (const q of ['', '?9', `?e=${PASSWORD}`, '?a']) {
      const r = await get(q)
      assert.ok(!/content-length/i.test(r.head), 'no Content-Length header')
      assert.equal(r.serverClosed, true, `board closed the connection for ${q}`)
      assert.equal(r.error, null)
    }
  })

  test('the request is cut at 97 characters (String(100) starts as "100")', async () => {
    // A query that only starts after the cap is never seen: help page.
    const r = await get('?9', { headers: '' }) // fits
    assert.match(r.body, /door_1_locked/)
    const long = await get(`${'x'.repeat(100)}?9`)
    assert.equal(long.body, HELP)
  })
})

describe('login rules', () => {
  before(() => resetBoard())

  test('a bare ?u while logged out says "Not logged in." and logs F 2', async () => {
    await clearLog() // also leaves us logged out (&e= logs out)
    const r = await get('?u')
    assert.equal(r.body, "<a href='/'>Not logged in.</a>")
    assert.deepEqual(await logEntries(), ['F:2'])
    assert.deepEqual((await pins(0)).pins['6'], 0, 'door not touched')
  })

  test('?e=PW logs in and stays logged in for the next request', async () => {
    const r = await get(`?e=${PASSWORD}`)
    assert.equal(r.body, 'authok\r\n')
    const z = await get('?z')
    assert.match(z.body, /^<pre>\r\n/, 'log shown without a password')
    const s = await get('?9')
    assert.equal(s.body, STATUS(0, 0, 1, 1))
  })

  test('?cmd&e=PW logs in, runs, and logs out at the end', async () => {
    const r = await get(`?z&e=${PASSWORD}`)
    assert.match(r.body, /^authok\r\n<pre>\r\n/)
    const after = await get('?z')
    assert.equal(after.body, "<a href='/'>Not logged in.</a>")
  })

  test('a wrong password answers authfail and nothing else', async () => {
    const r = await get('?9&e=0BAD')
    assert.equal(r.raw.toString('latin1'), HEADER + 'authfail\r\n')
    // a good login clears the failure count again
    assert.equal((await get(`?e=${PASSWORD}`)).body, 'authok\r\n')
  })

  test('?e=0000 logs out, but answers authfail (it is a wrong password)', async () => {
    assert.equal((await get('?e=0000')).body, 'authfail\r\n')
    assert.equal((await get('?z')).body, "<a href='/'>Not logged in.</a>")
  })
})

describe('doors', () => {
  before(() => resetBoard({ uptimeMs: 1000 }))

  test('?o1: "Opened 1.", D6 high for about DOORDELAY, status still locked, log U then L', async () => {
    await clearLog()
    const t0 = await simNow()
    const r = await authed('o1')
    assert.equal(r.body, 'authok\r\nOpened 1.')
    assert.equal((await get('?9')).body, STATUS(4, 0, 1, 1), 'reported state stays locked, alarm in chime mode (4)')
    await waitSim(t0, 6000)
    const e = await edges(6, t0)
    assert.equal(e.length, 2, JSON.stringify(e))
    assert.deepEqual(e.map(([, v]) => v), [1, 0])
    const held = e[1][0] - e[0][0]
    assert.ok(held >= 5000 && held < 5300, `door 1 held ${held} ms`)
    assert.deepEqual(await logEntries(), ['U:1', 'L:1'])
    assert.equal(await chirps(t0), 0, 'no chirp for ?o1')
  })

  test('?u=1 unlocks door 1 and it stays unlocked, with 3 chirps', async () => {
    const t0 = await simNow()
    const r = await authed('u=1')
    assert.equal(r.body, 'authok\r\nUnlocked 1.' + STATUS(4, 0, 0, 1))
    await waitSim(t0, 6500)
    assert.deepEqual((await edges(6, t0)).map(([, v]) => v), [1], 'D6 went high and stayed')
    assert.equal((await pins(0)).pins['6'], 1)
    assert.equal(await chirps(t0), 3)
  })

  test('?l locks all with no chirp', async () => {
    const t0 = await simNow()
    const r = await authed('l')
    assert.equal(r.body, 'authok\r\nLocked all.' + STATUS(4, 0, 1, 1))
    await waitSim(t0, 400)
    assert.deepEqual((await edges(6, t0)).map(([, v]) => v), [0])
    assert.equal(await chirps(t0), 0)
  })

  test('?l=1 locks door 1 with 3 chirps and prints only the status', async () => {
    await authed('u=1')
    const t0 = await simNow()
    const r = await authed('l=1')
    assert.equal(r.body, 'authok\r\n' + STATUS(4, 0, 1, 1))
    assert.equal(await chirps(t0), 3)
    const e = await edges(9, t0)
    // each chirp: strobe high 100 ms, low 200 ms
    assert.ok(Math.abs(e[1][0] - e[0][0] - 100) < 2, `chirp ${e[1][0] - e[0][0]} ms`)
    assert.ok(Math.abs(e[2][0] - e[0][0] - 300) < 2, `chirp period ${e[2][0] - e[0][0]} ms`)
  })

  test('?u unlocks all with 3 chirps', async () => {
    const t0 = await simNow()
    const r = await authed('u')
    assert.equal(r.body, 'authok\r\nUnlocked all.' + STATUS(4, 0, 0, 0))
    const p = await pins(t0)
    assert.equal(p.pins['6'], 1)
    assert.equal(p.pins['8'], 1)
    assert.equal(await chirps(t0), 3)
    await authed('l')
  })
})

describe('users', () => {
  before(() => resetBoard())

  test('?m010&p001&t0012ABCD writes slot 10 and shows prev:/cur:', async () => {
    const r = await authed('m010&p001&t0012ABCD')
    assert.equal(r.raw.toString('latin1'), HEADER +
      'authok\r\n<pre>\r\nprev:\r\n10\t255\tFFFFFFFF\r\ncur:\r\n10\t1\t12ABCD\r\n</pre>\r\n')
    const e = await eeprom()
    assert.deepEqual([...e.subarray(24 + 50, 24 + 55)], [0xCD, 0xAB, 0x12, 0x00, 0x01], 'tag little-endian, then mask')
  })

  test('?a lists slots 0..199 in the documented format', async () => {
    const r = await authed('a')
    let expected = 'authok\r\n<pre>\r\nUserNum: Usermask: TagNum:\r\n'
    for (let i = 0; i < 200; i++) expected += i === 10 ? '10\t1\t12ABCD\r\n' : EMPTY_SLOT(i)
    expected += '</pre>\r\n'
    assert.equal(r.body, expected)
  })

  test('?s010 shows one slot', async () => {
    const r = await authed('s010')
    assert.equal(r.body, 'authok\r\n<pre>\r\nUserNum: Usermask: TagNum:\r\n10\t1\t12ABCD\r\n</pre>\r\n')
  })

  test('?r010 clears the slot to FFFFFFFF/255 (no closing </pre>)', async () => {
    const r = await authed('r010')
    assert.equal(r.body, 'authok\r\nr\r\n<pre>\r\nprev:\r\n10\t1\t12ABCD\r\ncur:\r\n10\t255\tFFFFFFFF\r\n')
    const e = await eeprom()
    assert.deepEqual([...e.subarray(74, 79)], [0xFF, 0xFF, 0xFF, 0xFF, 0xFF])
  })

  test('a query that does not line up (&t not 10 chars after ?m) is err:query', async () => {
    const r = await authed('m10&p001&t0012ABCD')
    assert.equal(r.body, 'authok\r\nerr:query\r\n')
  })

  test('slot 200 is accepted and wraps to EEPROM bytes 0..4 (alarm state)', async () => {
    const r = await authed('m200&p001&t12345678')
    assert.equal(r.body, 'authok\r\n<pre>\r\nprev:\r\nBad user number!\r\ncur:\r\nBad user number!\r\n</pre>\r\n')
    const e = await eeprom()
    assert.deepEqual([...e.subarray(0, 5)], [0x78, 0x56, 0x34, 0x12, 0x01])
    // After a power cycle the firmware restores the alarm bytes from 0 and 1.
    await resetBoard({ eeprom: 'keep' })
    assert.equal((await get('?9')).body, STATUS(0x56, 0x78, 1, 1))
    // ?r200 fills them with 0xFF instead.
    await authed('r200')
    assert.deepEqual([...(await eeprom()).subarray(0, 5)], [0xFF, 0xFF, 0xFF, 0xFF, 0xFF])
    await resetBoard({ eeprom: 'keep' })
    assert.equal((await get('?9')).body, STATUS(255, 255, 1, 1))
  })
})

describe('event log', () => {
  before(() => resetBoard())

  test('?z prints exactly 40 lines and ?y clears', async () => {
    await get('?u') // F:2
    let r = await authed('z')
    let log = parseLog(r.body)
    assert.equal(log.length, 40)
    assert.deepEqual(log[0], ['F', 2])
    assert.match(r.body, /^authok\r\n<pre>\r\nF: 2\r\n\0: 0\r\n/)
    assert.ok(r.body.endsWith('\0: 0\r\n</pre>\r\n'))
    r = await authed('y')
    assert.equal(r.body, 'authok\r\ny\r\n')
    log = parseLog((await authed('z')).body)
    assert.equal(log.length, 40)
    assert.ok(log.every(([k, v]) => k === '\0' && v === 0))
  })

  test('the log is a ring of 40: the 41st entry replaces the first', async () => {
    await clearLog()
    for (let i = 0; i < 40; i++) await get('?u') // 40 x F:2
    await authed('m010&p001&t0012ABCD') // the 41st entry: a:10
    const log = parseLog((await authed('z')).body)
    assert.equal(log.length, 40)
    assert.deepEqual(log[0], ['a', 10])
    assert.ok(log.slice(1).every(([k, v]) => k === 'F' && v === 2))
  })
})

describe('card swipes', () => {
  const GRANT = 0x12ABCD // slot 10, mask 1
  const LOCKED = 0xABC001 // slot 11, mask 255
  const NOPRIV = 0xABC002 // slot 12, mask 0
  const UNKNOWN = 0x777777

  before(async () => {
    // millis() must be past 5000: the keypad window reads a global
    // keypadTime that is never set, so it only blocks during the first 5 s.
    await resetBoard({ uptimeMs: 5200 })
    await authed('m010&p001&t0012ABCD')
    await authed('m011&p255&t00ABC001')
    await authed('m012&p000&t00ABC002')
  })

  test('mask 1: G/g logged, D6 energised for about 5 s', async () => {
    await clearLog()
    const t0 = await simNow()
    const s = await swipe(GRANT)
    assert.equal(s.ok, true)
    assert.ok(s.endMs - s.startMs > 49 && s.endMs - s.startMs < 51, '26 bits at 2 ms')
    await waitSim(t0, 6500)
    const e = await edges(6, t0)
    assert.deepEqual(e.map(([, v]) => v), [1, 0])
    const held = e[1][0] - e[0][0]
    assert.ok(held >= 5000 && held < 5300, `door 1 held ${held} ms`)
    const [lo, hi] = split(GRANT)
    // G/g, unlock, an empty keypad command (C/c 0), and the relock
    assert.deepEqual(await logEntries(), [`G:${lo}`, `g:${hi}`, 'U:1', 'C:0', 'c:0', 'L:1'])
    assert.equal(await chirps(t0), 1, 'one chirp when the tag is read')
  })

  test('mask 255: logs f 255, no door', async () => {
    await clearLog()
    const t0 = await simNow()
    await swipe(LOCKED)
    await waitSim(t0, 700)
    assert.deepEqual(await logEntries(), ['f:255'])
    assert.deepEqual(await edges(6, t0), [])
  })

  test('mask 0: logs G/g but does not open', async () => {
    await clearLog()
    const t0 = await simNow()
    await swipe(NOPRIV)
    await waitSim(t0, 700)
    const [lo, hi] = split(NOPRIV)
    assert.deepEqual(await logEntries(), [`G:${lo}`, `g:${hi}`])
    assert.deepEqual(await edges(6, t0), [])
  })

  test('unknown tag: 1 s brute-force delay, then denied', async () => {
    await clearLog()
    const t0 = await simNow()
    await swipe(UNKNOWN)
    // loop() serves HTTP before it looks at the reader, so wait until the
    // tag is being processed (the read chirp), then a request has to wait
    // out the rest of the chirp (300 ms) and checkUser's delay(1000).
    while (!(await edges(9, t0)).some(([, v]) => v === 1)) await sleep(5)
    const busyFrom = await simNow()
    await get('?9')
    const busy = (await simNow()) - busyFrom
    assert.ok(busy > 1100, `board busy ${Math.round(busy)} ms`)
    await waitSim(t0, 6500)
    const [lo, hi] = split(UNKNOWN)
    // Denied (fixed third superuser check; see the firmware's checkSuperuser).
    assert.deepEqual(await logEntries(), [`D:${lo}`, `d:${hi}`])
    assert.deepEqual(await edges(6, t0), [])
  })

  test('Wiegand: facility/card are packed into the raw 26-bit frame the firmware checks', async () => {
    // even parity, 8-bit facility, 16-bit card, odd parity
    const frame = (f, c) => {
      const data = (f << 16) | c
      const ones = (x) => x.toString(2).split('1').length - 1
      return ((ones(data >>> 12) & 1) << 25) | (data << 1) | ((ones(data & 0xFFF) & 1) ^ 1)
    }
    const tag = frame(18, 0xABCD)
    await authed(`m013&p001&t${tag.toString(16).padStart(8, '0')}`)
    await clearLog()
    const t0 = await simNow()
    const s = await swipe(undefined, 1, { facility: 18, card: 0xABCD })
    assert.equal(s.tag, tag)
    await waitSim(t0, 500)
    const [lo, hi] = split(tag)
    assert.deepEqual((await logEntries()).slice(0, 2), [`G:${lo}`, `g:${hi}`])
    await waitSim(t0, 6500) // let door 1 relock before the next test
  })

  test('reader 2 drives door 2 (D8)', async () => {
    await clearLog()
    const t0 = await simNow()
    await swipe(GRANT, 2)
    await waitSim(t0, 6500)
    assert.deepEqual((await edges(8, t0)).map(([, v]) => v), [1, 0])
    const [lo, hi] = split(GRANT)
    // C/c is the (empty) keypad command split like a card number, not the door
    assert.deepEqual(await logEntries(), [`G:${lo}`, `g:${hi}`, 'U:2', 'C:0', 'c:0', 'L:2'])
  })

  test('tags wider than 26 bits are refused by the control API', async () => {
    const r = await ctl('POST', '/swipe', { reader: 1, tag: 2 ** 26 })
    assert.equal(r.ok, false)
  })
})

describe('alarm', () => {
  before(() => resetBoard())

  test('?2 (arm) blocks the board for 20 chirps, about 6 s', async () => {
    const t0 = await simNow()
    const r = await authed('2')
    const took = (await simNow()) - t0 // simulated ms, the board's own clock
    assert.equal(r.body, 'authok\r\n' + STATUS(1, 0, 1, 1))
    assert.ok(took > 6000 && took < 6600, `?2 took ${Math.round(took)} ms (wall ${Math.round(r.ms)} ms)`)
    assert.equal(await chirps(t0), 20)
    const e = await edges(9, t0)
    const span = e[e.length - 1][0] - e[0][0]
    assert.ok(Math.abs(span - 5800) < 5, `chirp train ${span} ms`) // 19 x 300 + 100
    const d = await authed('1')
    assert.equal(d.body, 'authok\r\n' + STATUS(0, 0, 1, 1))
  })
})

describe('connections', () => {
  before(() => resetBoard())

  test('5 simultaneous connections: one is served, the other four get nothing', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => get('?9')))
    const served = results.filter((r) => r.body.includes('door_1_locked'))
    assert.equal(served.length, 1, JSON.stringify(results.map((r) => [r.error, r.raw.length])))
    for (const r of results.filter((x) => !x.body.includes('door_1_locked'))) {
      assert.equal(r.raw.length, 0)
    }
  })

  test('a 4 KB request body fills the 2 KB RX buffer without breaking real-time pacing', async () => {
    const reply = await new Promise((resolve) => {
      let buf = ''
      const s = net.connect(boardAddress(), () => {
        s.write(`GET /?9 HTTP/1.1\r\nHost: board\r\nContent-Length: 4096\r\n\r\n${'x'.repeat(4096)}`)
        s.end() // half-close: our FIN sits behind data the board never reads
      })
      s.on('data', (d) => { buf += d })
      s.on('error', () => {})
      s.on('close', () => resolve(buf))
    })
    assert.match(reply, /door_1_locked/)
    // The board now waits up to 1 s in client.stop() for a FIN it cannot see.
    // Simulated time must not run ahead of the wall clock meanwhile.
    let ahead = 0
    for (const end = Date.now() + 1500; Date.now() < end;) {
      ahead = Math.max(ahead, -(await health()).behindMs)
      await sleep(20)
    }
    assert.ok(ahead < 20, `simulated time ran ${Math.round(ahead)} ms ahead of the wall clock`)
    await waitReady()
  })

  test('inside the Docker network the extra SYNs are refused (RST), like the chip', async (t) => {
    const name = containerName()
    if (!name) return t.skip('only when the test started the container')
    const script = `
      const net = require('node:net');
      const t0 = Date.now();
      const one = () => new Promise((res) => {
        const s = net.connect({ host: '127.0.0.1', port: 80 }, () => s.write('GET /?9 HTTP/1.1\\r\\n\\r\\n'));
        let n = 0; s.on('data', (d) => n += d.length);
        s.on('error', (e) => res(Date.now() - t0 < 500 ? e.code : 'late ' + e.code));
        s.on('close', () => res(n > 0 ? 'served' : 'empty'));
      });
      Promise.all([0,1,2,3,4].map(one)).then((r) => console.log(JSON.stringify(r)));`
    let out
    try {
      out = execFileSync('docker', ['run', '--rm', '--network', `container:${name}`, 'node:22-alpine', 'node', '-e', script], { timeout: 60000 }).toString()
    } catch (e) {
      return t.skip(`could not run node:22-alpine: ${e.message.split('\n')[0]}`)
    }
    // The chip resets the SYN (ECONNREFUSED). Connections the host kernel had
    // already completed are reset when the listener closes (ECONNRESET).
    const r = JSON.parse(out)
    assert.equal(r.filter((x) => x === 'served').length, 1, out)
    assert.equal(r.filter((x) => x === 'ECONNREFUSED' || x === 'ECONNRESET').length, 4, out)
  })
})

describe('EEPROM file', () => {
  test('EEPROM_FILE persists the card table across container restarts', async (t) => {
    if (!containerName()) return t.skip('only when the test starts containers')
    const vol = `door-sim-test-eeprom-${process.pid}`
    let name
    const run = (n) => {
      name = `${vol}-run${n}`
      execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-v', `${vol}:/data`, '-e', 'EEPROM_FILE=/data/eeprom.bin',
        '-p', '127.0.0.1::80', process.env.DOOR_SIM_IMAGE ?? 'door-sim-avr'], { stdio: 'pipe' })
      return Number(execFileSync('docker', ['port', name, '80/tcp']).toString().trim().split('\n')[0].split(':').pop())
    }
    const raw = (port, q) => new Promise((resolve) => {
      import('node:net').then(({ default: net }) => {
        let s
        const go = () => {
          let buf = ''
          s = net.connect({ host: '127.0.0.1', port }, () => s.write(`GET /${q} HTTP/1.1\r\n\r\n`))
          s.on('data', (d) => { buf += d })
          s.on('error', () => setTimeout(go, 100))
          s.on('close', (hadErr) => { if (hadErr) return; if (buf) resolve(buf); else setTimeout(go, 100) })
        }
        go()
      })
    })
    try {
      let port = run(1)
      const w = await raw(port, `?m005&p001&t00C0FFEE&e=${PASSWORD}`)
      assert.match(w, /cur:\r\n5\t1\tC0FFEE/)
      execFileSync('docker', ['stop', '-t', '10', name], { stdio: 'pipe' })
      port = run(2)
      const s = await raw(port, `?s005&e=${PASSWORD}`)
      assert.match(s, /5\t1\tC0FFEE\r\n/)
    } finally {
      try { execFileSync('docker', ['rm', '-f', name], { stdio: 'pipe' }) } catch { /* already gone */ }
      try { execFileSync('docker', ['volume', 'rm', '-f', vol], { stdio: 'pipe' }) } catch { /* already gone */ }
    }
  })
})

describe('console lockout (runs fast with SPEED)', () => {
  const speed = Number(process.env.LOCKOUT_SPEED ?? 0) // 0 = as fast as the host can

  before(() => resetBoard())
  after(async () => {
    await setSpeed(1)
    await waitReady()
  })

  test('after 5 wrong passwords a correct one is refused for 5 minutes, then works', { timeout: 15 * 60 * 1000 }, async () => {
    await clearLog() // a good login, then the &e= logout counts as failure #1
    await resetBoard() // so start clean: consoleFail = 0
    const t0 = await simNow()
    for (let i = 0; i < 5; i++) assert.equal((await get('?e=0BAD')).body, 'authfail\r\n')
    assert.equal((await get(`?e=${PASSWORD}`)).body, 'authfail\r\n', 'locked out')
    await setSpeed(speed)
    await waitSim(t0, 290000)
    assert.equal((await get(`?e=${PASSWORD}`)).body, 'authfail\r\n', 'still locked at 290 s')
    await waitSim(t0, 300500)
    await setSpeed(1)
    assert.equal((await get(`?e=${PASSWORD}`)).body, 'authok\r\n', 'accepted after 5 minutes')
    // each refused login while locked out logs F 1
    const log = await logEntries()
    assert.deepEqual(log.filter((x) => x === 'F:1').length, 2)
  })
})
