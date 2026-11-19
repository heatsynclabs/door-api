/*
 * w5100.c - WIZnet W5100 model for the door-board emulator.
 *
 * Models what the Arduino 1.0.3 Ethernet driver vendored with the firmware
 * (lib/Ethernet/utility/w5100.cpp, socket.cpp, EthernetServer.cpp,
 * EthernetClient.cpp) actually uses, and bridges each hardware socket to a
 * real host TCP connection:
 *
 *  - SPI: one 4-byte frame per register access while /SS (PB2, Arduino D10)
 *    is low. 0xF0 addrH addrL data writes, 0x0F addrH addrL xx reads. The chip
 *    shifts out 0x00 0x01 0x02 and then 0x03 (write) or the data (read).
 *  - Common registers MR (bit 7 = software reset), GAR, SUBR, SHAR, SIPR,
 *    RTR, RCR, RMSR, TMSR. They are plain storage except MR reset.
 *  - Four sockets at 0x0400 + n*0x100: Sn_MR, Sn_CR (command, reads 0 once
 *    accepted), Sn_IR (write 1 to clear), Sn_SR, Sn_PORT, Sn_DIPR/DPORT,
 *    TX_FSR/TX_RD/TX_WR, RX_RSR/RX_RD. Pointers are free-running 16-bit
 *    values; the buffer offset is pointer & (size - 1).
 *  - TX buffers from 0x4000 and RX buffers from 0x6000, sized by TMSR/RMSR
 *    (the driver writes 0x55: 2 KB per socket, mask 0x07FF).
 *
 * Host bridging rules (see README "W5100 model"):
 *  - A host listener exists on a port only while some hardware socket is in
 *    LISTEN on it. With no listener the host kernel answers a SYN with RST,
 *    which is what the chip does. An accepted connection is attached to the
 *    lowest-numbered socket in LISTEN (LISTEN -> ESTABLISHED); if that leaves
 *    no socket listening the host listener is closed again, so connections
 *    queued behind it are reset, just as the chip would have reset their SYNs
 *    (the client sees ECONNRESET, or ECONNREFUSED if its SYN came after the
 *    close, where the chip gives ECONNREFUSED). At most four connections can
 *    therefore exist, as on the chip.
 *  - Peer FIN: ESTABLISHED -> CLOSE_WAIT, or FIN_WAIT -> CLOSED. Peer RST: CLOSED.
 *  - DISCON: graceful FIN (shutdown(SHUT_WR)). ESTABLISHED -> FIN_WAIT, then
 *    CLOSED when the peer's FIN arrives; CLOSE_WAIT -> LAST_ACK -> CLOSED one
 *    LAN round trip (W5100_RTT_US) later.
 *  - CLOSE: socket dropped at once. If no FIN was sent the host connection is
 *    aborted with RST.
 *  - SEND: the bytes between the last SEND and Sn_TX_WR go to the host socket
 *    as one write (TCP_NODELAY, so normally one segment, as the chip sends).
 *    SEND_OK is raised after the frame's wire time at W5100_LINK_MBPS.
 *    TX space is freed as soon as the host kernel has the bytes, which is an
 *    instantly-ACKing LAN peer.
 *  - RECV: commits the driver's Sn_RX_RD; RX_RSR = bytes received - committed.
 *
 * Not modelled: UDP/IPRAW/MACRAW traffic (the sockets open but nothing is
 * bridged), outbound CONNECT (times out), ARP, retransmission, PPPoE, the
 * interrupt pin. The firmware uses none of these.
 */
#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include "avr_ioport.h"
#include "avr_spi.h"
#include "sim_time.h"
#include "w5100.h"

#define NSOCK 4
#define TX_BASE 0x4000
#define RX_BASE 0x6000
#define MEM_SIZE 0x8000

/* Common registers */
enum { MR = 0x00, GAR = 0x01, SUBR = 0x05, SHAR = 0x09, SIPR = 0x0F, IR = 0x15, IMR = 0x16,
       RTR = 0x17, RCR = 0x19, RMSR = 0x1A, TMSR = 0x1B, PTIMER = 0x28 };
/* Socket register offsets */
enum { Sn_MR = 0x00, Sn_CR = 0x01, Sn_IR = 0x02, Sn_SR = 0x03, Sn_PORT = 0x04, Sn_DHAR = 0x06,
       Sn_DIPR = 0x0C, Sn_DPORT = 0x10, Sn_TTL = 0x16, Sn_TX_FSR = 0x20, Sn_TX_RD = 0x22,
       Sn_TX_WR = 0x24, Sn_RX_RSR = 0x26, Sn_RX_RD = 0x28 };
