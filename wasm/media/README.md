# Streaming MPEG-2 / AAC WASM

## Sources and license

- FFmpeg upstream: https://github.com/FFmpeg/FFmpeg
- Release: `n7.1.1`
- Commit: `db69d06eeeab4f46da15030a80d539efb4503ca8`
- Configuration: LGPL-2.1-or-later; no GPL/nonfree components, external codecs, network, filesystem, or threads.
- `decoder.c`: project streaming adapter, LGPL-2.1-or-later. It uses the FFmpeg public codec, filter and resampler APIs; no upstream source modifications.
- FFmpeg copyright notices remain in `vendor/`; `COPYING.LGPLv2.1` and `LICENSE.md` are copied to `public/media-licenses/` for distribution.

The build script, adapter, pinned upstream source and Emscripten let recipients rebuild/replace the decoder. When distributing generated binaries, provide these sources and the corresponding FFmpeg sources with their notices and LGPL terms. The ignored `vendor/` tree is the source checkout, not a project-maintained fork.

## Build

```sh
# Activate Emscripten's environment first. Verified with Emscripten 5.0.6.
npm run build:media
```

