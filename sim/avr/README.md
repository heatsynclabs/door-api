# door-sim-avr: the real door firmware, emulated

This runs the actual compiled AVR binary of HeatSync Labs' front door
controller (the "Open Access Control Ethernet" sketch, built with PlatformIO
from `door-controller-platformio/legacy-ethernet-door-firmware`) on simavr's
cycle-accurate ATmega328P at 16 MHz. Around the CPU sit small models of the
other parts on the board: the W5100 Ethernet chip bridged to real TCP, the
DS1307 clock, the four alarm inputs, the two Wiegand readers and the four
relays. Door software talks to it over HTTP exactly as it talks to the board,
and tests drive and observe the hardware side through a control API.

It exists because the firmware's behaviour is in its quirks (the 97-character
request buffer, the login and lockout rules, blocking chirps and delays, the
40-entry log that overwrites its own cursor, slot 200 writing over the alarm
bytes), and a rewrite only reproduces the quirks someone noticed. Here the
quirks come from the binary.

## Build and run

From the door-api repo root, with a checkout of the firmware next to it:

```sh
docker build --build-context firmware=../door-controller-platformio/legacy-ethernet-door-firmware \
  --build-arg PASSWORD=0x1234 -t door-sim-avr sim/avr
docker run --rm -p 8080:80 -p 9199:9199 -e TZ=America/Phoenix door-sim-avr
```

Then `curl 'http://localhost:8080/?9'` is the board and
`curl http://localhost:9199/health` is the control API.

Without `--build-context firmware=...` the Dockerfile clones
`heatsynclabs/door-controller-platformio` at `FIRMWARE_REF`. That commit
predates the `#ifndef PRIVPASSWORD` guard, so the build refuses any
password other than the default until the guard is pushed.

The image is multi-stage and builds everything from source: about 150 MB,
for linux/arm64 and linux/amd64. Both architectures produce the same flash
image (`firmware.hex` sha256 `520d6042...` with the default password; the ELF
files differ only in debug-section layout). `/opt/door/BUILDINFO` in the image,
and `build` in `GET /health`, record the flags, PlatformIO, platform, toolchain
and framework versions and both hashes.

### Build arguments

| Arg | Default | Meaning |
|---|---|---|
| `PASSWORD` | `0x1234` | console password, passed as `-DPRIVPASSWORD`. Typed as `?e=1234`. |
| `FIRMWARE_FLAGS` | (empty) | extra compiler flags for a variant build, e.g. `-fno-aggressive-loop-optimizations` (see "checkSuperuser" below). Empty means exactly what `pio run -e uno` builds. |
| `FIRMWARE_REPO`, `FIRMWARE_REF` | GitHub, `2ac92da` | source when no `firmware` build context is given |
| `PLATFORMIO_VERSION`, `ATMELAVR_VERSION`, `TOOLCHAIN_VERSION`, `FRAMEWORK_VERSION` | 6.1.19, 5.1.0, 1.70300.191015, 5.2.0 | pinned toolchain |
| `SIMAVR_TAG`, `SIMAVR_COMMIT` | `v1.8`, `f44723e8…` | pinned simavr release |

### Runtime environment

| Env | Default | Meaning |
|---|---|---|
| `BOARD_PORT` | `80` | host port that serves the chip's port 80 |
| `CONTROL_PORT` | `9199` | control API |
| `SPEED` | `1` | simulated seconds per wall second. `0` runs as fast as the host can (about 7x on an M1). Changeable at runtime with `POST /speed`. |
| `EEPROM_FILE` | (none) | 1024-byte file the EEPROM is loaded from and written back to (within 100 ms of a change, and on SIGTERM). Missing file: start from the default image. Mount a volume at `/data` and use `/data/eeprom.bin`. |
| `SENSORS` | `512,512,512,512` | ADC counts (0-1023) on A0..A3. `SENSOR_A0`..`SENSOR_A3` override one input. |
| `RTC_TIME` | now | `YYYY-MM-DDTHH:MM:SS` to load into the DS1307, local time |
| `TZ` | UTC | the container's zone, used for "now". The lab is `America/Phoenix`. |
| `SLICE_US` | `500` | simulated time per CPU slice between host I/O checks |
| `W5100_LINK_MBPS` | `100` | link speed for the SEND_OK wire-time model |
| `W5100_RTT_US` | `200` | LAN round trip (LAST_ACK to CLOSED) |
| `W5100_TRACE` | `0` | `1` logs every socket command and state change |
| `WIEGAND_PULSE_US`, `WIEGAND_PERIOD_US` | `50`, `2000` | reader timing |

