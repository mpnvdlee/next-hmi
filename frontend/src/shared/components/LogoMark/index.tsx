/**
 * The NEXT HMI logo mark.
 *
 * Shared by the app top bar and the runtime boot splash so the artwork exists
 * once. Same mark used by the website and the favicon. The tile follows
 * `currentColor` so it tracks the surrounding chrome, and the two squares are
 * knocked out in the surface behind it — they have to be the ground, not a
 * fixed cream, or the mark stops reading on a tinted panel. The indigo accent
 * is part of the logo and stays literal, lifted a step so it carries on the
 * dark tile the app-chrome palette gives it. The caller sizes it through
 * `className`.
 */
export default function LogoMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" fill="none" aria-hidden="true" focusable="false">
      <rect width="48" height="48" rx="11" fill="currentColor" />
      <g fill="var(--cfg-surface, #faf9f6)">
        <rect x="26" y="8" width="14" height="14" rx="3.5" />
        <rect x="8" y="26" width="14" height="14" rx="3.5" />
      </g>
      <path d="M14.42 8 22 15 14.42 22 8 22 15.58 15 8 8Z" fill="#7b72ee" />
      <rect x="26" y="26" width="14" height="14" rx="3.5" fill="#7b72ee" />
    </svg>
  );
}
