import TreeRow from '../../ui/TreeRow';
import { TreeRenameInput } from '../../ui/TreeAffordances';
import SectionRow from './SectionRow';
import { TreeSearchHighlight } from './TreeSearchHighlight';
import { useConfigStore } from '@shared/store/configStore';
import { EDITOR_NODE_IDS, makeValueMapNodeId } from '@shared/constants/editorSentinels';
import type { NodeKind } from './types';
import { addValueMap, select } from '@config/utils/valueMapActions';

/** The project's value maps (config.json `valueMaps`): one row per map, which
 *  opens it in the properties panel, `+` to add one, and a context menu on the
 *  section and on each map. */
export default function ValueMapsSection({
  isOpen,
  onToggle,
  selectedId,
  onCtxMenu,
  editingId,
  draft,
  onEditChange,
  onEditCommit,
}: {
  isOpen: boolean;
  onToggle: () => void;
  selectedId: string | null;
  onCtxMenu: (event: React.MouseEvent, nodeId: string, kind: NodeKind) => void;
  /** The tree's inline rename, shared with pages: the node id being renamed. */
  editingId: string | null;
  draft: string;
  onEditChange: (text: string) => void;
  onEditCommit: (nodeId: string) => void;
}) {
  const valueMaps = useConfigStore((s) => s.valueMaps);

  return (
    <>
      <SectionRow
        label="Value Maps"
        icon="⇄"
        isOpen={isOpen}
        onToggle={onToggle}
        addTitle="Add value map"
        onAdd={() => {
          addValueMap();
          if (!isOpen) onToggle();
        }}
        selected={false}
        onSelect={onToggle}
        onCtxMenu={(event) => onCtxMenu(event, EDITOR_NODE_IDS.VALUE_MAPS, 'value-maps-root')}
        count={valueMaps.length}
      />
      {isOpen &&
        valueMaps.map((m) => {
          const nodeId = makeValueMapNodeId(m.id);
          return (
            <TreeRow
              key={m.id}
              depth={1}
              selected={selectedId === nodeId}
              label={
                <TreeRenameInput
                  id={nodeId}
                  editingId={editingId}
                  draft={draft}
                  onChange={onEditChange}
                  onCommit={onEditCommit}
                  label={<TreeSearchHighlight text={m.id} />}
                />
              }
              onSelect={() => select(nodeId)}
              onContextMenu={(event) => {
                event.preventDefault();
                onCtxMenu(event, nodeId, 'value-map');
              }}
            />
          );
        })}
    </>
  );
}
