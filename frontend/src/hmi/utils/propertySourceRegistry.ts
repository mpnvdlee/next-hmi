/**
 * Canonical property-source registry — single source of truth for all
 * property-source metadata: labels, badge styling, default value factories, and
 * value-type compatibility.
 *
 * Consumers should import helpers from here instead of maintaining their own maps.
 */

export type PropertySource =
  | 'static'
  | '$var'
  | '$loc'
  | '$urlParam'
  | '$pageIsActive'
  | '$if'
  | '$compare'
  | '$not'
  | '$formula'
  | '$random'
  | '$switch'
  | '$user'
  | '$userGroups'
  | '$device'
  | '$time'
  | '$widgetProp'
  | '$languages'
  | '$stringExpr'
  | '$http'
  | '$alarmCount'
  | '$recipe'
  | '$recipeList'
  | '$componentProp'
  | '$page'
  | '$viewport'
  | '$result'
  | '$repeatItem';

/** The persisted JSON key for a property source. 'static' is stored as '$static'; all others match the PropertySource string. */
export type PropertySourceKey = Exclude<PropertySource, 'static'> | '$static';

/**
 * The base value type a source yields, used to decide where the source is
 * offered (a source appears wherever its produced type fits the field's type).
 * `'any'` marks a flexible source that adopts whatever type the field needs
 * (literal `$static`, a `$var` binding, an `$if`/`$switch` branch, or an exported
 * `$widgetProp`). `'string[]'` marks a string-array-only producer; `'record-list'`
 * an array-of-records producer. Both array kinds are offered only on curated
 * editor-kind fields, never on scalar fields.
 */
export type ProducedValueType =
  | 'any'
  | 'string'
  | 'integer'
  | 'float'
  | 'boolean'
  | 'datetime'
  | 'date'
  | 'time'
  | 'string[]'
  | 'record-list';

/**
 * Content-tier shape for the property-panel `FieldGroup` primitive — how many
 * controls this source needs: 1 = single inline control, 2 = single inline
 * `<select>`, 3 = multi-field, renders as an expandable nested box.
 */
type ContentTier = 1 | 2 | 3;

interface PropertySourceDescriptor {
  /** Property source: 'static' for plain/unwrapped values, '$…' for the rest. */
  source: PropertySource;
  /**
   * The key used in persisted JSON values and the capability matrix.
   * For 'static' this is '$static'; all others match the source string.
   */
  key: PropertySourceKey;
  /** Full label shown in the source selector popup. */
  label: string;
  /** Content-tier shape — see `ContentTier`. */
  contentTier: ContentTier;
  /** Short explanation shown in property-source discovery surfaces. */
  description: string;
  /** Short label for the pill trigger. Falls back to `label` when absent. */
  short?: string;
  /** Abbreviation shown inside the coloured badge. */
  abbr: string;
  /** Base value type(s) this source yields — drives which fields it is offered on. */
  produces: ProducedValueType[];
  /** Create the default value for this source given the target field type —
   *  `fieldType` the first of a union, `fieldTypes` all of them. */
  createDefault: (
    fieldType: string,
    defaultValue: unknown,
    fieldTypes: readonly string[],
  ) => unknown;
}

/**
 * What each choice of a source's inner `field` selector yields. A source with
 * such a selector produces the union of these; its editor lists the choices
 * that fit the field it sits in. A choice that yields one type on a list field
 * and another elsewhere lists both — it fits a field either one fits.
 * Parity fixture: `sourceProduces.json`.
 */
