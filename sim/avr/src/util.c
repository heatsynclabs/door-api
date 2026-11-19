/*
 * util.c - buffers, logging, environment, sockets and a minimal JSON reader.
 */
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include "sim.h"

void sb_append(sbuf_t *b, const void *data, size_t n)
{
	if (b->len + n + 1 > b->cap) {
		size_t cap = b->cap ? b->cap : 256;
		while (cap < b->len + n + 1)
			cap *= 2;
		b->s = realloc(b->s, cap);
		if (!b->s)
			abort();
		b->cap = cap;
	}
	memcpy(b->s + b->len, data, n);
	b->len += n;
	b->s[b->len] = 0;
}

void sb_printf(sbuf_t *b, const char *fmt, ...)
{
	char small[512];
	va_list ap;
	va_start(ap, fmt);
	int n = vsnprintf(small, sizeof small, fmt, ap);
	va_end(ap);
	if (n < (int)sizeof small) {
		sb_append(b, small, n);
		return;
	}
	char *big = malloc(n + 1);
	va_start(ap, fmt);
	vsnprintf(big, n + 1, fmt, ap);
	va_end(ap);
	sb_append(b, big, n);
	free(big);
}

void sb_free(sbuf_t *b)
{
	free(b->s);
	b->s = NULL;
	b->len = b->cap = 0;
}

void ps_add(pollset_t *ps, int fd, short events, io_cb cb, void *ctx)
{
	if (fd < 0 || ps->n >= MAX_POLL)
		return;
	ps->fds[ps->n] = (struct pollfd){ .fd = fd, .events = events };
	ps->cb[ps->n] = cb;
	ps->ctx[ps->n] = ctx;
	ps->n++;
}

uint64_t mono_ns(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint64_t)ts.tv_sec * 1000000000ULL + ts.tv_nsec;
}

void logmsg(const char *fmt, ...)
{
	va_list ap;
	fprintf(stderr, "door-sim: ");
	va_start(ap, fmt);
	vfprintf(stderr, fmt, ap);
	va_end(ap);
	fputc('\n', stderr);
}

const char *env_str(const char *name, const char *def)
{
	const char *v = getenv(name);
	return (v && *v) ? v : def;
}

long env_long(const char *name, long def)
{
	const char *v = getenv(name);
	if (!v || !*v)
		return def;
	char *end;
	long n = strtol(v, &end, 0);
	if (*end) {
		logmsg("%s=%s is not a number, using %ld", name, v, def);
		return def;
	}
	return n;
}

double env_double(const char *name, double def)
{
	const char *v = getenv(name);
	if (!v || !*v)
		return def;
	char *end;
	double d = strtod(v, &end);
	if (*end) {
		logmsg("%s=%s is not a number, using %g", name, v, def);
		return def;
	}
	return d;
}

void set_nonblock(int fd)
{
	fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
	fcntl(fd, F_SETFD, FD_CLOEXEC);
}

int tcp_listen(int port, int backlog)
{
	int fd = socket(AF_INET, SOCK_STREAM, 0);
	if (fd < 0)
		return -1;
	int one = 1;
	setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
	struct sockaddr_in sa = { .sin_family = AF_INET, .sin_port = htons(port), .sin_addr.s_addr = htonl(INADDR_ANY) };
	if (bind(fd, (struct sockaddr *)&sa, sizeof sa) < 0 || listen(fd, backlog) < 0) {
		int e = errno;
		close(fd);
		errno = e;
		return -1;
	}
	set_nonblock(fd);
	return fd;
}

/* Find "key": and return a pointer just past the colon, or NULL. */
static const char *json_find(const char *body, const char *key)
{
	size_t kl = strlen(key);
	for (const char *p = body; p && (p = strchr(p, '"')); p++) {
		if (!strncmp(p + 1, key, kl) && p[kl + 1] == '"') {
			const char *q = p + kl + 2;
			while (isspace((unsigned char)*q))
				q++;
			if (*q == ':') {
				q++;
				while (isspace((unsigned char)*q))
					q++;
				return q;
			}
		}
	}
	return NULL;
}

/* Numbers may be JSON numbers or strings holding a number ("0x1F", "12"). */
int json_num(const char *body, const char *key, double *out)
{
	const char *p = json_find(body, key);
	if (!p)
		return 0;
	char *end;
	if (*p == '"') {
		p++;
		if (p[0] == '0' && (p[1] == 'x' || p[1] == 'X'))
			*out = (double)strtoull(p, &end, 16);
		else
			*out = strtod(p, &end);
		return end != p && *end == '"';
	}
	*out = strtod(p, &end);
	return end != p;
}

int json_str(const char *body, const char *key, char *out, size_t n)
{
	const char *p = json_find(body, key);
	if (!p || *p != '"' || n == 0)
		return 0;
	p++;
	size_t i = 0;
	while (*p && *p != '"' && i + 1 < n)
		out[i++] = *p++;
	out[i] = 0;
	return *p == '"';
}

int json_num_array(const char *body, const char *key, double *out, int max)
{
	const char *p = json_find(body, key);
	if (!p || *p != '[')
		return -1;
	p++;
	int n = 0;
	while (n < max) {
		while (isspace((unsigned char)*p) || *p == ',')
			p++;
		if (*p == ']')
			break;
		char *end;
		double d = strtod(p, &end);
		if (end == p)
			return -1;
		out[n++] = d;
		p = end;
	}
	return n;
}
