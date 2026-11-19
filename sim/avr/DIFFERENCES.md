# AVR emulator vs the JavaScript simulator

`test/differential.mjs` sends one request sequence to both: the real firmware
in the AVR emulator (`door-sim-avr`, default build, password 1234, default
EEPROM) and `sim/arduino-openaccess.mjs` (`PORT=9098 PASSWORD=1234
DOORDELAY=5000`). Chunked JS bodies are decoded before comparing, so what is
listed here is content and behaviour, not transfer encoding. Regenerate with:

```sh
node sim/avr/test/differential.mjs > /tmp/diff.md
```

Last run: 36 of the request bodies differed. Everything below is what the
firmware does, as observed in the emulator, against what the JS simulator does.
The JS simulator was not changed.

## Framing and connections

| | Firmware | JS simulator |
|---|---|---|
| Headers | `HTTP/1.1 200 OK`, `Cache-Control: no-store`, `Content-Type: text/html`, nothing else | adds `Date`, `Connection`, and `Transfer-Encoding: chunked` |
| Connection | board closes after every reply (FIN), no keep-alive | Node keep-alive; closes only if the client asks |
| 5 simultaneous `?9` | 1 served, 4 refused (RST from the chip; through Docker Desktop port forwarding the client sees connect-then-close with 0 bytes) | all 5 served |
| Latency of `?9` | 170 ms median (up to one 80 ms `loop()` pass, byte-at-a-time reads over SPI, two `pollAlarm()` of 20 ms) | 1 ms |
| Blocking | the board does nothing else while it chirps or delays: `?u=1` ~1.0 s, `?2` ~6.2 s, `?3` ~1.2 s, a swipe 0.3-1.6 s | never blocks |
| Request length | only the first 97 characters are seen; a `?` after that gives the help page | whole URL parsed |

## Replies

| Request | Firmware body | JS body |
|---|---|---|
| `GET /` | `<h2>Open Access Control</h2><hr/>See help[] source for command syntax (https://github.com/zyphlar/Open_Access_Control_Ethernet).` | `<a href='/'>Not logged in.</a>` |
| `?9` (fresh default EEPROM) | `{\r\n"armed":0,"activated":0\r\n,"alarm_3":0\r\n,"alarm_2":0\r\n,"door_1_locked":1\r\n,"door_2_locked":1\r\n}\r\n` | `"armed":255,"activated":255`, `"alarm_3":1`, `"alarm_2":1` (hard-coded) |
| `?s`, `?a`, `?m`, `?r` | `<pre>\r\n` then the lines | `<pre>` with no line break before `UserNum:` / `prev:` |
| `?o1` | `Opened 1.` | (empty) |
| `?u=1`, `?u` | `Unlocked 1.` / `Unlocked all.` followed by the status JSON | (empty) |
| `?l` | `Locked all.` + status | (empty) |
| `?l=1`, `?l=2` | status only | (empty) |
| `?o3` | `err:door#\r\n` | (empty), and pulses door 1 |
| `?u=3` | `err:door#\r\n` + status, no door change | (empty), unlocks door 1 |
| `?l=3` | `Locked all.` + status, locks both doors, 1 chirp | (empty), locks door 1 |
| `?1`, `?2`, `?3` | status JSON (`?1` sets armed 0) | (empty); `?1` sets armed to 255 |
| `?w` | the date as `YYMMDDWHHmmSS` without padding (e.g. `26111952584`), then falls into `?x` and sets the DS1307 to 2000-00-00 00:00:00 | (empty), no clock |
| `?x...`, `?v=N` | no body; `?x` sets the clock; `?v` changes nothing (reads the `=`) | no body, no effect |
| `?z` | 40 lines | 100 lines (`LOG_SIZE`) |

Same bytes on both: `?u` not logged in, `?e=PW`, `?e=0000`, wrong password,
`?y`, the misaligned `?m10&p001&t...` (`err:query`), `?x...`, `?v=1`, every
step of the lockout sequence, and the `?a` slot lines themselves.

## Login and lockout

