/*
 * w5100.h - WIZnet W5100 on the SPI bus, bridged to host TCP.
 */
#ifndef DOOR_W5100_H
#define DOOR_W5100_H

#include "sim.h"

/* board_port is the host port that the chip's port 80 is served on. */
w5100_t *w5100_new(avr_t *avr, int board_port);

/* Power-on / hardware reset: registers to datasheet defaults, every host
 * connection and listener dropped. Call after avr_reset(). */
void w5100_power_on(w5100_t *w);

/* Housekeeping: add host sockets to the poll set. */
void w5100_add_fds(w5100_t *w, pollset_t *ps);

/* Socket table as JSON, for GET /sockets. */
void w5100_json(w5100_t *w, sbuf_t *b);

#endif