export const SOURCE_FIELD_PRODUCES = {
  $page: {
    title: 'string',
    breadcrumbLabel: 'string',
    description: 'string',
    icon: 'string',
    id: 'string',
    parentId: 'string',
    pathString: 'string',
    depth: 'integer',
    pathSegments: 'string[]',
  },
  $viewport: { size: 'string', orientation: 'string', width: 'integer', height: 'integer' },
  $recipe: { parametersChanged: 'boolean', loaded: 'boolean', activeName: 'string' },
  // On a list field `userList` is every user and `groups` every group, as
  // options; on a text field `resolveUser` joins the names — the signed-in
  // user's group labels for `groups` — into one string. `userList` comes before
  // `groups`, so a new list starts on the users.
  $user: {
    username: 'string',
    userList: ['string[]', 'string'],
    groups: ['string', 'string[]'],
  },
  $device: { hostname: 'string', ipAddress: 'string', macAddress: 'string' },
} as const satisfies Partial<
  Record<PropertySource, Record<string, ProducedValueType | readonly ProducedValueType[]>>
>;

export type FieldSelectingSource = keyof typeof SOURCE_FIELD_PRODUCES;

/** The types one choice yields, or none for a choice the table does not know. */
function choiceProduces(source: FieldSelectingSource, field: string): readonly ProducedValueType[] {
  const produced = (
    SOURCE_FIELD_PRODUCES[source] as Record<
      string,
      ProducedValueType | readonly ProducedValueType[] | undefined
    >
  )[field];
  return produced === undefined ? [] : typeof produced === 'string' ? [produced] : produced;
}

function fieldProduces(source: FieldSelectingSource): ProducedValueType[] {
  return [
    ...new Set(
      Object.keys(SOURCE_FIELD_PRODUCES[source]).flatMap((f) => choiceProduces(source, f)),
    ),
  ];
}

export const SCALAR_FIELD_TYPES = [
  'string',
  'datetime',
  'date',
  'time',
  'duration',
  'integer',
  'float',
  'boolean',
];
/** Editor kinds whose value is a string (see `acceptedValueTypes`). */
const STRING_BOUND_KINDS = new Set(['color', 'icon', 'image', 'video']);
const LIST_KINDS = new Set(['option-list', 'item-list']);

/** Whether a produced base type fits a scalar field type (offer-time gate):
 *  the same type only, except that a number also fills a `duration` field.
 *  Array producers never fit a scalar; the editor-kind lists gate them. */
export function producedFits(produced: ProducedValueType, fieldType: string): boolean {
  if (produced === 'any' || produced === fieldType) return true;
  // a duration is a number of seconds
  return fieldType === 'duration' && (produced === 'integer' || produced === 'float');
}

/** Whether a produced type fits a field of any kind: a scalar by
 *  `producedFits`, a string-valued editor kind a string, a list kind a list.
 *  A field type this does not know is not narrowed. */
function producedFitsField(produced: ProducedValueType, fieldType: string): boolean {
  const ft = fieldType.toLowerCase();
  if (SCALAR_FIELD_TYPES.includes(ft)) return producedFits(produced, ft);
  if (produced === 'any') return true;
  if (STRING_BOUND_KINDS.has(ft)) return produced === 'string';
  if (LIST_KINDS.has(ft)) return produced === 'string[]' || produced === 'record-list';
  if (ft === 'record-list') return produced === 'record-list';
  return true;
}

/** Whether one choice of a source's `field` selector fits the field it sits
 *  in — any one of a union's types will do. A choice the table does not know —
 *  hand-edited JSON — does not. */
export function sourceFieldFits(
  source: FieldSelectingSource,
  field: string,
  fieldType: string | readonly string[],
): boolean {
  const types = typeof fieldType === 'string' ? [fieldType] : fieldType;
  return choiceProduces(source, field).some((p) => types.some((t) => producedFitsField(p, t)));
}

/** The `field` a new source starts on: `preferred` when it fits the field,
 *  else the first choice that does. */
