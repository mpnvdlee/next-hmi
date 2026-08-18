import { useMemo } from 'react';
import SelectionDrawer, {
  SelectionDrawerCard,
  type SelectionDrawerCategory,
} from '@config/components/ui/SelectionDrawer';
import SearchHighlight from '@config/components/ui/SearchHighlight';
import { matchesSearchWords } from '@shared/utils/search';
import { PROPERTY_SOURCES, type PropertySource } from '@hmi/utils/propertySourceRegistry';
import PropertySourceBadge from './PropertySourceBadge';
import { propertySourceColorStyle } from './propertySourceStyle';

interface PropertySourceItem {
  source: PropertySource;
  key: string;
  label: string;
  description: string;
  category: string;
}

interface PropertySourceDrawerProps {
  /** Property name shown before the drawer's own action. */
  label?: string;
  sources: PropertySource[];
  /** Null when a multi-selection disagrees on the source — no card is marked. */
  activeSource: PropertySource | null;
  onClose(): void;
  onSelect(source: PropertySource): void;
}

function buildCatalog(sources: PropertySource[]): SelectionDrawerCategory<PropertySourceItem>[] {
  const categories: SelectionDrawerCategory<PropertySourceItem>[] = [
    { category: 'Flexible sources', items: [] },
    { category: 'Fixed-type sources', items: [] },
  ];

  for (const source of sources) {
    const descriptor = PROPERTY_SOURCES[source];
    const category = descriptor.produces.includes('any') ? categories[0] : categories[1];
    category.items.push({
      source,
      key: descriptor.key,
      label: descriptor.label,
      description: descriptor.description,
      category: category.category,
    });
  }

  return categories.filter((category) => category.items.length > 0);
}

function itemMatches(item: PropertySourceItem, query: string): boolean {
  return matchesSearchWords(query, [item.category, item.label, item.key, item.description]);
}

export default function PropertySourceDrawer({
  label,
  sources,
  activeSource,
  onClose,
  onSelect,
}: PropertySourceDrawerProps) {
  const catalog = useMemo(() => buildCatalog(sources), [sources]);

  return (
    <SelectionDrawer
      title={label}
      action="Select source"
      searchPlaceholder="Search property sources"
      searchAriaLabel="Search property sources"
      categories={catalog}
      itemKey={(item) => item.source}
      itemMatches={itemMatches}
      onSelectItem={(item) => onSelect(item.source)}
      emptyMessage={(query) => `No property sources match “${query}”.`}
      onClose={onClose}
      renderItem={(item, onSelectItem) => (
        <SelectionDrawerCard
          className="cfg-property-source-card"
          style={propertySourceColorStyle(item.source)}
          icon={<PropertySourceBadge source={item.source} />}
          title={
            <>
              <SearchHighlight text={item.label} />
              <code className="cfg-property-source-card__key">{item.key}</code>
            </>
          }
          description={<SearchHighlight text={item.description} />}
          selected={item.source === activeSource}
          onClick={onSelectItem}
        />
      )}
    />
  );
}