The default EEPROM image has the user area erased (0xFF), the alarm state and
armed bytes (0 and 1) at 0, bytes 2-19 erased, and the zone baselines (20-23)
set to `SENSORS/4`, so no sensor reads as tripped.

## Control API (port 9199, JSON)

| Endpoint | |
|---|---|
| `GET /health` | `simMs` (ms since power-on), `wallMs`, `speed`, `behindMs`, `slipMs` (time the host could not keep up with), `cpu`, `boots`, the RTC, sensors, and the firmware build record |
| `GET /pins[?since=ms]` | current levels of D6..D9 and every edge since boot as `{t, pin, value}`, `t` in simulated ms. Keeps the newest 8192 edges. |
| `POST /swipe` | `{"reader":1,"tag":1223629}` clocks a Wiegand frame onto the reader pins and answers once the last bit is out (`startMs`/`endMs`). `bits` (default 26, up to 32) sends shorter frames such as 4-bit keypad presses. `{"facility":18,"card":43981}` builds a standard 26-bit frame with parity. |
| `POST /sensors` | `{"a0":512,"a3":900}` or `{"values":[512,512,512,512]}` |
| `POST /reset` | power-cycle the board (CPU, W5100, pins). `{"eeprom":"default"}` also restores the default EEPROM; the default keeps it. The RTC keeps running, as on its battery. |
| `POST /speed` | `{"speed":8}` |
| `GET /eeprom[?format=json]` | hex dump, or `{"hex": "..."}` |
| `GET /sockets` | the W5100 socket table (state, ports, buffer use, host link) |
| `GET /rtc` | DS1307 time and raw registers |

### Wiegand mapping

The readers are D2 (DATA0) / D3 (DATA1) for reader 1 and D4/D5 for reader 2.
Each bit is a 50 us low pulse on DATA0 (0) or DATA1 (1), every 2 ms, most
significant bit first; a 26-bit frame takes 50.05 ms. The firmware's
pin-change handlers (lib/Wiegand26) do `reader1 = reader1 << 1 | bit` and
`loop()` acts at 26 bits, passing the raw frame, parity bits included, to
`checkUser()`. So the number the firmware compares with the EEPROM, and logs
as G/g or D/d (`tag % 32767`, `tag / 32767`), is exactly `tag`. `tag` must fit
in `bits` bits (0..67108863 for 26). A real HID card with facility F and card C
arrives as `(evenParity << 25) | (F << 17) | (C << 1) | oddParity`, which is
what the `facility`/`card` form sends.

## What is real and what is modelled

Real, from the binary: everything the firmware does. Request parsing, login,
lockout, every reply byte, EEPROM layout, the log, chirps and delays, the
relock timer, the pin-change interrupt decoding of Wiegand, the order in which
`loop()` serves HTTP, readers and sensors. simavr executes the AVR instructions
cycle by cycle, with the ATmega328P's timers (so `millis()` and `delay()` are
the real ones), interrupts, GPIO, SPI, TWI, ADC and EEPROM controllers.

Modelled, outside the chip:

- **W5100** (`src/w5100.c`). SPI frames on /SS = D10, the common and socket
  registers, commands and state machine, 2 KB ring buffers, bridged to host TCP.
- **DS1307** (`src/ds1307.c`). BCD registers, pointer, START latch, 1 Hz tick in
  simulated time.
- **Alarm inputs**: fixed ADC counts on A0..A3 (`POST /sensors` to change them).
- **Wiegand readers**: pulse trains on D2..D5 with the timing above.
- **Relays**: the pin levels on D6..D9, timestamped. No coil or lock delay.
- **EEPROM timing**: simavr writes instantly; we hold EEPE for the chip's
  3.3 ms per byte, so a 5-byte `?m` costs about 16 ms as on the chip.