/* Sn_CR commands */
enum { CMD_OPEN = 0x01, CMD_LISTEN = 0x02, CMD_CONNECT = 0x04, CMD_DISCON = 0x08,
       CMD_CLOSE = 0x10, CMD_SEND = 0x20, CMD_SEND_MAC = 0x21, CMD_SEND_KEEP = 0x22, CMD_RECV = 0x40 };
/* Sn_IR bits */
enum { IR_CON = 0x01, IR_DISCON = 0x02, IR_RECV = 0x04, IR_TIMEOUT = 0x08, IR_SEND_OK = 0x10 };
/* Sn_SR values */
enum { SR_CLOSED = 0x00, SR_INIT = 0x13, SR_LISTEN = 0x14, SR_SYNSENT = 0x15, SR_ESTABLISHED = 0x17,
       SR_FIN_WAIT = 0x18, SR_CLOSE_WAIT = 0x1C, SR_LAST_ACK = 0x1D, SR_UDP = 0x22,
       SR_IPRAW = 0x32, SR_MACRAW = 0x42 };

typedef struct wsock {
	w5100_t *w;
	int n;
	int fd;			/* attached host connection, -1 if none */
	uint16_t tx_rd;		/* end of the bytes the host kernel has taken ("ACKed") */
	uint16_t tx_sent;	/* end of the bytes handed out by SEND */
	uint16_t rx_wr;		/* end of the bytes received from the host */
	uint16_t rx_rd;		/* Sn_RX_RD as of the last RECV command */
	int fin_sent, peer_fin;
	int shut_pending;	/* DISCON while bytes still queued below */
	int send_ok_pending;	/* raise SEND_OK once the queue below drains */
	uint16_t send_ok_len;
	uint8_t *pend;		/* bytes the host kernel would not take yet */
	size_t pend_len;
	uint64_t bytes_in, bytes_out;
} wsock_t;

typedef struct wlisten {
	w5100_t *w;
	int chip_port;
	int fd;
} wlisten_t;

struct w5100 {
	avr_t *avr;
	avr_irq_t *miso;
	uint8_t mem[MEM_SIZE];
	int spi_idx;		/* byte within the frame, -1 while /SS is high */
	uint8_t op;
	uint16_t addr;
	wsock_t s[NSOCK];
	wlisten_t l[NSOCK];
	int board_port;
	int trace;
	double link_mbps;
	int rtt_us;
	uint64_t frames;
};

static const char *sr_name(uint8_t sr)
{
	switch (sr) {
	case SR_CLOSED: return "CLOSED";
	case SR_INIT: return "INIT";
	case SR_LISTEN: return "LISTEN";
	case SR_SYNSENT: return "SYNSENT";
	case SR_ESTABLISHED: return "ESTABLISHED";
	case SR_FIN_WAIT: return "FIN_WAIT";
	case SR_CLOSE_WAIT: return "CLOSE_WAIT";
	case SR_LAST_ACK: return "LAST_ACK";
	case SR_UDP: return "UDP";
	case SR_IPRAW: return "IPRAW";
	case SR_MACRAW: return "MACRAW";
	default: return "?";
	}
}

static inline uint16_t sreg(int s, int off) { return 0x0400 + s * 0x100 + off; }
static inline uint16_t get16(w5100_t *w, uint16_t a) { return (uint16_t)(w->mem[a] << 8 | w->mem[a + 1]); }
static inline void put16(w5100_t *w, uint16_t a, uint16_t v) { w->mem[a] = v >> 8; w->mem[a + 1] = v & 0xFF; }
static inline uint8_t *SR(wsock_t *k) { return &k->w->mem[sreg(k->n, Sn_SR)]; }
static inline uint8_t *IRn(wsock_t *k) { return &k->w->mem[sreg(k->n, Sn_IR)]; }

static void set_sr(wsock_t *k, uint8_t sr)
{
	if (k->w->trace && *SR(k) != sr)
		logmsg("w5100 sock%d %s -> %s @%.3fms", k->n, sr_name(*SR(k)), sr_name(sr),
		       cycles_to_ms(k->w->avr->cycle));
	*SR(k) = sr;
}