| | Firmware | JS simulator |
|---|---|---|
| `?e=0000` | answers `authfail` **and logs out** (it is `login(0)`, a wrong password) | answers `authfail`, stays logged in |
| `&e=` logout at the end of a command | is `login(0)` too: counts as a failed login (sets the 5-minute window if the count was 0) | just clears the session |
| Lockout window | 5 minutes from the **first** failure in the current run of failures | 5 minutes from the 5th failure |
| Refused login while locked out | logs `F: 1` | logs nothing |
| `?u` (any privileged command) not logged in | logs `F: 2` | logs nothing |

## Event log

| | Firmware | JS simulator |
|---|---|---|
| Size | 40 entries | 100 |
| Card read | `R`/`r` only at log level 0-1; the default level is 2, so **no R/r** | always `R`/`r` |
| Granted card (mask 1) | `G g U:1 C:0 c:0`, then `L:1` about 5 s later (the `C`/`c` is the empty keypad command) | `R r G g U:1`, then `L:1` |
| Mask 255 | `f: 255` only | `R r D d` |
| Mask 0 | `G g`, **door does not open** | `R r G g U:1 L:1`, door pulses |
| Unknown card | **`G g U:1 C:0 c:0 L:1`, door opens** (see below); with `FIRMWARE_FLAGS=-fno-aggressive-loop-optimizations`, `D d` | `R r D d` |
| 41st entry | overwrites `logCursor` and the keys of entries 0 and 1 (`\x02: 2`, `\0: 2` after 41 `F: 2`) | ring of 100, no overflow |
| `?u=3` / `?o3` | nothing logged | `U: 1` |

The unknown-card grant is the firmware build, not the emulator: avr-gcc 7.3
compiles `checkSuperuser()`'s `i <= numUsers` loop over a three-entry array so
that every tag that reaches it is "superuser 2". See the README.

## Doors and alarm

| | Firmware | JS simulator |
|---|---|---|
| `?o1` relock | relay high for DOORDELAY plus up to one `loop()` pass: 5075 ms in this run (5000-5200) | exactly 5000 ms (timer) |
| `?o1` side effects | `alarmState(0)`, `armAlarm(4)`: status then reports `"armed":4` | none |
| Chirps | D9 high 100 ms / low 200 ms per chirp: 3 for `?u`, `?u=N`, `?l=N`; 1 for `?l=3`, `?1`, the boot and every card read; 20 for `?2` | not modelled |
| Slot 200 | `?m200` writes EEPROM 1024..1028, which wraps onto 0..4 (alarm state and armed). Reply `Bad user number!` twice. After a power cycle `?9` shows the new bytes (`?m200&p001&t12345678` gives armed 86, activated 120; `?r200` gives 255/255) | stored in an extra array element, invisible |
| `?m` validation | only checks that `&t` is 10 characters after `?m`; digits are `atoi`/`strtoul`, so `?m01x...` writes slot 1 | regex: 3 digits, 3 digits, 8 hex |

## What door-api should take from this

- **One request at a time.** The board serves one connection per `loop()` pass
  and refuses the rest. A status poll overlapping a command fails on the real
  board and succeeds on the JS simulator.
- **Timeouts.** Commands take 0.1 s to 6.2 s on the board, 1 ms on the JS
  simulator. `?2` (arm) and anything that chirps blocks the board for seconds.
- **Mask 0 and unknown cards** behave differently from the JS simulator; the
  PlatformIO build lets unknown cards in.
- **`armed`/`activated` 255 and `alarm_2`/`alarm_3` 1** in the JS simulator look
  like a capture from a real board whose EEPROM bytes 0/1 were never written (or
  were hit by `?r200`) and whose zone baselines do not match its sensors. To get
  that state here, start from an EEPROM image with 0xFF at 0 and 1, and move
  A2/A3 more than 400 ADC counts away from 4 x their trained bytes
  (`pollAlarm()` trips when `|analogRead/4 - trained| > 100`), e.g.
  `POST /sensors {"a2":1000,"a3":1000}` with the default baselines of 128.
