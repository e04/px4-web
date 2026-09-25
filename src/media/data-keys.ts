// ARIB STD-B24 remote keys, numbered as web-bml's AribKeyCode (exported there only as a type).
export const AribKey = {
  Up: 1,
  Down: 2,
  Left: 3,
  Right: 4,
  Digit0: 5,
  Enter: 18,
  Back: 19,
  Data: 20,
  Blue: 21,
  Red: 22,
  Green: 23,
  Yellow: 24,
} as const;

const KEYS: Record<string, number> = {
  ArrowUp: AribKey.Up,
  ArrowDown: AribKey.Down,
  ArrowLeft: AribKey.Left,
  ArrowRight: AribKey.Right,
  Enter: AribKey.Enter,
  ' ': AribKey.Enter,
  Backspace: AribKey.Back,
  x: AribKey.Back,
  d: AribKey.Data,
  b: AribKey.Blue,
  r: AribKey.Red,
  g: AribKey.Green,
  y: AribKey.Yellow,
};

/** Map a keyboard event to a remote key, or undefined when it belongs to the page. */
export function aribKeyFromEvent(event: KeyboardEvent): number | undefined {
  if (event.altKey || event.ctrlKey || event.metaKey) return undefined;
  // The target may belong to the PiP window, whose Element differs from this realm's.
  const target = event.target as Partial<Element> | null;
  if (target?.closest?.('input, textarea, select, button, [role="slider"], [contenteditable]'))
    return undefined;
  if (/^[0-9]$/.test(event.key)) return AribKey.Digit0 + Number(event.key);
  return KEYS[event.key.length === 1 ? event.key.toLowerCase() : event.key];
}
