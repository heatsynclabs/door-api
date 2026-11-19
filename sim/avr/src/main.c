/*
 * main.c - door-board emulator: the real door firmware ELF on simavr's
 * ATmega328P at 16 MHz, paced against the wall clock.
 *
 * The CPU runs in slices of SLICE_US (default 500) simulated microseconds.
 * Between slices the emulator services host sockets (W5100 bridge, control
 * API) and, when simulated time is ahead of wall time * SPEED, sleeps in
 * ppoll() until it should continue, waking early for network traffic. If the host cannot keep
 * up, up to MAX_BEHIND_MS is caught up by running flat out and anything
 * beyond that is written off as "slip" (reported by /health) so the board
 * never fast-forwards.
 *
 * Environment: see README.md.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "sim_avr.h"
#include "sim_elf.h"
#include "avr_ioport.h"

#include "board.h"
#include "control.h"
#include "ds1307.h"
#include "sim.h"
#include "w5100.h"
#include "wiegand.h"

#define MAX_BEHIND_MS 50

/* Simulated microseconds per CPU slice (SLICE_US). Host I/O is looked at
 * between slices, so this is also the granularity at which network data
 * reaches the W5100 in simulated time. */
static long slice_us = 500;

extern avr_kind_t mega328;	/* simavr cores/sim_mega328.c */

sim_t SIM = { .cpu_state = "running" };

static volatile sig_atomic_t stopping;
static void on_signal(int sig) { stopping = 1; }

void sim_set_speed(double speed)
{
	SIM.speed = speed;
	SIM.wall_base_ns = mono_ns();
	SIM.cycle_base = SIM.avr->cycle;
}

/* Everything that happens on a power-up after avr_reset(). */
static void peripherals_power_on(void)
{
	/* avr_reset() zeroes the I/O registers but simavr's pin IRQs keep their
	 * last level, which would filter out the first real edge. Start them
	 * from 0 like the registers. */
	for (char port = 'B'; port <= 'D'; port++)
		for (int i = 0; i < 8; i++)
			avr_io_getirq(SIM.avr, AVR_IOCTL_IOPORT_GETIRQ(port), i)->value = 0;
	w5100_power_on(SIM.w5100);
	board_power_on(SIM.board);
	wiegand_power_on(SIM.wiegand);
	SIM.cycle_base = 0;
	SIM.wall_base_ns = mono_ns();
	SIM.boots++;
	SIM.cpu_state = "running";
}

void sim_power_cycle(int restore_default_eeprom)
{
	ds1307_before_reset(SIM.rtc);
	avr_reset(SIM.avr);	/* cycle counter and timers restart; EEPROM is kept */
	ds1307_after_reset(SIM.rtc);
	if (restore_default_eeprom)
		board_default_eeprom(SIM.board);
	peripherals_power_on();
	logmsg("power cycled (boot %d, EEPROM %s)", SIM.boots, restore_default_eeprom ? "default" : "kept");
}

static void parse_sensors(int out[4])
{
	const char *s = env_str("SENSORS", "512,512,512,512");
	for (int i = 0; i < 4; i++)
		out[i] = 512;
	for (int i = 0; i < 4 && s && *s; i++) {
		out[i] = (int)strtol(s, (char **)&s, 0);
		if (*s == ',')
			s++;
	}
	for (int i = 0; i < 4; i++) {
		char name[16];
		snprintf(name, sizeof name, "SENSOR_A%d", i);
		out[i] = (int)env_long(name, out[i]);
		if (out[i] < 0 || out[i] > 1023) {
			logmsg("sensor A%d=%d is outside 0..1023", i, out[i]);
			exit(2);
		}
	}
}

static time_t rtc_start(void)
{
	const char *s = env_str("RTC_TIME", NULL);
	if (!s)
		return time(NULL);
	struct tm tm = { 0 };
	if (!strptime(s, "%Y-%m-%dT%H:%M:%S", &tm)) {
		logmsg("RTC_TIME=%s is not YYYY-MM-DDTHH:MM:SS", s);
		exit(2);
	}
	tm.tm_isdst = -1;
	return mktime(&tm);
}

