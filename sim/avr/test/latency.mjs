// Measures how long the emulated board takes to answer each command, the way
// door-api calls it (Node fetch, ?cmd&e=PW), and prints a Markdown table.
//   node sim/avr/test/latency.mjs [runs]
// Each run starts from a freshly power-cycled board with the default EEPROM, so
// loop() has its idle period (about 80 ms: four pollAlarm() calls of 20 ms).
// Latency includes waiting for loop() to reach server.available(), reading the
// request one byte at a time over SPI, the command itself, and the close.
import { setTimeout as sleep } from 'node:timers/promises'
import { PASSWORD, boardAddress, median, resetBoard, get, startSim, stopSim } from './helpers.mjs'

const RUNS = Number(process.argv[2] ?? 5)
const pw = PASSWORD
const COMMANDS = [
  ['help page', ''],
  ['?9 (no login)', '?9'],
  ['?e=PW (login only)', `?e=${pw}`],
  ['wrong password (authfail)', '?9&e=0BAD'],
  ['?u logged out (Not logged in.)', '?u'],
  ['?s010', `?s010&e=${pw}`],
  ['?m010&p001&t0012ABCD', `?m010&p001&t0012ABCD&e=${pw}`],
  ['?r010', `?r010&e=${pw}`, `?m010&p001&t0012ABCD&e=${pw}`],
  ['?a (200 slots)', `?a&e=${pw}`],
  ['?z (40 entries)', `?z&e=${pw}`],
  ['?y', `?y&e=${pw}`],
  ['?o1', `?o1&e=${pw}`],
  ['?u=1', `?u=1&e=${pw}`],
  ['?u (all)', `?u&e=${pw}`],
  ['?l (all)', `?l&e=${pw}`],
  ['?l=1', `?l=1&e=${pw}`],
  ['?1 (disarm)', `?1&e=${pw}`],
  ['?2 (arm)', `?2&e=${pw}`],
  ['?3 (train)', `?3&e=${pw}`]
]

async function timedFetch(query) {
  const { host, port } = boardAddress()
  const t0 = performance.now()
  const res = await fetch(`http://${host}:${port}/${query}`, { headers: { 'User-Agent': 'door-api/0.1' } })
  const body = await res.text()
  return { ms: performance.now() - t0, bytes: body.length }
}

await startSim()
const rows = []
try {
  for (const [name, query, setup] of COMMANDS) {
    const times = []
    let bytes = 0
    for (let i = 0; i < RUNS; i++) {
      await resetBoard()
      if (setup) await get(setup)
      await sleep(Math.random() * 120) // land at a random point of loop()
      const r = await timedFetch(query)
      times.push(r.ms)
      bytes = r.bytes
    }
    rows.push([name, median(times), Math.min(...times), Math.max(...times), bytes])
    process.stderr.write('.')
  }
} finally {
  await stopSim()
}
process.stderr.write('\n')
console.log(`| Command | median ms | min | max | body bytes |`)
console.log(`|---|---:|---:|---:|---:|`)
for (const [name, med, min, max, bytes] of rows) {
  console.log(`| ${name} | ${Math.round(med)} | ${Math.round(min)} | ${Math.round(max)} | ${bytes} |`)
}
