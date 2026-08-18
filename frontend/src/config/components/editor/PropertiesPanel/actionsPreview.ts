import type { ButtonAction } from '@shared/types/config';

export const ACTION_TYPES = [
  { type: 'openDialog' as const, label: 'Open Dialog' },
  { type: 'closeDialog' as const, label: 'Close Dialog' },
  { type: 'openPageOverlay' as const, label: 'Open Page Overlay' },
  { type: 'closePageOverlay' as const, label: 'Close Page Overlay' },
  { type: 'writeDataVariable' as const, label: 'Write Data Variable' },
  { type: 'recipeLoad' as const, label: 'Recipe: Load' },
  { type: 'recipeSave' as const, label: 'Recipe: Save' },
  { type: 'loginUser' as const, label: 'Login User' },
  { type: 'logoutUser' as const, label: 'Logout User' },
  { type: 'setLanguage' as const, label: 'Set Language' },
  { type: 'setActiveTheme' as const, label: 'Set Theme' },
  { type: 'showAlert' as const, label: 'Show Alert' },
  { type: 'showToast' as const, label: 'Show Toast' },
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

/** Human label for an action type, falling back to the raw type. */
export function actionTypeLabel(type: ButtonAction['type']): string {
  return ACTION_TYPES.find((t) => t.type === type)?.label ?? type;
}
