import { useConfigStore } from '@shared/store/configStore';
import { PanelScopeContext } from '@config/store/panelExpansionStore';
import { makeValueMapNodeId } from '@shared/constants/editorSentinels';
import { VALUE_MAP_TYPES, type ValueMap } from '@shared/types/config';
import type { SchemaField } from '@shared/types/widgetSchema';
import type { PropertySource } from '../propertyValueUtils';
import PanelHeader from '../../ui/PanelHeader';
import PropRow from '../../ui/PropRow';
import Select from '../../ui/Select';
import TextField from '../../ui/TextField';
import AddButton from '../../ui/AddButton';
import SortableList, { SortableRow } from '../../ui/SortableList';
import { arrayMove } from '@dnd-kit/sortable';
import { ClearIcon } from '../../ui/actionIcons';
import { CollapsiblePropertyCard } from '../PropertySourceEditor/editors/shared';
import { COMPARE_OPERAND_SCHEMA } from '../PropertySourceEditor/editors/utils';
import { renameValueMap } from '@config/utils/valueMapActions';
import './valueMapPanel.css';

/** One project value map: its id, type, the `when → then` cases and the
 *  default. Deleting it is the tree's context menu. */
export default function ValueMapPanel({ mapId }: { mapId: string }) {
  const valueMaps = useConfigStore((s) => s.valueMaps);
  const updateValueMaps = useConfigStore((s) => s.updateValueMaps);
  const map = valueMaps.find((m) => m.id === mapId);
  if (!map) return <div className="cfg-panel-empty">This value map no longer exists.</div>;

  const patch = (next: Partial<ValueMap>) =>
    updateValueMaps(valueMaps.map((m) => (m.id === mapId ? { ...m, ...next } : m)));

  // The output takes the map's type; a String map may also name a translation.
  const thenSchema: SchemaField = { type: map.type, label: 'Then' };
  const thenSources: PropertySource[] | undefined = map.type === 'String' ? ['$loc'] : undefined;
  const setCase = (i: number, next: Partial<ValueMap['cases'][number]>) =>
    patch({ cases: map.cases.map((c, j) => (j === i ? { ...c, ...next } : c)) });

  return (
    <PanelScopeContext.Provider value={makeValueMapNodeId(mapId)}>
      <PanelHeader kind="Value map" name={mapId} />
      <div className="cfg-section">
        <PropRow label="Id">
          <TextField value={mapId} onCommit={(id) => void renameValueMap(mapId, id)} />
        </PropRow>
        <PropRow label="Type">
          <Select
            value={map.type}
            // The outputs were typed for the old type, so they go with it.
            onChange={(type) =>
              patch({
                type: type as ValueMap['type'],
                cases: map.cases.map((c) => ({ ...c, then: undefined })),
                default: undefined,
              })
            }
          >
            {VALUE_MAP_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </PropRow>

        <div className="cfg-editor-actions">
          <div className="cfg-editor-actions__title-row">
            <span className="cfg-field-group__label">When → then</span>
            <AddButton
              title="Add case"
              onClick={() => patch({ cases: [...map.cases, { when: '', then: undefined }] })}
            >
              + Add case
            </AddButton>
          </div>
          {map.cases.length === 0 && <div className="cfg-switch-empty">No cases yet</div>}
          <SortableList
            ids={map.cases.map((_, i) => String(i))}
            onMove={(from, to) => patch({ cases: arrayMove(map.cases, from, to) })}
          >
            {map.cases.map((c, i) => (
              // One line per case: what it matches, the arrow, what it gives, and its `×`.
              <SortableRow key={i} id={String(i)}>
                <div className="cfg-value-map-case">
                  <div className="cfg-value-map-case__when">
                    <CollapsiblePropertyCard
                      title="When"
                      hideLabel
                      value={c.when}
                      // The model takes a literal; a cleared input is the empty string.
                      onChange={(v) => setCase(i, { when: (v ?? '') as string })}
                      schema={COMPARE_OPERAND_SCHEMA}
                      sourceless
                    />
                  </div>
                  <span className="cfg-value-map-case__arrow" aria-hidden="true">
                    →
                  </span>
                  <div className="cfg-value-map-case__then">
                    <CollapsiblePropertyCard
                      title="Then"
                      hideLabel
                      value={c.then}
                      onChange={(v) => setCase(i, { then: v })}
                      schema={thenSchema}
                      forcedSources={thenSources}
                      sourceless={!thenSources}
                      // The row's own × removes the whole case; a second one beside it would only confuse.
                      hideClear
                      actions={
                        <button
                          type="button"
                          className="cfg-row-action-btn cfg-row-action-btn--stretch"
                          title="Remove case"
                          onClick={() => patch({ cases: map.cases.filter((_, j) => j !== i) })}
                        >
                          <ClearIcon />
                        </button>
                      }
                    />
                  </div>
                </div>
              </SortableRow>
            ))}
          </SortableList>
        </div>
      </div>

      <div className="cfg-section">
        <CollapsiblePropertyCard
          title="Default"
          description="When no case matches. Empty: the widget's own default."
          value={map.default}
          onChange={(v) => patch({ default: v })}
          schema={{ ...thenSchema, label: 'Default' }}
          forcedSources={thenSources}
          sourceless={!thenSources}
        />
      </div>
    </PanelScopeContext.Provider>
  );
}