/* Buffer geometry from TMSR/RMSR: 2 bits per socket, 1/2/4/8 KB, 8 KB total. */
static void geom(w5100_t *w, int s, int tx, uint16_t *base, uint16_t *size)
{
	uint8_t msr = w->mem[tx ? TMSR : RMSR];
	uint32_t b = tx ? TX_BASE : RX_BASE, end = b + 0x2000;
	for (int i = 0; i < s; i++)
		b += 1024u << ((msr >> (2 * i)) & 3);
	uint32_t sz = 1024u << ((msr >> (2 * s)) & 3);
	if (b + sz > end)	/* no memory left for this socket */
		sz = b < end ? end - b : 0;
	*base = b;
	*size = sz;
}

static uint16_t tx_free(wsock_t *k)
{
	uint16_t base, size;
	geom(k->w, k->n, 1, &base, &size);
	uint16_t used = get16(k->w, sreg(k->n, Sn_TX_WR)) - k->tx_rd;
	return used > size ? 0 : size - used;
}

static uint16_t rx_used(wsock_t *k) { return k->rx_wr - k->rx_rd; }

/* ---- host side ---------------------------------------------------------- */

static void sync_listeners(w5100_t *w);

static void detach(wsock_t *k, int abort_conn)
{
	if (k->fd < 0)
		return;
	if (abort_conn) {
		struct linger lg = { 1, 0 };
		setsockopt(k->fd, SOL_SOCKET, SO_LINGER, &lg, sizeof lg);
	}
	close(k->fd);
	k->fd = -1;
	free(k->pend);
	k->pend = NULL;
	k->pend_len = 0;
	k->shut_pending = 0;
}

static avr_cycle_count_t send_ok_timer(avr_t *avr, avr_cycle_count_t when, void *param)
{
	wsock_t *k = param;
	*IRn(k) |= IR_SEND_OK;
	return 0;
}

static avr_cycle_count_t last_ack_timer(avr_t *avr, avr_cycle_count_t when, void *param)
{
	wsock_t *k = param;
	if (*SR(k) == SR_LAST_ACK) {
		detach(k, 0);
		set_sr(k, SR_CLOSED);
	}
	return 0;
}

static avr_cycle_count_t connect_timer(avr_t *avr, avr_cycle_count_t when, void *param)
{
	wsock_t *k = param;
	if (*SR(k) == SR_SYNSENT) {
		set_sr(k, SR_CLOSED);
		*IRn(k) |= IR_TIMEOUT;
	}
	return 0;
}

/* Wire time of one TCP segment carrying len bytes: Ethernet + IP + TCP headers
 * (54), preamble and inter-frame gap (20). */
static void schedule_send_ok(wsock_t *k, uint16_t len)
{
	double us = (len + 74) * 8.0 / k->w->link_mbps;
	avr_cycle_count_t c = (avr_cycle_count_t)(us * (CPU_HZ / 1e6));
	avr_cycle_timer_register(k->w->avr, c ? c : 1, send_ok_timer, k);
}

static void send_fin(wsock_t *k)
{
	if (k->fd >= 0)
		shutdown(k->fd, SHUT_WR);
	k->fin_sent = 1;
	k->shut_pending = 0;
	if (*SR(k) == SR_LAST_ACK)
		avr_cycle_timer_register_usec(k->w->avr, k->w->rtt_us, last_ack_timer, k);
}

/* Push queued bytes to the host kernel; free TX space for what it takes. */
static void flush_pend(wsock_t *k)
{
	while (k->pend_len && k->fd >= 0) {
		ssize_t n = send(k->fd, k->pend, k->pend_len, MSG_NOSIGNAL);
		if (n < 0) {
			if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)
				return;
			/* peer reset: the chip would drop to CLOSED */
			detach(k, 0);
			set_sr(k, SR_CLOSED);
			*IRn(k) |= IR_DISCON;
			return;
		}
		memmove(k->pend, k->pend + n, k->pend_len - n);
		k->pend_len -= n;
		k->tx_rd += n;
		k->bytes_out += n;
	}
	if (!k->pend_len) {
		if (k->send_ok_pending) {
			k->send_ok_pending = 0;
			schedule_send_ok(k, k->send_ok_len);
		}
		if (k->shut_pending)
			send_fin(k);
	}
}

