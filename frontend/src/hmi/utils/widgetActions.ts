import type { AnchorRect, ButtonAction, OverlayPlacement } from '@shared/types/config';
import { writeTargetAddress } from '@shared/types/config';
import type { EvaluationContext, ResolvedValue } from '@hmi/utils/propertySourceEval';
import { useVariableStore } from '@hmi/store/variableStore';
import { evaluatePropertyValue, resolveBoundIndex } from '@hmi/utils/propertySourceEval';
import { substituteBoundIndexes } from '@hmi/utils/boundIndexResolution';
import { isAnchoredPlacement } from '@shared/utils/anchorPosition';
import { resolveComponentPropValue } from '@hmi/utils/componentPropResolution';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { resolveUserField, useHmiStore } from '@hmi/store/hmiStore';
import { useThemeRuntimeStore } from '@hmi/store/themeRuntimeStore';
import { useTranslationStore } from '@shared/store/translationStore';
import { randomUuid } from '@shared/utils/id';
import { hasPropertySourceKey } from '@shared/types/propertyValueGuards';
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

function readStoredVariable(datasource: string, path: string): ResolvedValue {
  const value = useVariableStore.getState().values[`${datasource}:${path}`];
  return (value !== undefined ? value : null) as ResolvedValue;
}

/** A write target's bound index resolved at the moment of the write — an action
 *  fired by a page or global event never passed through a widget's resolution. */
function withBoundIndexResolved(target: unknown, ctx: EvaluationContext): unknown {
  return substituteBoundIndexes(target, (index) => resolveBoundIndex(index, ctx));
}

/** The value a write address holds now. A struct member read outside a widget
 *  has no subscription of its own, so it is picked off the struct's record. */
function currentValueAt(target: unknown, ctx: EvaluationContext): unknown {
  const value = evaluatePropertyValue(target, ctx);
  if (value !== null) return value;
  const address = writeTargetAddress(target);
  const slash = address?.path.lastIndexOf('/') ?? -1;
  if (!address || slash < 0) return null;
  const parent = readStoredVariable(address.datasource, address.path.slice(0, slash));
  const record = parent as unknown as Record<string, unknown> | null;
  return typeof record === 'object' && record
    ? (record[address.path.slice(slash + 1)] ?? null)
    : null;
}

/** The range configured on the variable a write address names — its own, or a
 *  struct member's — and whether it holds whole numbers only. */
function configuredRange(address: { datasource: string; path: string }): {
  min?: number;
  max?: number;
  integer: boolean;
} {
  const { varMeta } = useVariableStore.getState();
  const location = address.path.replace(/\[-?\d+\]/g, '');
  const own = varMeta[`${address.datasource}:${location}`];
  if (own) {
    const integer = own.type.kind === 'scalar' && own.type.base === 'Integer';
    return { min: own.min, max: own.max, integer };
  }
  const slash = location.lastIndexOf('/');
  const parent =
    slash > 0 ? varMeta[`${address.datasource}:${location.slice(0, slash)}`] : undefined;
  return { ...parent?.fieldRanges?.[location.slice(slash + 1)], integer: false };
}

/** A number an action field resolves to, or undefined when it is left empty. */
function optionalNumber(value: unknown, ctx: EvaluationContext): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(evaluatePropertyValue(value, ctx));
  return Number.isFinite(n) ? n : undefined;
}

/** Page and global events fire outside any widget, so their context has no
 *  readers of its own; these read the live stores for the firing scope. */
function storeEvalContext(scope: string): EvaluationContext {
  const currentUser = () => useHmiStore.getState().currentUsersByScope[scope];
  return {
    resolveVariable: readStoredVariable,
    resolveTranslation: (key) => useTranslationStore.getState().resolve(key),
    resolveUser: (field) => resolveUserField(currentUser(), field),
    resolveUserGroups: () => currentUser()?.groups ?? ['guest'],
  };
}

