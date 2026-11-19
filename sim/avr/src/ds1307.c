/*
 * ds1307.c - Maxim DS1307 RTC model on simavr's TWI bus.
 *
 * Registers 0x00-0x07 hold BCD seconds (bit 7 = clock halt), minutes, hours
 * (bit 6 = 12-hour mode), day of week (1-7), date, month, year, control;
 * 0x08-0x3F are 56 bytes of battery-backed RAM. The register pointer
 * auto-increments and wraps from 0x3F to 0x00.
 *
 * As on the chip: a START copies the time registers into a read buffer so a
 * multi-byte read is consistent; writing the seconds register restarts the
 * one-second countdown; unused bits read as 0. The clock counts in BCD with
 * month lengths and leap years (year % 4), from whatever was written.
 * Nonsense values (the firmware's ?w writes some) are counted the same way;
 * the datasheet calls that undefined.
 *
 * Time advances with simulated time, so at SPEED > 1 the clock runs fast too.
 */
#include <stdlib.h>
#include <string.h>

#include "avr_twi.h"
#include "ds1307.h"
#include "sim_time.h"

#define DS1307_ADDR 0x68

struct ds1307 {
	avr_t *avr;
	avr_irq_t *irq;		/* our two TWI IRQs: [TWI_IRQ_INPUT] to the AVR, [TWI_IRQ_OUTPUT] from it */
	uint8_t reg[64];
	uint8_t snap[7];	/* time registers as of the last START */
	uint8_t ptr;
	int selected, have_ptr;
	avr_cycle_count_t next_tick, carry;
};

static const uint8_t write_mask[8] = { 0xFF, 0x7F, 0x7F, 0x07, 0x3F, 0x1F, 0xFF, 0x93 };

static int bcd(uint8_t v) { return (v >> 4) * 10 + (v & 0x0F); }
static uint8_t tobcd(int d) { return (uint8_t)(((d / 10) << 4) | (d % 10)); }

