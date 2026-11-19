/*
 * wiegand.h - Wiegand readers on D2/D3 (reader 1) and D4/D5 (reader 2).
 */
#ifndef DOOR_WIEGAND_H
#define DOOR_WIEGAND_H

#include "sim.h"

/* Called when the last bit of a frame has been clocked out (ok = 1) or the
 * frame was dropped by a reset (ok = 0). Times are simulated ms since boot. */
typedef void (*wiegand_done_cb)(void *ctx, int ok, double start_ms, double end_ms);

wiegand_t *wiegand_new(avr_t *avr);

/* Queue a frame of `bits` bits, most significant first. -1 if the queue is full. */
int wiegand_queue(wiegand_t *g, int reader, uint32_t value, int bits, wiegand_done_cb cb, void *ctx);

/* After avr_reset(): lines back to idle high, queued frames fail. */
void wiegand_power_on(wiegand_t *g);

/* Standard 26-bit frame: even parity, 8-bit facility, 16-bit card, odd parity. */
uint32_t wiegand26_frame(unsigned facility, unsigned card);

#endif
