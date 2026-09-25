import { useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { UnstyledButton } from '@mantine/core';
import { AribKey } from '../../media/data-keys';

interface DataRemoteProps {
  onKey: (key: number, down: boolean) => void;
}

// Kept across remounts (toggling the remote, PiP) for the page's lifetime.
let lastOffset = { right: 8, bottom: 56 };

const COLORS: [string, number, string][] = [
  ['Blue', AribKey.Blue, '#1c7ed6'],
  ['Red', AribKey.Red, '#e03131'],
  ['Green', AribKey.Green, '#2f9e44'],
  ['Yellow', AribKey.Yellow, '#f5c518'],
];

/** On-screen remote for data broadcasting: d, colour keys, cursor pad, back and digits. */
export function DataRemote({ onKey }: DataRemoteProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Offset from the video's bottom-right corner, moved by dragging anywhere but a key.
  const [offset, setOffset] = useState(lastOffset);
  const drag = useRef<{ x: number; y: number; right: number; bottom: number }>(undefined);
  const onDragStart = (event: PointerEvent) => {
    if ((event.target as Element).closest('.data-remote-key')) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, ...offset };
  };
  const onDragMove = (event: PointerEvent) => {
    const start = drag.current;
    const panel = panelRef.current;
    const parent = panel?.offsetParent as HTMLElement | null;
    if (!start || !panel || !parent) return;
    const clamp = (value: number, max: number) => Math.min(Math.max(0, value), Math.max(0, max));
    setOffset({
      right: clamp(start.right - (event.clientX - start.x), parent.clientWidth - panel.offsetWidth),
      bottom: clamp(
        start.bottom - (event.clientY - start.y),
        parent.clientHeight - panel.offsetHeight,
      ),
    });
  };
  const onDragEnd = () => {
    drag.current = undefined;
    lastOffset = offset;
  };
  const key = (label: string, code: number, content: ReactNode, style?: CSSProperties) => (
    <UnstyledButton
      key={label}
      className="data-remote-key"
      aria-label={label}
      title={label}
      style={style}
      onPointerDown={(event) => {
        event.preventDefault();
        onKey(code, true);
      }}
      onPointerUp={() => onKey(code, false)}
      onPointerLeave={(event) => {
        if (event.buttons) onKey(code, false);
      }}
    >
      {content}
    </UnstyledButton>
  );
  return (
    <div
      ref={panelRef}
      className="video-controls data-remote"
      style={offset}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={onDragStart}
      onPointerMove={onDragMove}
      onPointerUp={onDragEnd}
      onPointerCancel={onDragEnd}
    >
      <div className="data-remote-grip" aria-hidden />
      <div className="data-remote-row">
        {key('d', AribKey.Data, 'd', { fontWeight: 700 })}
        {key('Back', AribKey.Back, '↩')}
      </div>
      <div className="data-remote-row">
        {COLORS.map(([label, code, color]) =>
          key(label, code, null, { background: color, height: 14 }),
        )}
      </div>
      <div className="data-remote-pad">
        {key('Up', AribKey.Up, '▲', { gridArea: 'up' })}
        {key('Left', AribKey.Left, '◀', { gridArea: 'left' })}
        {key('Enter', AribKey.Enter, 'OK', { gridArea: 'enter' })}
        {key('Right', AribKey.Right, '▶', { gridArea: 'right' })}
        {key('Down', AribKey.Down, '▼', { gridArea: 'down' })}
      </div>
      <div className="data-remote-digits">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((digit) =>
          key(String(digit), AribKey.Digit0 + digit, digit),
        )}
      </div>
    </div>
  );
}
