import { afterEach, expect, it, vi } from 'vitest';
import { CanvasMainThreadRenderer } from 'aribb24.js';
import { CaptionOverlay } from '../src/media/captions';

// Use the real B24 parser and Feeder; only replace the browser drawing surface.
vi.mock('aribb24.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('aribb24.js')>()),
  CanvasMainThreadRenderer: class {
    onAttach() {}
    onDetach = vi.fn();
    onContainerResize = vi.fn();
    render = vi.fn();
    clear = vi.fn();
    show = vi.fn();
    hide = vi.fn();
    destroy = vi.fn();
  },
}));

function b24(id: number, body: number[], kind: 'caption' | 'super') {
  const group = [id << 2, 0, 0, body.length >>> 8, body.length & 255, ...body];
  let crc = 0;
  for (const byte of group) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return new Uint8Array([
    kind === 'caption' ? 0x80 : 0x81,
    0xff,
    0xf0,
    ...group,
    crc >>> 8,
    crc & 255,
  ]);
}
const management = (kind: 'caption' | 'super') =>
  b24(0, [0, 1, 0, 0x6a, 0x70, 0x6e, 0x80, 0, 0, 0], kind);
const statement = (text: number[], kind: 'caption' | 'super') =>
  b24(1, [0, 0, 0, 5 + text.length, 0x1f, 0x20, 0, 0, text.length, ...text], kind);

let overlay: CaptionOverlay;
afterEach(() => {
  overlay?.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  let time: number | undefined;
  let frame: FrameRequestCallback;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const attached = vi.spyOn(CanvasMainThreadRenderer.prototype, 'onAttach');
  // Capture the renderer instances without accessing Overlay's private fields.
  const container = { getBoundingClientRect: () => ({ width: 0, height: 0 }) } as HTMLElement;
  overlay = new CaptionOverlay(container, () => time);
  return {
    async advance(value: number) {
      time = value;
      frame!(0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      frame!(0);
    },
    views: attached.mock.instances,
  };
}

it.each(['caption', 'super'] as const)(
  'renders late %s cues and clears while hidden',
  async (kind) => {
    const { advance, views } = setup();
    const view = views[kind === 'caption' ? 0 : 1];
    const render = vi.mocked(view.render);
    await advance(10);
    overlay.push(kind, management(kind), 8, 8);
    // Two same-language statements arriving together must not overwrite each other in the decoder.
    overlay.push(kind, statement([0x0c, 0x0e, 0x41], kind), 9, 9);
    overlay.push(kind, statement([0x0c, 0x0e, 0x42], kind), 9.1, 9);
    await advance(10.1);
    expect(render.mock.lastCall?.[1]).toContainEqual(
      expect.objectContaining({ tag: 'Character', character: 'Ｂ' }),
    );
    overlay.push(kind, statement([0x0c, 0x0e, 0x43], kind), 12, 12);
    await advance(11);
    expect(render.mock.lastCall?.[1]).toContainEqual(
      expect.objectContaining({ tag: 'Character', character: 'Ｂ' }),
    );
    await advance(12.1);
    expect(render.mock.lastCall?.[1]).toContainEqual(
      expect.objectContaining({ tag: 'Character', character: 'Ｃ' }),
    );

    overlay.setEnabled(false);
    overlay.push(kind, statement([0x0c], kind), 12.2, 12.2);
    await advance(13);
    expect(render.mock.lastCall?.[1]).toEqual([expect.objectContaining({ tag: 'ClearScreen' })]);
    const calls = render.mock.calls.length;
    overlay.setEnabled(true);
    await advance(13.1);
    expect(render).toHaveBeenCalledTimes(calls);
    expect(view.hide).toHaveBeenCalledOnce();
    expect(view.show).toHaveBeenCalledOnce();
  },
);

it('decodes packets received before the first audio clock and drops old queued cues on reset', async () => {
  const { advance, views } = setup();
  const render = vi.mocked(views[0].render);
  overlay.push('caption', management('caption'), 1, 1);
  overlay.push('caption', statement([0x0c, 0x0e, 0x41], 'caption'), 2, 2);
  await advance(3);
  expect(render.mock.lastCall?.[1]).toContainEqual(
    expect.objectContaining({ tag: 'Character', character: 'Ａ' }),
  );
  overlay.push('caption', statement([0x0c, 0x0e, 0x42], 'caption'), 20, 20);
  overlay.reset();
  await advance(0);
  render.mockClear();
  await advance(21);
  expect(render).not.toHaveBeenCalled();
});