export function executeWidgetActions(
  actions: ButtonAction[] | undefined,
  context: ActionContext = {},
): void {
  if (!actions || actions.length === 0) return;

  const { scope = '', anchorEl } = context;
  const evalCtx: EvaluationContext = { ...storeEvalContext(scope), ...context.evalCtx };
  const inputScopeProps = evalCtx.inputScopeProps;

  for (const action of actions) {
    if (action.type === 'openDialog' || action.type === 'openPageOverlay') {
      // Only a Dialogs-folder node declares input parameters, so only
      // `openDialog` carries values to resolve against the opener's scope.
      const supplied = action.type === 'openDialog' ? action.componentProperties : undefined;
      const resolvedPageProps = supplied
        ? Object.fromEntries(
            Object.entries(supplied).map(([k, v]) => [
              k,
              resolveComponentPropValue(v, inputScopeProps),
            ]),
          )
        : {};
      useHmiStore.getState().openPageOverlay({
        pageId: action.pageId,
        componentProperties: resolvedPageProps,
        size: action.size ?? 'medium',
        placement: action.placement ?? 'center',
        width: action.width,
        height: action.height,
        backdrop: action.backdrop,
        anchorRect: anchorRectFor(action.placement, anchorEl),
      });
      continue;
    }

    if (action.type === 'if') {
      const branch = evaluatePropertyValue(action.condition, evalCtx) ? action.then : action.else;
      executeWidgetActions(branch, context);
      continue;
    }

    if (action.type === 'closePageOverlay') {
      useHmiStore.getState().closePageOverlay(action.pageId);
      continue;
    }

    if (action.type === 'writeDataVariable') {
      const address = writeTargetAddress(withBoundIndexResolved(action.target, evalCtx));
      if (!address) continue;
      const requestId = beginAsyncAction(action, scope, inputScopeProps);
      sendWsMessage({
        type: 'write_field',
        ...(requestId && { requestId }),
        scope,
        ...address,
        // A sourced value (a dialog's `$componentProp`, a `$var`) is resolved
        // here; the backend only coerces literals and rejects an object.
        value: hasPropertySourceKey(action.value)
          ? evaluatePropertyValue(action.value, evalCtx)
          : action.value,
      });
      continue;
    }

    if (action.type === 'toggleDataVariable') {
      const address = writeTargetAddress(withBoundIndexResolved(action.target, evalCtx));
      if (!address) continue;
      const requestId = beginAsyncAction(action, scope, inputScopeProps);
      sendWsMessage({
        type: 'toggle_field',
        ...(requestId && { requestId }),
        scope,
        ...address,
      });
      continue;
    }

    if (action.type === 'editValue') {
      const target = withBoundIndexResolved(action.target, evalCtx);
      const address = writeTargetAddress(target);
      if (!address) continue;
      const range = configuredRange(address);
      const decimals = optionalNumber(action.decimals, evalCtx) ?? (range.integer ? 0 : undefined);
      const previous = currentValueAt(target, evalCtx);
      const negative = action.allowNegative;
      useHmiStore.getState().openNumpad({
        id: randomUuid(),
        title: String(evaluatePropertyValue(action.title, evalCtx) ?? '') || undefined,
        unit: String(evaluatePropertyValue(action.unit, evalCtx) ?? '') || undefined,
        min: optionalNumber(action.min, evalCtx) ?? range.min,
        max: optionalNumber(action.max, evalCtx) ?? range.max,
        decimals,
        allowNegative:
          negative === undefined || negative === null
            ? undefined
            : Boolean(evaluatePropertyValue(negative, evalCtx)),
        position: action.position ?? 'center',
        currentValue:
          typeof previous === 'number'
            ? decimals !== undefined
              ? previous.toFixed(decimals)
              : String(previous)
            : undefined,
        apply: (value) => {
          const requestId = beginAsyncAction(action, scope, inputScopeProps, { value, previous });
          sendWsMessage({
            type: 'write_field',
            ...(requestId && { requestId }),
            scope,
            ...address,
            value,
          });
        },
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
        id: randomUuid(),
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
        id: randomUuid(),
        message,
        severity: action.severity,
        discard: action.discard,
        duration: action.duration ?? 4000,
      });
      continue;
    }
  }
}
