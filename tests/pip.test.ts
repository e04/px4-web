import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDocumentPipSupported, openPip } from '../src/media/pip';

function fakeElement() {
  const listeners = new Map<string, () => void>();
  return {
    className: '',
    textContent: '',
    children: [] as unknown[],
    parentNode: null as unknown,
    listeners,
    append(...nodes: unknown[]) {
      childrenPush(this, nodes);
    },
    appendChild(node: unknown) {
      childrenPush(this, [node]);
      return node;
    },
    setAttribute: vi.fn(),
    style: { setProperty: vi.fn() },
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, listener);
    },
  };
}

function childrenPush(el: { children: unknown[] }, nodes: unknown[]) {
  for (const node of nodes) {
    (node as { parentNode: unknown }).parentNode = el;
    el.children.push(node);
  }
}

function setup() {
  const listeners = new Map<string, () => void>();
  const head = { append: vi.fn() };
  const body = { append: vi.fn() };
  const created: { tag: string; el: ReturnType<typeof fakeElement> }[] = [];
  const pipWindow = {
    document: {
      title: '',
      head,
      body,
      createElement: vi.fn((tag: string) => {
        const el = fakeElement();
        created.push({ tag, el });
        return el;
      }),
    },
    close: vi.fn(),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      listeners.set(type, listener);
    }),
  };
  const requestWindow = vi.fn(async () => pipWindow);
  vi.stubGlobal('window', { documentPictureInPicture: { requestWindow } });
  const next = { marker: 'next' };
  const parent = { insertBefore: vi.fn(), appendChild: vi.fn() };
  const node = { parentNode: parent, nextSibling: next };
  return { head, body, created, pipWindow, requestWindow, listeners, parent, next, node };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('document PiP helper', () => {
  it('reports support from window.documentPictureInPicture', () => {
    vi.stubGlobal('window', {});
    expect(isDocumentPipSupported()).toBe(false);
    vi.stubGlobal('window', { documentPictureInPicture: {} });
    expect(isDocumentPipSupported()).toBe(true);
  });

  it('rejects without support or without an attached container', async () => {
    vi.stubGlobal('window', {});
    await expect(openPip({} as HTMLElement)).rejects.toThrow('not supported');
    setup();
    await expect(openPip({ parentNode: null } as unknown as HTMLElement)).rejects.toThrow(
      'not attached',
    );
  });

  it('moves the container into the PiP window and restores it on close', async () => {
    const { requestWindow, pipWindow, head, body, created, listeners, parent, next, node } =
      setup();
    const onClose = vi.fn();
    const handle = await openPip(node as unknown as HTMLElement, { onClose });

    expect(requestWindow).toHaveBeenCalledWith({ width: 960, height: 540 });
    expect(pipWindow.document.title).toContain('PiP');
    const style = created.find((item) => item.tag === 'style');
    expect(style?.el.textContent).toContain('television-canvas');
    expect(head.append).toHaveBeenCalledTimes(1);
    expect(body.append).toHaveBeenCalledTimes(1);
    const wrap = created.find((item) => item.tag === 'div');
    expect(wrap?.el.className).toBe('pip-wrap');
    expect(wrap?.el.children).toContain(node);
    expect(wrap?.el.children).toContain(handle.controlsHost);
    expect(handle.controlsHost.className).toBe('pip-controls');
    expect(handle.pipWindow).toBe(pipWindow);

    handle.close();
    expect(parent.insertBefore).toHaveBeenCalledWith(node, next);
    expect(parent.insertBefore).toHaveBeenCalledTimes(1);
    expect(pipWindow.close).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    handle.close();
    expect(parent.insertBefore).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(listeners.has('pagehide')).toBe(true);
  });

  it('restores the container when the PiP window is closed via pagehide', async () => {
    const { listeners, parent, next, node } = setup();
    const onClose = vi.fn();
    await openPip(node as unknown as HTMLElement, { onClose });
    listeners.get('pagehide')!();
    expect(parent.insertBefore).toHaveBeenCalledWith(node, next);
    expect(onClose).toHaveBeenCalledTimes(1);
    listeners.get('pagehide')!();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not register PiP content clicks as a close action', async () => {
    const { created, pipWindow, parent, node } = setup();
    const onClose = vi.fn();
    await openPip(node as unknown as HTMLElement, { onClose });
    const wrap = created.find((item) => item.tag === 'div');
    expect(wrap?.el.listeners.has('click')).toBe(false);
    expect(parent.insertBefore).not.toHaveBeenCalled();
    expect(pipWindow.close).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
