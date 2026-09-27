import type { ReactElement } from 'react';
import type { ComponentPropertySchema } from '@shared/types/componentProperty';
import { splitComponentPropPath } from './componentPropHelpers';

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

  const { parentPath, leaf } = splitComponentPropPath(value, properties);
  if (!parentPath) {
    return (
      <>
        <strong>{leaf}</strong>
        {withKeySuffix && properties[value] && (
          <span className="cfg-component-prop-path__suffix"> ({value})</span>
        )}
      </>
    );
  }

  return (
    <>
      <span className="cfg-component-prop-path__prefix">{parentPath} › </span>
      <strong>{leaf}</strong>
      {withKeySuffix && <span className="cfg-component-prop-path__suffix"> ({value})</span>}
    </>
  );
}
