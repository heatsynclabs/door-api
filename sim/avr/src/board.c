/*
 * board.c - relay outputs, alarm sensor inputs and the EEPROM.
 *
 * Relays: door 1 on D6 (PD6), siren on D7 (PD7), door 2 on D8 (PB0),
 * strobe/chirp on D9 (PB1). Every level change is kept with its simulated
 * time since boot, for GET /pins.
 *
 * Sensors: A0..A3 feed simavr's ADC. AVCC is set to 1023 "mV" in main.c so a
 * value fed in here comes out of analogRead() as exactly that count (simavr
 * scales by 1023, not 1024).
 *
 * EEPROM: simavr stores it and wraps addresses >= 1024 by masking with
 * size - 1, which is what the 328P does (EEARH bits 7:2 are not
 * implemented), so addUser(200) at offset 1024 lands on byte 0. simavr
 * completes a write instantly; the chip takes 3.3 ms during which EEPE stays
 * set and avr-libc's next eeprom_read_byte/eeprom_write_byte spins on it. We
 * model that busy time by setting EEPE again after each write and clearing it
 * 3.3 ms later. Writes mark the image dirty for the optional EEPROM_FILE.
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "avr_adc.h"
#include "avr_eeprom.h"
#include "avr_ioport.h"
#include "board.h"
#include "sim_io.h"
#include "sim_time.h"

#define EECR_ADDR 0x3F	/* data-space address of EECR on the ATmega328P */
#define EERE 0
#define EEPE 1
#define EEMPE 2
#define EEPROM_WRITE_US 3300

#define TIMELINE_MAX 8192

static const struct { int arduino; char port; int bit; const char *name; } relays[4] = {
	{ 6, 'D', 6, "door1" },
	{ 7, 'D', 7, "siren" },
	{ 8, 'B', 0, "door2" },
	{ 9, 'B', 1, "strobe" },
};

typedef struct { avr_cycle_count_t at; uint8_t pin, value; } edge_t;

typedef struct relay_ctx { board_t *b; int idx; } relay_ctx_t;

struct board {
	avr_t *avr;
	int sensors[4];
	avr_irq_t *adc[4];
	relay_ctx_t rctx[4];
	avr_irq_t *relay_irq[4];
	int level[4];
	edge_t *edges;
	size_t nedges, dropped;
	avr_cycle_count_t eempe_at;
	int eempe_armed;
	const char *eeprom_file;
	int dirty;
	uint64_t writes;
};

static uint8_t *eeprom(board_t *b)
{
	avr_eeprom_desc_t d = { .ee = NULL, .offset = 0, .size = EEPROM_SIZE };
	avr_ioctl(b->avr, AVR_IOCTL_EEPROM_GET, &d);
	return d.ee;
}

static void relay_hook(struct avr_irq_t *irq, uint32_t value, void *param)
{
	relay_ctx_t *r = param;
	board_t *b = r->b;
	int v = value ? 1 : 0;
	if (b->level[r->idx] == v)
		return;
	b->level[r->idx] = v;
	if (b->nedges == TIMELINE_MAX) {	/* keep the newest edges */
		memmove(b->edges, b->edges + TIMELINE_MAX / 2, sizeof(edge_t) * TIMELINE_MAX / 2);
		b->nedges = TIMELINE_MAX / 2;
		b->dropped += TIMELINE_MAX / 2;
	}
	b->edges[b->nedges++] = (edge_t){ b->avr->cycle, relays[r->idx].arduino, v };
}

static avr_cycle_count_t eepe_done(avr_t *avr, avr_cycle_count_t when, void *param)
{
	avr->data[EECR_ADDR] &= ~(1 << EEPE);
	return 0;
}

/* Runs after simavr's own EECR handler (simavr chains writers on one address). */
static void eecr_write(struct avr_t *avr, avr_io_addr_t addr, uint8_t v, void *param)
{
	board_t *b = param;
	if ((v & (1 << EEMPE)) && !(v & (1 << EEPE))) {
		b->eempe_armed = 1;
		b->eempe_at = avr->cycle;
	} else if ((v & (1 << EEPE)) && b->eempe_armed && avr->cycle - b->eempe_at <= 4) {
		b->eempe_armed = 0;
		b->dirty = 1;
		b->writes++;
		avr->data[EECR_ADDR] |= 1 << EEPE;	/* busy */
		avr_cycle_timer_register_usec(avr, EEPROM_WRITE_US, eepe_done, b);
	}
}

void board_default_eeprom(board_t *b)
{
	uint8_t img[EEPROM_SIZE];
	memset(img, 0xFF, sizeof img);
	img[0] = 0;	/* alarm triggered state */
	img[1] = 0;	/* alarm armed level */
	for (int i = 0; i < 4; i++)
		img[20 + i] = (uint8_t)(b->sensors[i] / 4);	/* pollAlarm compares analogRead/4 */
	memcpy(eeprom(b), img, sizeof img);
	b->dirty = 1;
}

