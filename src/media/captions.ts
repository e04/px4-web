import { CanvasMainThreadRenderer, MPEGTSFeeder } from 'aribb24.js';

/** ARIB B24 caption overlay driven by the player audio clock (no <video> element). */
export class CaptionOverlay {
  private captionFeeder = new MPEGTSFeeder({
    recieve: { type: 'Caption', language: 0 },
    tokenizer: {},
    offset: {},
  });
  private superFeeder = new MPEGTSFeeder({
    recieve: { type: 'Superimpose', language: 0 },
    tokenizer: {},
    offset: {},
  });
  private captionView = new CanvasMainThreadRenderer({
    font: {
      normal:
        "'Noto Sans JP', 'Hiragino Maru Gothic Pro', 'BIZ UDGothic', 'Yu Gothic Medium', sans-serif",
    },
  });
  private superView = new CanvasMainThreadRenderer({
    font: {
      normal:
        "'Noto Sans JP', 'Hiragino Maru Gothic Pro', 'BIZ UDGothic', 'Yu Gothic Medium', sans-serif",
    },
  });
  private captionPts: number | null = null;
  private superPts: number | null = null;
  private decodeTime = -Infinity;
  private captionDts = -Infinity;
  private superDts = -Infinity;
  private animation = 0;
  private observer?: ResizeObserver;
  private destroyed = false;

  constructor(
    private container: HTMLElement,
    private clock: () => number | undefined,
  ) {
    this.captionFeeder.prepare(-Infinity);
    this.superFeeder.prepare(-Infinity);
    this.captionView.onAttach(container);
    this.superView.onAttach(container);
    this.resize();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.animation = requestAnimationFrame(this.tick);
  }

  setEnabled(on: boolean): void {
    if (on) {
      this.captionView.show();
      this.superView.show();
    } else {
      this.captionView.hide();
      this.superView.hide();
    }
  }

  push(kind: 'caption' | 'super', bytes: Uint8Array, pts: number, dts: number): void {
    if (this.destroyed) return;
    // Feeder only decodes DTS in [previous content time, current time).
    // Keep late packets reachable and distinct, without changing their display PTS.
    if (kind === 'caption') {
      this.captionDts = Math.max(dts, this.decodeTime, this.captionDts + 0.000001);
      this.captionFeeder.feedB24(bytes, pts, this.captionDts);
    } else {
      this.superDts = Math.max(dts, this.decodeTime, this.superDts + 0.000001);
      this.superFeeder.feedB24(bytes, pts, this.superDts);
    }
  }

  reset(): void {
    this.captionFeeder.clear();
    this.superFeeder.clear();
    this.captionFeeder.prepare(-Infinity);
    this.superFeeder.prepare(-Infinity);
    this.decodeTime = this.captionDts = this.superDts = -Infinity;
    this.clear();
  }

  private clear(): void {
    this.captionView.clear();
    this.superView.clear();
    this.captionPts = this.superPts = null;
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const scale = window.devicePixelRatio || 1;
    const width = Math.round(rect.width * scale),
      height = Math.round(rect.height * scale);
    this.captionView.onContainerResize(width, height);
    this.superView.onContainerResize(width, height);
  }

  private tick = () => {
    if (this.destroyed) return;
    const time = this.clock();
    if (time !== undefined) {
      this.decodeTime = Math.max(time, this.decodeTime);
      this.paint(this.captionFeeder, this.captionView, this.decodeTime, 'caption');
      this.paint(this.superFeeder, this.superView, this.decodeTime, 'super');
    }
    this.animation = requestAnimationFrame(this.tick);
  };

  private paint(
    feeder: MPEGTSFeeder,
    view: CanvasMainThreadRenderer,
    time: number,
    which: 'caption' | 'super',
  ): void {
    const current = feeder.content(time);
    const previous = which === 'caption' ? this.captionPts : this.superPts;
    const remember = (value: number | null) => {
      if (which === 'caption') this.captionPts = value;
      else this.superPts = value;
    };
    if (current == null) {
      if (previous != null) {
        view.clear();
        remember(null);
      }
      return;
    }
    if (time >= current.pts + current.duration) {
      const end = current.pts + current.duration;
      if (previous !== end) {
        view.clear();
        remember(end);
      }
      return;
    }
    if (previous === current.pts) return;
    view.render(
      structuredClone(current.state),
      structuredClone(current.data),
      structuredClone(current.info),
    );
    remember(current.pts);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.animation);
    this.observer?.disconnect();
    this.captionView.onDetach();
    this.superView.onDetach();
    this.captionView.destroy();
    this.superView.destroy();
    this.captionFeeder.destroy();
    this.superFeeder.destroy();
  }
}
