// SPDX-License-Identifier: GPL-2.0-only
#ifndef PX4_WEB_COMPAT_H
#define PX4_WEB_COMPAT_H
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <errno.h>
#include <assert.h>
#include <emscripten.h>
typedef uint8_t u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef int32_t s32;
struct device { int unused; };
// JS serializes the entire exported operation, including Asyncify suspensions.
struct mutex { bool held; };
static inline void mutex_init(struct mutex *m) { m->held = false; }
static inline void mutex_lock(struct mutex *m) { assert(!m->held); m->held = true; }
static inline void mutex_unlock(struct mutex *m) { assert(m->held); m->held = false; }
static inline void mutex_destroy(struct mutex *m) { assert(!m->held); }
#define GFP_KERNEL 0
#define kmalloc(n, flags) malloc(n)
#define kfree(p) free(p)
#define ARRAY_SIZE(a) (sizeof(a) / sizeof((a)[0]))
#define dev_err(dev, ...) fprintf(stderr, __VA_ARGS__)
#define dev_dbg(dev, ...) ((void)0)
#define msleep(ms) emscripten_sleep(ms)
#define mdelay(ms) emscripten_sleep(ms)
#endif