static void load_eeprom(board_t *b)
{
	FILE *f = b->eeprom_file ? fopen(b->eeprom_file, "rb") : NULL;
	if (!f) {
		board_default_eeprom(b);
		if (b->eeprom_file)
			logmsg("EEPROM file %s not found, starting from the default image", b->eeprom_file);
		return;
	}
	uint8_t img[EEPROM_SIZE];
	size_t n = fread(img, 1, sizeof img, f);
	fclose(f);
	if (n != EEPROM_SIZE) {
		logmsg("EEPROM file %s is %zu bytes, expected %d; refusing to guess", b->eeprom_file, n, EEPROM_SIZE);
		exit(2);
	}
	memcpy(eeprom(b), img, sizeof img);
	b->dirty = 0;
	logmsg("EEPROM loaded from %s", b->eeprom_file);
}

void board_flush_eeprom(board_t *b)
{
	if (!b->dirty || !b->eeprom_file)
		return;
	char tmp[4096];
	snprintf(tmp, sizeof tmp, "%s.tmp", b->eeprom_file);
	FILE *f = fopen(tmp, "wb");
	if (!f || fwrite(eeprom(b), 1, EEPROM_SIZE, f) != EEPROM_SIZE || fclose(f) != 0 ||
	    rename(tmp, b->eeprom_file) != 0) {
		logmsg("cannot write EEPROM file %s: %s", b->eeprom_file, strerror(errno));
		if (f)
			unlink(tmp);
	}
	b->dirty = 0;
}

void board_set_sensor(board_t *b, int n, int counts)
{
	if (n < 0 || n > 3)
		return;
	if (counts < 0)
		counts = 0;
	if (counts > 1023)
		counts = 1023;
	b->sensors[n] = counts;
	avr_raise_irq(b->adc[n], counts);
}

int board_sensor(board_t *b, int n) { return b->sensors[n]; }

board_t *board_new(avr_t *avr, const int sensors[4], const char *eeprom_file)
{
	board_t *b = calloc(1, sizeof *b);
	b->avr = avr;
	b->eeprom_file = eeprom_file;
	b->edges = calloc(TIMELINE_MAX, sizeof(edge_t));
	for (int i = 0; i < 4; i++) {
		b->adc[i] = avr_io_getirq(avr, AVR_IOCTL_ADC_GETIRQ, ADC_IRQ_ADC0 + i);
		b->sensors[i] = sensors[i];
		b->rctx[i] = (relay_ctx_t){ b, i };
		b->relay_irq[i] = avr_io_getirq(avr, AVR_IOCTL_IOPORT_GETIRQ(relays[i].port), relays[i].bit);
		avr_irq_register_notify(b->relay_irq[i], relay_hook, &b->rctx[i]);
	}
	avr_register_io_write(avr, EECR_ADDR, eecr_write, b);
	load_eeprom(b);
	return b;
}

void board_power_on(board_t *b)
{
	/* Pins float at reset; the relay drivers read that as off. */
	for (int i = 0; i < 4; i++) {
		b->relay_irq[i]->value = 0;
		b->level[i] = 0;
		board_set_sensor(b, i, b->sensors[i]);
	}
	b->nedges = 0;
	b->dropped = 0;
	b->eempe_armed = 0;
}

void board_pins_json(board_t *b, sbuf_t *out, double since_ms)
{
	sb_printf(out, "{\"nowMs\":%.3f,\"pins\":{", cycles_to_ms(b->avr->cycle));
	for (int i = 0; i < 4; i++)
		sb_printf(out, "%s\"%d\":%d", i ? "," : "", relays[i].arduino, b->level[i]);
	sb_printf(out, "},\"names\":{");
	for (int i = 0; i < 4; i++)
		sb_printf(out, "%s\"%d\":\"%s\"", i ? "," : "", relays[i].arduino, relays[i].name);
	sb_printf(out, "},\"dropped\":%zu,\"timeline\":[", b->dropped);
	int first = 1;
	for (size_t i = 0; i < b->nedges; i++) {
		double t = cycles_to_ms(b->edges[i].at);
		if (t < since_ms)
			continue;
		sb_printf(out, "%s{\"t\":%.3f,\"pin\":%d,\"value\":%d}", first ? "" : ",", t, b->edges[i].pin,
			  b->edges[i].value);
		first = 0;
	}
	sb_printf(out, "]}");
}

void board_eeprom_hex(board_t *b, sbuf_t *out, int json)
{
	const uint8_t *e = eeprom(b);
	if (json) {
		sb_printf(out, "{\"size\":%d,\"writes\":%llu,\"hex\":\"", EEPROM_SIZE, (unsigned long long)b->writes);
		for (int i = 0; i < EEPROM_SIZE; i++)
			sb_printf(out, "%02x", e[i]);
		sb_printf(out, "\"}");
		return;
	}
	for (int i = 0; i < EEPROM_SIZE; i += 16) {
		sb_printf(out, "%04x:", i);
		for (int j = 0; j < 16; j++)
			sb_printf(out, " %02x", e[i + j]);
		sb_printf(out, "\n");
	}
}
