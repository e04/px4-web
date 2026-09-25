import { BMLBrowser } from 'web-bml';
import type { ResponseMessage } from 'web-bml/protocol';
import roundGothic from 'web-bml-fonts/KosugiMaru-Regular.woff2?url';
import boldRoundGothic from 'web-bml-fonts/KosugiMaru-Bold.woff2?url';
import squareGothic from 'web-bml-fonts/Kosugi-Regular.woff2?url';
import { AribKey } from './data-keys';

/**
 * ARIB data broadcasting: carousel decoding in a worker, BML rendered over the video.
 * The document plane is scaled to the video box; in video plane mode the canvas is
 * moved into the rectangle the document reserves for video.
 */
export class DataBroadcast {
  private worker = new Worker(new URL('../workers/data-broadcast.ts', import.meta.url), {
    type: 'module',
  });
  private plane = document.createElement('div');
  private bml: BMLBrowser;
  private resolution = { width: 960, height: 540 };
  private videoRect?: { left: number; top: number; right: number; bottom: number };
  private invisible = true;
  private hidden = false;
  private screenShown = false;
  /** A document has finished loading, including its onload script. */
  private ready = false;
  /** d was pressed before any document was ready; press it once one is. */
  private pendingData = false;
  private observer = new ResizeObserver(() => this.layout());

  constructor(
    private host: HTMLElement,
    private canvas: HTMLCanvasElement,
    serviceId: number,
    log: (message: string) => void,
    private onVisibleChange: (visible: boolean) => void,
  ) {
    Object.assign(this.plane.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      transformOrigin: '0 0',
      visibility: 'hidden',
      pointerEvents: 'none',
    });
    host.appendChild(this.plane);
    this.bml = new BMLBrowser({
      containerElement: this.plane,
      mediaElement: document.createElement('div'),
      videoPlaneModeEnabled: true,
      storagePrefix: 'px4-bml:',
      fonts: {
        roundGothic: { source: `url(${roundGothic})` },
        boldRoundGothic: { source: `url(${boldRoundGothic})` },
        squareGothic: { source: `url(${squareGothic})` },
      },
      showErrorMessage: (title, message, code) =>
        log(`Data broadcast: ${title} ${message}${code ? ` (${code})` : ''}`),
      log: { level: 'warn' },
      // setUrl(_, false) is the only signal that a document's onload has completed.
      indicator: {
        setUrl: (_name, loading) => {
          // A new document may have no video object, and then sends no videochanged.
          if (loading) this.videoRect = undefined;
          this.ready = !loading;
          if (this.ready && this.pendingData) {
            this.pendingData = false;
            this.pressData();
          }
        },
        setReceivingStatus() {},
        setNetworkingGetStatus() {},
        setNetworkingPostStatus() {},
        setEventName() {},
      },
    });
    this.bml.addEventListener('load', (event) => {
      this.resolution = event.detail.resolution;
      this.layout();
    });
    this.bml.addEventListener('invisible', (event) => {
      this.invisible = event.detail;
      this.layout();
    });
    this.bml.addEventListener('videochanged', (event) => {
      this.videoRect = event.detail.clientRect;
      this.layout();
    });
    this.worker.onmessage = (event: MessageEvent<ResponseMessage>) => {
      if (event.data.type === 'error') log(`Data broadcast: ${event.data.message}`);
      else this.bml.emitMessage(event.data);
    };
    this.worker.onerror = () => log('Data broadcast worker failed');
    this.worker.postMessage({ type: 'open', serviceId });
    this.observer.observe(host);
  }

  /**
   * The remote's d key. web-bml drops it while no document is ready (the carousel is still
   * arriving or onload is running), so an early press waits for the first ready document.
   */
  pressData(): void {
    if (!this.ready) {
      this.pendingData = true;
      return;
    }
    if (!this.hidden) this.bml.content.processKeyDown(AribKey.Data);
  }

  push(bytes: ArrayBuffer): void {
    this.worker.postMessage({ type: 'chunk', bytes }, [bytes]);
  }

  key(aribKey: number, down: boolean): void {
    if (this.hidden) return;
    // d only raises DataButtonPressed on key down, and must survive an early press.
    if (aribKey === AribKey.Data) {
      if (down) this.pressData();
      return;
    }
    if (down) this.bml.content.processKeyDown(aribKey);
    else this.bml.content.processKeyUp(aribKey);
  }

  /** PiP moves the canvas to another window, where the BML plane does not follow. */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.layout();
  }

  destroy(): void {
    this.observer.disconnect();
    this.worker.postMessage({ type: 'close' });
    this.worker.terminate();
    this.bml.destroy();
    this.plane.remove();
    this.placeVideo(undefined);
  }

  private layout(): void {
    const { width, height } = this.resolution;
    const shown = !this.invisible && !this.hidden;
    Object.assign(this.plane.style, {
      width: `${width}px`,
      height: `${height}px`,
      // 720x480 documents are anamorphic 16:9, like the video box.
      transform: `scale(${this.host.clientWidth / width}, ${this.host.clientHeight / height})`,
      visibility: shown ? 'visible' : 'hidden',
      pointerEvents: shown ? 'auto' : 'none',
    });
    const rect = shown ? this.videoRect : undefined;
    this.placeVideo(rect);
    // The resident startup document is visible but only shows full-screen video (at most a
    // small banner); the data screen is up once the document takes space from the video.
    const screen = shown && (!rect || !this.fullScreen(rect));
    if (screen !== this.screenShown) {
      this.screenShown = screen;
      this.onVisibleChange(screen);
    }
  }

  private fullScreen(rect: NonNullable<DataBroadcast['videoRect']>): boolean {
    const { width, height } = this.resolution;
    return rect.left <= 0 && rect.top <= 0 && rect.right >= width && rect.bottom >= height;
  }

  private placeVideo(rect: DataBroadcast['videoRect']): void {
    const style = this.canvas.style;
    const { width, height } = this.resolution;
    if (!rect || this.fullScreen(rect)) {
      style.position = style.left = style.top = style.width = style.height = '';
      return;
    }
    style.position = 'absolute';
    style.left = `${(rect.left / width) * 100}%`;
    style.top = `${(rect.top / height) * 100}%`;
    style.width = `${((rect.right - rect.left) / width) * 100}%`;
    style.height = `${((rect.bottom - rect.top) / height) * 100}%`;
  }
}
