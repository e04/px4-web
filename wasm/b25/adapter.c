// SPDX-License-Identifier: Apache-2.0
// Async card adapter for libarib25; no PC/SC dependency.
#include <emscripten.h>
#include <stdint.h>
#include <string.h>
#include "arib_std_b25.h"

EM_ASYNC_JS(int, card_apdu, (const uint8_t *src, int len, uint8_t *dst, int capacity), {
  try {
    const response = await Module.apdu(HEAPU8.slice(src, src + len));
    if (response.length > capacity) return -1;
    HEAPU8.set(response, dst);
    return response.length;
  } catch (error) { Module.cardError = String(error); return -1; }
});
static ARIB_STD_B25 *decoder;
static B_CAS_CARD card;
static B_CAS_INIT_STATUS status;
static int64_t ids[256];
static B_CAS_ID card_ids;
static uint8_t input[188 * 816];
static ARIB_STD_B25_BUFFER output;
static int valid(const uint8_t *r, int n, int minimum) {
  return n >= minimum && r[n-2] == 0x90 && r[n-1] == 0;
}
static int get_status(void *unused, B_CAS_INIT_STATUS *dst) { *dst = status; return 0; }
static int get_ids(void *unused, B_CAS_ID *dst) { *dst = card_ids; return 0; }
static int process_ecm(void *unused, B_CAS_ECM_RESULT *dst, uint8_t *src, int len) {
  if (len < 1 || len > 255) return -1;
  uint8_t cmd[261] = {0x90, 0x34, 0, 0}, response[4096];
  cmd[4] = len; memcpy(cmd + 5, src, len); cmd[len + 5] = 0;
  int n = card_apdu(cmd, len + 6, response, sizeof(response));
  if (!valid(response, n, 25)) return -1;
  dst->return_code = (response[4] << 8) | response[5];
  memcpy(dst->scramble_key, response + 6, 16);
  return 0;
}
static int process_emm(void *unused, uint8_t *src, int len) {
  if (len < 1 || len > 255) return -1;
  uint8_t cmd[261] = {0x90, 0x36, 0, 0}, response[4096];
  cmd[4] = len; memcpy(cmd + 5, src, len); cmd[len + 5] = 0;
  int n = card_apdu(cmd, len + 6, response, sizeof(response));
  return valid(response, n, 8) && response[4] == 0x21 && response[5] == 0 ? 0 : -1;
}
EMSCRIPTEN_KEEPALIVE void b25_close(void) {
  if (decoder) decoder->release(decoder);
  decoder = 0; memset(&status, 0, sizeof(status)); memset(ids, 0, sizeof(ids));
  memset(&output, 0, sizeof(output)); memset(input, 0, sizeof(input));
}
EMSCRIPTEN_KEEPALIVE int b25_open(int emm) {
  b25_close();
  uint8_t cmd[] = {0x90, 0x30, 0, 0, 0}, response[4096];
  int n = card_apdu(cmd, sizeof(cmd), response, sizeof(response));
  if (!valid(response, n, 58) || response[4] != 0x21 || response[5]) return -1;
  memcpy(status.system_key, response + 16, 32); memcpy(status.init_cbc, response + 48, 8);
  status.card_status = (response[2] << 8) | response[3];
  status.ca_system_id = (response[6] << 8) | response[7];
  for (int i = 8; i < 14; i++) status.bcas_card_id = (status.bcas_card_id << 8) | response[i];
  cmd[1] = 0x32;
  n = card_apdu(cmd, sizeof(cmd), response, sizeof(response));
  if (!valid(response, n, 9) || response[4] != 0x21 || response[5] || n < 9 + 10 * response[6]) return -2;
  card_ids.data = ids; card_ids.count = response[6];
  for (int i = 0; i < card_ids.count; i++)
    for (int j = 0; j < 6; j++) ids[i] = (ids[i] << 8) | response[7 + i * 10 + j + 2];
  memset(&card, 0, sizeof(card));
  card.get_init_status = get_status; card.get_id = get_ids;
  card.proc_ecm = process_ecm; card.proc_emm = process_emm;
  decoder = create_arib_std_b25();
  if (!decoder) return -3;
  decoder->set_multi2_round(decoder, 4); decoder->set_strip(decoder, 0);
  decoder->set_emm_proc(decoder, emm);
  return decoder->set_b_cas_card(decoder, &card);
}
EMSCRIPTEN_KEEPALIVE uint8_t *b25_input(void) { return input; }
EMSCRIPTEN_KEEPALIVE int b25_put(int length) {
  if (!decoder || length < 0 || length > sizeof(input)) return -1;
  ARIB_STD_B25_BUFFER in = {input, length};
  return decoder->put(decoder, &in);
}
EMSCRIPTEN_KEEPALIVE int b25_flush(void) { return decoder ? decoder->flush(decoder) : -1; }
EMSCRIPTEN_KEEPALIVE int b25_get(void) {
  if (!decoder) return -1;
  int ret = decoder->get(decoder, &output);
  return ret < 0 ? ret : output.size;
}
EMSCRIPTEN_KEEPALIVE uint8_t *b25_output(void) { return output.data; }