### W5100 model: what the driver relies on

Read from `lib/Ethernet` (Arduino 1.0.3): every register access is one 4-byte
SPI frame with /SS toggled; `execCmdSn` writes Sn_CR and spins until it reads
0; `send()` polls TX_FSR, copies into the ring at `TX_WR & 0x7FF`, issues SEND
and spins on SEND_OK (or SR == CLOSED); `recv()` reads RX_RSR twice, reads one
byte at `RX_RD & 0x7FF`, bumps RX_RD and issues RECV; `EthernetServer` keeps
exactly one socket in LISTEN and only opens the next one on the following
`server.available()`; `client.stop()` issues DISCON and polls for CLOSED for up
to 1 s before CLOSE.

Decisions where the datasheet is vague or the host forces a choice:

- **No listener, no connection.** A host listener exists only while a socket is
  in LISTEN. With none, the host kernel answers SYN with RST, as the chip does.
  Accepted connections go to the lowest LISTEN socket; if none is left listening
  the host listener is closed, which resets anything queued behind it. So, as on
  the board, five simultaneous connections give one reply and four refusals
  until the firmware's next `loop()` opens another LISTEN socket. Through
  Docker Desktop's port forwarding a refusal looks like an accepted connection
  that closes with no data. Inside the Docker network it is ECONNREFUSED, or
  ECONNRESET for a connection the host kernel had already completed before the
  listener closed (the chip would have refused it). The listener backlog is
  deep on purpose: with a full accept queue Linux drops SYNs silently, the
  client retries a second later and could then be served, which the chip
  never does.
- **SEND_OK** is raised after the frame's wire time at 100 Mb/s (about 6 us for
  a 1-byte segment). The datasheet only says "when SEND completes". If the real
  chip waits for the peer's ACK, replies made of many small writes (the help
  page and `?a`) are slower on the board than here, especially against a peer
  that delays ACKs.
- **TX space** frees as soon as the host kernel takes the bytes, i.e. an
  instantly-ACKing LAN peer. Each SEND is one `send()` with TCP_NODELAY, so it is
  normally one segment, as on the wire from the chip (`client.print(char)` makes
  one-byte segments).
- **Peer FIN** moves ESTABLISHED to CLOSE_WAIT; **peer RST** moves to CLOSED.
  **DISCON** shuts down our write side (FIN); from ESTABLISHED we go to FIN_WAIT
  and to CLOSED when the peer's FIN arrives, from CLOSE_WAIT to LAST_ACK and to
  CLOSED one `W5100_RTT_US` later. **CLOSE** drops the socket; if no FIN was sent
  the host connection is aborted with RST.
- **Full RX buffer**: the host socket is not read (the chip would advertise a
  zero window) and not polled, so a peer that hung up behind unread data is
  noticed only when the firmware reads or closes.
- **OPEN** resets the socket's pointers to 0. **RECV** commits the driver's
  RX_RD; RX_RSR is bytes received minus that. **MR bit 7** resets every register
  to its datasheet value and drops all connections.
- **Not bridged**: UDP/IPRAW/MACRAW traffic (sockets open, SEND completes, nothing
  goes out), outbound CONNECT (times out after RTR x (RCR+1)), ARP, retransmission,
  TCP windows. The firmware uses none of them.

### simavr

simavr is built from the `v1.8` release tag (commit `f44723e8`), pinned in the
Dockerfile, rather than Debian's `libsimavr-dev` (1.6 in bookworm), so both
architectures get the same, newest code. Two findings:

