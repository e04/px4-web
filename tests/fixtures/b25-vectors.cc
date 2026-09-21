// Synthetic test vectors only. No broadcast/card secrets.
// clang++ -Iwasm/b25 -Iwasm/b25/vendor/src tests/fixtures/b25-vectors.cc \
//   wasm/b25/vendor/src/multi2.cc -o /tmp/b25-vectors
#include <cstdio>
#include "multi2.h"
int main() {
  auto m = create_multi2();
  uint8_t system[32] = {}, iv[8] = {}, keys[16], data[17];
  m->set_system_key(m, system); m->set_init_cbc(m, iv);
  for (int generation = 0; generation < 2; generation++) {
    for (int i = 0; i < 16; i++) keys[i] = generation * 16 + i;
    m->set_scramble_key(m, keys);
    for (int parity = 2; parity <= 3; parity++) {
      for (int i = 0; i < 17; i++) data[i] = i;
      if (m->encrypt(m, parity, data, 17)) return 1;
      for (auto b : data) std::printf("%02x", b);
      std::puts("");
    }
  }
  m->release(m);
}
