/*
 * wiegand.c - drives Wiegand frames onto the reader pins.
 *
 * A Wiegand reader holds DATA0 and DATA1 high and sends each bit as a short
 * low pulse on DATA0 (a 0) or DATA1 (a 1), most significant bit first.
 * Reader 1 is DATA0 = D2 (PD2), DATA1 = D3 (PD3); reader 2 is D4/D5.
 *
 * The firmware attaches pin-change interrupts to those pins (PCATTACH) and
 * lib/Wiegand26 shifts in a bit on every change that leaves the pin low:
 *   reader1 = reader1 << 1 | bit;  reader1Count++;
 * loop() acts once reader1Count >= 26 and passes reader1, the raw frame
 * including both parity bits, to checkUser(). So the value the firmware
 * checks is exactly the frame we clock out.
 *
 * Timing follows the common reader defaults: 50 us pulses every 2 ms
 * (WIEGAND_PULSE_US, WIEGAND_PERIOD_US), so a 26-bit frame takes 52 ms.
 *
 * The lines are modelled as the reader's open-collector outputs with
 * pull-ups: simavr's "external pull" on PD2..PD5 keeps them high whenever the
 * AVR has them as inputs, and a pulse pulls one low. When the firmware itself
 * drives a pin as an output (initReaderOne/Two does), the AVR wins.
 */
#include <stdlib.h>

#include "avr_ioport.h"
#include "sim_time.h"
#include "wiegand.h"

#define QMAX 16

typedef struct frame {
	int reader;
	uint32_t value;
	int bits;
	wiegand_done_cb cb;
	void *ctx;
} frame_t;

struct wiegand {
	avr_t *avr;
	avr_irq_t *pin[8];	/* PORTD pin IRQs */
	uint8_t lines;		/* level the readers put on PD2..PD5 */
	frame_t q[QMAX];
	int qhead, qlen;
	int bit;		/* next bit index (counting down), -1 = idle */
	int low;		/* a pulse is in progress */
	int pulse_us, period_us;
	double start_ms;
};

static void drive(wiegand_t *g, int pd, int level)
{
	if (level)
		g->lines |= 1 << pd;
	else
		g->lines &= ~(1 << pd);
	avr_ioport_external_t ext = { .name = 'D', .mask = 0x3C, .value = g->lines };
	avr_ioctl(g->avr, AVR_IOCTL_IOPORT_SET_EXTERNAL('D'), &ext);
	avr_raise_irq(g->pin[pd], level);
}

static avr_cycle_count_t step(avr_t *avr, avr_cycle_count_t when, void *param);

static void start_next(wiegand_t *g)
{
	if (!g->qlen) {
		g->bit = -1;
		return;
	}
	g->bit = g->q[g->qhead].bits - 1;
	g->low = 0;
	g->start_ms = cycles_to_ms(g->avr->cycle);
	avr_cycle_timer_register(g->avr, 1, step, g);
}

static avr_cycle_count_t step(avr_t *avr, avr_cycle_count_t when, void *param)
{
	wiegand_t *g = param;
	frame_t *f = &g->q[g->qhead];
	int base = f->reader == 2 ? 4 : 2;	/* PD of DATA0 */
	int pd = base + ((f->value >> g->bit) & 1);	/* DATA1 for a 1 */
	if (!g->low) {
		drive(g, pd, 0);
		g->low = 1;
		return when + US_TO_CYCLES(g->pulse_us);
	}
	drive(g, pd, 1);
	g->low = 0;
	if (--g->bit >= 0)
		return when + US_TO_CYCLES(g->period_us - g->pulse_us);
	/* frame done */
	frame_t done = *f;
	g->qhead = (g->qhead + 1) % QMAX;
	g->qlen--;
	if (done.cb)
		done.cb(done.ctx, 1, g->start_ms, cycles_to_ms(avr->cycle));
	/* next frame after one bit period, like a reader re-arming */
	if (g->qlen) {
		g->bit = g->q[g->qhead].bits - 1;
		g->start_ms = cycles_to_ms(avr->cycle + US_TO_CYCLES(g->period_us));
		return when + US_TO_CYCLES(g->period_us);
	}
	g->bit = -1;
	return 0;
}

uint32_t wiegand26_frame(unsigned facility, unsigned card)
{
	uint32_t data = (facility & 0xFF) << 16 | (card & 0xFFFF);	/* 24 bits */
	int even = __builtin_popcount(data >> 12) & 1;		/* bits 2..13 of the frame */
	int odd = !(__builtin_popcount(data & 0xFFF) & 1);		/* bits 14..25 */
	return (uint32_t)even << 25 | data << 1 | odd;
}

int wiegand_queue(wiegand_t *g, int reader, uint32_t value, int bits, wiegand_done_cb cb, void *ctx)
{
	if (g->qlen >= QMAX)
		return -1;
	g->q[(g->qhead + g->qlen) % QMAX] = (frame_t){ reader, value, bits, cb, ctx };
	g->qlen++;
	if (g->bit < 0)
		start_next(g);
	return 0;
}

void wiegand_power_on(wiegand_t *g)
{
	avr_cycle_timer_cancel(g->avr, step, g);
	while (g->qlen) {
		frame_t f = g->q[g->qhead];
		g->qhead = (g->qhead + 1) % QMAX;
		g->qlen--;
		if (f.cb)
			f.cb(f.ctx, 0, 0, 0);
	}
	g->bit = -1;
	g->low = 0;
	/* Readers idle high. After avr_reset() simavr's PIND reads 0 but the pin
	 * IRQs remember their old level, so force a fresh edge into PIND. */
	g->lines = 0x3C;
	for (int pd = 2; pd <= 5; pd++) {
		g->pin[pd]->value = 0;
		drive(g, pd, 1);
	}
}

wiegand_t *wiegand_new(avr_t *avr)
{
	wiegand_t *g = calloc(1, sizeof *g);
	g->avr = avr;
	g->bit = -1;
	g->pulse_us = env_long("WIEGAND_PULSE_US", 50);
	g->period_us = env_long("WIEGAND_PERIOD_US", 2000);
	if (g->pulse_us < 1)
		g->pulse_us = 1;
	if (g->period_us <= g->pulse_us)
		g->period_us = g->pulse_us + 1;
	for (int i = 0; i < 8; i++)
		g->pin[i] = avr_io_getirq(avr, AVR_IOCTL_IOPORT_GETIRQ('D'), i);
	return g;
}
