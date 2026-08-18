import FieldGroup, { type FieldGroupSelection } from '../FieldGroup';
import { ClearIcon } from '../actionIcons';
import PropertySourceBadge from '../../editor/PropertySourceSelector/PropertySourceBadge';
import { KindLabel } from '../../editor/PropertySourceEditor/editors/shared';
import GroupsEditor, { GroupsSummary } from '../../editor/PropertiesPanel/GroupsEditor';

/**
 * A user-group checklist as a collapsible tier-3 field: a colored summary of the
 * checked labels while collapsed, the checkbox list itself only when expanded —
 * the same shape the `$userGroups` source uses.
 *
 * Clearing always emits `undefined`; callers that store `[]` rather than absence
 * normalise it in their `onChange`.
 */
export default function GroupsField({
  label,
  description,
  value,
  onChange,
  selection,
  sourceless,
}: {
  label: string;
  description?: string;
  value: unknown;
  onChange: (v: unknown) => void;
  selection?: FieldGroupSelection;
  sourceless?: boolean;
}) {
  const hasSelection = Array.isArray(value) && value.length > 0;

  return (
    <FieldGroup
      label={label}
      description={description}
      tier={3}
      selection={selection}
      sourceless={sourceless}
      badge={sourceless ? undefined : <PropertySourceBadge source="static" variant="cap" />}
      summary={<GroupsSummary value={value} />}
      kindLabel={<KindLabel>Groups</KindLabel>}
      drawerTitle={label}
      actions={
        hasSelection ? (
          <button
            type="button"
            className="cfg-row-action-btn cfg-row-action-btn--stretch"
            title="Clear (empty → all users)"
            onClick={() => onChange(undefined)}
          >
            <ClearIcon />
          </button>
        ) : undefined
      }
    >
      <GroupsEditor value={value} onChange={onChange} />
    </FieldGroup>
  );
}
