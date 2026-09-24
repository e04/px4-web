// SPDX-License-Identifier: GPL-2.0-only
// Receiver sequences adapted from px4_device, isdb2056_device, m1ur_device and pxmlt_device.
// Driver algorithms: Copyright (c) 2018-2021 nns779.
#include "r850.h"
#include "rt710.h"
#include "tc90522.h"
#include "cxd2856er.h"
#include "cxd2858er.h"

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
static bool is_satellite;
// 0: PX4/PX5, 1: ISDB2056/PX-M1UR, 2: ISDB2056N, 3: MLT.
static int model;
static struct device device;
static struct cxd2856er_demod sony_demod;
static struct cxd2858er_tuner sony_tuner;
// Auxiliary PX4 receiver state: 0 closed, 1 terrestrial (T1), 2 satellite (S1).
static int aux_mode;
static int aux_sleep(void);
#define CHECK(call) do { int ret = (call); if (ret) return ret; } while (0)

static int sony_init(void) {
  sony_demod.dev = &device;
  sony_demod.i2c = &bus;
  sony_demod.i2c_addr.slvt = 0x65;
  sony_demod.i2c_addr.slvx = 0x67;
  sony_demod.config.xtal = 24000;
  sony_demod.config.tuner_i2c = true;
  CHECK(cxd2856er_init(&sony_demod));
  sony_tuner.i2c = &sony_demod.i2c_master;
  sony_tuner.dev = &device;
  sony_tuner.i2c_addr = 0x60;
  sony_tuner.config.xtal = 16000;
  sony_tuner.config.ter.lna = true;
  sony_tuner.config.sat.lna = true;
  CHECK(cxd2858er_init(&sony_tuner));
  // Serial TS configuration from pxmlt_chrdev_open.
  const u8 regs[][4] = {
    {0x00,0xc4,0x80,0x88}, {0x00,0xc5,0x01,0x01}, {0x00,0xc6,0x03,0x1f},
    {0x60,0x52,0x03,0x1f}, {0x00,0xc8,0x03,0x1f}, {0x00,0xc9,0x03,0x1f},
    {0xa0,0xb9,0x01,0x01}
  };
  for (unsigned i = 0; i < ARRAY_SIZE(regs); i++) {
    CHECK(cxd2856er_write_slvt_reg(&sony_demod, 0, regs[i][0]));
    CHECK(cxd2856er_write_slvt_reg_mask(&sony_demod, regs[i][1], regs[i][2], regs[i][3]));
  }
  ready = true;
  return 0;
}