static void cmd_send(wsock_t *k)
{
	w5100_t *w = k->w;
	uint16_t base, size;
	geom(w, k->n, 1, &base, &size);
	uint16_t len = get16(w, sreg(k->n, Sn_TX_WR)) - k->tx_sent;
	if (len > size)
		len = size;
	if (k->fd < 0 || len == 0) {
		k->tx_sent += len;
		k->tx_rd = k->tx_sent;
		schedule_send_ok(k, len);
		return;
	}
	k->pend = realloc(k->pend, k->pend_len + len);
	for (uint16_t i = 0; i < len; i++)
		k->pend[k->pend_len + i] = w->mem[base + ((k->tx_sent + i) & (size - 1))];
	k->pend_len += len;
	k->tx_sent += len;
	k->send_ok_pending = 1;
	k->send_ok_len = len;
	flush_pend(k);
}

static void sock_io(void *ctx, int fd, short revents)
{
	wsock_t *k = ctx;
	w5100_t *w = k->w;
	if (k->fd != fd)
		return;
	if (revents & POLLOUT)
		flush_pend(k);
	if (k->fd < 0 || !(revents & (POLLIN | POLLHUP | POLLERR)))
		return;
	uint16_t base, size;
	geom(w, k->n, 0, &base, &size);
	uint16_t room = size - rx_used(k);
	if (!room)
		return;		/* RX buffer full: the chip would advertise a zero window */
	uint8_t buf[8192];
	ssize_t n = recv(fd, buf, room < sizeof buf ? room : sizeof buf, 0);
	if (n > 0) {
		for (ssize_t i = 0; i < n; i++)
			w->mem[base + ((k->rx_wr + i) & (size - 1))] = buf[i];
		k->rx_wr += n;
		k->bytes_in += n;
		*IRn(k) |= IR_RECV;
		return;
	}
	if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR))
		return;
	if (n == 0) {
		/* peer FIN */
		k->peer_fin = 1;
		*IRn(k) |= IR_DISCON;
		if (*SR(k) == SR_ESTABLISHED)
			set_sr(k, SR_CLOSE_WAIT);
		else if (*SR(k) == SR_FIN_WAIT) {
			detach(k, 0);
			set_sr(k, SR_CLOSED);
		}
		return;
	}
	/* peer RST or another hard error */
	detach(k, 0);
	*IRn(k) |= IR_DISCON;
	set_sr(k, SR_CLOSED);
}

