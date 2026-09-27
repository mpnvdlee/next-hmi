import SelectionDrawer, {
  SelectionDrawerCard,
  type SelectionDrawerCategory,
} from '@config/components/ui/SelectionDrawer';
import SearchHighlight from '@config/components/ui/SearchHighlight';
import { matchesSearchWords } from '@shared/utils/search';
import type { ButtonAction } from '@shared/types/config';
import { ACTION_TYPES } from './actionsPreview';
import { ActionTypeBadge } from './actionTypeIcons';

type ActionTypeItem = (typeof ACTION_TYPES)[number];

interface ActionTypeDrawerProps {
  /** Action list name shown before the drawer's own action. */
  label?: string;
  onClose(): void;
  onSelect(type: ButtonAction['type']): void;
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

export default function ActionTypeDrawer({ label, onClose, onSelect }: ActionTypeDrawerProps) {
  return (
    <SelectionDrawer
      title={label}
      action="Add action"
      searchPlaceholder="Search actions"
      searchAriaLabel="Search actions"
      categories={CATALOG}
      itemKey={(item) => item.type}
      itemMatches={itemMatches}
      onSelectItem={(item) => onSelect(item.type)}
      emptyMessage={(query) => `No actions match “${query}”.`}
      onClose={onClose}
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
