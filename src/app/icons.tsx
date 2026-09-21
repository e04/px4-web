import type { ReactNode } from 'react';

export function VideoButtonIcon({ path }: { path: ReactNode }) {
  return (
    <svg
      width="20"
      height="20"
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

export function PipButtonIcon() {
  return (
    <VideoButtonIcon
      path={
        <>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor" stroke="none" />
        </>
      }
    />
  );
}

export function MaximizeButtonIcon() {
  return <VideoButtonIcon path={<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />} />;
}

export function MinimizeButtonIcon() {
  return <VideoButtonIcon path={<path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5" />} />;
}

export function SubtitlesButtonIcon() {
  return (
    <VideoButtonIcon
      path={
        <>
          <rect x="3" y="5" width="18" height="13" rx="2" />
          <path d="M7 11h7M7 14.5h10" />
        </>
      }
    />
  );
}
