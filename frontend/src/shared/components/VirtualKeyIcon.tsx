// Inline, not Phosphor: the soft keyboards open on runtime panels where a lazy
// icon chunk would flash an empty key, and a glyph like ⌫ is missing from many
// kiosk fonts.
const PATHS = {
  backspace: 'M8.5 5H20v14H8.5L3 12z M11.5 9.5l5 5 M16.5 9.5l-5 5',
  enter: 'M19 5v7H6 M10 8l-4 4 4 4',
  shift: 'M12 4l7 8h-4v7H9v-7H5z',
  capsLock: 'M12 3l7 7.5h-4V15H9v-4.5H5z M9 19h6',
  tab: 'M4 12h14 M14 8l4 4-4 4 M20 6v12',
  clear: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z M9 9l6 6 M15 9l-6 6',
  space: 'M4 10v4h16v-4',
  warning: 'M12 4l9 16H3z M12 10v4.5 M12 17.5v.5',
} as const;

export type VirtualKeyIconName = keyof typeof PATHS;

export function VirtualKeyIcon({ name }: { name: VirtualKeyIconName }) {
  return (
    <svg
      className="hmi-virtual-input__key-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