static int days_in_month(int month, int year)
{
	static const int dim[13] = { 31, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
	if (month == 2 && year % 4 == 0)
		return 29;
	return (month >= 1 && month <= 12) ? dim[month] : 31;
}

static void tick(ds1307_t *d)
{
	uint8_t *r = d->reg;
	if (r[0] & 0x80)
		return;		/* CH: oscillator halted */
	int s = bcd(r[0] & 0x7F) + 1;
	if (s < 60) { r[0] = tobcd(s); return; }
	r[0] = 0;
	int m = bcd(r[1] & 0x7F) + 1;
	if (m < 60) { r[1] = tobcd(m); return; }
	r[1] = 0;
	if (r[2] & 0x40) {	/* 12-hour mode: bit 5 is PM */
		int h = bcd(r[2] & 0x1F), pm = r[2] & 0x20;
		if (h == 11)
			pm ^= 0x20;
		h = h == 12 ? 1 : h + 1;
		r[2] = 0x40 | pm | tobcd(h);
		if (!(h == 12 && !pm))
			return;
	} else {
		int h = bcd(r[2] & 0x3F) + 1;
		if (h < 24) { r[2] = tobcd(h); return; }
		r[2] = 0;
	}
	r[3] = (r[3] & 0x07) % 7 + 1;
	int month = bcd(r[5] & 0x1F), year = bcd(r[6]);
	int date = bcd(r[4] & 0x3F) + 1;
	if (date <= days_in_month(month, year)) { r[4] = tobcd(date); return; }
	r[4] = 1;
	if (++month <= 12) { r[5] = tobcd(month); return; }
	r[5] = 1;
	r[6] = tobcd((year + 1) % 100);
}

static avr_cycle_count_t tick_timer(avr_t *avr, avr_cycle_count_t when, void *param)
{
	ds1307_t *d = param;
	tick(d);
	d->next_tick = when + CPU_HZ;
	return d->next_tick;
}

static void restart_countdown(ds1307_t *d, avr_cycle_count_t in)
{
	d->next_tick = d->avr->cycle + in;
	avr_cycle_timer_register(d->avr, in, tick_timer, d);
}

static void twi_hook(struct avr_irq_t *irq, uint32_t value, void *param)
{
	ds1307_t *d = param;
	avr_twi_msg_irq_t v = { .u.v = value };

	if (v.u.twi.msg & TWI_COND_STOP)
		d->selected = 0;

	if (v.u.twi.msg & TWI_COND_START) {
		d->selected = 0;
		if ((v.u.twi.addr >> 1) == DS1307_ADDR) {
			d->selected = v.u.twi.addr;
			d->have_ptr = 0;
			memcpy(d->snap, d->reg, sizeof d->snap);
			avr_raise_irq(d->irq + TWI_IRQ_INPUT, avr_twi_irq_msg(TWI_COND_ACK, d->selected, 1));
		}
	}
	if (!d->selected)
		return;

	if (v.u.twi.msg & TWI_COND_WRITE) {
		avr_raise_irq(d->irq + TWI_IRQ_INPUT, avr_twi_irq_msg(TWI_COND_ACK, d->selected, 1));
		if (!d->have_ptr) {
			d->ptr = v.u.twi.data & 0x3F;
			d->have_ptr = 1;
		} else {
			uint8_t p = d->ptr;
			d->reg[p] = p < 8 ? (v.u.twi.data & write_mask[p]) : v.u.twi.data;
			if (p < 7)
				d->snap[p] = d->reg[p];
			if (p == 0)
				restart_countdown(d, CPU_HZ);
			d->ptr = (p + 1) & 0x3F;
		}
	}
	if (v.u.twi.msg & TWI_COND_READ) {
		uint8_t p = d->ptr;
		uint8_t data = p < 7 ? d->snap[p] : d->reg[p];
		d->ptr = (p + 1) & 0x3F;
		avr_raise_irq(d->irq + TWI_IRQ_INPUT, avr_twi_irq_msg(TWI_COND_READ, d->selected, data));
	}
}

static const char *irq_names[2] = {
	[TWI_IRQ_INPUT] = "8>ds1307.out",
	[TWI_IRQ_OUTPUT] = "32<ds1307.in",
};

ds1307_t *ds1307_new(avr_t *avr, time_t start)
{
	ds1307_t *d = calloc(1, sizeof *d);
	d->avr = avr;
	struct tm tm;
	localtime_r(&start, &tm);
	d->reg[0] = tobcd(tm.tm_sec > 59 ? 59 : tm.tm_sec);
	d->reg[1] = tobcd(tm.tm_min);
	d->reg[2] = tobcd(tm.tm_hour);
	d->reg[3] = tm.tm_wday + 1;	/* 1 = Sunday */
	d->reg[4] = tobcd(tm.tm_mday);
	d->reg[5] = tobcd(tm.tm_mon + 1);
	d->reg[6] = tobcd(tm.tm_year % 100);
	d->reg[7] = 0x03;	/* power-on control value */
	d->irq = avr_alloc_irq(&avr->irq_pool, 0, 2, irq_names);
	avr_irq_register_notify(d->irq + TWI_IRQ_OUTPUT, twi_hook, d);
	avr_connect_irq(d->irq + TWI_IRQ_INPUT, avr_io_getirq(avr, AVR_IOCTL_TWI_GETIRQ(0), TWI_IRQ_INPUT));
	avr_connect_irq(avr_io_getirq(avr, AVR_IOCTL_TWI_GETIRQ(0), TWI_IRQ_OUTPUT), d->irq + TWI_IRQ_OUTPUT);
	restart_countdown(d, CPU_HZ);
	return d;
}

void ds1307_before_reset(ds1307_t *d)
{
	d->carry = d->next_tick > d->avr->cycle ? d->next_tick - d->avr->cycle : 1;
}

void ds1307_after_reset(ds1307_t *d)
{
	d->selected = 0;
	restart_countdown(d, d->carry ? d->carry : CPU_HZ);
}

void ds1307_json(ds1307_t *d, sbuf_t *b)
{
	const uint8_t *r = d->reg;
	sb_printf(b, "{\"time\":\"20%02x-%02x-%02xT%02x:%02x:%02x\",\"dow\":%d,\"halted\":%s,\"regs\":\"",
		  r[6], r[5], r[4], r[2] & 0x3F, r[1], r[0] & 0x7F, r[3], (r[0] & 0x80) ? "true" : "false");
	for (int i = 0; i < 8; i++)
		sb_printf(b, "%02x", r[i]);
	sb_printf(b, "\"}");
}
