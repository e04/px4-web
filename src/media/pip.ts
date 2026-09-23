/** Document Picture-in-Picture for the video + caption container. */

export interface PipHandle {
  pipWindow: Window;
  controlsHost: HTMLElement;
  close: () => void;
}

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  readonly window?: Window | undefined;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture | undefined;
  }
}

const PIP_CSS = [
  'html,body{margin:0;height:100%;background:#000}',
  '.pip-wrap{position:relative;width:100vw;height:100vh;background:#000;overflow:hidden;cursor:pointer}',
  '.pip-wrap .television-canvas{display:block;width:100%;height:100%;object-fit:contain}',
  '.pip-controls{position:absolute;inset:0;pointer-events:none}',
  '.pip-controls .video-controls{opacity:0;transition:opacity .15s ease-in-out}',
  '.pip-wrap:hover .pip-controls .video-controls,.pip-wrap:focus-within .pip-controls .video-controls{opacity:1}',
  '.pip-controls-gradient{position:absolute;left:0;right:0;bottom:0;height:96px;background:linear-gradient(to top,rgba(0,0,0,.8),transparent)}',
  '.pip-controls-actions{position:absolute;left:8px;bottom:8px;pointer-events:auto}',
  '.pip-program-info{position:absolute;right:16px;bottom:12px;max-width:calc(100% - 32px);color:#fff;text-align:right;overflow-wrap:anywhere}',
].join('');

export function isDocumentPipSupported(): boolean {
  return typeof window !== 'undefined' && window.documentPictureInPicture != null;
}

export async function openPip(
  node: HTMLElement,
  options: { width?: number; height?: number; onClose?: () => void } = {},
): Promise<PipHandle> {
  const pip = window.documentPictureInPicture;
  if (!pip) throw new Error('Document PiP is not supported in this browser');
  const parent = node.parentNode;
  if (!parent) throw new Error('Video container is not attached');
  const next = node.nextSibling;
  const pipWindow = await pip.requestWindow({
    width: options.width ?? 960,
    height: options.height ?? 540,
  });
  const doc = pipWindow.document;
  doc.title = 'PX4 Viewer PiP';
  if (typeof document !== 'undefined') {
    doc.documentElement.setAttribute(
      'data-mantine-color-scheme',
      document.documentElement.getAttribute('data-mantine-color-scheme') ?? 'dark',
    );
    for (const source of document.querySelectorAll('link[rel="stylesheet"], style')) {
      doc.head.append(source.cloneNode(true));
    }
  }
  const style = doc.createElement('style');
  style.textContent = PIP_CSS;
  doc.head.append(style);
  const wrap = doc.createElement('div');
  wrap.className = 'pip-wrap';
  doc.body.append(wrap);
  wrap.append(node);
  const controlsHost = doc.createElement('div');
  controlsHost.className = 'pip-controls';
  wrap.append(controlsHost);
  let closed = false;
  const restore = () => {
    try {
      parent.insertBefore(node, next);
    } catch {
      parent.appendChild(node);
    }
  };
  const handle: PipHandle = {
    pipWindow,
    controlsHost,
    close: () => {
      if (closed) return;
      closed = true;
      restore();
      options.onClose?.();
      try {
        pipWindow.close();
      } catch {
        /* Already closed. */
      }
    },
  };
  pipWindow.addEventListener('pagehide', () => {
    if (closed) return;
    closed = true;
    restore();
    options.onClose?.();
  });
  wrap.addEventListener('click', () => handle.close());
  return handle;
}
