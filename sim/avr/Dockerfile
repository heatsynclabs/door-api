# syntax=docker/dockerfile:1.7
#
# Door-board emulator: the real Open Access Control Ethernet firmware (the
# compiled AVR binary) running under simavr, with a modelled W5100, DS1307,
# ADC inputs and Wiegand readers. See README.md.
#
# Build from the door-api repo root, pointing the "firmware" context at a
# checkout of the PlatformIO port:
#
#   docker build \
#     --build-context firmware=../door-controller-platformio/legacy-ethernet-door-firmware \
#     --build-arg PASSWORD=0x1234 -t door-sim-avr sim/avr
#
# Without --build-context the firmware is cloned from GitHub at FIRMWARE_REF.

ARG DEBIAN_IMAGE=debian:bookworm-20241016-slim
ARG PYTHON_IMAGE=python:3.12.7-slim-bookworm

# ---------------------------------------------------------------------------
# Firmware source. Overridden by --build-context firmware=<dir>.
FROM alpine/git:v2.45.2 AS firmware-git
ARG FIRMWARE_REPO=https://github.com/heatsynclabs/door-controller-platformio.git
ARG FIRMWARE_REF=2ac92da
RUN git clone --quiet "$FIRMWARE_REPO" /src \
 && git -C /src checkout --quiet "$FIRMWARE_REF"

FROM scratch AS firmware
COPY --from=firmware-git /src/legacy-ethernet-door-firmware/ /

# ---------------------------------------------------------------------------
# Build the firmware ELF with PlatformIO, exactly as `pio run -e uno` does in
# the firmware repo. Platform, toolchain and framework are pre-installed at
# pinned versions so the unpinned `platform = atmelavr` resolves to them.
FROM ${PYTHON_IMAGE} AS fw-build
ARG PLATFORMIO_VERSION=6.1.19
ARG ATMELAVR_VERSION=5.1.0
ARG TOOLCHAIN_VERSION=1.70300.191015
ARG FRAMEWORK_VERSION=5.2.0
ENV PLATFORMIO_CORE_DIR=/opt/pio PLATFORMIO_NO_ANSI=1 PLATFORMIO_SETTING_ENABLE_TELEMETRY=No
RUN pip install --no-cache-dir "platformio==${PLATFORMIO_VERSION}" \
 && pio pkg install --global --platform "platformio/atmelavr@${ATMELAVR_VERSION}" \
 && pio pkg install --global --tool "platformio/toolchain-atmelavr@${TOOLCHAIN_VERSION}" \
                             --tool "platformio/framework-arduino-avr@${FRAMEWORK_VERSION}"
COPY --from=firmware / /fw
# PASSWORD is the console password as hex, with or without 0x (?e=XXXX).
# FIRMWARE_FLAGS adds compiler flags for a variant build (empty = exactly
# what `pio run -e uno` produces). See README "checkSuperuser".
ARG PASSWORD=0x1234
ARG FIRMWARE_FLAGS=
RUN set -e; rm -rf /fw/.pio; \
    pw="${PASSWORD#0x}"; pw="${pw#0X}"; \
    echo "$pw" | grep -Eq '^[0-9A-Fa-f]{1,4}$' || { echo "PASSWORD must be 1-4 hex digits, got '$PASSWORD'" >&2; exit 1; }; \
    if ! grep -q '#ifndef PRIVPASSWORD' /fw/src/main.cpp && [ "$((0x$pw))" != "$((0x1234))" ]; then \
      echo "this firmware checkout hard-codes PRIVPASSWORD; build from a checkout with the #ifndef guards" >&2; exit 1; fi; \
    PLATFORMIO_BUILD_FLAGS="-DPRIVPASSWORD=0x$pw $FIRMWARE_FLAGS" pio run -d /fw -e uno > /tmp/build.log 2>&1 \
      || { cat /tmp/build.log; exit 1; }; \
    grep -q "PLATFORM: Atmel AVR (${ATMELAVR_VERSION})" /tmp/build.log \
      || { echo "PlatformIO did not use atmelavr ${ATMELAVR_VERSION}" >&2; exit 1; }; \
    mkdir -p /out; cp /fw/.pio/build/uno/firmware.elf /fw/.pio/build/uno/firmware.hex /out/; \
    { echo "flags=$FIRMWARE_FLAGS"; pio --version; grep -E '^(PLATFORM|PACKAGES|HARDWARE)|^ - ' /tmp/build.log; \
      /opt/pio/packages/toolchain-atmelavr/bin/avr-gcc --version | head -1; \
      grep -E '^(RAM|Flash):' /tmp/build.log; cd /out && sha256sum firmware.hex firmware.elf; } > /out/BUILDINFO; \
    cat /out/BUILDINFO

# ---------------------------------------------------------------------------
# simavr from a pinned upstream release tag, plus the board models.
FROM ${DEBIAN_IMAGE} AS sim-build
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential libelf-dev gcc-avr avr-libc git ca-certificates pkg-config \
 && rm -rf /var/lib/apt/lists/*
ARG SIMAVR_TAG=v1.8
ARG SIMAVR_COMMIT=f44723e8c42431136d5b4de81f789ded56d7e8fa
COPY patches/ /patches/
RUN git clone --quiet --depth 1 --branch "$SIMAVR_TAG" https://github.com/buserror/simavr.git /simavr \
 && test "$(git -C /simavr rev-parse HEAD)" = "$SIMAVR_COMMIT" \
 && git -C /simavr apply /patches/*.patch \
 && make -C /simavr/simavr RELEASE=1 -j"$(nproc)" all >/tmp/simavr-build.log 2>&1 || { tail -40 /tmp/simavr-build.log; exit 1; }
COPY Makefile /door-sim/
COPY src/ /door-sim/src/
RUN make -C /door-sim SIMAVR=/simavr/simavr -j"$(nproc)"

# ---------------------------------------------------------------------------
FROM ${DEBIAN_IMAGE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends libelf1 tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /data --create-home door
COPY --from=sim-build /door-sim/door-sim /usr/local/bin/door-sim
COPY --from=fw-build /out/ /opt/door/
ENV FIRMWARE=/opt/door/firmware.elf \
    FIRMWARE_INFO=/opt/door/BUILDINFO \
    BOARD_PORT=80 \
    CONTROL_PORT=9199 \
    SPEED=1 \
    SENSORS=512,512,512,512 \
    EEPROM_FILE=
USER door
WORKDIR /data
EXPOSE 80 9199
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/door-sim"]
