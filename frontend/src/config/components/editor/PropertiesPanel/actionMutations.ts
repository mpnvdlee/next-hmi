import type { ButtonAction } from '@shared/types/config';
import type { OverlayTargets } from './actionEditors';
import type { getWriteCoercionKind } from '@config/utils/variableType';

export function getDefaultValueForKind(
  kind: ReturnType<typeof getWriteCoercionKind>,
): string | number | boolean {
  if (kind === 'boolean') return false;
  if (kind === 'number') return 0;
  return '';
}

/** Build a fresh default ButtonAction for the given type. */
export function makeDefaultAction(
  type: string,
  context: { overlayTargets: OverlayTargets },
): ButtonAction | null {
  switch (type) {
    case 'openDialog':
      return {
        type: 'openDialog',
        pageId: context.overlayTargets.dialogs[0]?.id ?? '',
        componentProperties: {},
        size: 'medium',
        placement: 'center',
      };
    case 'openPageOverlay':
      return {
        type: 'openPageOverlay',
        pageId: context.overlayTargets.pages[0]?.id ?? '',
        size: 'medium',
        placement: 'center',
      };
    case 'closePageOverlay':
      return { type: 'closePageOverlay' };
    case 'writeDataVariable':
      return { type: 'writeDataVariable', datasource: '', path: '', value: '' };
    case 'recipeLoad':
      return { type: 'recipeLoad', datasetId: { $static: '' }, verify: false };
    case 'recipeSave':
      return { type: 'recipeSave', datasetId: { $static: '' } };
    case 'loginUser':
      return {
        type: 'loginUser',
        username: { $static: '' },
        password: { $static: '' },
      };
    case 'logoutUser':
      return { type: 'logoutUser' };
    case 'setLanguage':
      return { type: 'setLanguage', language: { $static: '' } };
    case 'setActiveTheme':
      return { type: 'setActiveTheme', theme: { $static: '' } };
    case 'showAlert':
      return {
        type: 'showAlert',
        title: { $static: '' },
        description: { $static: '' },
        cancelText: { $static: 'Cancel' },
        okText: { $static: 'OK' },
        dismissible: false,
        onCancel: [],
        onOk: [],
      };
    case 'showToast':
      return {
        type: 'showToast',
        message: { $static: '' },
        severity: 'info',
        discard: 'auto',
        duration: 4000,
      };
    default:
      return null;
  }
}
