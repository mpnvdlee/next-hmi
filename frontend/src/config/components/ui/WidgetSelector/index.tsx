import { useMemo } from 'react';
import SearchHighlight from '../SearchHighlight';
import SelectionDrawer, { SelectionDrawerCard } from '../SelectionDrawer';
import WidgetIcon from '../WidgetIcon';
import { buildCatalog, itemMatches, type CatalogItem } from './catalog';

interface WidgetSelectorProps {
  /** Name of the container the widget lands in. */
  contextName?: string;
  /** Optional type filter, e.g. to hide reusable components inside a definition. */
  filter?: (type: string) => boolean;
  onClose(): void;
  onInsert(type: string): void;
}

/**
 * Slide-in drawer that lists every widget and reusable component as a card
 * (icon + name + description), grouped into categories shown as a scroll-spy rail
 * on the left. Search + match highlighting + `/`-shortcut mirror the component
 * tree. Clicking a card inserts it, closes the drawer, and selects the new node
 * in the tree. This is the only way to pick a new widget — the context menus
 * open this drawer instead of listing types themselves.
 */
export default function WidgetSelector({
  contextName,
  filter,
  onClose,
  onInsert,
}: WidgetSelectorProps) {
  const catalog = useMemo(() => buildCatalog(filter), [filter]);

  return (
    <SelectionDrawer
      title={contextName}
      action="Add widget/component"
      searchPlaceholder="Search widgets and components"
      searchAriaLabel="Search widgets and components"
      categories={catalog}
      itemKey={(item) => item.type}
      itemMatches={itemMatches}
      onSelectItem={(item) => onInsert(item.type)}
      emptyMessage={(query) => `No widgets or components match “${query}”.`}
      side="left"
      onClose={onClose}
      renderItem={(item, onSelect) => <WidgetCard item={item} onSelect={onSelect} />}
    />
  );
}

function WidgetCard({ item, onSelect }: { item: CatalogItem; onSelect(): void }) {
  return (
    <SelectionDrawerCard
      icon={<WidgetIcon icon={item.icon} size={18} />}
      title={<SearchHighlight text={item.name} />}
      description={item.description ? <SearchHighlight text={item.description} /> : undefined}
      badge={item.component ? 'Component' : item.builtin ? 'Built-in' : 'Custom'}
      onClick={onSelect}
    />
  );
}
