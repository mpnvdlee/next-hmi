import type { LayoutConfig, WidgetConfig } from '@shared/types/config';
import CollapsibleSection from '../../ui/CollapsibleSection';
import MultiSelectionBody from './MultiSelectionBody';

interface Props {
  /** Two or more widgets, in document order; the first is the lead. */
  comps: WidgetConfig[];
  updateComponents: (
    ids: string[],
    patch: { properties?: Record<string, unknown>; layout?: Partial<LayoutConfig> },
  ) => void;
}

/**
 * Properties panel for a multi-selection: {@link MultiSelectionBody} in the page
 * editor's collapsible sections, with `$var` binding offered.
 *
 * A sibling of `ComponentPanel` rather than a mode inside it — that panel is built
 * throughout on having exactly one `comp` (its id scopes the expand state, the
 * diagnostics lookup and the per-parameter copy/paste shortcut).
 */
export default function MultiComponentPanel({ comps, updateComponents }: Props) {
  return (
    <MultiSelectionBody
      comps={comps}
      onUpdate={updateComponents}
      section={CollapsibleSection}
      bindingPicker
    />
  );
}
