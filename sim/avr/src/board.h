/*
 * board.h - relays, alarm sensors and EEPROM of the door board.
 */
#ifndef DOOR_BOARD_H
#define DOOR_BOARD_H

#include "sim.h"

#define EEPROM_SIZE 1024

/* sensors: ADC counts 0..1023 for A0..A3. eeprom_file may be NULL. */
board_t *board_new(avr_t *avr, const int sensors[4], const char *eeprom_file);

/* After avr_reset(): pins and ADC inputs back in place, timeline restarted. */
void board_power_on(board_t *b);

/* Replace the EEPROM with the default image (user area erased, alarm bytes 0,
 * zone baselines matching the current sensor values). */
void board_default_eeprom(board_t *b);

void board_set_sensor(board_t *b, int n, int counts);
int board_sensor(board_t *b, int n);

/* Write the EEPROM file if it changed (debounced by the caller). */
void board_flush_eeprom(board_t *b);

void board_pins_json(board_t *b, sbuf_t *out, double since_ms);
void board_eeprom_hex(board_t *b, sbuf_t *out, int json);

#endif
