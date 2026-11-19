/*
 * sim.h - shared declarations for the door-board emulator.
 *
 * The emulator runs the real Open Access Control Ethernet firmware ELF on
 * simavr's ATmega328P core and surrounds it with small models of the parts on
 * the board: the W5100 Ethernet chip (w5100.c), the DS1307 clock (ds1307.c),
 * the Wiegand readers (wiegand.c), and the relays, alarm sensors and EEPROM
 * (board.c). control.c serves the JSON control API and main.c paces the CPU
 * against the wall clock.
 */
#ifndef DOOR_SIM_H
#define DOOR_SIM_H

#include <stdint.h>
#include <stddef.h>
#include <poll.h>
#include "sim_avr.h"

#define CPU_HZ 16000000ULL
#define US_TO_CYCLES(us) ((avr_cycle_count_t)((us) * (CPU_HZ / 1000000ULL)))

static inline double cycles_to_ms(avr_cycle_count_t c) { return (double)c / (CPU_HZ / 1000.0); }

/* Growable text buffer for HTTP replies. */
typedef struct { char *s; size_t len, cap; } sbuf_t;
void sb_printf(sbuf_t *b, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
void sb_append(sbuf_t *b, const void *data, size_t n);
void sb_free(sbuf_t *b);

/* The poll set is rebuilt on every housekeeping pass from every module. */
typedef void (*io_cb)(void *ctx, int fd, short revents);
#define MAX_POLL 48
typedef struct { struct pollfd fds[MAX_POLL]; io_cb cb[MAX_POLL]; void *ctx[MAX_POLL]; int n; } pollset_t;
void ps_add(pollset_t *ps, int fd, short events, io_cb cb, void *ctx);

void logmsg(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
const char *env_str(const char *name, const char *def);
long env_long(const char *name, long def);
double env_double(const char *name, double def);

/* Open a non-blocking IPv4 TCP listener on 0.0.0.0:port. -1 on error. */
int tcp_listen(int port, int backlog);
void set_nonblock(int fd);

/* Tiny JSON helpers for the flat request bodies the control API takes. */
int json_num(const char *body, const char *key, double *out);
int json_str(const char *body, const char *key, char *out, size_t n);
int json_num_array(const char *body, const char *key, double *out, int max);

/* Modules. */
typedef struct w5100 w5100_t;
typedef struct ds1307 ds1307_t;
typedef struct wiegand wiegand_t;
typedef struct board board_t;
typedef struct control control_t;

/* Process-wide state, owned by main.c. */
typedef struct sim {
	avr_t *avr;
	w5100_t *w5100;
	ds1307_t *rtc;
	wiegand_t *wiegand;
	board_t *board;
	control_t *control;
	const char *firmware;
	double speed;		/* simulated seconds per wall second; 0 = unpaced */
	uint64_t wall_base_ns;	/* wall time that matches cycle_base */
	avr_cycle_count_t cycle_base;
	double slip_ms;		/* simulated time the host could not keep up with */
	int boots;		/* power-on count; /reset increments it */
	int board_port;
	const char *cpu_state;
} sim_t;

extern sim_t SIM;

void sim_power_cycle(int restore_default_eeprom);
void sim_set_speed(double speed);
uint64_t mono_ns(void);

#endif