function defaultSourceField<S extends FieldSelectingSource>(
  source: S,
  fieldType: readonly string[],
  preferred: keyof (typeof SOURCE_FIELD_PRODUCES)[S] & string,
): keyof (typeof SOURCE_FIELD_PRODUCES)[S] & string {
  if (sourceFieldFits(source, preferred, fieldType)) return preferred;
  const fitting = Object.keys(SOURCE_FIELD_PRODUCES[source]).find((f) =>
    sourceFieldFits(source, f, fieldType),
  );
  return (fitting ?? preferred) as keyof (typeof SOURCE_FIELD_PRODUCES)[S] & string;
}

export function defaultValueFor(fieldType: string, defaultValue?: unknown): unknown {
  if (defaultValue !== undefined) return defaultValue;
  const ft = fieldType.toLowerCase();
  if (ft === 'option-list' || ft === 'item-list') return [];
  if (ft === 'integer' || ft === 'float') return 0;
  if (ft === 'boolean') return false;
  if (ft === 'color') return '#000000';
  return '';
}

const DESCRIPTORS: PropertySourceDescriptor[] = [
  {
    source: 'static',
    key: '$static',
    contentTier: 1,
    label: 'Static Value',
    description: 'A fixed value you type or pick.',
    short: 'Static',
    abbr: '—',
    produces: ['any'],
    createDefault: (fieldType, defaultValue) => defaultValueFor(fieldType, defaultValue),
  },
  {
    source: '$var',
    key: '$var',
    contentTier: 1,
    label: 'Variable',
    description: 'A live datasource or OPC-UA variable.',
    abbr: 'V',
    produces: ['any'],
    createDefault: () => ({ $var: { path: '' } }),
  },
  {
    source: '$loc',
    key: '$loc',
    contentTier: 1,
    label: 'Localizable Text',
    description: 'Text translated for the current language.',
    abbr: 'L',
    produces: ['string'],
    createDefault: () => ({ $loc: '' }),
  },
  {
    source: '$urlParam',
    key: '$urlParam',
    contentTier: 3,
    label: 'URL Parameter',
    description: 'A value read from the current page URL.',
    short: 'URL Param',
    abbr: 'U',
    produces: ['string'],
    createDefault: (fieldType, defaultValue) => ({
      $urlParam: { name: '', default: defaultValueFor(fieldType, defaultValue) },
    }),
  },
  {
    source: '$pageIsActive',
    key: '$pageIsActive',
    contentTier: 3,
    label: 'Page Active',
    description: 'Whether a selected page is currently active.',
    abbr: 'P',
    produces: ['boolean'],
    createDefault: () => ({ $pageIsActive: {} }),
  },
  {
    source: '$if',
    key: '$if',
    contentTier: 3,
    label: 'If Condition',
    description: 'One of two values selected by a condition.',
    abbr: 'IF',
    produces: ['any'],
    createDefault: (fieldType, defaultValue) => ({
      $if: {
        condition: { $var: { path: '' } },
        true: defaultValueFor(fieldType, defaultValue),
        false: defaultValueFor(fieldType, defaultValue),
      },
    }),
  },
  {
    source: '$compare',
    key: '$compare',
    contentTier: 3,
    label: 'Comparison',
    description: 'A boolean result from comparing two values.',
    abbr: '≤',
    produces: ['boolean'],
    createDefault: () => ({
      $compare: {
        left: { $var: { path: '' } },
        operator: '>',
        right: 0,
      },
    }),
  },
  {
    source: '$not',
    key: '$not',
    contentTier: 3,
    label: 'Invert',
    description: 'The opposite of a boolean value: true becomes false and false becomes true.',
    abbr: '!',
    produces: ['boolean'],
    createDefault: () => ({ $not: { value: { $var: { path: '' } } } }),
  },
  {
    source: '$formula',
    key: '$formula',
    contentTier: 3,
    label: 'Formula',
    description: 'A number calculated from values with + − × ÷ and parentheses.',
    abbr: 'fx',
    produces: ['float'],
    createDefault: () => ({ $formula: { expression: '', wildcards: {} } }),
  },
  {
    source: '$random',
    key: '$random',
    contentTier: 3,
    label: 'Random Value',
    description: 'A random number within a configured range.',
    abbr: 'R',
    // whole numbers unless `integer: false`
    produces: ['integer', 'float'],
    createDefault: () => ({ $random: { min: 0, max: 100, integer: true } }),
  },
  {
    source: '$switch',
    key: '$switch',
    contentTier: 3,
    label: 'Switch / Case',
    description: 'One of several values selected by a matching key.',
    abbr: 'S',
    produces: ['any'],
    createDefault: (fieldType, defaultValue) => ({
      $switch: {
        value: { $var: { path: '' } },
        cases: [],
        default: defaultValueFor(fieldType, defaultValue),
      },
    }),
  },
  {
    source: '$user',
    key: '$user',
    contentTier: 3,
    label: 'User Data',
    description: 'Information about the logged-in user or user list.',
    abbr: '@',
    produces: fieldProduces('$user'),
    createDefault: (_fieldType, _defaultValue, fieldTypes) => ({
      $user: { field: defaultSourceField('$user', fieldTypes, 'username') },
    }),
  },
  {
    source: '$userGroups',
    key: '$userGroups',
    contentTier: 3,
    label: 'User Groups',
    description:
      'True when the signed-in user is in one of the selected groups (empty = everyone).',
    short: 'Groups',
    abbr: 'UG',
    produces: ['boolean'],
    createDefault: () => ({ $userGroups: { groups: [] } }),
  },
  {
    source: '$device',
    key: '$device',
    contentTier: 3,
    label: 'Device Info',
    description: 'The hostname, IP address, or MAC address of this device.',
    short: 'Device',
    abbr: 'D',
    produces: fieldProduces('$device'),
    createDefault: (_fieldType, _defaultValue, fieldTypes) => ({
      $device: { field: defaultSourceField('$device', fieldTypes, 'hostname') },
    }),
  },
  {
    source: '$time',
    key: '$time',
    contentTier: 3,
    label: 'Current Time',
    description: 'The current date and time in a chosen format.',
    abbr: 'T',
    // the time as text formatted by `format`, which decides whether that text
    // is a DateTime, a Date, a Time or just a string
    produces: ['datetime', 'string', 'date', 'time'],
    createDefault: () => ({ $time: { format: 'HH:mm:ss', timezone: '' } }),
  },
  {
    source: '$widgetProp',
    key: '$widgetProp',
    contentTier: 1,
    label: 'Exported Property',
    description: 'A value exported by another widget on the page.',
    short: 'Exported Prop',
    abbr: 'XP',
    produces: ['any'],
    createDefault: () => ({ $widgetProp: { componentId: '', property: '' } }),
  },
  {
    source: '$languages',
    key: '$languages',
    contentTier: 3,
    label: 'Language List',
    description: 'The languages configured for this project.',
    abbr: 'LG',
    produces: ['string[]'],
    createDefault: () => ({ $languages: {} }),
  },
  {
    source: '$stringExpr',
    key: '$stringExpr',
    contentTier: 3,
    label: 'String Expression',
    description: 'Text assembled from a template and dynamic values.',
    short: 'String Expr',
    abbr: 'SE',
    produces: ['string'],
    createDefault: () => ({ $stringExpr: { template: '', wildcards: {} } }),
  },
  {
    source: '$http',
    key: '$http',
    contentTier: 3,
    label: 'HTTP Request',
    description: 'A value read from an HTTP API response.',
    short: 'HTTP',
    abbr: 'HT',
    produces: ['any'],
    createDefault: () => ({
      $http: { url: '', wildcards: {}, method: 'GET', path: '', refreshSeconds: 0 },
    }),
  },
  {
    source: '$alarmCount',
    key: '$alarmCount',
    contentTier: 3,
    label: 'Alarm Count',
    description: 'A live count of alarms matching a filter.',
    abbr: 'AC',
    produces: ['integer'],
    createDefault: () => ({ $alarmCount: { filter: 'unacked' } }),
  },
  {
    source: '$recipe',
    key: '$recipe',
    contentTier: 3,
    label: 'Recipe',
    description: 'State from a selected recipe dataset type.',
    abbr: 'RC',
    produces: fieldProduces('$recipe'),
    createDefault: (_fieldType, _defaultValue, fieldTypes) => ({
      $recipe: { type: '', field: defaultSourceField('$recipe', fieldTypes, 'parametersChanged') },
    }),
  },
  {
    source: '$recipeList',
    key: '$recipeList',
    contentTier: 3,
    label: 'Recipe List',
    description: 'Saved recipes exposed as rows for a data grid.',
    abbr: 'RL',
    produces: ['record-list'],
    createDefault: () => ({ $recipeList: { type: '' } }),
  },
  {
    source: '$componentProp',
    key: '$componentProp',
    contentTier: 1,
    label: 'Component Property',
    description:
      'A value passed in by the parent component, or by the action that opened this page overlay.',
    short: 'Component Prop',
    abbr: 'CP',
    produces: ['any'],
    createDefault: () => ({ $componentProp: '' }),
  },
  {
    source: '$page',
    key: '$page',
    contentTier: 3,
    label: 'Page Metadata',
    description: 'Metadata from the current page or another selected page.',
    short: 'Page',
    abbr: 'PG',
    produces: fieldProduces('$page'),
    createDefault: (fieldType, _defaultValue, fieldTypes) => ({
      $page: {
        field: defaultSourceField(
          '$page',
          fieldTypes,
          fieldType.toLowerCase() === 'icon' ? 'icon' : 'title',
        ),
      },
    }),
  },
  {
    source: '$viewport',
    key: '$viewport',
    contentTier: 3,
    label: 'Viewport',
    description: 'The current screen size, orientation, width, or height.',
    short: 'Viewport',
    abbr: 'VP',
    produces: fieldProduces('$viewport'),
    createDefault: (_fieldType, _defaultValue, fieldTypes) => ({
      $viewport: { field: defaultSourceField('$viewport', fieldTypes, 'size') },
    }),
  },
  {
    source: '$result',
    key: '$result',
    contentTier: 3,
    label: 'Action Result',
    description: 'A field returned by an action completion handler.',
    short: 'Result',
    abbr: 'RS',
    produces: ['any'],
    createDefault: () => ({ $result: 'reason' }),
  },
  {
    source: '$repeatItem',
    key: '$repeatItem',
    contentTier: 1,
    label: 'Repeat Item',
    description: 'The element of the surrounding Repeater copy, one of its members, or its index.',
    short: 'Repeat Item',
    abbr: 'RI',
    produces: ['any'],
    createDefault: () => ({ $repeatItem: { field: 'value' } }),
  },
];

/** Lookup table: property source → descriptor. */
export const PROPERTY_SOURCES = Object.fromEntries(DESCRIPTORS.map((d) => [d.source, d])) as Record<
  PropertySource,
  PropertySourceDescriptor
>;

/**
 * All valid property-source keys (the '$…' strings used in persisted JSON).
 * Derived from the registry — no separate enumeration needed.
 */
export const PROPERTY_SOURCE_KEYS: readonly PropertySourceKey[] = DESCRIPTORS.map((d) => d.key);

/** Type-guard: check whether a string is a known property-source key. */
export function isPropertySourceKey(k: string): k is PropertySourceKey {
  return (PROPERTY_SOURCE_KEYS as readonly string[]).includes(k);
}

/** Create the default value for a property source and field type (or a
 *  union of them, whose first type shapes the value). */
export function createSourceDefault(
  source: PropertySource,
  fieldType: string | readonly string[],
  defaultValue?: unknown,
): unknown {
  const types = typeof fieldType === 'string' ? [fieldType] : fieldType;
  return PROPERTY_SOURCES[source].createDefault(types[0] ?? '', defaultValue, types);
}
