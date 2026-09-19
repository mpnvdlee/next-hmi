import type { CSSProperties } from 'react';
import type { ButtonAction } from '@shared/types/config';

/** `category` groups the browse drawer, matching the catalog sections in
 *  `docs/user/actions.md`. */
export const ACTION_TYPES = [
  {
    type: 'openDialog' as const,
    label: 'Open Dialog',
    category: 'Screens',
    description: 'Opens a dialog, optionally passing input properties its widgets read.',
  },
  {
    type: 'closeDialog' as const,
    label: 'Close Dialog',
    category: 'Screens',
    description: 'Closes a named dialog, or the top-most one when left empty.',
  },
  {
    type: 'openPageOverlay' as const,
    label: 'Open Page Overlay',
    category: 'Screens',
    description: 'Opens a page or page group as a modal on top of the current screen.',
  },
  {
    type: 'closePageOverlay' as const,
    label: 'Close Page Overlay',
    category: 'Screens',
    description: 'Closes a named page overlay, or the top-most one when left empty.',
  },
  {
    type: 'writeDataVariable' as const,
    label: 'Write Data Variable',
    category: 'Machine',
    description: 'Pushes a value to a writable variable — a coil, a mode, a setpoint.',
  },
  {
    type: 'recipeLoad' as const,
    label: 'Recipe: Load',
    category: 'Machine',
    description: 'Downloads a saved recipe dataset into its variables.',
  },
  {
    type: 'recipeSave' as const,
    label: 'Recipe: Save',
    category: 'Machine',
    description: 'Captures the current live values into a recipe dataset.',
  },
  {
    type: 'loginUser' as const,
    label: 'Login User',
    category: 'Session',
    description: 'Signs this runtime in with a username and password.',
  },
  {
    type: 'logoutUser' as const,
    label: 'Logout User',
    category: 'Session',
    description: 'Drops back to the auto-login user.',
  },
  {
    type: 'setLanguage' as const,
    label: 'Set Language',
    category: 'Interface',
    description: 'Switches the interface language by code.',
  },
  {
    type: 'setActiveTheme' as const,
    label: 'Set Theme',
    category: 'Interface',
    description: 'Switches the active theme by id.',
  },
  {
    type: 'showAlert' as const,
    label: 'Show Alert',
    category: 'Interface',
    description: 'Shows a modal whose OK and Cancel buttons each run their own action list.',
  },
  {
    type: 'showToast' as const,
    label: 'Show Toast',
    category: 'Interface',
    description: 'Shows a transient message with an info, warning or error severity.',
  },
] as const;

/** Tint token per action type, mirrored onto both the badge and the
 *  collapsed-summary keyword so the row reads with one consistent tint (same
 *  rule the property-panel sandbox uses: keyword color == badge color). */
export const ACTION_TYPE_TINT: Record<ButtonAction['type'], string> = {
  openDialog: 'if',
  closeDialog: 'static',
  openPageOverlay: 'page',
  closePageOverlay: 'static',
  writeDataVariable: 'var',
  recipeLoad: 'recipe',
  recipeSave: 'recipeList',
  loginUser: 'user',
  logoutUser: 'userGroups',
  setLanguage: 'languages',
  setActiveTheme: 'viewport',
  showAlert: 'alarmCount',
  showToast: 'result',
};

/** Sets `--option-color` to the action's tint, the hook badges and popup rows
 *  read their color from. */
export function actionTypeColorStyle(type: ButtonAction['type']): CSSProperties {
  return { '--option-color': `var(--cfg-source-${ACTION_TYPE_TINT[type]})` } as CSSProperties;
}

/** Human label for an action type, falling back to the raw type. */
export function actionTypeLabel(type: ButtonAction['type']): string {
  return ACTION_TYPES.find((t) => t.type === type)?.label ?? type;
}
