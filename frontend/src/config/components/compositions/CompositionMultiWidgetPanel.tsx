import { useMemo, type ReactNode } from 'react';
import type { LayoutConfig, WidgetConfig } from '@shared/types/config';
import type { ComponentPropertySchema } from '@shared/types/componentProperty';
import { ComponentPropertySchemaContext } from '../editor/PropertySourceEditor/componentPropertySchemaContext';
import MultiSelectionBody from '../editor/PropertiesPanel/MultiSelectionBody';

interface Props {
  /** Two or more widgets of the open definition, in tree order; the first is the lead. */
  comps: WidgetConfig[];
  componentProperties: Record<string, ComponentPropertySchema>;
  onUpdate: (
    ids: string[],
    patch: { properties?: Record<string, unknown>; layout?: Partial<LayoutConfig> },
  ) => void;
}

function PlainSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="cfg-section">
      <div className="cfg-section__title">{title}</div>
      {children}
    </div>
  );
}

/**
 * The components editor's multi-selection panel — {@link MultiSelectionBody}
 * against one definition. Simpler in one respect: every selected widget lives in
 * the same definition, so they share one `componentProperties` and there is
 * nothing to merge. No binding picker: `$var` is forbidden while authoring a
 * definition.
 */
export default function CompositionMultiWidgetPanel({
  comps,
  componentProperties,
  onUpdate,
}: Props) {
  const componentPropertySchemaValue = useMemo(
    () => ({ properties: componentProperties, forbidVar: true }),
    [componentProperties],
  );

  return (
    <ComponentPropertySchemaContext.Provider value={componentPropertySchemaValue}>
      <MultiSelectionBody comps={comps} onUpdate={onUpdate} section={PlainSection} />
    </ComponentPropertySchemaContext.Provider>
  );
}
