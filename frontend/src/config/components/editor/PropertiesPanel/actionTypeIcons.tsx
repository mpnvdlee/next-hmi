import type { CSSProperties, ReactNode } from 'react';
import type { ButtonAction } from '@shared/types/config';
import Icon, { LinkGlyphPaths, GlobeGlyphPaths } from '../../ui/glyphIcon';
import { ACTION_TYPE_TINT } from './actionsPreview';

/** One hand-authored inline SVG glyph per action type, same visual language as
 *  the property-source badges. See `glyphIcon.tsx`. openDialog/closeDialog/
 *  writeDataVariable use the 24×24 glyphs from the property-panel design
 *  sandbox; the rest still use the original 16×16 set. */

type ActionType = ButtonAction['type'];

const ACTION_TYPE_ICON: Record<ActionType, ReactNode> = {
  // Dialog with a title bar.
  openDialog: (
    <Icon viewBox="0 0 24 24" strokeWidth={2}>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M4 9h16" />
    </Icon>
  ),
  // Same dialog, a close bar through the middle.
  closeDialog: (
    <Icon viewBox="0 0 24 24" strokeWidth={2}>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M9 12h6" />
    </Icon>
  ),
  // Two overlapping pages.
  openPageOverlay: (
    <Icon>
      <path d="M6 2.5 h6 v7" />
      <rect x="2.5" y="5.5" width="8" height="8" rx="1" />
    </Icon>
  ),
  // Overlapping pages, crossed out.
  closePageOverlay: (
    <Icon>
      <path d="M6 2.5 h6 v7" />
      <rect x="2.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M5 8 l4.5 4.5 M9.5 8 l-4.5 4.5" />
    </Icon>
  ),
  // Link — writes a live signal.
  writeDataVariable: (
    <Icon viewBox="0 0 24 24" strokeWidth={2}>
      <LinkGlyphPaths />
    </Icon>
  ),
  // Tray, arrow down — load into the form.
  recipeLoad: (
    <Icon>
      <path d="M8 2.5 v6.5" />
      <path d="M5.2 6.2 L8 9 L10.8 6.2" />
      <path d="M2.8 11 h10.4 v2.5 H2.8 Z" />
    </Icon>
  ),
  // Tray, arrow up — save from the form.
  recipeSave: (
    <Icon>
      <path d="M8 11 v-6.5" />
      <path d="M5.2 7.3 L8 4.5 L10.8 7.3" />
      <path d="M2.8 11 h10.4 v2.5 H2.8 Z" />
    </Icon>
  ),
  // Person, arrow in.
  loginUser: (
    <Icon>
      <circle cx="6.3" cy="5.2" r="2.3" />
      <path d="M2.3 13.2 a4 3.6 0 0 1 8 0" />
      <path d="M11 8.2 h3.2 M13 6.6 l1.6 1.6 -1.6 1.6" />
    </Icon>
  ),
  // Person, arrow out.
  logoutUser: (
    <Icon>
      <circle cx="6.3" cy="5.2" r="2.3" />
      <path d="M2.3 13.2 a4 3.6 0 0 1 8 0" />
      <path d="M14.2 8.2 h-3.2 M12.4 6.6 l-1.6 1.6 1.6 1.6" />
    </Icon>
  ),
  // Globe.
  setLanguage: (
    <Icon>
      <GlobeGlyphPaths />
    </Icon>
  ),
  // Half-filled circle — theme swap.
  setActiveTheme: (
    <Icon>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5 a5.5 5.5 0 0 1 0 11 Z" fill="currentColor" stroke="none" opacity="0.85" />
    </Icon>
  ),
  // Exclamation triangle.
  showAlert: (
    <Icon>
      <path d="M8 2.6 L14 13.4 H2 Z" />
      <path d="M8 6.4 v3" />
      <circle cx="8" cy="11.2" r="0.9" fill="currentColor" stroke="none" />
    </Icon>
  ),
  // Toast rising with motion lines.
  showToast: (
    <Icon>
      <rect x="2.5" y="6.5" width="11" height="5" rx="2.5" />
      <path d="M5.5 5 v-1.8 M8 4.6 v-2.3 M10.5 5 v-1.8" />
    </Icon>
  ),
};

export function ActionTypeBadge({ type }: { type: ActionType }) {
  return (
    <span
      className="cfg-field-group__badge-cap"
      title={type}
      style={{ '--option-color': `var(--cfg-source-${ACTION_TYPE_TINT[type]})` } as CSSProperties}
    >
      {ACTION_TYPE_ICON[type]}
    </span>
  );
}
