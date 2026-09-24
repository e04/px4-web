import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface GuideOverlayProps {
  /** The fullscreen element or the PiP controls host; the page body is out of sight in both. */
  host: HTMLElement;
  onClose: () => void;
  children: (portalTarget: HTMLElement) => ReactNode;
}

/** Channel guide laid over the fullscreen video or the PiP window. */
export function GuideOverlay({ host, onClose, children }: GuideOverlayProps) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    // PiP keys arrive at the PiP document, not the page's.
    const doc = host.ownerDocument;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    doc.addEventListener('keydown', onKeyDown);
    return () => doc.removeEventListener('keydown', onKeyDown);
  }, [host, onClose]);

  return createPortal(
    // Clicks must not reach the video, where a PiP click returns the video to the page.
    <div
      className="guide-overlay-backdrop"
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={setNode} className="guide-overlay" aria-label="Channel guide overlay">
        {node && children(node)}
      </div>
    </div>,
    host,
  );
}
