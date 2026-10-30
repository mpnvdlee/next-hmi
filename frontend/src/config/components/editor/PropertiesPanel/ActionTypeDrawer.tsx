import { useEffect, useRef } from 'react';
import SelectionDrawer, {
  SelectionDrawerCard,
  type SelectionDrawerCategory,
} from '@config/components/ui/SelectionDrawer';
import SearchHighlight from '@config/components/ui/SearchHighlight';
import { matchesSearchWords } from '@shared/utils/search';
import type { ButtonAction } from '@shared/types/config';
import { ACTION_TYPES } from './actionsPreview';
import { ActionTypeBadge } from './actionTypeIcons';
import Button from '@config/components/ui/Button';
import { detectCopyPasteKey, isEditableTarget } from '@shared/utils/domEvent';
import {
  parseClipboardAction,
  pasteActionValue,
  toast,
} from '@config/components/ui/SchemaFieldRow/clipboardOps';

type ActionTypeItem = (typeof ACTION_TYPES)[number];

interface ActionTypeDrawerProps {
  /** Action list name shown before the drawer's own action. */
  label?: string;
  onClose(): void;
  onSelect(type: ButtonAction['type']): void;
  /** A copied action pasted with the header button or Ctrl+V. */
  onPaste(action: ButtonAction): void;
}

function buildCatalog(): SelectionDrawerCategory<ActionTypeItem>[] {
  const categories: SelectionDrawerCategory<ActionTypeItem>[] = [];
  for (const item of ACTION_TYPES) {
    let category = categories.find((c) => c.category === item.category);
    if (!category) {
      category = { category: item.category, items: [] };
      categories.push(category);
    }
    category.items.push(item);
  }
  return categories;
}

const CATALOG = buildCatalog();

function itemMatches(item: ActionTypeItem, query: string): boolean {
  return matchesSearchWords(query, [item.category, item.label, item.type, item.description]);
}

export default function ActionTypeDrawer({
  label,
  onClose,
  onSelect,
  onPaste,
}: ActionTypeDrawerProps) {
  const onPasteRef = useRef(onPaste);
  onPasteRef.current = onPaste;

  useEffect(() => {
    // Ctrl+V here belongs to the drawer, not to the property selected behind it
    // (`useCopyPasteShortcut` listens on window in the bubble phase).
    const shield = (e: KeyboardEvent) => {
      if (detectCopyPasteKey(e) === 'v') e.stopPropagation();
    };
    const paste = (e: ClipboardEvent) => {
      const action = parseClipboardAction(e.clipboardData?.getData('text') ?? '');
      if (action) {
        e.preventDefault();
        onPasteRef.current(action);
      } else if (!isEditableTarget(e.target)) {
        // Text pasted into the search field searches; anywhere else it was meant as an action.
        toast('error', 'Clipboard does not contain an action');
      }
    };
    window.addEventListener('keydown', shield, true);
    document.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('keydown', shield, true);
      document.removeEventListener('paste', paste);
    };
  }, []);

  return (
    <SelectionDrawer
      title={label}
      action="Add action"
      searchPlaceholder="Search actions"
      categories={CATALOG}
      itemKey={(item) => item.type}
      itemMatches={itemMatches}
      onSelectItem={(item) => onSelect(item.type)}
      emptyMessage={(query) => `No actions match “${query}”.`}
      onClose={onClose}
      headerMeta={
        <Button
          variant="neutral"
          type="button"
          onClick={() => void pasteActionValue(label ?? 'Actions', onPaste)}
        >
          Paste action
        </Button>
      }
      renderItem={(item, onSelectItem) => (
        <SelectionDrawerCard
          icon={<ActionTypeBadge type={item.type} variant="pill" />}
          title={
            <>
              <SearchHighlight text={item.label} />
              <code className="cfg-property-source-card__key">{item.type}</code>
            </>
          }
          description={<SearchHighlight text={item.description} />}
          onClick={onSelectItem}
        />
      )}
    />
  );
}
