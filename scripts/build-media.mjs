import { mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status}`);
}
mkdirSync(`${root}wasm/media`, { recursive: true });
if (!existsSync(`${root}wasm/media/vendor/.git`))
  run('git', [
    'clone',
    '--depth',
    '1',
    '--branch',
    'n7.1.1',
    'https://github.com/FFmpeg/FFmpeg.git',
    'wasm/media/vendor',
  ]);
// Release n7.1.1; verify the source rather than silently building another checkout.
const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: `${root}wasm/media/vendor`,
  encoding: 'utf8',
}).stdout.trim();
if (revision !== 'db69d06eeeab4f46da15030a80d539efb4503ca8')
  throw new Error(`Unexpected FFmpeg revision ${revision}`);
const vendor = `${root}wasm/media/vendor`;
run(
  'emconfigure',
  [
    './configure',
    '--cc=emcc',
    '--cxx=em++',
    '--ar=emar',
    '--ranlib=emranlib',
    '--nm=emnm',
    '--target-os=none',
    '--arch=wasm32',
    '--enable-cross-compile',
    '--disable-everything',
    '--disable-programs',
    '--disable-doc',
    '--disable-network',
    '--disable-autodetect',
    '--disable-asm',
    '--disable-x86asm',
    '--disable-pthreads',
    '--disable-avdevice',
    '--disable-avformat',
    '--enable-avcodec',
    '--enable-avfilter',
    '--enable-avutil',
    '--enable-swresample',
    '--disable-swscale',
    '--enable-filter=buffer,buffersink,bwdif',
    '--enable-decoder=mpeg2video,aac',
    '--enable-parser=mpegvideo,aac,ac3',
    '--extra-cflags=-O3',
  ],
  vendor,
);
run('emmake', ['make', '-j4'], vendor);
mkdirSync(`${root}src/media/generated`, { recursive: true });
mkdirSync(`${root}public/media-licenses`, { recursive: true });
for (const name of ['COPYING.LGPLv2.1', 'LICENSE.md'])
  copyFileSync(`${vendor}/${name}`, `${root}public/media-licenses/${name}`);
run(process.env.EMCC || 'emcc', [
  '-O3',
  '-Iwasm/media/vendor',
  'wasm/media/decoder.c',
  'wasm/media/vendor/libavfilter/libavfilter.a',
  'wasm/media/vendor/libavcodec/libavcodec.a',
  'wasm/media/vendor/libswresample/libswresample.a',
  'wasm/media/vendor/libavutil/libavutil.a',
  '-sMODULARIZE=1',
  '-sEXPORT_ES6=1',
  '-sENVIRONMENT=web,worker,node',
  '-sFILESYSTEM=0',
  '-sSINGLE_FILE=1',
  '-sALLOW_MEMORY_GROWTH=1',
  '-sINITIAL_MEMORY=33554432',
  '-sSTACK_SIZE=1048576',
  '-sMAXIMUM_MEMORY=268435456',
  '-sEXPORTED_RUNTIME_METHODS=["HEAPU8","HEAPF32"]',
  '-o',
  'src/media/generated/decoder.js',
]);