static void listener_io(void *ctx, int fd, short revents)
{
	wlisten_t *L = ctx;
	w5100_t *w = L->w;
	while (L->fd == fd) {
		struct sockaddr_in sa;
		socklen_t sl = sizeof sa;
		int c = accept(fd, (struct sockaddr *)&sa, &sl);
		if (c < 0)
			return;
		set_nonblock(c);
		wsock_t *k = NULL;
		for (int i = 0; i < NSOCK && !k; i++)
			if (*SR(&w->s[i]) == SR_LISTEN && get16(w, sreg(i, Sn_PORT)) == L->chip_port)
				k = &w->s[i];
		if (!k) {	/* nobody listening any more: the chip answers RST */
			struct linger lg = { 1, 0 };
			setsockopt(c, SOL_SOCKET, SO_LINGER, &lg, sizeof lg);
			close(c);
			continue;
		}
		int one = 1;
		setsockopt(c, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
		k->fd = c;
		k->fin_sent = k->peer_fin = 0;
		memcpy(&w->mem[sreg(k->n, Sn_DIPR)], &sa.sin_addr.s_addr, 4);
		put16(w, sreg(k->n, Sn_DPORT), ntohs(sa.sin_port));
		*IRn(k) |= IR_CON;
		set_sr(k, SR_ESTABLISHED);
		sync_listeners(w);
	}
}

/* Keep one host listener per chip port that has a socket in LISTEN. */
static void sync_listeners(w5100_t *w)
{
	int want[NSOCK], nwant = 0;
	for (int i = 0; i < NSOCK; i++) {
		if (*SR(&w->s[i]) != SR_LISTEN)
			continue;
		int p = get16(w, sreg(i, Sn_PORT)), dup = 0;
		for (int j = 0; j < nwant; j++)
			dup |= want[j] == p;
		if (!dup)
			want[nwant++] = p;
	}
	for (int i = 0; i < NSOCK; i++) {
		wlisten_t *L = &w->l[i];
		if (L->fd < 0)
			continue;
		int keep = 0;
		for (int j = 0; j < nwant; j++)
			keep |= want[j] == L->chip_port;
		if (!keep) {
			close(L->fd);
			L->fd = -1;
		}
	}
	for (int j = 0; j < nwant; j++) {
		int have = 0;
		for (int i = 0; i < NSOCK; i++)
			have |= w->l[i].fd >= 0 && w->l[i].chip_port == want[j];
		if (have)
			continue;
		for (int i = 0; i < NSOCK; i++) {
			wlisten_t *L = &w->l[i];
			if (L->fd >= 0)
				continue;
			int host_port = want[j] == 80 ? w->board_port : want[j];
			/* A deep backlog: a full accept queue makes Linux drop SYNs
			 * silently, the client retries a second later and may then be
			 * served, where the chip answers RST at once. Queued
			 * connections are reset when the listener closes. */
			L->fd = tcp_listen(host_port, 64);
			L->chip_port = want[j];
			if (L->fd < 0)
				logmsg("w5100: cannot listen on host port %d: %s", host_port, strerror(errno));
			else if (w->trace)
				logmsg("w5100 listening on host port %d (chip port %d)", host_port, want[j]);
			break;
		}
	}
}

void w5100_add_fds(w5100_t *w, pollset_t *ps)
{
	sync_listeners(w);	/* retries a listener whose bind failed earlier */
	for (int i = 0; i < NSOCK; i++)
		if (w->l[i].fd >= 0)
			ps_add(ps, w->l[i].fd, POLLIN, listener_io, &w->l[i]);
	for (int i = 0; i < NSOCK; i++) {
		wsock_t *k = &w->s[i];
		if (k->fd < 0)
			continue;
		uint16_t base, size;
		geom(w, i, 0, &base, &size);
		short ev = 0;
		uint8_t sr = *SR(k);
		if (!k->peer_fin && (sr == SR_ESTABLISHED || sr == SR_FIN_WAIT) && rx_used(k) < size)
			ev |= POLLIN;
		if (k->pend_len)
			ev |= POLLOUT;
		/* poll() reports HUP/ERR even with no events asked for. Watch an idle
		 * socket only in CLOSE_WAIT (to see a peer RST); otherwise a hung-up
		 * peer behind a full RX buffer would wake ppoll() forever and stop
		 * the pacing. The chip cannot act on it either until the firmware
		 * reads. */
		if (!ev && sr != SR_CLOSE_WAIT)
			continue;
		ps_add(ps, k->fd, ev, sock_io, k);
	}
}

/* ---- chip side ------------------------------------------------------------ */

static void command(w5100_t *w, int s, uint8_t cmd)
{
	wsock_t *k = &w->s[s];
	uint8_t sr = *SR(k);
	if (w->trace)
		logmsg("w5100 sock%d cmd 0x%02x in %s @%.3fms", s, cmd, sr_name(sr), cycles_to_ms(w->avr->cycle));
	switch (cmd) {
	case CMD_OPEN: {
		detach(k, 1);
		avr_cycle_timer_cancel(w->avr, send_ok_timer, k);
		avr_cycle_timer_cancel(w->avr, last_ack_timer, k);
		k->tx_rd = k->tx_sent = k->rx_wr = k->rx_rd = 0;
		put16(w, sreg(s, Sn_TX_WR), 0);
		put16(w, sreg(s, Sn_RX_RD), 0);
		k->fin_sent = k->peer_fin = k->send_ok_pending = 0;
		switch (w->mem[sreg(s, Sn_MR)] & 0x0F) {
		case 1: set_sr(k, SR_INIT); break;
		case 2: set_sr(k, SR_UDP); break;
		case 3: set_sr(k, SR_IPRAW); break;
		case 4: set_sr(k, s == 0 ? SR_MACRAW : SR_CLOSED); break;
		default: set_sr(k, SR_CLOSED); break;
		}
		break;
	}
	case CMD_LISTEN:
		if (sr == SR_INIT)
			set_sr(k, SR_LISTEN);
		break;
	case CMD_CONNECT:
		/* Outbound connections are not bridged: SYN goes nowhere, times
		 * out after RTR * (RCR + 1) like an unanswered SYN would. */
		if (sr == SR_INIT) {
			set_sr(k, SR_SYNSENT);
			uint32_t us = get16(w, RTR) * 100u * (w->mem[RCR] + 1u);
			avr_cycle_timer_register_usec(w->avr, us, connect_timer, k);
		}
		break;
	case CMD_DISCON:
		if (sr == SR_ESTABLISHED || sr == SR_CLOSE_WAIT) {
			set_sr(k, sr == SR_ESTABLISHED ? SR_FIN_WAIT : SR_LAST_ACK);
			if (k->pend_len)
				k->shut_pending = 1;
			else
				send_fin(k);
		} else if (sr == SR_SYNSENT || sr == SR_LISTEN) {
			set_sr(k, SR_CLOSED);
		}
		break;
	case CMD_CLOSE:
		avr_cycle_timer_cancel(w->avr, last_ack_timer, k);
		avr_cycle_timer_cancel(w->avr, connect_timer, k);
		detach(k, !k->fin_sent);
		set_sr(k, SR_CLOSED);
		break;
	case CMD_SEND:
	case CMD_SEND_MAC:
		if (sr == SR_ESTABLISHED || sr == SR_CLOSE_WAIT)
			cmd_send(k);
		else if (sr == SR_UDP || sr == SR_IPRAW || sr == SR_MACRAW) {
			k->tx_sent = k->tx_rd = get16(w, sreg(s, Sn_TX_WR));
			schedule_send_ok(k, 0);	/* datagram modes: not bridged */
		}
		break;
	case CMD_SEND_KEEP:
		break;
	case CMD_RECV:
		k->rx_rd = get16(w, sreg(s, Sn_RX_RD));
		break;
	}
	w->mem[sreg(s, Sn_CR)] = 0;	/* command accepted */
	sync_listeners(w);
}

static void chip_reset(w5100_t *w)
{
	for (int i = 0; i < NSOCK; i++) {
		wsock_t *k = &w->s[i];
		detach(k, 1);
		avr_cycle_timer_cancel(w->avr, send_ok_timer, k);
		avr_cycle_timer_cancel(w->avr, last_ack_timer, k);
		avr_cycle_timer_cancel(w->avr, connect_timer, k);
		memset(k, 0, sizeof *k);
		k->w = w;
		k->n = i;
		k->fd = -1;
	}
	for (int i = 0; i < NSOCK; i++) {
		if (w->l[i].fd >= 0)
			close(w->l[i].fd);
		w->l[i] = (wlisten_t){ .w = w, .fd = -1 };
	}
	memset(w->mem, 0, 0x0800);	/* registers; buffer memory keeps its contents */
	/* datasheet reset values */
	put16(w, RTR, 0x07D0);
	w->mem[RCR] = 0x08;
	w->mem[RMSR] = 0x55;
	w->mem[TMSR] = 0x55;
	w->mem[PTIMER] = 0x28;
	for (int i = 0; i < NSOCK; i++) {
		memset(&w->mem[sreg(i, Sn_DHAR)], 0xFF, 6);
		w->mem[sreg(i, Sn_TTL)] = 0x80;
	}
}

static uint8_t reg_read(w5100_t *w, uint16_t a)
{
	if (a >= MEM_SIZE)
		return 0;
	if (a >= 0x0400 && a < 0x0800) {
		wsock_t *k = &w->s[(a - 0x0400) >> 8];
		int off = a & 0xFF;
		uint16_t v;
		switch (off & ~1) {
		case Sn_TX_FSR: v = tx_free(k); break;
		case Sn_TX_RD: v = k->tx_rd; break;
		case Sn_RX_RSR: v = rx_used(k); break;
		default: return w->mem[a];
		}
		return (off & 1) ? v & 0xFF : v >> 8;
	}
	if (a == IR) {
		uint8_t v = w->mem[IR] & 0xE0;
		for (int i = 0; i < NSOCK; i++)
			if (w->mem[sreg(i, Sn_IR)])
				v |= 1 << i;
		return v;
	}
	return w->mem[a];
}

static void reg_write(w5100_t *w, uint16_t a, uint8_t v)
{
	if (a >= MEM_SIZE)
		return;
	if (a == MR) {
		if (v & 0x80) {
			if (w->trace)
				logmsg("w5100 software reset @%.3fms", cycles_to_ms(w->avr->cycle));
			chip_reset(w);	/* RST self-clears; MR reads 0 */
		} else
			w->mem[MR] = v;
		return;
	}
	if (a == IR) {
		w->mem[IR] &= ~(v & 0xE0);
		return;
	}
	if (a >= 0x0400 && a < 0x0800) {
		int s = (a - 0x0400) >> 8, off = a & 0xFF;
		switch (off) {
		case Sn_CR:
			command(w, s, v);
			return;
		case Sn_IR:
			w->mem[a] &= ~v;
			return;
		case Sn_SR:
		case Sn_TX_FSR: case Sn_TX_FSR + 1:
		case Sn_TX_RD: case Sn_TX_RD + 1:
		case Sn_RX_RSR: case Sn_RX_RSR + 1:
			return;	/* read-only */
		}
	}
	w->mem[a] = v;
}

/* /SS on PB2: low selects the chip and starts a new frame. */
static void spi_cs(struct avr_irq_t *irq, uint32_t value, void *param)
{
	w5100_t *w = param;
	w->spi_idx = value ? -1 : 0;
}

/* One byte clocked out by the AVR; answer with the byte the chip shifts back. */
static void spi_byte(struct avr_irq_t *irq, uint32_t value, void *param)
{
	w5100_t *w = param;
	uint8_t in = value, out = 0xFF;
	if (w->spi_idx >= 0) {
		switch (w->spi_idx & 3) {
		case 0: w->op = in; out = 0x00; break;
		case 1: w->addr = in << 8; out = 0x01; break;
		case 2: w->addr |= in; out = 0x02; break;
		case 3:
			w->frames++;
			if (w->op == 0xF0) {
				reg_write(w, w->addr, in);
				out = 0x03;
			} else if (w->op == 0x0F) {
				out = reg_read(w, w->addr);
			}
			break;
		}
		w->spi_idx++;
	}
	avr_raise_irq(w->miso, out);
}

w5100_t *w5100_new(avr_t *avr, int board_port)
{
	w5100_t *w = calloc(1, sizeof *w);
	w->avr = avr;
	w->board_port = board_port;
	w->trace = env_long("W5100_TRACE", 0);
	w->link_mbps = env_double("W5100_LINK_MBPS", 100);
	w->rtt_us = env_long("W5100_RTT_US", 200);
	w->spi_idx = -1;
	for (int i = 0; i < NSOCK; i++) {
		w->s[i] = (wsock_t){ .w = w, .n = i, .fd = -1 };
		w->l[i] = (wlisten_t){ .w = w, .fd = -1 };
	}
	avr_irq_register_notify(avr_io_getirq(avr, AVR_IOCTL_SPI_GETIRQ(0), SPI_IRQ_OUTPUT), spi_byte, w);
	w->miso = avr_io_getirq(avr, AVR_IOCTL_SPI_GETIRQ(0), SPI_IRQ_INPUT);
	avr_irq_register_notify(avr_io_getirq(avr, AVR_IOCTL_IOPORT_GETIRQ('B'), 2), spi_cs, w);
	chip_reset(w);
	return w;
}

void w5100_power_on(w5100_t *w)
{
	chip_reset(w);
	memset(w->mem + 0x0800, 0, MEM_SIZE - 0x0800);
	w->spi_idx = -1;
}

void w5100_json(w5100_t *w, sbuf_t *b)
{
	sb_printf(b, "{\"ip\":\"%d.%d.%d.%d\",\"mac\":\"%02x:%02x:%02x:%02x:%02x:%02x\",\"frames\":%llu,\"sockets\":[",
		  w->mem[SIPR], w->mem[SIPR + 1], w->mem[SIPR + 2], w->mem[SIPR + 3],
		  w->mem[SHAR], w->mem[SHAR + 1], w->mem[SHAR + 2], w->mem[SHAR + 3], w->mem[SHAR + 4], w->mem[SHAR + 5],
		  (unsigned long long)w->frames);
	for (int i = 0; i < NSOCK; i++) {
		wsock_t *k = &w->s[i];
		sb_printf(b, "%s{\"n\":%d,\"state\":\"%s\",\"sr\":%d,\"port\":%d,\"ir\":%d,\"txFree\":%d,\"rxUsed\":%d,"
			  "\"host\":%s,\"bytesIn\":%llu,\"bytesOut\":%llu}",
			  i ? "," : "", i, sr_name(*SR(k)), *SR(k), get16(w, sreg(i, Sn_PORT)), *IRn(k), tx_free(k),
			  rx_used(k), k->fd >= 0 ? "true" : "false",
			  (unsigned long long)k->bytes_in, (unsigned long long)k->bytes_out);
	}
	sb_printf(b, "]}");
}