/* Sleep or poll between CPU slices, keeping simulated time on the wall clock. */
static void housekeeping(void)
{
	static uint64_t last_flush;
	pollset_t ps = { .n = 0 };
	w5100_add_fds(SIM.w5100, &ps);
	control_add_fds(SIM.control, &ps);

	int64_t wait_ns = 0;
	uint64_t now = mono_ns();
	if (SIM.speed > 0) {
		double sim_wall_ns = (double)(SIM.avr->cycle - SIM.cycle_base) * 1e9 / CPU_HZ / SIM.speed;
		wait_ns = (int64_t)(SIM.wall_base_ns + sim_wall_ns) - (int64_t)now;
		int64_t max_behind = (int64_t)MAX_BEHIND_MS * 1000000;
		if (wait_ns < -max_behind) {
			SIM.slip_ms += (double)(-wait_ns - max_behind) / 1e6 * SIM.speed;
			SIM.wall_base_ns += -wait_ns - max_behind;
			wait_ns = -max_behind;
		}
	}
	if (strcmp(SIM.cpu_state, "running"))
		wait_ns = 50 * 1000000LL;	/* CPU stopped: just serve the control API */
	struct timespec ts = { 0, 0 };
	if (wait_ns > 0) {
		ts.tv_sec = wait_ns / 1000000000LL;
		ts.tv_nsec = wait_ns % 1000000000LL;
	}
	int n = ppoll(ps.fds, ps.n, &ts, NULL);
	for (int i = 0; n > 0 && i < ps.n; i++)
		if (ps.fds[i].revents)
			ps.cb[i](ps.ctx[i], ps.fds[i].fd, ps.fds[i].revents);

	if (now - last_flush > 100000000ULL) {
		board_flush_eeprom(SIM.board);
		last_flush = now;
	}
}

int main(int argc, char **argv)
{
	setvbuf(stderr, NULL, _IOLBF, 0);
	SIM.firmware = argc > 1 ? argv[1] : env_str("FIRMWARE", "/opt/door/firmware.elf");
	SIM.board_port = (int)env_long("BOARD_PORT", 80);
	int control_port = (int)env_long("CONTROL_PORT", 9199);
	slice_us = env_long("SLICE_US", slice_us);
	if (slice_us < 10 || slice_us > 100000) {
		logmsg("SLICE_US must be 10..100000");
		return 2;
	}
	double speed = env_double("SPEED", 1);
	if (speed < 0) {
		logmsg("SPEED must be >= 0");
		return 2;
	}
	int sensors[4];
	parse_sensors(sensors);

	elf_firmware_t fw = { { 0 } };
	if (elf_read_firmware(SIM.firmware, &fw)) {
		logmsg("cannot read firmware %s", SIM.firmware);
		return 2;
	}
	strcpy(fw.mmcu, "atmega328p");
	fw.frequency = CPU_HZ;
	/* Not avr_make_mcu_by_name(): in simavr v1.8 sim_mega324a.c fills all
	 * four slots of names[4] with no NULL terminator, so the name search
	 * runs off its end into the next core's names and "atmega328p" comes
	 * back as an ATmega324A (wrong vector table). Take the core directly. */
	avr_t *avr = mega328.make();
	if (!avr || strcmp(avr->mmcu, "atmega328")) {
		logmsg("simavr's ATmega328 core is missing or wrong (%s)", avr ? avr->mmcu : "none");
		return 2;
	}
	avr_init(avr);
	avr_load_firmware(avr, &fw);
	avr->vcc = avr->avcc = avr->aref = 1023;	/* 1 "mV" per ADC count, see board.c */
	SIM.avr = avr;

	const char *eeprom_file = env_str("EEPROM_FILE", NULL);
	SIM.board = board_new(avr, sensors, eeprom_file);
	SIM.w5100 = w5100_new(avr, SIM.board_port);
	SIM.rtc = ds1307_new(avr, rtc_start());
	SIM.wiegand = wiegand_new(avr);
	SIM.control = control_new(control_port);

	signal(SIGTERM, on_signal);
	signal(SIGINT, on_signal);
	signal(SIGPIPE, SIG_IGN);

	sim_power_cycle(0);
	SIM.boots = 1;
	sim_set_speed(speed);
	logmsg("running %s: board HTTP on :%d (chip port 80), control API on :%d, SPEED=%g, sensors %d,%d,%d,%d, EEPROM %s",
	       SIM.firmware, SIM.board_port, control_port, speed, sensors[0], sensors[1], sensors[2], sensors[3],
	       eeprom_file ? eeprom_file : "in memory");

	while (!stopping) {
		if (!strcmp(SIM.cpu_state, "running")) {
			avr_cycle_count_t end = avr->cycle + US_TO_CYCLES(slice_us);
			while (avr->cycle < end) {
				int st = avr_run(avr);
				if (st == cpu_Done || st == cpu_Crashed) {
					SIM.cpu_state = st == cpu_Crashed ? "crashed" : "stopped";
					logmsg("CPU %s at PC 0x%04x, cycle %llu; POST /reset to restart", SIM.cpu_state,
					       avr->pc, (unsigned long long)avr->cycle);
					break;
				}
			}
		}
		housekeeping();
	}
	board_flush_eeprom(SIM.board);
	logmsg("stopped");
	return 0;
}
