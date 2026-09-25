import { BMLBrowser } from 'web-bml';
import type { ResponseMessage } from 'web-bml/protocol';
import roundGothic from 'web-bml-fonts/KosugiMaru-Regular.woff2?url';
import boldRoundGothic from 'web-bml-fonts/KosugiMaru-Bold.woff2?url';
import squareGothic from 'web-bml-fonts/Kosugi-Regular.woff2?url';
import { AribKey } from './data-keys';

const ZIP_CODE = 'nvram://receiverinfo/zipcode';

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
  /** d was pressed before the document could take it; press it once it can. */
  private pendingData = false;
  /** From a d press until the data screen appears or disappears. */
  private loading = false;
  private loadingTimer?: number;
  private observer = new ResizeObserver(() => this.layout());
  /** The BML document root, which web-bml keeps private behind a closed shadow root. */
  private documentElement: HTMLElement;
  private subscribeObserver = new MutationObserver(() => this.flushData());

  constructor(
    private host: HTMLElement,
    private canvas: HTMLCanvasElement,
    serviceId: number,
    log: (message: string) => void,
    private onVisibleChange: (visible: boolean) => void,
    private onLoadingChange: (loading: boolean) => void,
  ) {
    Object.assign(this.plane.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      transformOrigin: '0 0',
      visibility: 'hidden',
      opacity: '0',
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
          // A press the previous document never took is not meant for the next one.
          if (loading && this.ready && this.pendingData) {
            this.pendingData = false;
            this.setLoading(false);
          }
          this.ready = !loading;
          this.flushData();
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
    this.documentElement = (
      this.bml.content as unknown as { documentElement: HTMLElement }
    ).documentElement;
    // Documents subscribe to DataButtonPressed from script once they can handle it.
    // A new document's beitems are covered by setUrl, as they are in place when it loads.
    this.subscribeObserver.observe(this.documentElement, {
      subtree: true,
      attributeFilter: ['subscribe'],
    });
    this.worker.onerror = () => log('Data broadcast worker failed');
    this.worker.postMessage({ type: 'open', serviceId });
    this.observer.observe(host);
  }

  /**
   * The remote's d key. It only reaches a document that has loaded and subscribes to
   * DataButtonPressed, which some documents do seconds after onload (TBS waits for its
   * modules), so an early press waits for that instead of being dropped.
   */
  pressData(): void {
    if (this.hidden) return;
    this.pendingData = true;
    this.setLoading(true);
    this.flushData();
  }

  private flushData(): void {
    if (!this.pendingData || !this.ready) return;
    const subscribed = this.documentElement.querySelector(
      'beitem[type="DataButtonPressed"][subscribe="subscribe"]',
    );
    if (!subscribed) return;
    this.pendingData = false;
    if (this.hidden) return this.setLoading(false);
    this.bml.content.processKeyDown(AribKey.Data);
    // Nothing acknowledges the press, so stop waiting if the screen never changes.
    this.loadingTimer = window.setTimeout(() => this.setLoading(false), 10_000);
  }

  private setLoading(loading: boolean): void {
    clearTimeout(this.loadingTimer);
    if (loading === this.loading) return;
    this.loading = loading;
    this.onLoadingChange(loading);
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

  /** The receiver's postal code (7 digits, or empty), which documents use for local content. */
  get zipCode(): string {
    const row = this.bml.nvram.readPersistentArray(ZIP_CODE, 'S:7B');
    return /^\d{7}$/.test(String(row?.[0])) ? String(row?.[0]) : '';
  }

  set zipCode(zipCode: string) {
    this.bml.nvram.writePersistentArray(ZIP_CODE, 'S:7B', [zipCode]);
  }

  /** PiP moves the canvas to another window, where the BML plane does not follow. */
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.layout();
  }

  destroy(): void {
    clearTimeout(this.loadingTimer);
    this.observer.disconnect();
    this.subscribeObserver.disconnect();
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
      // web-bml's stylesheet forces the document body visible, which overrides the plane's
      // visibility; opacity hides the whole subtree regardless.
      visibility: shown ? 'visible' : 'hidden',
      opacity: shown ? '1' : '0',
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
      this.setLoading(false);
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
