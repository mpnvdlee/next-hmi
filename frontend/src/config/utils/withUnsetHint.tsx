import type { ReactNode } from 'react';
import { useHmiStore } from '@hmi/store/hmiStore';
import { ClearIcon } from '@config/components/ui/actionIcons';
import { FieldActions } from '@config/components/ui/FieldGroup';

/**
 * Wraps a scalar control with the unset→default hint: muted resolved-default
 * text while unset, or a `×` to revert back to unset once overridden. A no-op
 * when `display` is null (nothing meaningful to fall back to).
 *
 * `inlineDefaultTag` skips the hint span while unset for controls that already
 * show that same signal inline in their own default option (see `renderSelect`
 * / `BoolButtonGroup` in `renderSchemaField.tsx`), so it isn't said twice.
 */
export function withUnsetHint(
  rawValue: unknown,
  onChange: (v: unknown) => void,
  control: ReactNode,
  display: { text: string; suffix: string } | null,
  inlineDefaultTag?: boolean,
): ReactNode {
  if (!display) return control;
  const isUnset = rawValue === undefined || rawValue === null;
  if (isUnset && inlineDefaultTag) return control;

  return (
    <div className="cfg-prop-affix cfg-unset-hint-row">
      {control}
      {isUnset ? (
        <span className="cfg-unset-hint" title={`Falls back to ${display.text}`}>
          · {display.suffix}
        </span>
      ) : (
        // Portal the revert into the FieldGroup's shared action column so it sits
        // flush-right in the same bordered slot as every other row's buttons
        // (pick, unit, color clear), rather than floating after the control.
        <FieldActions>
          <button
            type="button"
            className="cfg-row-action-btn cfg-row-action-btn--stretch"
            title={`Revert to ${display.suffix} (${display.text})`}
            onClick={() => {
              onChange(undefined);
              useHmiStore.getState().showToast({
                id: crypto.randomUUID(),
                message: `Reverted to ${display.suffix}`,
                severity: 'info',
                discard: 'auto',
                duration: 2500,
              });
            }}
          >
            <ClearIcon />
          </button>
        </FieldActions>
      )}
    </div>
  );
}
