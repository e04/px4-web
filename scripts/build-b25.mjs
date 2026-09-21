import { mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const revision = '93ff3afd0a13f42724b20564873066f470825e78';
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status}`);
}
if (!existsSync(new URL('../wasm/b25/vendor/.git', import.meta.url)))
  run('git', ['clone', 'https://github.com/stz2012/libarib25.git', 'wasm/b25/vendor']);
run('git', ['-C', 'wasm/b25/vendor', 'checkout', '--detach', revision]);
for (const path of ['src/media/generated', 'public/b25-licenses'])
  mkdirSync(new URL(`../${path}`, import.meta.url), { recursive: true });
for (const name of ['LICENSE', 'NOTICE'])
  copyFileSync(
    new URL(`../wasm/b25/vendor/${name}`, import.meta.url),
    new URL(`../public/b25-licenses/${name}`, import.meta.url),
  );
run(process.env.EMCC || 'emcc', [
  '-O2',
  '-Iwasm/b25',
  '-Iwasm/b25/vendor/src',
  'wasm/b25/adapter.c',
  ...['arib_std_b25.c', 'ts_section_parser.c', 'multi2.cc'].map(
    (name) => `wasm/b25/vendor/src/${name}`,
  ),
  '-sASYNCIFY=1',
  '-sMODULARIZE=1',
  '-sEXPORT_ES6=1',
  '-sENVIRONMENT=web,worker,node',
  '-sFILESYSTEM=0',
  '-sSINGLE_FILE=1',
  '-sALLOW_MEMORY_GROWTH=1',
  '-sMAXIMUM_MEMORY=67108864',
  '-sEXPORTED_RUNTIME_METHODS=["ccall","HEAPU8"]',
  '-o',
  'src/media/generated/b25.js',
]);
