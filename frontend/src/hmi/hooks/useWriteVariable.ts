/**
 * The one supported way for a widget to write a bound variable.
 *
 * Composes what the SDK already exposes — binding lookup, scope, write
 * coercion, the pending-request dispatcher — into a single call so every
 * writer widget correlates its write and surfaces a rejection. Writing raw
 * `sendWsMessage({ type: 'write_field', … })` omits the `requestId`, which
 * makes the backend skip its `write_response` / `write_error` entirely: an
 * out-of-range value or a `interactableByGroups` denial then reaches the
 * operator as nothing at all.
 */

import { useCallback, useId, useMemo } from 'react';
import { bindingKey } from '@shared/types/config';
import { parseVarKey } from '@shared/types/datasource';
import { coerceOpcuaWrite, type OpcuaWriteDescriptor } from '@shared/utils/opcuaWriteCoercion';
import { getPropBinding } from '../components/layoutUtils';
import { useHmiScope } from '../context/HmiScopeContext';
import { useHmiStore } from '../store/hmiStore';
import type { VarMeta } from '../store/variableStore';
import { beginTrackedWrite } from '../utils/actionDispatcher';
import { useVariableMeta } from './useVariable';
import { sendWsMessage } from './useWebSocket';

export interface WriteVariableOptions {
  /**
   * How a rejected write is surfaced. `'toast'` (the default) shows one error
   * toast; `'silent'` swallows it; a function receives the raw reason code.
   */
  onError?: 'toast' | 'silent' | ((reason: string) => void);
  /**
   * Correlate each write with a `requestId` so the backend answers and a
   * rejection can be reported — the default, and what a discrete control
   * (button, switch, numpad commit) needs. Pass `false` from a continuous
   * writer such as a slider drag: every tracked write costs a pending-map
   * entry, a 10 s timer and a response frame, which at drag rates is a hot
   * path. Local coercion still applies; only backend rejections go unseen.
   */
  tracked?: boolean;
}

/** Write `value` to the bound variable; `opts.field` targets one struct field. */
export interface WriteVariable {
  (value: unknown, opts?: { field?: string }): void;
  /**
   * Whether a `$var` binding resolved. When false every call is a no-op, so a
   * widget gates its control on this instead of on the presence of a property:
   * a `$static` / `$if` / `$widgetProp` source yields a value to display but
   * nothing to write to, and an enabled control would swallow the interaction.
   */
  canWrite: boolean;
}

const TOAST_DURATION_MS = 4000;

const FAILURE_MESSAGES: Record<string, string> = {
  permission_denied: 'You are not allowed to change this value',
  value_out_of_range: 'Value is outside the allowed range',
  integer_out_of_range: 'Value is outside the allowed range',
  float_out_of_range: 'Value is outside the allowed range',
  array_index_out_of_bounds: 'Value is outside the allowed range',
  opcua_unreachable: 'Not connected to the controller',
  disconnected: 'Not connected to the controller',
  timeout: 'The controller did not respond',
  bad_path: 'This control is not bound to a valid variable',
  bad_field: 'This control is not bound to a valid variable',
};

function failureMessage(reason: string): string {
  return FAILURE_MESSAGES[reason] ?? `Write rejected (${reason})`;
}

/**
 * `VarMeta.type.base` is a *simple* type, so it cannot say how wide the real
 * OPC-UA variable is: `Float` covers Float and Double, `Integer` covers Int16
 * through UInt64. The coercion matrix keys on wire types and enforces the width
 * it is given — `float` narrows to float32 (rejecting 19.9 as `lossy_conversion`)
 * and bare `integer` carries int32 bounds. Widening here keeps this pass a
 * pre-flight for type and shape; the backend holds the real width and rejects
 * authoritatively, so a false local reject would block a write the PLC accepts.
 */
const WIDEST_FOR_SIMPLE: Record<string, string> = {
  float: 'double',
  integer: 'int64',
};

/**
 * Build the coercion descriptor for a whole-variable (non-field) write.
 *
 * Returns null when there is nothing reliable to check against: `VarType`'s
 * struct arm carries a field *name* list and no per-field type, so a struct
 * has no `dataType` to key the coercion matrix with.
 */
