import '../BindingPickerShell/style.css';
import { useMemo, useState } from 'react';
import SelectionDrawer, {
  SelectionDrawerCard,
  type SelectionDrawerCategory,
} from '@config/components/ui/SelectionDrawer';
import SearchHighlight from '@config/components/ui/SearchHighlight';
import { matchesSearchWords } from '@shared/utils/search';
import { PROPERTY_SOURCES, type PropertySource } from '@hmi/utils/propertySourceRegistry';
import { typeLabel } from '@shared/types/componentProperty';
import PropertySourceBadge from './PropertySourceBadge';
import { propertySourceColorStyle } from './propertySourceStyle';

interface PropertySourceItem {
  source: PropertySource;
  key: string;
  label: string;
  description: string;
  category: string;
  /** Base types the source yields, as the card's badge shows them. */
  produces: string;
  /** Listed under "Show all" only — the field does not take this source. */
  refused: boolean;
}

const ALL_SOURCES = Object.keys(PROPERTY_SOURCES) as PropertySource[];

interface PropertySourceDrawerProps {
  /** Property name shown before the drawer's own action. */
  label?: string;
  sources: PropertySource[];
  /** Null when a multi-selection disagrees on the source — no card is marked. */
  activeSource: PropertySource | null;
  onClose(): void;
  onSelect(source: PropertySource): void;
}

function buildCatalog(
  sources: PropertySource[],
  showAll: boolean,
): SelectionDrawerCategory<PropertySourceItem>[] {
  const categories: SelectionDrawerCategory<PropertySourceItem>[] = [
    { category: 'Flexible sources', items: [] },
    { category: 'Fixed-type sources', items: [] },
  ];

  // Refused sources follow the offered ones, so the top result stays pickable.
  const listed = showAll
    ? [...sources, ...ALL_SOURCES.filter((s) => !sources.includes(s))]
    : sources;
  for (const source of listed) {
    const descriptor = PROPERTY_SOURCES[source];
    const category = descriptor.produces.includes('any') ? categories[0] : categories[1];
    category.items.push({
      source,
      key: descriptor.key,
      label: descriptor.label,
      description: descriptor.description,
      category: category.category,
      produces: descriptor.produces.map(typeLabel).join(', '),
      refused: !sources.includes(source),
    });
  }

  return categories.filter((category) => category.items.length > 0);
}

function itemMatches(item: PropertySourceItem, query: string): boolean {
  return matchesSearchWords(query, [
    item.category,
    item.label,
    item.key,
    item.description,
    item.produces,
  ]);
}

export default function PropertySourceDrawer({
  label,
  sources,
  activeSource,
  onClose,
  onSelect,
}: PropertySourceDrawerProps) {
  const [showAll, setShowAll] = useState(false);
  const catalog = useMemo(() => buildCatalog(sources, showAll), [sources, showAll]);

  return (
    <SelectionDrawer
      title={label}
      action="Select source"
      searchPlaceholder="Search property sources"
      searchAriaLabel="Search property sources"
      categories={catalog}
      itemKey={(item) => item.source}
      itemMatches={itemMatches}
      onSelectItem={(item) => {
        if (!item.refused) onSelect(item.source);
      }}
      emptyMessage={(query) => `No property sources match “${query}”.`}
      onClose={onClose}
      headerMeta={
        sources.length < ALL_SOURCES.length && (
          <label className="editor-binding-showall">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
            />
            Show all
          </label>
        )
      }
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
          badge={<SearchHighlight text={item.produces} />}
          description={
            <>
              <SearchHighlight text={item.description} />
              {item.refused && (
                <span className="cfg-property-source-card__refused">
                  ✗ Not available on this field.
                </span>
              )}
            </>
          }
          disabled={item.refused}
          selected={item.source === activeSource}
          onClick={onSelectItem}
        />
      )}
    />
  );
}
