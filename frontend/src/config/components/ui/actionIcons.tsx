import type { SVGProps } from 'react';
import GlyphIcon from './glyphIcon';

/** Fixed-size inline SVG glyphs for the shared field/row action buttons
 *  (`.cfg-row-action-btn`) — edit, clear, expand. Slightly heavier stroke than
 *  the badge glyphs (1.5 vs `GlyphIcon`'s 1.4 default) since these render smaller. */
function ActionIcon(props: SVGProps<SVGSVGElement>) {
  return <GlyphIcon strokeWidth={1.5} {...props} />;
}

/** `×` — clear a value / remove a row. */
export function ClearIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ActionIcon {...props}>
      <path d="M4 4 L12 12 M12 4 L4 12" />
    </ActionIcon>
  );
}

/** `✎` — open the binding picker / edit. */
export function EditIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ActionIcon {...props}>
      <path d="M9.5 4 L12 6.5 L6 12.5 L3.2 13.3 L4 10.5 Z" />
      <path d="M8.5 5 L11 7.5" />
    </ActionIcon>
  );
}

/** `文A` — edit the texts of a translation key. */
export function TranslateIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ActionIcon {...props}>
      <path d="M1.5 4.2 H7.4 M4.4 2.6 V4.2" />
      <path d="M6.6 4.2 C6.1 7.2 4.2 9.4 1.6 10.6" />
      <path d="M3.2 6.6 C4 8.6 5.4 10 7.2 10.8" />
      <path d="M8.9 14 L11.5 7.4 L14.1 14" />
      <path d="M9.9 11.6 H13.1" />
    </ActionIcon>
  );
}

/** `›` — collapse/expand a tier-3 field. Rotate 90° via `.is-open` for expanded. */
export function ChevronIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ActionIcon {...props}>
      <path d="M6 3.5 L10.5 8 L6 12.5" />
    </ActionIcon>
  );
}

/** `⌄` — a select trigger's open affordance. Rotates 180° when the popup is open. */
export function ChevronDownIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ActionIcon {...props}>
      <path d="M3.5 6 L8 10.5 L12.5 6" />
    </ActionIcon>
  );
}

/** `⤢` — expand the field in a side drawer. */
export function ExpandIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <ActionIcon {...props}>
      <path d="M9 3 H13 V7" />
      <path d="M13 3 L8.5 7.5" />
      <path d="M7 13 H3 V9" />
      <path d="M3 13 L7.5 8.5" />
    </ActionIcon>
  );
}