function scalarDescriptor(meta: VarMeta, index: number | undefined): OpcuaWriteDescriptor | null {
  if (meta.type.kind !== 'scalar') return null;
  const simple = meta.type.base.toLowerCase();
  return {
    dataType: WIDEST_FOR_SIMPLE[simple] ?? simple,
    isArray: meta.type.array,
    ...(meta.type.array && meta.type.length !== undefined ? { arrayLength: meta.type.length } : {}),
    ...(meta.min !== undefined ? { min: meta.min } : {}),
    ...(meta.max !== undefined ? { max: meta.max } : {}),
    ...(index !== undefined ? { indexed: true, arrayIndex: index } : {}),
  };
}

/** Range half of the coercion, for values whose type we cannot know. */
function outOfRange(value: unknown, range: { min?: number; max?: number } | undefined): boolean {
  if (!range || typeof value !== 'number') return false;
  const { min, max } = range;
  // A persisted min > max is a contract violation, left unenforced to match
  // backend write_service (and `rangeBounds` in opcuaWriteCoercion).
  if (min !== undefined && max !== undefined && min > max) return false;
  return (min !== undefined && value < min) || (max !== undefined && value > max);
}

/**
 * Returns a writer for the `$var` binding on `properties[propKey]`. The writer
 * is a no-op when the property holds no binding, so a widget can call it
 * unconditionally — and carries `canWrite` so the widget can gate its control
 * on the same binding the writer uses, rather than on a guess that drifts.
 */
export function useWriteVariable(
  properties: Record<string, unknown> | undefined,
  propKey: string,
  options?: WriteVariableOptions,
): WriteVariable {
  const scope = useHmiScope();
  const binding = getPropBinding(properties, propKey);
  const varKey = bindingKey(binding);
  const index = binding?.index;
  const meta = useVariableMeta(varKey);
  // One toast id per hook instance: an operator who presses the same control
  // again while its rejection is still on screen reuses that toast instead of
  // stacking one per press. Per instance rather than global, so two controls
  // rejected for different reasons each still get to say so.
  const toastId = `write-${useId()}`;
  const onError = options?.onError ?? 'toast';
  const tracked = options?.tracked ?? true;

  const write = useCallback(
    (value: unknown, opts?: { field?: string }): void => {
      if (!varKey) return;

      const report = (reason: string): void => {
        if (onError === 'silent') return;
        if (typeof onError === 'function') {
          onError(reason);
          return;
        }
        const { pendingToasts, showToast } = useHmiStore.getState();
        if (pendingToasts.some((t) => t.id === toastId)) return;
        showToast({
          id: toastId,
          message: failureMessage(reason),
          severity: 'error',
          discard: 'auto',
          duration: TOAST_DURATION_MS,
        });
      };

      const field = opts?.field;
      let payloadValue = value;
      if (field) {
        // Struct fields carry no type in `VarMeta` — only names — so there is
        // no `dataType` to coerce against and the matrix would reject the
        // write as `unknown_type`. Check the configured field range only and
        // leave type coercion to the backend, which knows the field's type.
        if (outOfRange(value, meta?.fieldRanges?.[field])) {
          report('value_out_of_range');
          return;
        }
      } else if (meta) {
        const descriptor = scalarDescriptor(meta, index);
        if (descriptor) {
          const coerced = coerceOpcuaWrite(value, descriptor);
          if (!coerced.ok) {
            report(coerced.reason);
            return;
          }
          payloadValue = coerced.value;
        }
      }

      const { datasource, path } = parseVarKey(varKey);
      // No requestId on an untracked write: the backend answers only correlated
      // frames, so omitting it is what keeps the response off the wire.
      const requestId = tracked
        ? beginTrackedWrite(scope, (ok, result) => {
            if (ok) return;
            report(typeof result.reason === 'string' ? result.reason : 'write_failed');
          })
        : undefined;

      sendWsMessage({
        type: 'write_field',
        ...(requestId ? { requestId } : {}),
        scope,
        datasource,
        path: index !== undefined ? `${path}[${index}]` : path,
        ...(field ? { field } : {}),
        value: payloadValue,
      });
    },
    [varKey, index, meta, scope, toastId, onError, tracked],
  );

  return useMemo(() => Object.assign(write, { canWrite: Boolean(varKey) }), [write, varKey]);
}
