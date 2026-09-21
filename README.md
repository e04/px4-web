# px4-web

DEMO: https://e04.github.io/px4-web/

<img width="771" height="600" alt="px4-web" src="https://github.com/user-attachments/assets/b7474588-2053-4194-9ba5-60fa7d888062" />

PLEX PX4系（PX-W3U4/Q3U4/W3PE4/Q3PE4/W3PE5/Q3PE5）をWebUSBで開き、ブラウザのみで放送を視聴できるアプリです。

カードリーダーはチューナー内蔵リーダーを使用します。

## libs

- [px4_drv](https://github.com/tsukumijima/px4_drv)（オリジナル: [nns779/px4_drv](https://github.com/nns779/px4_drv)、Copyright (c) 2018-2021 nns779、GPL-2.0）。`it930x` ブリッジ、`r850` / `rt710` / `tc90522` チューナー制御、SmartCard T=1、TS同期を移植・参考（`src/driver`、`src/card`、`src/usb`、`wasm/tuner`）
-  [libarib25](https://github.com/stz2012/libarib25)（Copyright (c) 2012 stz2012、MARUMO、2ch NoNames ほか、Apache-2.0。`wasm/b25/vendor` に revision `93ff3afd0a13f42724b20564873066f470825e78` で同梱し WASM 化
- [FFmpeg](https://github.com/FFmpeg/FFmpeg) `n7.1.1`（`db69d06eeeab4f46da15030a80d539efb4503ca8`、LGPL-2.1-or-later; MPEG-2 Video / AAC のみ有効。詳細は同梱の `public/media-licenses/`）
-  `aribb24.js`（MIT、© monyone）
-  `arib-mmt-tlv-ts`（MIT）
