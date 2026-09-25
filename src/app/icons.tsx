import type { ReactNode } from 'react';

export function VideoButtonIcon({ path, size = 20 }: { path: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {path}
    </svg>
  );
}

export function PipButtonIcon({ size }: { size?: number }) {
  return (
    <VideoButtonIcon
      size={size}
      path={
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <rect x="12" y="12" width="7" height="6" rx="1" fill="currentColor" stroke="none" />
        </>
      }
    />
  );
}

export function MaximizeButtonIcon() {
  return <VideoButtonIcon path={<path d="M9 4H3v6M15 4h6v6M9 20H3v-6M15 20h6v-6" />} />;
}

export function MinimizeButtonIcon() {
  return <VideoButtonIcon path={<path d="M3 10h6V4M21 10h-6V4M3 14h6v6M21 14h-6v6" />} />;
}

export function GuideButtonIcon() {
  return (
    <VideoButtonIcon
      path={
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18M9 9v11M13 14.5h4" />
        </>
      }
    />
  );
}

export function SubtitlesButtonIcon() {
  return (
    <VideoButtonIcon
      path={
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M7 11h7M7 15h10" />
        </>
      }
    />
  );
}

export function SettingsButtonIcon({ size }: { size?: number }) {
  return (
    <VideoButtonIcon
      size={size}
      path={
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </>
      }
    />
  );
}

export function DataButtonIcon() {
  return (
    <VideoButtonIcon
      path={
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="11" cy="13" r="3" />
          <path d="M14 7v9" />
        </>
      }
    />
  );
}

export function StopButtonIcon() {
  return (
    <VideoButtonIcon
      path={<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />}
    />
  );
}