- **`avr_make_mcu_by_name("atmega328p")` returns an ATmega324A in v1.8.**
  `cores/sim_mega324a.c` fills all four slots of `names[4]` with no NULL
  terminator, so the name search runs into the next core's names. The firmware
  then runs with the 324A's vector table and resets on its first timer
  interrupt (simavr's own `run_avr` does the same). `main.c` takes the
  `mega328` core directly and checks its name.
- **ADC conversion time.** v1.8 multiplies the start delay into the prescaler
  it later uses for the 11 remaining ADC clocks, so a conversion takes 24 ADC
  clocks instead of 13 (192 us instead of 104 us), and the first one 168
  instead of 25 (1.3 ms instead of 0.2 ms).
  `patches/0001-adc-conversion-time.patch` fixes it. It matters because
  `loop()` calls `pollAlarm()` (20 ms + one conversion) four or more times.

EEPROM addresses at or above 1024: simavr masks with `size - 1` (and logs an
error), which is what the ATmega328P does with the unimplemented EEARH bits.
So no extra wrap model was needed; the tests check bytes 0..4 after `?m200`.

## Firmware behaviour worth knowing

Found by running the binary; all covered by tests.

- **checkSuperuser grants every unknown card in this build.** The loop is
  `for (i = 0; i <= numUsers; i++)` over a three-entry array. avr-gcc 7.3
  (PlatformIO's toolchain) treats the read of `superUserList[3]` as undefined
  behaviour and concludes the loop must match by `i = 2`: the compiled code
  compares the tag with `adam` and `bob` and then returns "superuser 2"
  without ever comparing with `carl`. Any card that is not in the EEPROM is
  logged G/g and opens the door after the 1 s brute-force delay and a second
  chirp. The D/d (denied) path is unreachable. The 2013 build (Arduino 1.0.3,
  avr-gcc 4.3.2) predates `-faggressive-loop-optimizations` (GCC 4.8), so it
  most likely compiled the loop literally and compared the fourth time with
  whatever word follows the array; that cannot be checked here. **Do not flash
  the PlatformIO build to a real door** until the loop is `i < numUsers`.
  Building with `--build-arg FIRMWARE_FLAGS=-fno-aggressive-loop-optimizations`
  restores the comparisons (it then also treats tag 0 as a superuser); the
  swipe test checks whichever build it is given.
- **`?w` sets the clock to garbage.** It has no `break`, falls into `?x`, which
  parses `?x` that is not there, so the clock becomes 2000-00-00 with a day of
  week taken from the character `/`. `?x` itself passes the day-of-week ASCII
  character (`'4'` = 52) through `decToBcd`.
- **`?v=N` never changes the log level**: it reads `offset + 2`, the `=`.
- **Logout counts as a failed login.** `&e=` and `?e=0000` call `login(0)`,
  which increments the failure counter (and starts the 5-minute window if it was
  0) and answers `authfail` for `?e=0000`. A good login resets the counter.
- **The log's 41st entry** writes its key into the low byte of `logCursor` and
  its value over the keys of entries 0 and 1 (`logData[40]` is `logKeys[0..1]`
  in this build's RAM layout). The cursor then restarts at 0.
- **The keypad window only exists in the first 5 s after boot.** The local
  `keypadTime` in `processTagAccess` shadows the global, which stays 0, so the
  `millis() - keypadTime <= 5000` wait only runs before 5 s of uptime. After
  that every granted swipe immediately logs an empty keypad command `C:0 c:0`.
- **`loop()` serves HTTP before it looks at the readers**, so a request that
  arrives with a swipe is answered first.
- **Slot 200** (`?m200`) writes EEPROM bytes 1024..1028, which wrap to 0..4: the
  alarm state and armed bytes. After the next power-up `?9` reports
  `armed` = byte 1 and `activated` = byte 0. `?r200` makes both 255.
- **Requests are cut at 97 characters**: `String(100)` makes the string "100"
  and only 97 more characters fit under the 100 cap.
- **Responses** are `HTTP/1.1 200 OK`, `Cache-Control: no-store`,
  `Content-Type: text/html`, no Content-Length, then the board closes the
  connection (FIN). Strings from flash go out one character per TCP segment.

## Tests

```sh
node --test --test-concurrency=1 'sim/avr/test/*.test.mjs'   # starts door-sim-avr itself
node sim/avr/test/latency.mjs 5                               # latency table below
node sim/avr/test/differential.mjs > /tmp/diff.md             # vs the JS simulator
```

Set `BOARD_URL` and `CONTROL_URL` to test a running instance instead,
`DOOR_SIM_IMAGE` for another image tag, `PASSWORD` if it is not 1234, and
`LOCKOUT_SPEED` (default 0, flat out) for the 5-minute lockout test.

### Results (2026-11-18, Docker Desktop on an Apple M1, linux/arm64)

35 of 35 pass against the default image in about 134 s; the lockout test runs
the 300 simulated seconds in 44 s. The swipe group also passes against a
`FIRMWARE_FLAGS=-fno-aggressive-loop-optimizations` build, where the unknown
card is denied (D/d) after the same 1 s delay. The linux/amd64 image, run
under QEMU on the same Mac at 0.37x real time, passes the other 33 (lockout
and EEPROM-file tests skipped for time) in 258 s. Timing assertions use the
board's simulated clock, so they hold when the host is slower than real time.

| Group | Tests |
|---|---|
| HTTP framing | help page on `GET /`; `?9` JSON without login; no Content-Length and a FIN from the board; 97-character request cap |
| Login | bare `?u` gives "Not logged in." and logs F 2; `?e=PW` stays logged in; `?cmd&e=PW` logs out after; wrong password is exactly `authfail`; `?e=0000` logs out with `authfail` |
| Doors | `?o1` "Opened 1.", D6 high 5000-5300 ms, status still locked, log U then L, no chirp; `?u=1` stays unlocked, 3 chirps; `?l` no chirp; `?l=1` 3 chirps of 100/200 ms; `?u` 3 chirps |
| Users | exact replies for `?m010...`, `?a` (200 slots), `?s010`, `?r010`; EEPROM bytes; `err:query`; slot 200 writes bytes 0..4 and changes `?9` after a power cycle |
| Log | exactly 40 lines, `?y` clears; the 41st entry corrupts keys 0 and 1 |
| Swipes | mask 1 opens D6 ~5 s and logs G/g; mask 255 logs f; mask 0 logs G/g without opening; unknown tag blocks the board for the 1 s delay and then (this build) is granted as superuser; facility/card frames; reader 2 drives D8; tags over 26 bits refused |
| Alarm | `?2` blocks 6.1-6.2 s for 20 chirps (span 5800 ms); `?1` disarms |
| Connections | 5 simultaneous: 1 served, 4 get nothing; inside the Docker network the 4 are refused/reset at once; a 4 KB body that fills the RX buffer is answered and simulated time never runs ahead of the wall clock while `client.stop()` waits |
| EEPROM file | the card table survives `docker stop` and a new container on the same volume |
| Lockout | 5 wrong passwords, then the right one is refused at 0 s and at 290 s and accepted at 300.5 s (SPEED 0) |

### Exact replies

From a fresh default board, logged in once with `?e=1234`, in this order (the
JSON's `armed` follows from the earlier commands):

```
?9     {\r\n"armed":0,"activated":0\r\n,"alarm_3":0\r\n,"alarm_2":0\r\n,"door_1_locked":1\r\n,"door_2_locked":1\r\n}\r\n
?o1    Opened 1.
?u=1   Unlocked 1.{\r\n"armed":4,"activated":0\r\n,"alarm_3":0\r\n,"alarm_2":0\r\n,"door_1_locked":0\r\n,"door_2_locked":1\r\n}\r\n
?l     Locked all.{\r\n"armed":4,"activated":0\r\n,"alarm_3":0\r\n,"alarm_2":0\r\n,"door_1_locked":1\r\n,"door_2_locked":1\r\n}\r\n
?l=1   {\r\n"armed":4,"activated":0\r\n,"alarm_3":0\r\n,"alarm_2":0\r\n,"door_1_locked":1\r\n,"door_2_locked":1\r\n}\r\n
?m010&p001&t0012ABCD
       <pre>\r\nprev:\r\n10\t255\tFFFFFFFF\r\ncur:\r\n10\t1\t12ABCD\r\n</pre>\r\n
?r010  r\r\n<pre>\r\nprev:\r\n10\t1\t12ABCD\r\ncur:\r\n10\t255\tFFFFFFFF\r\n
?a     <pre>\r\nUserNum: Usermask: TagNum:\r\n0\t255\tFFFFFFFF\r\n1\t255\tFFFFFFFF\r\n2\t255\tFFFFFFFF\r\n
       ... one line per slot up to 199\t255\tFFFFFFFF\r\n, then </pre>\r\n
?z     (on a board that only ran ?o1 and its relock)
       <pre>\r\nU: 1\r\nL: 1\r\n\0: 0\r\n\0: 0\r\n ... 40 entry lines in all, then </pre>\r\n
?y     y\r\n
```

`?r` has no closing `</pre>`. `\0` is a NUL byte: an empty log slot prints its
key, which is 0. Every reply starts with the header block
`HTTP/1.1 200 OK\r\nCache-Control: no-store\r\nContent-Type: text/html\r\n\r\n`,
then `authok\r\n` if the request carried `&e=PW`.

### Measured latency

`node sim/avr/test/latency.mjs 5`: Node `fetch` from the Mac host through Docker
port forwarding, `?cmd&e=1234` as door-api sends it, a freshly power-cycled
board for every run, median of 5.

| Command | median ms | min | max | body bytes |
|---|---:|---:|---:|---:|
| help page | 141 | 110 | 158 | 128 |
| ?9 (no login) | 172 | 145 | 183 | 99 |
| ?e=PW (login only) | 82 | 76 | 148 | 8 |
| wrong password (authfail) | 129 | 87 | 150 | 10 |
| ?u logged out (Not logged in.) | 119 | 85 | 161 | 30 |
| ?s010 | 92 | 84 | 152 | 68 |
| ?m010&p001&t0012ABCD | 145 | 121 | 176 | 66 |
| ?r010 | 148 | 108 | 171 | 61 |
| ?a (200 slots) | 531 | 524 | 561 | 3541 |
| ?z (40 entries) | 171 | 167 | 178 | 263 |
| ?y | 108 | 86 | 122 | 11 |
| ?o1 | 149 | 110 | 160 | 17 |
| ?u=1 | 1041 | 1032 | 1087 | 118 |
| ?u (all) | 1073 | 1060 | 1091 | 120 |
| ?l (all) | 189 | 129 | 197 | 118 |
| ?l=1 | 1076 | 1032 | 1101 | 107 |
| ?1 (disarm) | 480 | 434 | 506 | 107 |
| ?2 (arm) | 6161 | 6137 | 6180 | 107 |
| ?3 (train) | 1165 | 1137 | 1193 | 107 |

Most of a simple command is the wait for `loop()` (an idle pass is about 80 ms:
four `pollAlarm()` calls with `delay(20)` each) and reading the request one byte
at a time over SPI (21 four-byte register frames per byte, measured: RX_RSR
read twice, RX_RD read and written, the byte, RECV, Sn_SR). `?9` and every
command that prints the status add two more `pollAlarm()` calls. After `?o1`
or `?u` the alarm is in chime mode (4), which adds two `pollAlarm()` calls to
every pass, and after `?2` (armed) four.

## Known gaps

- **Which binary is on the door.** This runs the PlatformIO build. The board on
  the wall may run a 2013 Arduino IDE 1.0.3 build. Anything that depends on code
  generation can differ: the superuser check above, the RAM layout behind the
  log overflow, and timing at the microsecond level.
- **W5100 SEND_OK and TCP details** as described above; the host's TCP stack
  shapes segments, windows and retransmissions.
- **Refusals through Docker Desktop port forwarding** are seen by the client as
  connect-then-close, not ECONNREFUSED.
- **Timing granularity.** Host data reaches the chip at `SLICE_US` boundaries
  (0.5 ms). If the host cannot keep up with `SPEED`, up to 50 ms is caught up and
  the rest is dropped (`slipMs`), so the board never fast-forwards. simavr runs
  about 7x real time on an Apple M1 in Docker, and 0.37x for the amd64 image
  under QEMU on the same Mac, so use the native image; on an amd64 server or
  GitHub runner the amd64 image runs natively.
- **DS1307** counts nonsense dates (the datasheet calls it undefined) with
  ordinary BCD rollover, and runs on simulated time, so it runs fast at
  SPEED > 1. Day of week is 1 = Sunday when loaded from the host clock.
- **Sensors** are constant voltages; there is no noise, so a trained zone never
  trips by itself.
- **Not exercised by the tests**: keypad entry on reader 2 (send 4-bit frames
  with `bits: 4`), the armed alarm actually triggering, mask 10 and mask 20
  cards, `?3` training values.
- simavr is GPLv3; the image contains it built from source.
