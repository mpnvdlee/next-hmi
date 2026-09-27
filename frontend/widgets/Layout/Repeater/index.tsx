/* @jsxRuntime classic */
export const schema = {
  items: {
    type: 'item-list',
    label: 'Items',
    group: 'Content',
    description:
      'The array to repeat over. The widgets inside are drawn once per element; bind them to it with the Repeat Item source.',
  },
  startOffset: {
    type: 'integer' as const,
    label: 'Start at',
    group: 'Content',
    defaultValue: 0,
    min: 0,
    description: 'Index of the first element drawn. Earlier elements are skipped.',
  },
  maxItems: {
    type: 'integer' as const,
    label: 'Max items',
    group: 'Content',
    defaultValue: 0,
    min: 0,
    description: 'How many elements to draw at most, from Start at. 0 draws all of them.',
  },
  emptyText: {
    type: 'string' as const,
    label: 'Empty text',
    group: 'Content',
    description: 'Shown instead when there are no elements to draw. Empty shows nothing.',
  },
};

export const category = 'Layout & structure';
export const description =
  'Draws its child widgets once per element of an array, each copy bound to its own element.';
export const icon = { type: 'builtin', name: 'rows' } as const;
/** The template: the children are drawn once per element, not once overall. */
export const hostsChildren = true;
/** Every copy lays out in this one flex box, so each template child gets a
 *  main axis for the Layout panel's Hug/Fill/Fixed rows. */
export const flowsChildren = true;
/** The property whose elements the children repeat over — what makes the
 *  editor and the validator offer Repeat item inside this widget. */
export const repeatsChildren = 'items';

function wholeNumber(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** One level deep: a struct element or `{ label, value }` record rebuilt with
 *  the same values is the same element, and keeps its copy from re-rendering. */
function sameItem(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

export default function Repeater({ id, properties, layout, children }: HmiWidgetProps) {
  const { items, arrayKey, structArray } = useItemListProp(properties, repeatsChildren);
  const start = wholeNumber(usePropNumber(properties, 'startOffset', 0));
  const max = wholeNumber(usePropNumber(properties, 'maxItems', 0));
  const emptyText = usePropString(properties, 'emptyText', '');
  const outer = useRepeatScope();
  const isPreview = useIsPreview();
  const previous = useRef(new Map<string, RepeatScopeValue>());

  const end = max > 0 ? Math.min(items.length, start + max) : items.length;
  const shown = items.slice(start, end);
  // With nothing to draw, the editor still draws the template once, unbound —
  // otherwise its children would vanish from the canvas they are edited on.
  const template = shown.length === 0 && isPreview;

  const scopes = useMemo(() => {
    const next = new Map<string, RepeatScopeValue>();
    const prefix = `${outer ? `${outer.key}/` : ''}${id ?? 'repeater'}#`;
    const list = (template ? [undefined] : shown).map((item, i) => {
      const index = start + i;
      const candidate: RepeatScopeValue = {
        index,
        item,
        arrayKey,
        structArray,
        key: `${prefix}${index}`,
        first: i === 0,
        ghost: isPreview && i > 0,
      };
      const prev = previous.current.get(candidate.key);
      const scope =
        prev &&
        prev.index === index &&
        prev.arrayKey === arrayKey &&
        prev.structArray === structArray &&
        prev.first === candidate.first &&
        prev.ghost === candidate.ghost &&
        sameItem(prev.item, item)
          ? prev
          : candidate;
      next.set(scope.key, scope);
      return scope;
    });
    previous.current = next;
    return list;
    // `shown` is a fresh slice each render; `items` is the stable input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, start, end, template, arrayKey, structArray, outer, id, isPreview]);

  const { style, ...flowAttrs } = containerLayoutProps(layout);

  if (scopes.length === 0) {
    if (!emptyText) return null;
    return (
      <div className="hmi-component hmi-repeater hmi-repeater--empty" style={style}>
        <span className="hmi-repeater__empty">{emptyText}</span>
      </div>
    );
  }

  return (
    <div className="hmi-component hmi-repeater" style={style} {...flowAttrs}>
      {scopes.map((scope) => (
        <React.Fragment key={scope.key}>
          <RepeatScope value={scope}>{children}</RepeatScope>
        </React.Fragment>
      ))}
    </div>
  );
}
