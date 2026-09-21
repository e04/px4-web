// SPDX-License-Identifier: GPL-2.0-only
// PX4 receiver sequence adapted from px4_device.cpp (reference B).
// Driver algorithms: Copyright (c) 2018-2021 nns779.
#include "r850.h"
#include "rt710.h"
#include "tc90522.h"

EM_ASYNC_JS(int, web_i2c, (int read, int addr, u8 *data, int len), {
  try {
    if (read) HEAPU8.set(await Module['i2cRead'](addr, len), data);
    else await Module['i2cWrite'](addr, HEAPU8.slice(data, data + len));
    return 0;
  } catch (error) {
    Module['ioError'] = error;
    return -5;
  }
});

static int request(void *priv, const struct i2c_comm_request *req, int num) {
  for (int i = 0; i < num; i++) {
    if (req[i].req != I2C_READ_REQUEST && req[i].req != I2C_WRITE_REQUEST) return -EINVAL;
    int ret = web_i2c(req[i].req == I2C_READ_REQUEST, req[i].addr, req[i].data, req[i].len);
    if (ret) return ret;
  }
  return 0;
}
static struct i2c_comm_master bus = { .request = request };
static struct tc90522_demod demods[4];
static struct r850_tuner terrestrial[2];
static struct rt710_tuner satellite[2];
static bool ready;
#define CHECK(call) do { int ret = (call); if (ret) return ret; } while (0)

EMSCRIPTEN_KEEPALIVE int receiver_init(void) {
  const u8 addresses[] = {0x11, 0x13, 0x10, 0x12};
  ready = false;
  memset(demods, 0, sizeof(demods));
  memset(terrestrial, 0, sizeof(terrestrial));
  memset(satellite, 0, sizeof(satellite));
  for (int i = 0; i < 4; i++) {
    struct tc90522_demod *d = &demods[i];
    d->i2c = &bus;
    d->i2c_addr = addresses[i];
    d->is_secondary = !!(addresses[i] & 0x0e);
    CHECK(tc90522_init(d));
    if (i < 2) {
      struct rt710_tuner *t = &satellite[i];
      t->i2c = &d->i2c_master;
      t->i2c_addr = 0x7a;
      t->config.xtal = 24000;
      t->config.signal_output_mode = RT710_SIGNAL_OUTPUT_DIFFERENTIAL;
      t->config.agc_mode = RT710_AGC_POSITIVE;
      CHECK(rt710_init(t));
      CHECK(rt710_sleep(t));
      CHECK(tc90522_sleep_s(d, true));
    } else {
      struct r850_tuner *t = &terrestrial[i - 2];
      t->i2c = &d->i2c_master;
      t->i2c_addr = 0x7c;
      t->config.xtal = 24000;
      t->config.loop_through = !d->is_secondary;
      t->config.no_imr_calibration = true;
      t->config.no_lpf_calibration = true;
      CHECK(r850_init(t));
      if (i == 3) {
        CHECK(r850_sleep(t));
        CHECK(tc90522_sleep_t(d, true));
      }
    }
  }
  struct tc90522_demod *d = &demods[2];
  const u8 regs[][2] = {
    {0xb0,0xa0},{0xb2,0x3d},{0xb3,0x25},{0xb4,0x8b},{0xb5,0x4b},
    {0xb6,0x3f},{0xb7,0xff},{0xb8,0xc0},{0x1f,0},{0x75,0}
  };
  for (unsigned i = 0; i < ARRAY_SIZE(regs); i++) CHECK(tc90522_write_reg(d, regs[i][0], regs[i][1]));
  CHECK(tc90522_enable_ts_pins_t(d, false));
  CHECK(tc90522_sleep_t(d, false));
  CHECK(r850_wakeup(&terrestrial[0]));
  struct r850_system_config sys = {R850_SYSTEM_ISDB_T, R850_BANDWIDTH_6M, 4063};
  CHECK(r850_set_system(&terrestrial[0], &sys));
  CHECK(tc90522_write_reg(&demods[0], 0x07, 0x31));
  CHECK(tc90522_write_reg(&demods[0], 0x08, 0x77));
  CHECK(tc90522_write_reg(d, 0x0e, 0x77));
  CHECK(tc90522_write_reg(d, 0x0f, 0x13));
  ready = true;
  return 0;
}

EMSCRIPTEN_KEEPALIVE int receiver_frequency(int khz) {
  if (!ready || khz < 473143 || khz > 767143) return -EINVAL;
  CHECK(tc90522_write_reg(&demods[2], 0x47, 0x30));
  CHECK(tc90522_set_agc_t(&demods[2], false));
  CHECK(tc90522_write_reg(&demods[2], 0x76, 0x0c));
  return r850_set_frequency(&terrestrial[0], khz);
}
EMSCRIPTEN_KEEPALIVE int receiver_pll(void) {
  if (!ready) return -EINVAL;
  bool locked = false;
  CHECK(r850_is_pll_locked(&terrestrial[0], &locked));
  return locked;
}
EMSCRIPTEN_KEEPALIVE int receiver_acquire(void) {
  if (!ready) return -EINVAL;
  CHECK(tc90522_set_agc_t(&demods[2], true));
  CHECK(tc90522_write_reg(&demods[2], 0x71, 0x21));
  CHECK(tc90522_write_reg(&demods[2], 0x72, 0x25));
  return tc90522_write_reg(&demods[2], 0x75, 0x08);
}
EMSCRIPTEN_KEEPALIVE int receiver_lock(void) {
  if (!ready) return -EINVAL;
  bool locked = false;
  CHECK(tc90522_is_signal_locked_t(&demods[2], &locked));
  return locked;
}
EMSCRIPTEN_KEEPALIVE int receiver_stop(void) {
  if (!ready) return 0;
  ready = false;
  // Attempt every shutdown step, preserving the first error.
  int ret = tc90522_enable_ts_pins_t(&demods[2], false);
  int next = r850_sleep(&terrestrial[0]);
  if (!ret) ret = next;
  next = tc90522_sleep_t(&demods[2], true);
  return ret ? ret : next;
}