EMSCRIPTEN_KEEPALIVE int receiver_init(int device_model) {
  if (device_model < 0 || device_model > 3) return -EINVAL;
  model = device_model;
  const u8 addresses[] = {0x11, 0x13, 0x10, 0x12};
  ready = false;
  is_satellite = false;
  aux_mode = 0;
  if (model == 3) return sony_init();
  memset(demods, 0, sizeof(demods));
  memset(terrestrial, 0, sizeof(terrestrial));
  memset(satellite, 0, sizeof(satellite));
  for (int i = 0; i < 4; i++) {
    if (model && (i == 1 || i == 3)) continue;
    struct tc90522_demod *d = &demods[i];
    d->i2c = &bus;
    d->i2c_addr = addresses[i];
    if (model == 2 && i == 0) d->i2c_addr = 0x13;
    d->is_secondary = !!(d->i2c_addr & 0x0e);
    CHECK(tc90522_init(d));
    if (i < 2) {
      struct rt710_tuner *t = &satellite[i];
      t->i2c = &d->i2c_master;
      t->i2c_addr = 0x7a;
      t->config.xtal = 24000;
      t->config.signal_output_mode = RT710_SIGNAL_OUTPUT_DIFFERENTIAL;
      t->config.agc_mode = RT710_AGC_POSITIVE;
      CHECK(rt710_init(t));
      if (!model) {
        CHECK(rt710_sleep(t));
        CHECK(tc90522_sleep_s(d, true));
      }
    } else {
      struct r850_tuner *t = &terrestrial[i - 2];
      t->i2c = &d->i2c_master;
      t->i2c_addr = 0x7c;
      t->config.xtal = 24000;
      t->config.loop_through = !model && !d->is_secondary;
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
  for (unsigned i = 0; i < (model ? 8 : ARRAY_SIZE(regs)); i++) CHECK(tc90522_write_reg(d, regs[i][0], regs[i][1]));
  CHECK(tc90522_enable_ts_pins_t(d, false));
  CHECK(tc90522_sleep_t(d, !!model));
  if (!model) CHECK(r850_wakeup(&terrestrial[0]));
  struct r850_system_config sys = {R850_SYSTEM_ISDB_T, R850_BANDWIDTH_6M, 4063};
  CHECK(r850_set_system(&terrestrial[0], &sys));
  if (!model) {
    CHECK(tc90522_write_reg(&demods[0], 0x07, 0x31));
    CHECK(tc90522_write_reg(&demods[0], 0x08, 0x77));
    CHECK(tc90522_write_reg(d, 0x0e, 0x77));
    CHECK(tc90522_write_reg(d, 0x0f, 0x13));
  } else if (model == 2) {
    demods[1].i2c = &bus;
    demods[1].i2c_addr = 0x11;
    CHECK(tc90522_init(&demods[1]));
  }
  CHECK(tc90522_write_reg(&demods[0], 0x15, 0));
  CHECK(tc90522_write_reg(&demods[0], 0x1d, 0));
  if (!model) CHECK(tc90522_write_reg(&demods[0], 0x04, 2));
  CHECK(tc90522_enable_ts_pins_s(&demods[0], false));
  if (model) CHECK(tc90522_sleep_s(&demods[0], true));
  ready = true;
  return 0;
}

EMSCRIPTEN_KEEPALIVE int receiver_frequency(int khz, int slot) {
  if (!ready || !((khz >= 473143 && khz <= 767143) || (khz >= 1049480 && khz <= 2053000))) return -EINVAL;
  is_satellite = khz >= 1049480;
  if (model == 3) {
    if (sony_demod.state == CXD2856ER_ACTIVE_STATE) CHECK(cxd2856er_sleep(&sony_demod));
    if (is_satellite) CHECK(cxd2856er_set_slot_isdbs(&sony_demod, slot));
    union cxd2856er_system_params params = { .bandwidth = is_satellite ? 0 : 6 };
    CHECK(cxd2856er_wakeup(&sony_demod, is_satellite ? CXD2856ER_ISDB_S_SYSTEM : CXD2856ER_ISDB_T_SYSTEM, &params));
    if (is_satellite) CHECK(cxd2858er_set_params_s(&sony_tuner, CXD2858ER_ISDB_S_SYSTEM, khz, 28860));
    else CHECK(cxd2858er_set_params_t(&sony_tuner, CXD2858ER_ISDB_T_SYSTEM, khz, 6));
    return cxd2856er_post_tune(&sony_demod);
  }
  CHECK(tc90522_enable_ts_pins_t(&demods[2], false));
  CHECK(tc90522_enable_ts_pins_s(&demods[0], false));
  if (is_satellite) {
    if (model) {
      CHECK(tc90522_set_agc_s(&demods[0], false));
      CHECK(tc90522_write_reg(&demods[2], 0x0e, 0x11));
      CHECK(tc90522_write_reg(&demods[2], 0x0f, 0x70));
      CHECK(tc90522_sleep_t(&demods[2], true));
      struct tc90522_demod *primary = &demods[model == 2 ? 1 : 0];
      CHECK(tc90522_write_reg(primary, 0x07, 0x77));
      CHECK(tc90522_write_reg(primary, 0x08, model == 2 ? 0x37 : 0x10));
      CHECK(tc90522_sleep_s(&demods[0], false));
      CHECK(tc90522_write_reg(&demods[0], 0x04, 2));
      CHECK(tc90522_write_reg(&demods[0], 0x8e, 2));
      CHECK(tc90522_write_reg(&demods[2], 0x1f, 0x20));
      return rt710_set_params(&satellite[0], khz, 28860, 4);
    }
    CHECK(tc90522_sleep_s(&demods[0], false));
    CHECK(tc90522_set_agc_s(&demods[0], false));
    CHECK(tc90522_write_reg(&demods[0], 0x8e, 0x06));
    CHECK(tc90522_write_reg(&demods[0], 0xa3, 0xf7));
    return rt710_set_params(&satellite[0], khz, 28860, 4);
  }
  CHECK(tc90522_write_reg(&demods[2], 0x47, 0x30));
  CHECK(tc90522_set_agc_t(&demods[2], false));
  if (model) {
    CHECK(tc90522_sleep_s(&demods[0], true));
    CHECK(tc90522_write_reg(&demods[2], 0x0e, 0x77));
    CHECK(tc90522_write_reg(&demods[2], 0x0f, 0x10));
    CHECK(tc90522_write_reg(&demods[2], 0x71, 0x20));
    CHECK(tc90522_sleep_t(&demods[2], false));
  }
  CHECK(tc90522_write_reg(&demods[2], 0x76, 0x0c));
  if (model) {
    CHECK(tc90522_write_reg(&demods[2], 0x1f, 0x30));
    CHECK(r850_wakeup(&terrestrial[0]));
  }
  return r850_set_frequency(&terrestrial[0], khz);
}
EMSCRIPTEN_KEEPALIVE int receiver_pll(void) {
  if (!ready) return -EINVAL;
  // CXD2858ER set_params performs the settling sequence; lock is checked by the demod.
  if (model == 3) return 1;
  bool locked = false;
  if (is_satellite) CHECK(rt710_is_pll_locked(&satellite[0], &locked));
  else CHECK(r850_is_pll_locked(&terrestrial[0], &locked));
  return locked;
}
EMSCRIPTEN_KEEPALIVE int receiver_acquire(void) {
  if (!ready) return -EINVAL;
  if (model == 3) return 0;
  if (is_satellite) return tc90522_set_agc_s(&demods[0], true);
  CHECK(tc90522_set_agc_t(&demods[2], true));
  CHECK(tc90522_write_reg(&demods[2], 0x71, model ? 0x01 : 0x21));
  CHECK(tc90522_write_reg(&demods[2], 0x72, 0x25));
  CHECK(tc90522_write_reg(&demods[2], 0x75, model ? 0 : 0x08));
  if (model) msleep(100);
  return 0;
}
// 1: locked, 0: not yet, 2: demod reports no signal (pxmlt_chrdev_check_lock -ECANCELED).
EMSCRIPTEN_KEEPALIVE int receiver_lock(void) {
  if (!ready) return -EINVAL;
  bool locked = false;
  if (model == 3) {
    bool unlocked = false;
    if (is_satellite) CHECK(cxd2856er_is_ts_locked_isdbs(&sony_demod, &locked));
    else CHECK(cxd2856er_is_ts_locked_isdbt(&sony_demod, &locked, &unlocked));
    return locked ? 1 : unlocked ? 2 : 0;
  }
  if (is_satellite) CHECK(tc90522_is_signal_locked_s(&demods[0], &locked));
  else CHECK(tc90522_is_signal_locked_t(&demods[2], &locked));
  return locked;
}
EMSCRIPTEN_KEEPALIVE int receiver_tsid(int slot) {
  if (!ready || model == 3 || !is_satellite || slot < 0 || slot >= 12) return -EINVAL;
  u16 tsid = 0;
  CHECK(tc90522_tmcc_get_tsid_s(&demods[0], slot, &tsid));
  return tsid;
}
EMSCRIPTEN_KEEPALIVE int receiver_select_tsid(int tsid) {
  if (!ready || model == 3 || !is_satellite || tsid <= 0 || tsid >= 65535) return -EINVAL;
  return tc90522_set_tsid_s(&demods[0], tsid);
}
EMSCRIPTEN_KEEPALIVE int receiver_current_tsid(void) {
  if (!ready || model == 3 || !is_satellite) return -EINVAL;
  u16 tsid = 0;
  CHECK(tc90522_get_tsid_s(&demods[0], &tsid));
  return tsid;
}
EMSCRIPTEN_KEEPALIVE int receiver_capture(void) {
  if (!ready) return -EINVAL;
  if (model == 3) return 0; // post_tune already enables the selected TS.
  return is_satellite ? tc90522_enable_ts_pins_s(&demods[0], true) : tc90522_enable_ts_pins_t(&demods[2], true);
}
EMSCRIPTEN_KEEPALIVE int receiver_pause(void) {
  if (!ready) return -EINVAL;
  if (model == 3) {
    CHECK(cxd2856er_write_slvt_reg(&sony_demod, 0, 0));
    return cxd2856er_write_slvt_reg(&sony_demod, 0xc3, 1);
  }
  CHECK(tc90522_enable_ts_pins_t(&demods[2], false));
  return tc90522_enable_ts_pins_s(&demods[0], false);
}
EMSCRIPTEN_KEEPALIVE int receiver_stop(void) {
  if (!ready) return 0;
  ready = false;
  if (model == 3) {
    int ret = sony_tuner.system == CXD2858ER_UNSPECIFIED_SYSTEM ? 0 : cxd2858er_stop(&sony_tuner);
    int next = sony_demod.state == CXD2856ER_SLEEP_STATE ? 0 : cxd2856er_sleep(&sony_demod);
    return ret ? ret : next;
  }
  // Attempt every shutdown step, preserving the first error.
  int ret = aux_sleep();
  int next = tc90522_enable_ts_pins_t(&demods[2], false);
  if (!ret) ret = next;
  next = r850_sleep(&terrestrial[0]);
  if (!ret) ret = next;
  next = tc90522_sleep_t(&demods[2], true);
  if (!ret) ret = next;
  next = tc90522_enable_ts_pins_s(&demods[0], false);
  if (!ret) ret = next;
  next = rt710_sleep(&satellite[0]);
  if (!ret) ret = next;
  next = tc90522_sleep_s(&demods[0], true);
  return ret ? ret : next;
}

// Auxiliary receiver on PX4/PX5 boards: the second tuner pair (S1: demods[1], T1: demods[3]),
// tagged as receiver 1/3 in the shared TS stream. Sequences follow px4_chrdev_open/tune_t/tune_s.
static int aux_sleep(void) {
  int ret = 0;
  if (aux_mode == 1) {
    ret = tc90522_enable_ts_pins_t(&demods[3], false);
    int next = r850_sleep(&terrestrial[1]);
    if (!ret) ret = next;
    next = tc90522_sleep_t(&demods[3], true);
    if (!ret) ret = next;
  } else if (aux_mode == 2) {
    ret = tc90522_enable_ts_pins_s(&demods[1], false);
    int next = rt710_sleep(&satellite[1]);
    if (!ret) ret = next;
    next = tc90522_sleep_s(&demods[1], true);
    if (!ret) ret = next;
  }
  aux_mode = 0;
  return ret;
}
static int aux_wakeup(int mode) {
  if (aux_mode == mode) return 0;
  CHECK(aux_sleep());
  struct tc90522_demod *d = &demods[mode == 1 ? 3 : 1];
  if (mode == 1) {
    const u8 regs[][2] = {
      {0xb0,0xa0},{0xb2,0x3d},{0xb3,0x25},{0xb4,0x8b},{0xb5,0x4b},
      {0xb6,0x3f},{0xb7,0xff},{0xb8,0xc0},{0x1f,0},{0x75,0}
    };
    for (unsigned i = 0; i < ARRAY_SIZE(regs); i++) CHECK(tc90522_write_reg(d, regs[i][0], regs[i][1]));
    CHECK(tc90522_enable_ts_pins_t(d, false));
    CHECK(tc90522_sleep_t(d, false));
    CHECK(r850_wakeup(&terrestrial[1]));
    struct r850_system_config sys = {R850_SYSTEM_ISDB_T, R850_BANDWIDTH_6M, 4063};
    CHECK(r850_set_system(&terrestrial[1], &sys));
  } else {
    CHECK(tc90522_write_reg(d, 0x15, 0));
    CHECK(tc90522_write_reg(d, 0x1d, 0));
    CHECK(tc90522_write_reg(d, 0x04, 2));
    CHECK(tc90522_enable_ts_pins_s(d, false));
    CHECK(tc90522_sleep_s(d, false));
  }
  aux_mode = mode;
  return 0;
}
EMSCRIPTEN_KEEPALIVE int aux_frequency(int khz) {
  if (!ready || model != 0 || !((khz >= 473143 && khz <= 767143) || (khz >= 1049480 && khz <= 2053000))) return -EINVAL;
  int mode = khz >= 1049480 ? 2 : 1;
  CHECK(aux_wakeup(mode));
  if (mode == 2) {
    struct tc90522_demod *d = &demods[1];
    CHECK(tc90522_enable_ts_pins_s(d, false));
    CHECK(tc90522_set_agc_s(d, false));
    CHECK(tc90522_write_reg(d, 0x8e, 0x06));
    CHECK(tc90522_write_reg(d, 0xa3, 0xf7));
    return rt710_set_params(&satellite[1], khz, 28860, 4);
  }
  struct tc90522_demod *d = &demods[3];
  CHECK(tc90522_enable_ts_pins_t(d, false));
  CHECK(tc90522_write_reg(d, 0x47, 0x30));
  CHECK(tc90522_set_agc_t(d, false));
  CHECK(tc90522_write_reg(d, 0x76, 0x0c));
  return r850_set_frequency(&terrestrial[1], khz);
}
EMSCRIPTEN_KEEPALIVE int aux_pll(void) {
  if (!ready || !aux_mode) return -EINVAL;
  bool locked = false;
  if (aux_mode == 2) CHECK(rt710_is_pll_locked(&satellite[1], &locked));
  else CHECK(r850_is_pll_locked(&terrestrial[1], &locked));
  return locked;
}
EMSCRIPTEN_KEEPALIVE int aux_acquire(void) {
  if (!ready || !aux_mode) return -EINVAL;
  if (aux_mode == 2) return tc90522_set_agc_s(&demods[1], true);
  struct tc90522_demod *d = &demods[3];
  CHECK(tc90522_set_agc_t(d, true));
  CHECK(tc90522_write_reg(d, 0x71, 0x21));
  CHECK(tc90522_write_reg(d, 0x72, 0x25));
  return tc90522_write_reg(d, 0x75, 0x08);
}
EMSCRIPTEN_KEEPALIVE int aux_lock(void) {
  if (!ready || !aux_mode) return -EINVAL;
  bool locked = false;
  if (aux_mode == 2) CHECK(tc90522_is_signal_locked_s(&demods[1], &locked));
  else CHECK(tc90522_is_signal_locked_t(&demods[3], &locked));
  return locked;
}
EMSCRIPTEN_KEEPALIVE int aux_tsid(int slot) {
  if (!ready || aux_mode != 2 || slot < 0 || slot >= 12) return -EINVAL;
  u16 tsid = 0;
  CHECK(tc90522_tmcc_get_tsid_s(&demods[1], slot, &tsid));
  return tsid;
}
EMSCRIPTEN_KEEPALIVE int aux_select_tsid(int tsid) {
  if (!ready || aux_mode != 2 || tsid <= 0 || tsid >= 65535) return -EINVAL;
  return tc90522_set_tsid_s(&demods[1], tsid);
}
EMSCRIPTEN_KEEPALIVE int aux_current_tsid(void) {
  if (!ready || aux_mode != 2) return -EINVAL;
  u16 tsid = 0;
  CHECK(tc90522_get_tsid_s(&demods[1], &tsid));
  return tsid;
}
EMSCRIPTEN_KEEPALIVE int aux_capture(void) {
  if (!ready || !aux_mode) return -EINVAL;
  return aux_mode == 2 ? tc90522_enable_ts_pins_s(&demods[1], true) : tc90522_enable_ts_pins_t(&demods[3], true);
}
EMSCRIPTEN_KEEPALIVE int aux_stop(void) {
  if (!ready) return 0;
  return aux_sleep();
}
