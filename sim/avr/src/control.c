/*
 * control.c - the test control API.
 *
 *   GET  /health                       simulated time, pacing, CPU state
 *   GET  /pins[?since=ms]              relay levels and edge timeline (ms since boot)
 *   GET  /eeprom[?format=json]         1024-byte EEPROM as a hex dump
 *   GET  /sockets                      W5100 socket table
 *   GET  /rtc                          DS1307 registers
 *   POST /swipe   {"reader":1,"tag":N[,"bits":26]} or {"facility":F,"card":C}
 *                 replies once the last bit has been clocked out
 *   POST /sensors {"a0":512,...} or {"values":[a0,a1,a2,a3]}  (ADC counts)
 *   POST /reset   [{"eeprom":"keep"|"default"}]  power-cycle the board
 *   POST /speed   {"speed":10}         change the SPEED factor (0 = unpaced)
 *
 * Runs in the emulator's single thread from the same poll loop as the W5100.
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <unistd.h>

#include "board.h"
#include "control.h"
#include "ds1307.h"
#include "w5100.h"
#include "wiegand.h"

#define MAX_CONN 16
#define MAX_REQ 16384

typedef struct conn {
	control_t *c;
	int fd;
	sbuf_t in, out;
	size_t out_off;
	int waiting;	/* reply deferred until a swipe finishes */
	unsigned gen;	/* guards deferred callbacks against reuse of the slot */
} conn_t;

struct control {
	int lfd;
	conn_t conns[MAX_CONN];
};

typedef struct swipe_wait { conn_t *k; unsigned gen; int reader; uint32_t tag; int bits; } swipe_wait_t;

static void conn_close(conn_t *k)
{
	if (k->fd >= 0)
		close(k->fd);
	k->fd = -1;
	sb_free(&k->in);
	sb_free(&k->out);
	k->out_off = 0;
	k->waiting = 0;
	k->gen++;
}

static void reply(conn_t *k, int code, const char *body)
{
	const char *reason = code == 200 ? "OK" : code == 400 ? "Bad Request" : code == 404 ? "Not Found" :
			     code == 503 ? "Service Unavailable" : "Error";
	sb_printf(&k->out, "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n",
		  code, reason, body[0] == '{' ? "application/json" : "text/plain", strlen(body));
	sb_append(&k->out, body, strlen(body));
	k->waiting = 0;
}

static void reply_err(conn_t *k, int code, const char *msg)
{
	sbuf_t b = { 0 };
	sb_printf(&b, "{\"ok\":false,\"error\":\"%s\"}", msg);
	reply(k, code, b.s);
	sb_free(&b);
}

static void swipe_done(void *ctx, int ok, double start_ms, double end_ms)
{
	swipe_wait_t *sw = ctx;
	conn_t *k = sw->k;
	if (k->gen == sw->gen && k->fd >= 0) {
		if (!ok) {
			reply_err(k, 503, "board was reset before the frame finished");
		} else {
			sbuf_t b = { 0 };
			sb_printf(&b, "{\"ok\":true,\"reader\":%d,\"tag\":%u,\"bits\":%d,\"startMs\":%.3f,\"endMs\":%.3f}",
				  sw->reader, sw->tag, sw->bits, start_ms, end_ms);
			reply(k, 200, b.s);
			sb_free(&b);
		}
	}
	free(sw);
}

static void health(sbuf_t *b)
{
	avr_t *avr = SIM.avr;
	double sim_ms = cycles_to_ms(avr->cycle);
	double wall_ms = (mono_ns() - SIM.wall_base_ns) / 1e6;
	sb_printf(b, "{\"ok\":true,\"cpu\":\"%s\",\"boots\":%d,\"simMs\":%.3f,\"wallMs\":%.3f,\"speed\":%g,"
		  "\"behindMs\":%.3f,\"slipMs\":%.3f,\"boardPort\":%d,\"firmware\":\"%s\",\"rtc\":",
		  SIM.cpu_state, SIM.boots, sim_ms, wall_ms, SIM.speed,
		  SIM.speed > 0 ? wall_ms * SIM.speed - sim_ms : 0.0, SIM.slip_ms, SIM.board_port, SIM.firmware);
	ds1307_json(SIM.rtc, b);
	sb_printf(b, ",\"sensors\":[%d,%d,%d,%d],\"build\":\"", board_sensor(SIM.board, 0), board_sensor(SIM.board, 1),
		  board_sensor(SIM.board, 2), board_sensor(SIM.board, 3));
	/* the firmware build record (flags, PlatformIO and toolchain versions) */
	FILE *f = fopen(env_str("FIRMWARE_INFO", "/opt/door/BUILDINFO"), "r");
	for (int c; f && (c = fgetc(f)) != EOF;) {
		if (c == '"' || c == '\\')
			sb_printf(b, "\\%c", c);
		else if (c == '\n')
			sb_printf(b, "\\n");
		else if (c >= 0x20 && c < 0x7f)
			sb_printf(b, "%c", c);
	}
	if (f)
		fclose(f);
	sb_printf(b, "\"}");
}

