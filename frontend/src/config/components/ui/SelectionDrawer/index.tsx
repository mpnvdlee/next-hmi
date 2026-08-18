import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import ModalShell from '../ModalShell';
import PickerDrawerHeader, { PickerTitle } from '../PickerDrawerHeader';
import PickerFooter from '../PickerFooter';
import { SearchHighlightProvider } from '../SearchHighlight';

export interface SelectionDrawerCategory<T> {
  category: string;
  items: T[];
}

interface SelectionDrawerProps<T> {
  /** What the pick is for — the container being filled, the property being set. */
  title?: string;
  /** What is being picked: "Add widget", "Select source". */
  action: string;
  searchPlaceholder: string;
  searchAriaLabel: string;
  categories: SelectionDrawerCategory<T>[];
  itemKey(item: T): string;
  itemMatches(item: T, query: string): boolean;
  renderItem(item: T, onSelect: () => void): ReactNode;
  onSelectItem(item: T): void;
  emptyMessage(query: string): ReactNode;
  /** Screen edge the drawer is anchored to and slides in from. Defaults to 'right'. */
  side?: 'left' | 'right';
  onClose(): void;
}

interface SelectionDrawerCardProps {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Small label pinned to the card's top-right, beside the title. */
  badge?: ReactNode;
  selected?: boolean;
  className?: string;
  style?: CSSProperties;
  onClick(): void;
}

export function SelectionDrawerCard({
  icon,
  title,
  description,
  badge,
  selected,
  className = '',
  style,
  onClick,
}: SelectionDrawerCardProps) {
  const classes = ['cfg-selection-card', selected ? 'cfg-selection-card--selected' : '', className]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={classes}
      style={style}
      aria-pressed={selected === undefined ? undefined : selected}
      onClick={onClick}
    >
      <span className="cfg-selection-card__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="cfg-selection-card__name">{title}</span>
      {badge ? <span className="cfg-selection-card__badge">{badge}</span> : null}
      {description ? <span className="cfg-selection-card__desc">{description}</span> : null}
    </button>
  );
}

/** Shared searchable selection drawer used by widget and property-source catalogs. */
export default function SelectionDrawer<T>({
  title,
  action,
  searchPlaceholder,
  searchAriaLabel,
  categories,
  itemKey,
  itemMatches,
  renderItem,
  onSelectItem,
  emptyMessage,
  side = 'right',
  onClose,
}: SelectionDrawerProps<T>) {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Map<string, HTMLElement>>(new Map());

  const filtered = useMemo(() => {
    if (!query.trim()) return categories;
    return categories
      .map((category) => ({
        ...category,
        items: category.items.filter((item) => itemMatches(item, query)),
      }))
      .filter((category) => category.items.length > 0);
  }, [categories, itemMatches, query]);

  const categoryKey = filtered.map((category) => category.category).join('|');
  const topItem = filtered[0]?.items[0];

  useEffect(() => {
    if (filtered.some((category) => category.category === activeCategory)) return;
    setActiveCategory(filtered[0]?.category ?? null);
  }, [activeCategory, categoryKey, filtered]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const top = visible[0]?.target.getAttribute('data-category');
        if (top) setActiveCategory(top);
      },
      { root, rootMargin: '0px 0px -70% 0px', threshold: 0 },
    );
    sectionRefs.current.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [categoryKey]);

  const scrollToCategory = (category: string) => {
    setActiveCategory(category);
    sectionRefs.current.get(category)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  const registerSectionCallbacks = useRef<Map<string, (element: HTMLElement | null) => void>>(
    new Map(),
  );
  const registerSection = useCallback((category: string) => {
    let callback = registerSectionCallbacks.current.get(category);
    if (!callback) {
      callback = (element: HTMLElement | null) => {
        if (element) sectionRefs.current.set(category, element);
        else sectionRefs.current.delete(category);
      };
      registerSectionCallbacks.current.set(category, callback);
    }
    return callback;
  }, []);

  return (
    <ModalShell
      onClose={onClose}
      overlayClassName={
        'cfg-picker-drawer-overlay' + (side === 'left' ? ' cfg-picker-drawer-overlay--left' : '')
      }
      dialogClassName={
        'cfg-drawer cfg-drawer--md cfg-selection-drawer' +
        (side === 'left' ? ' cfg-drawer--left' : '')
      }
      initialFocusRef={searchInputRef}
    >
      <PickerDrawerHeader
        className="cfg-selection-drawer__header"
        title={<PickerTitle context={title} action={action} />}
        search={query}
        onSearchChange={setQuery}
        onSearchEnter={() => {
          if (topItem) onSelectItem(topItem);
        }}
        searchAriaLabel={searchAriaLabel}
        searchPlaceholder={searchPlaceholder}
        searchInputRef={searchInputRef}
        onClose={onClose}
      />

      <SearchHighlightProvider query={query}>
        <div className="cfg-selection-drawer__body">
          <nav className="cfg-selection-drawer__rail" aria-label={`${action} categories`}>
            {filtered.map((category) => (
              <button
                key={category.category}
                type="button"
                className={
                  'cfg-selection-drawer__rail-item' +
                  (activeCategory === category.category
                    ? ' cfg-selection-drawer__rail-item--active'
                    : '')
                }
                onClick={() => scrollToCategory(category.category)}
              >
                {category.category}
              </button>
            ))}
          </nav>

          <div className="cfg-selection-drawer__scroll" ref={scrollRef}>
            {filtered.length === 0 ? (
              <p className="cfg-selection-drawer__empty">{emptyMessage(query)}</p>
            ) : (
              filtered.map((category) => (
                <section
                  key={category.category}
                  className="cfg-selection-drawer__group"
                  data-category={category.category}
                  ref={registerSection(category.category)}
                >
                  <div className="cfg-selection-drawer__glabel">{category.category}</div>
                  <div className="cfg-selection-drawer__grid">
                    {category.items.map((item) => (
                      <Fragment key={itemKey(item)}>
                        {renderItem(item, () => onSelectItem(item))}
                      </Fragment>
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        </div>
      </SearchHighlightProvider>

      <PickerFooter onCancel={onClose} />
    </ModalShell>
  );
}
