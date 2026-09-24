import type { Channel } from './channels';

/**
 * Nationwide BS / 110°CS lineup (right-hand circular, 2K) as of 2025-07,
 * keyed by `<transponder>_<relative TS>`. Satellite channels do not vary by
 * region, so these stand in for a scan until the user scans the band.
 * Only the main service of each TS is listed; the service selector shows the rest.
 */
export const SATELLITE_DEFAULTS: [channel: Channel, serviceId: number, stationName: string][] = [
  ['BS1_0', 151, 'BS朝日'],
  ['BS1_1', 161, 'BS-TBS'],
  ['BS1_2', 171, 'BSテレ東'],
  ['BS3_0', 191, 'WOWOWプライム'],
  ['BS3_1', 236, 'BSアニマックス'],
  ['BS3_2', 251, 'BS釣りビジョン'],
  ['BS5_0', 192, 'WOWOWライブ'],
  ['BS5_1', 193, 'WOWOWシネマ'],
  ['BS9_0', 211, 'BS11'],
  ['BS9_2', 222, 'BS12 トゥエルビ'],
  ['BS13_0', 141, 'BS日テレ'],
  ['BS13_1', 181, 'BSフジ'],
  ['BS13_2', 231, '放送大学'],
  ['BS15_0', 101, 'NHK BS'],
  ['BS15_1', 201, 'BS10スターチャンネル'],
  ['BS15_2', 200, 'BS10'],
  ['BS19_0', 245, 'J SPORTS 4'],
  ['BS19_1', 242, 'J SPORTS 1'],
  ['BS19_2', 243, 'J SPORTS 2'],
  ['BS19_3', 244, 'J SPORTS 3'],
  ['BS21_0', 252, 'WOWOWプラス'],
  ['BS21_1', 255, '日本映画専門チャンネル'],
  ['BS21_2', 234, 'グリーンチャンネル'],
  ['BS23_0', 256, 'ディズニー・チャンネル'],
  ['BS23_1', 265, 'BSよしもと'],
  ['BS23_3', 260, 'J:COM BS'],
  ['CS2_0', 296, 'TBSチャンネル1'],
  ['CS4_0', 250, 'スカイA'],
  ['CS6_0', 294, 'ホームドラマチャンネル'],
  ['CS8_0', 55, 'ショップチャンネル'],
  ['CS10_0', 219, '衛星劇場'],
  ['CS12_0', 254, 'GAORA'],
  ['CS14_0', 293, 'ファミリー劇場'],
  ['CS16_0', 333, 'AT-X'],
  ['CS18_0', 240, 'ムービープラス'],
  ['CS20_0', 307, 'フジテレビONE'],
  ['CS22_0', 161, 'QVC'],
  ['CS24_0', 257, '日テレジータス'],
];
