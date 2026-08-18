import type { AnchorRect, ButtonAction, OverlayPlacement } from '@shared/types/config';
import type { EvaluationContext } from '@hmi/utils/propertySourceEval';
import { evaluatePropertyValue } from '@hmi/utils/propertySourceEval';
import { isAnchoredPlacement } from '@shared/utils/anchorPosition';
import { resolveComponentPropValue } from '@hmi/utils/componentPropResolution';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { useHmiStore } from '@hmi/store/hmiStore';
import { useThemeRuntimeStore } from '@hmi/store/themeRuntimeStore';
import { useTranslationStore } from '@shared/store/translationStore';
import { beginAsyncAction } from '@hmi/utils/actionDispatcher';

interface ActionContext {
  scope?: string;
  /** Eval context from `useEvalContext` — already carries the firing site's
   *  input scope via `inputScopeProps`. */
  evalCtx?: EvaluationContext;
  /** Element that fired the action, used to anchor `trigger-*` placements. */
  anchorEl?: HTMLElement | null;
}

/** Snapshot the trigger's bounds when an anchored placement is requested. */
function anchorRectFor(
  placement: OverlayPlacement | undefined,
  anchorEl: HTMLElement | null | undefined,
): AnchorRect | undefined {
  if (!isAnchoredPlacement(placement) || !anchorEl) return undefined;
  const r = anchorEl.getBoundingClientRect();
  return {
    top: r.top,
    left: r.left,
    right: r.right,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  };
}

export function executeWidgetActions(
  actions: ButtonAction[] | undefined,
  context: ActionContext = {},
): void {
  if (!actions || actions.length === 0) return;

  const { scope = '', evalCtx = {}, anchorEl } = context;
  const inputScopeProps = evalCtx.inputScopeProps;

  for (const action of actions) {
    if (action.type === 'openDialog') {
      const resolved = action.componentProperties
        ? Object.fromEntries(
            Object.entries(action.componentProperties).map(([k, v]) => [
              k,
              resolveComponentPropValue(v, inputScopeProps),
            ]),
          )
        : undefined;
      useHmiStore.getState().openDialog(action.dialogId, resolved, {
        size: action.size ?? 'auto',
        placement: action.placement,
        width: action.width,
        height: action.height,
        backdrop: action.backdrop,
        anchorRect: anchorRectFor(action.placement, anchorEl),
      });
      continue;
    }

    if (action.type === 'closeDialog') {
      useHmiStore.getState().closeDialog(action.dialogId);
      continue;
    }

    if (action.type === 'openPageOverlay') {
      useHmiStore.getState().openPageOverlay({
        pageId: action.pageId,
        size: action.size ?? 'medium',
        placement: action.placement ?? 'center',
        width: action.width,
        height: action.height,
        backdrop: action.backdrop,
        anchorRect: anchorRectFor(action.placement, anchorEl),
      });
      continue;
    }

    if (action.type === 'closePageOverlay') {
      useHmiStore.getState().closePageOverlay(action.pageId);
      continue;
    }

    if (action.type === 'writeDataVariable') {
      if (!action.datasource || !action.path) continue;
      const requestId = beginAsyncAction(action, scope, inputScopeProps);
      sendWsMessage({
        type: 'write_field',
        ...(requestId && { requestId }),
        scope,
        datasource: action.datasource,
        path: action.path,
        value: action.value,
      });
      continue;
    }

    if (action.type === 'recipeLoad') {
      const datasetId = String(evaluatePropertyValue(action.datasetId, evalCtx) ?? '');
      if (!datasetId) continue;
      const requestId = beginAsyncAction(action, scope, inputScopeProps);
      sendWsMessage({
        type: 'recipe_load',
        ...(requestId && { requestId }),
        scope,
        datasetId,
        ...(action.verify && { verify: true }),
      });
      continue;
    }

    if (action.type === 'recipeSave') {
      // No datasetId configured → save the currently-loaded dataset (backend
      // default). A configured datasetId that resolves to empty is an
      // unresolved target — skip rather than silently save the wrong dataset.
      let datasetId: string | undefined;
      if (action.datasetId !== undefined) {
        datasetId = String(evaluatePropertyValue(action.datasetId, evalCtx) ?? '');
        if (!datasetId) continue;
      }
      const requestId = beginAsyncAction(action, scope, inputScopeProps);
      sendWsMessage({
        type: 'recipe_save',
        ...(requestId && { requestId }),
        scope,
        ...(datasetId && { datasetId }),
      });
      continue;
    }

    if (action.type === 'loginUser') {
      const username = String(evaluatePropertyValue(action.username, evalCtx) ?? '');
      const password = String(evaluatePropertyValue(action.password, evalCtx) ?? '');
      const requestId = beginAsyncAction(action, scope, inputScopeProps);
      sendWsMessage({
        type: 'login',
        ...(requestId && { requestId }),
        scope,
        username,
        password,
      });
      continue;
    }

    if (action.type === 'logoutUser') {
      const requestId = beginAsyncAction(action, scope, inputScopeProps);
      sendWsMessage({ type: 'logout', ...(requestId && { requestId }), scope });
      continue;
    }

    if (action.type === 'setLanguage') {
      const lang = String(evaluatePropertyValue(action.language, evalCtx) ?? '');
      if (lang) {
        useTranslationStore.getState().setActiveLanguage(lang);
      }
      continue;
    }

    if (action.type === 'setActiveTheme') {
      const themeId = String(evaluatePropertyValue(action.theme, evalCtx) ?? '');
      if (themeId) {
        useThemeRuntimeStore.getState().setActiveTheme(themeId);
      }
      continue;
    }

    if (action.type === 'showAlert') {
      const title = String(evaluatePropertyValue(action.title, evalCtx) ?? '');
      const description = String(evaluatePropertyValue(action.description, evalCtx) ?? '');
      const cancelText = String(evaluatePropertyValue(action.cancelText, evalCtx) ?? 'Cancel');
      const okText = String(evaluatePropertyValue(action.okText, evalCtx) ?? 'OK');
      useHmiStore.getState().showAlert({
        id: crypto.randomUUID(),
        title,
        description,
        cancelText,
        okText,
        dismissible: action.dismissible ?? false,
        onCancel: action.onCancel ?? [],
        onOk: action.onOk ?? [],
        // Capture so AlertModal can replay onOk/onCancel under the firing
        // site's input scope, even though it renders at the top of HmiView.
        inputScopeProps,
      });
      continue;
    }

    if (action.type === 'showToast') {
      const message = String(evaluatePropertyValue(action.message, evalCtx) ?? '');
      useHmiStore.getState().showToast({
        id: crypto.randomUUID(),
        message,
        severity: action.severity,
        discard: action.discard,
        duration: action.duration ?? 4000,
      });
      continue;
    }
  }
}
