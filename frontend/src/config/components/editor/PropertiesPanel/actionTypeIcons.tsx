import type { ReactNode } from 'react';
import type { ButtonAction } from '@shared/types/config';
import Icon, { LinkGlyphPaths, GlobeGlyphPaths } from '../../ui/glyphIcon';
import { actionTypeColorStyle } from './actionsPreview';

/** One hand-authored inline SVG glyph per action type, same visual language as
 *  the property-source badges. See `glyphIcon.tsx`. writeDataVariable uses the
 *  24×24 glyph from the property-panel design sandbox; the rest still use the
 *  original 16×16 set. */

type ActionType = ButtonAction['type'];

const ACTION_TYPE_ICON: Record<ActionType, ReactNode> = {
  // A modal card centred on a screen.
  openDialog: (
    <Icon>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <rect x="4.5" y="5.5" width="7" height="5" rx="1" />
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
  // An arrow into a page — goes there.
  navigateToPage: (
    <Icon>
      <rect x="6.5" y="2.5" width="7" height="11" rx="1" />
      <path d="M1.5 8 h7.5 M6.5 5.5 L9 8 l-2.5 2.5" />
    </Icon>
  ),
  // A tab strip with an arrow out of its right end.
  pageGroupNext: (
    <Icon>
      <path d="M1.5 13.5 v-8 h5 v8 M6.5 7.5 h4" />
      <path d="M9.5 10.5 h5 M12.5 8.5 l2 2 l-2 2" />
    </Icon>
  ),
  // The same strip, the arrow pointing back.
  pageGroupPrevious: (
    <Icon>
      <path d="M14.5 13.5 v-8 h-5 v8 M9.5 7.5 h-4" />
      <path d="M6.5 10.5 h-5 M3.5 8.5 l-2 2 l2 2" />
    </Icon>
  ),
  // Three tabs, the middle one raised — picks one by number.
  pageGroupGoTo: (
    <Icon>
      <path d="M1.5 13.5 h13 M1.5 13.5 v-6 h4 M10.5 7.5 h4 v6" />
      <path d="M5.5 13.5 v-9 h5 v9" />
    </Icon>
  ),
  // Link — writes a live signal.
  writeDataVariable: (
    <Icon viewBox="0 0 24 24" strokeWidth={2}>
      <LinkGlyphPaths />
    </Icon>
  ),
  // A path forking in two — one branch or the other.
  // Clock — waits.
  delay: (
    <Icon>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5 v3 l2 1.5" />
    </Icon>
  ),
  if: (
    <Icon>
      <path d="M8 13.5 v-5" />
      <path d="M8 8.5 L3.5 3.5 M8 8.5 L12.5 3.5" />
      <path d="M3.5 6 v-2.5 h2.5 M12.5 6 v-2.5 h-2.5" />
    </Icon>
  ),
  // Two opposed arrows — flips a flag.
  toggleDataVariable: (
    <Icon>
      <path d="M2.5 5.5 h10 M10 3 l2.5 2.5 L10 8" />
      <path d="M13.5 10.5 h-10 M6 8 l-2.5 2.5 L6 13" />
    </Icon>
  ),
  // A keypad — three by three keys.
  editValue: (
    <Icon>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
      <path d="M6 2.5 v11 M10 2.5 v11 M2.5 6 h11 M2.5 10 h11" />
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
  // A play mark inside a component's box.
  runComponentActions: (
    <Icon>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
      <path d="M6.5 5.6 v4.8 l4 -2.4 Z" />
    </Icon>
  ),
  // Check mark — acknowledge.
  acknowledgeAllAlarms: (
    <Icon>
      <path d="M3.2 8.6 l3.1 3.1 L12.8 4.6" />
    </Icon>
  ),
  // Circular arrow — reload.
  reloadHmi: (
    <Icon>
      <path d="M13 8 a5 5 0 1 1 -1.5 -3.5" />
      <path d="M12 1.8 v3 h-3" />
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

/** 'cap' (default) fills a `FieldGroup` badge slot; 'pill' is the inline chip the
 *  property-source popup and browse drawer use, and sits beside a visible label
 *  that already names it. */
export function ActionTypeBadge({
  type,
  variant = 'cap',
}: {
  type: ActionType;
  variant?: 'cap' | 'pill';
}) {
  if (variant === 'pill') {
    return (
      <span
        className="cfg-source-pill__abbr cfg-property-source-badge"
        style={actionTypeColorStyle(type)}
        aria-hidden="true"
      >
        {ACTION_TYPE_ICON[type]}
      </span>
    );
  }
  return (
    <span className="cfg-field-group__badge-cap" title={type} style={actionTypeColorStyle(type)}>
      {ACTION_TYPE_ICON[type]}
    </span>
  );
}
