import type { JSX } from 'preact';

type P = { size?: number; class?: string };

function Svg({ size = 22, children, ...rest }: P & { children: JSX.Element | JSX.Element[] }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconPlay = (p: P) => (
  <Svg {...p}>
    <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconPause = (p: P) => (
  <Svg {...p}>
    <rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
    <rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconToStart = (p: P) => (
  <Svg {...p}>
    <path d="M6 5v14" />
    <path d="M18 5.5v13L9 12z" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconLoop = (p: P) => (
  <Svg {...p}>
    <path d="M17 2l3 3-3 3" />
    <path d="M4 11V9a4 4 0 0 1 4-4h12" />
    <path d="M7 22l-3-3 3-3" />
    <path d="M20 13v2a4 4 0 0 1-4 4H4" />
  </Svg>
);
export const IconMagnet = (p: P) => (
  <Svg {...p}>
    <path d="M6 3v8a6 6 0 0 0 12 0V3" />
    <path d="M6 7h4M14 7h4" />
    <path d="M10 3v8a2 2 0 0 0 4 0V3" />
  </Svg>
);
export const IconBack = (p: P) => (
  <Svg {...p}>
    <path d="M15 18l-6-6 6-6" />
  </Svg>
);
export const IconUndo = (p: P) => (
  <Svg {...p}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
);
export const IconRedo = (p: P) => (
  <Svg {...p}>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </Svg>
);
export const IconScissors = (p: P) => (
  <Svg {...p}>
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12" />
  </Svg>
);
export const IconCrop = (p: P) => (
  <Svg {...p}>
    <path d="M6 2v14a2 2 0 0 0 2 2h14" />
    <path d="M18 22V8a2 2 0 0 0-2-2H2" />
  </Svg>
);
export const IconRepeat = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="7" width="8" height="10" rx="1.5" />
    <rect x="13" y="7" width="8" height="10" rx="1.5" />
  </Svg>
);
export const IconSplit = (p: P) => (
  <Svg {...p}>
    <path d="M12 2v20" />
    <path d="M8 8l-4 4 4 4M16 8l4 4-4 4" />
  </Svg>
);
export const IconFadeOut = (p: P) => (
  <Svg {...p}>
    <path d="M3 6c6 0 12 4 18 12" />
    <path d="M3 18h18" />
  </Svg>
);
export const IconFadeIn = (p: P) => (
  <Svg {...p}>
    <path d="M3 18C9 10 15 6 21 6" />
    <path d="M3 18h18" />
  </Svg>
);
export const IconWand = (p: P) => (
  <Svg {...p}>
    <path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5" />
  </Svg>
);
export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const IconUpload = (p: P) => (
  <Svg {...p}>
    <path d="M12 16V4M7 9l5-5 5 5" />
    <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
  </Svg>
);
export const IconShare = (p: P) => (
  <Svg {...p}>
    <path d="M12 3v12M8 7l4-4 4 4" />
    <path d="M5 11v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8" />
  </Svg>
);
export const IconDownload = (p: P) => (
  <Svg {...p}>
    <path d="M12 4v12M7 11l5 5 5-5" />
    <path d="M4 20h16" />
  </Svg>
);
export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h16M10 11v6M14 11v6" />
    <path d="M6 7l1 13h10l1-13M9 7V4h6v3" />
  </Svg>
);
export const IconMore = (p: P) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconZoomIn = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3M11 8v6M8 11h6" />
  </Svg>
);
export const IconZoomOut = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3M8 11h6" />
  </Svg>
);
export const IconFit = (p: P) => (
  <Svg {...p}>
    <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
  </Svg>
);
export const IconEdit = (p: P) => (
  <Svg {...p}>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <path d="M20 5L8 15.5M14 13l6 6M8 8.5l3 2.6" />
  </Svg>
);
export const IconLayers = (p: P) => (
  <Svg {...p}>
    <path d="M12 3l9 5-9 5-9-5z" />
    <path d="M3 13l9 5 9-5" />
  </Svg>
);
export const IconSliders = (p: P) => (
  <Svg {...p}>
    <path d="M5 21v-7M5 10V3M12 21v-9M12 8V3M19 21v-5M19 12V3" />
    <path d="M2 14h6M9 8h6M16 16h6" />
  </Svg>
);
export const IconGauge = (p: P) => (
  <Svg {...p}>
    <path d="M12 14l4-4" />
    <path d="M3.3 19a10 10 0 1 1 17.4 0" />
  </Svg>
);
export const IconExport = (p: P) => (
  <Svg {...p}>
    <path d="M14 3h7v7M21 3l-9 9" />
    <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
  </Svg>
);
export const IconMusic = (p: P) => (
  <Svg {...p}>
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </Svg>
);
export const IconX = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);
export const IconBracketL = (p: P) => (
  <Svg {...p}>
    <path d="M10 4H6v16h4" />
    <path d="M14 12h6" />
  </Svg>
);
export const IconBracketR = (p: P) => (
  <Svg {...p}>
    <path d="M14 4h4v16h-4" />
    <path d="M4 12h6" />
  </Svg>
);
export const IconChevL = (p: P) => (
  <Svg {...p}>
    <path d="M14 7l-5 5 5 5" />
  </Svg>
);
export const IconChevR = (p: P) => (
  <Svg {...p}>
    <path d="M10 7l5 5-5 5" />
  </Svg>
);
export const IconClock = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);
export const IconLogo = ({ size = 28 }: P) => (
  <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
    <rect width="64" height="64" rx="16" fill="var(--accent)" />
    <path
      d="M12 34v-4M19 40V24M26 46V18M33 38v-12M40 44V20M47 36v-8M54 33v-2"
      stroke="var(--accent-ink)"
      stroke-width="4"
      stroke-linecap="round"
    />
  </svg>
);
