import type { ReactElement } from 'react';
import type { ComponentPropertySchema } from '@shared/types/componentProperty';

interface Props {
  /** Property key, possibly nested (e.g. "motor/stSignalRaw"). */
  value: string;
  properties: Record<string, ComponentPropertySchema>;
  /** Append ` (rawKey)` after the leaf, muted — used in picker pills. */
  withKeySuffix?: boolean;
}

/**
 * Render a component-property path with the leaf segment in `<strong>` and the
 * preceding breadcrumb muted. Returns `null` for an empty key so consumers
 * can fall back to an empty-state label.
 */
export function ComponentPropPath({
  value,
  properties,
  withKeySuffix = false,
}: Props): ReactElement | null {
  if (!value) return null;

  const slashIdx = value.indexOf('/');
  if (slashIdx === -1) {
    const prop = properties[value];
    const label = prop?.label ?? value;
    return (
      <>
        <strong>{label}</strong>
        {withKeySuffix && prop && (
          <span className="cfg-component-prop-path__suffix"> ({value})</span>
        )}
      </>
    );
  }

  const propKey = value.slice(0, slashIdx);
  const subPath = value.slice(slashIdx + 1);
  const prefix = properties[propKey]?.label ?? propKey;
  const segments = subPath.split('/');
  const leaf = segments[segments.length - 1];
  const middle = segments.slice(0, -1);
  const prefixText = [prefix, ...middle].join(' › ');

  return (
    <>
      <span className="cfg-component-prop-path__prefix">{prefixText} › </span>
      <strong>{leaf}</strong>
      {withKeySuffix && <span className="cfg-component-prop-path__suffix"> ({value})</span>}
    </>
  );
}
