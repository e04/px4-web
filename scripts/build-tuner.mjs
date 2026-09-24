import { mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// tsukumijima/px4_drv v0.6.1
const revision = 'd748866f0da1cb3656106a520de4e9d7f073aacd';
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status}`);
}
if (!existsSync(new URL('../wasm/tuner/vendor/.git', import.meta.url)))
  run('git', ['clone', 'https://github.com/tsukumijima/px4_drv.git', 'wasm/tuner/vendor']);
run('git', ['-C', 'wasm/tuner/vendor', 'checkout', '--detach', revision]);
mkdirSync(new URL('../src/driver/generated/', import.meta.url), { recursive: true });
mkdirSync(new URL('../firmware/', import.meta.url), { recursive: true });
// Same checkout already contains the firmware; no separate download needed.
copyFileSync(
  new URL('../wasm/tuner/vendor/etc/it930x-firmware.bin', import.meta.url),
  new URL('../firmware/it930x-firmware.bin', import.meta.url),
);
const driver = 'wasm/tuner/vendor/driver';
run(process.env.EMCC || 'emcc', [
  '-O2',
  '-U__linux__',
  '-include',
  'wasm/tuner/compat.h',
  `-I${driver}`,
  'wasm/tuner/adapter.c',
  ...['r850', 'rt710', 'tc90522', 'cxd2856er', 'cxd2858er'].map((name) => `${driver}/${name}.c`),
  '-sASYNCIFY=1',
  '-sASSERTIONS=1',
  '-sMODULARIZE=1',
  '-sEXPORT_ES6=1',
  '-sENVIRONMENT=web,node',
  '-sFILESYSTEM=0',
  '-sSINGLE_FILE=1',
  '-sEXPORTED_RUNTIME_METHODS=["ccall"]',
  '-o',
  'src/driver/generated/tuner.js',
]);
