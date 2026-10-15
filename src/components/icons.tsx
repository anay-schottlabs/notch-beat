const PATHS = {
  play: "M5 3.5v9l7.5-4.5z",
  pause: "M4.5 3.5h2.5v9H4.5zM9 3.5h2.5v9H9z",
  next: "M3.5 3.5v9l6-4.5zM10.5 3.5h2v9h-2z",
  prev: "M12.5 3.5v9l-6-4.5zM3.5 3.5h2v9h-2z",
  reset: "M8 3a5 5 0 1 1-4.6 3H1.8l2.6-3 2.6 3H5.1A3.4 3.4 0 1 0 8 4.6z",
  chevronUp: "M3.5 10l4.5-4.5 4.5 4.5-1.2 1.2L8 7.9l-3.3 3.3z",
  soundOn: "M2.5 6h2.5l3.5-3v10L5 10H2.5zM10.5 5.2a3.6 3.6 0 0 1 0 5.6l-.9-1a2.3 2.3 0 0 0 0-3.6zM12.3 3.4a6 6 0 0 1 0 9.2l-.9-1a4.6 4.6 0 0 0 0-7.2z",
  soundOff: "M2.5 6h2.5l3.5-3v10L5 10H2.5zM10 6l1 -1 1.5 1.5L14 5l1 1-1.5 1.5L15 9l-1 1-1.5-1.5L11 10l-1-1 1.5-1.5z",
  wave: "M2 7h1.5v2H2zM4.75 5h1.5v6h-1.5zM7.25 2.5h1.5v11h-1.5zM9.75 4.5h1.5v7h-1.5zM12.5 6.5H14v3h-1.5z",
  quit: "M7.2 2h1.6v6H7.2zM4.4 4.2l1.1 1.1a3.9 3.9 0 1 0 5 0l1.1-1.1a5.4 5.4 0 1 1-7.2 0z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
