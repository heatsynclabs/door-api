/*
 * control.h - JSON-over-HTTP control API for tests (default port 9199).
 */
#ifndef DOOR_CONTROL_H
#define DOOR_CONTROL_H

#include "sim.h"

control_t *control_new(int port);
void control_add_fds(control_t *c, pollset_t *ps);

#endif
