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