static void route(conn_t *k, const char *method, const char *path, const char *body)
{
	sbuf_t b = { 0 };
	char route[256];
	const char *q = strchr(path, '?');
	size_t rl = q ? (size_t)(q - path) : strlen(path);
	if (rl >= sizeof route)
		rl = sizeof route - 1;
	memcpy(route, path, rl);
	route[rl] = 0;
	int get = !strcmp(method, "GET"), post = !strcmp(method, "POST");

	if (get && !strcmp(route, "/health")) {
		health(&b);
	} else if (get && !strcmp(route, "/pins")) {
		double since = -1;
		const char *s = q ? strstr(q, "since=") : NULL;
		if (s)
			since = strtod(s + 6, NULL);
		board_pins_json(SIM.board, &b, since);
	} else if (get && !strcmp(route, "/eeprom")) {
		board_eeprom_hex(SIM.board, &b, q && strstr(q, "format=json"));
	} else if (get && !strcmp(route, "/sockets")) {
		w5100_json(SIM.w5100, &b);
	} else if (get && !strcmp(route, "/rtc")) {
		ds1307_json(SIM.rtc, &b);
	} else if (post && !strcmp(route, "/swipe")) {
		double reader = 1, tag = -1, bits = 26, fac, card;
		json_num(body, "reader", &reader);
		json_num(body, "bits", &bits);
		if (json_num(body, "facility", &fac) && json_num(body, "card", &card))
			tag = wiegand26_frame((unsigned)fac, (unsigned)card);
		else if (!json_num(body, "tag", &tag))
			tag = -1;
		if ((reader != 1 && reader != 2) || bits < 1 || bits > 32 || tag < 0 ||
		    (bits < 32 && tag >= (double)(1ULL << (int)bits))) {
			reply_err(k, 400, "need reader 1|2, tag 0..2^bits-1 (or facility+card), bits 1..32");
			return;
		}
		swipe_wait_t *sw = malloc(sizeof *sw);
		*sw = (swipe_wait_t){ k, k->gen, (int)reader, (uint32_t)tag, (int)bits };
		if (wiegand_queue(SIM.wiegand, sw->reader, sw->tag, sw->bits, swipe_done, sw) < 0) {
			free(sw);
			reply_err(k, 503, "swipe queue full");
			return;
		}
		k->waiting = 1;
		return;
	} else if (post && !strcmp(route, "/sensors")) {
		double v[4];
		int n = json_num_array(body, "values", v, 4);
		for (int i = 0; i < n; i++)
			board_set_sensor(SIM.board, i, (int)v[i]);
		for (int i = 0; i < 4; i++) {
			char key[4] = { 'a', '0' + i, 0 };
			double d;
			if (json_num(body, key, &d))
				board_set_sensor(SIM.board, i, (int)d);
		}
		sb_printf(&b, "{\"ok\":true,\"sensors\":[%d,%d,%d,%d]}", board_sensor(SIM.board, 0),
			  board_sensor(SIM.board, 1), board_sensor(SIM.board, 2), board_sensor(SIM.board, 3));
	} else if (post && !strcmp(route, "/reset")) {
		char mode[16] = "keep";
		json_str(body, "eeprom", mode, sizeof mode);
		if (strcmp(mode, "keep") && strcmp(mode, "default")) {
			reply_err(k, 400, "eeprom must be keep or default");
			return;
		}
		sim_power_cycle(!strcmp(mode, "default"));
		sb_printf(&b, "{\"ok\":true,\"boots\":%d,\"eeprom\":\"%s\"}", SIM.boots, mode);
	} else if (post && !strcmp(route, "/speed")) {
		double s;
		if (!json_num(body, "speed", &s) || s < 0 || s > 1000) {
			reply_err(k, 400, "need speed 0..1000 (0 = as fast as possible)");
			return;
		}
		sim_set_speed(s);
		sb_printf(&b, "{\"ok\":true,\"speed\":%g}", SIM.speed);
	} else {
		reply_err(k, 404, "no such endpoint");
		return;
	}
	reply(k, 200, b.s);
	sb_free(&b);
}

