import type { ReactNode } from 'react';
import FieldGroup, { type FieldGroupSelection, type FieldGroupTier } from '../FieldGroup';
import PropertySourceBadge from '../../editor/PropertySourceSelector/PropertySourceBadge';

interface Props {
  label: string;
  /** Explanatory copy shown between the label and the field box. */
  description?: ReactNode;
  children: ReactNode;
  /**
   * Hides the badge entirely — reserved for object-name/identifier fields
   * (component name, dialog/page title, alarm/group title, datasource name,
   * user name, property key/label, …). Every other field keeps the plain
   * static badge (decorative — these fields aren't expression-switchable).
   */
  sourceless?: boolean;
  /** Selection identity for click-to-select + Ctrl+C copy/paste. */
  selection?: FieldGroupSelection;
  /** Tier 2 for a bare `<select>` (click-2 opens it); defaults to 1. */
  tier?: FieldGroupTier;
  /** Stacks content vertically — replaces the old `col` prop. */
  block?: boolean;
  /** Trailing row action (e.g. a clear `×`) — same slot as `FieldGroup`'s `actions`. */
  actions?: ReactNode;
  /** Server build-diagnostic for this row (see `usePanelDiagnostics`). */
  diagnostic?: { level: 'error' | 'warning'; message: string; nested?: boolean };
}

/** Thin `FieldGroup` wrapper — the default shape for a single plain property row. */
export default function PropRow({
  label,
  description,
  children,
  sourceless,
  selection,
  tier = 1,
  block,
  actions,
  diagnostic,
}: Props) {
  return (
    <FieldGroup
      label={label}
      description={description}
      tier={tier}
      selection={selection}
      sourceless={sourceless}
      badge={sourceless ? undefined : <PropertySourceBadge source="static" variant="cap" />}
      block={block}
      actions={actions}
      diagnostic={diagnostic}
    >
      {children}
    </FieldGroup>
  );
}
