/*
 * ds1307.h - DS1307 real-time clock on the TWI bus (address 0x68).
 */
#ifndef DOOR_DS1307_H
#define DOOR_DS1307_H

#include <time.h>
#include "sim.h"

/* start is the wall time to load into the clock, read as local time. */
ds1307_t *ds1307_new(avr_t *avr, time_t start);

/* The AVR is about to be reset (its cycle counter and timers restart). The
 * clock runs on its own battery, so remember where in the second it was. */
void ds1307_before_reset(ds1307_t *d);
void ds1307_after_reset(ds1307_t *d);

/* Current time registers as JSON, for GET /rtc and /health. */
void ds1307_json(ds1307_t *d, sbuf_t *b);

#endif