/* Parse once the headers and Content-Length bytes of body are in. */
static void try_request(conn_t *k)
{
	char *hend = k->in.s ? strstr(k->in.s, "\r\n\r\n") : NULL;
	if (!hend) {
		if (k->in.len > MAX_REQ)
			reply_err(k, 400, "request too large");
		return;
	}
	size_t clen = 0;
	for (char *h = strstr(k->in.s, "\r\n"); h && h < hend; h = strstr(h + 2, "\r\n"))
		if (!strncasecmp(h + 2, "content-length:", 15))
			clen = strtoul(h + 17, NULL, 10);
	size_t hlen = hend + 4 - k->in.s;
	if (k->in.len < hlen + clen)
		return;
	char method[8] = "", path[1024] = "";
	sscanf(k->in.s, "%7s %1023s", method, path);
	char *body = calloc(1, clen + 1);
	memcpy(body, hend + 4, clen);
	route(k, method, path, body);
	free(body);
}

static void conn_io(void *ctx, int fd, short revents)
{
	conn_t *k = ctx;
	if (k->fd != fd)
		return;
	if ((revents & (POLLIN | POLLHUP | POLLERR)) && !k->waiting && !k->out.len) {
		char buf[4096];
		ssize_t n = recv(fd, buf, sizeof buf, 0);
		if (n <= 0) {
			if (n == 0 || (errno != EAGAIN && errno != EINTR))
				conn_close(k);
			return;
		}
		sb_append(&k->in, buf, n);
		try_request(k);
	} else if ((revents & (POLLHUP | POLLERR)) && k->waiting) {
		conn_close(k);	/* client gave up; the swipe still completes */
		return;
	}
	while (k->out.len > k->out_off) {
		ssize_t n = send(fd, k->out.s + k->out_off, k->out.len - k->out_off, MSG_NOSIGNAL);
		if (n < 0) {
			if (errno != EAGAIN && errno != EINTR)
				conn_close(k);
			return;
		}
		k->out_off += n;
	}
	if (k->out.len && k->out_off == k->out.len)
		conn_close(k);
}

static void accept_io(void *ctx, int fd, short revents)
{
	control_t *c = ctx;
	for (;;) {
		int s = accept(fd, NULL, NULL);
		if (s < 0)
			return;
		set_nonblock(s);
		conn_t *k = NULL;
		for (int i = 0; i < MAX_CONN && !k; i++)
			if (c->conns[i].fd < 0)
				k = &c->conns[i];
		if (!k) {
			close(s);
			continue;
		}
		k->fd = s;
	}
}

control_t *control_new(int port)
{
	control_t *c = calloc(1, sizeof *c);
	for (int i = 0; i < MAX_CONN; i++)
		c->conns[i] = (conn_t){ .c = c, .fd = -1 };
	c->lfd = tcp_listen(port, 16);
	if (c->lfd < 0) {
		logmsg("cannot listen on control port %d: %s", port, strerror(errno));
		exit(2);
	}
	return c;
}

void control_add_fds(control_t *c, pollset_t *ps)
{
	ps_add(ps, c->lfd, POLLIN, accept_io, c);
	for (int i = 0; i < MAX_CONN; i++) {
		conn_t *k = &c->conns[i];
		if (k->fd < 0)
			continue;
		short ev = k->out.len > k->out_off ? POLLOUT : (k->waiting ? 0 : POLLIN);
		ps_add(ps, k->fd, ev, conn_io, k);
	}
}
