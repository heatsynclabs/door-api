# Builds door-sim against a simavr source tree built with `make -C simavr`.
#   make SIMAVR=/path/to/simavr/simavr
SIMAVR ?= /simavr/simavr
OBJDIR := $(SIMAVR)/obj-$(shell $(CC) -dumpmachine)

CFLAGS ?= -O2 -g
CFLAGS += -std=gnu11 -Wall -Wextra -Wno-unused-parameter -Wno-missing-field-initializers
CPPFLAGS += -I$(SIMAVR)/sim -I$(SIMAVR)
LDLIBS += $(OBJDIR)/libsimavr.a -lelf -lm

SRCS := $(wildcard src/*.c)
OBJS := $(SRCS:.c=.o)

door-sim: $(OBJS)
	$(CC) $(LDFLAGS) -o $@ $(OBJS) $(LDLIBS)

src/%.o: src/%.c src/*.h
	$(CC) $(CPPFLAGS) $(CFLAGS) -c -o $@ $<

clean:
	rm -f door-sim src/*.o

.PHONY: clean
