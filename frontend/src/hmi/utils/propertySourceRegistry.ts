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
  | '$result';

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
  'any' | 'string' | 'integer' | 'float' | 'boolean' | 'datetime' | 'string[]' | 'record-list';

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
  /** Create the default value for this source given the target field type. */
  createDefault: (fieldType: string, defaultValue?: unknown) => unknown;
}

export function defaultValueFor(fieldType: string, defaultValue?: unknown): unknown {
  if (defaultValue !== undefined) return defaultValue;
  const ft = fieldType.toLowerCase();
  if (ft === 'option-list') return [];
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
    source: '$random',
    key: '$random',
    contentTier: 3,
    label: 'Random Value',
    description: 'A random number within a configured range.',
    abbr: 'R',
    produces: ['float'],
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
    // username → string; groups / userList → string[]
    produces: ['string', 'string[]'],
    createDefault: () => ({ $user: { field: 'username' } }),
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
    produces: ['string'],
    createDefault: () => ({ $device: { field: 'hostname' } }),
  },
  {
    source: '$time',
    key: '$time',
    contentTier: 3,
    label: 'Current Time',
    description: 'The current date and time in a chosen format.',
    abbr: 'T',
    produces: ['datetime'],
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
    produces: ['boolean', 'string'],
    createDefault: () => ({ $recipe: { type: '', field: 'parametersChanged' } }),
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
    description: 'A value passed in by the parent component or dialog.',
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
    // most fields → string; depth → integer; pathSegments → string[]
    produces: ['string', 'integer', 'string[]'],
    createDefault: () => ({ $page: { field: 'title' } }),
  },
  {
    source: '$viewport',
    key: '$viewport',
    contentTier: 3,
    label: 'Viewport',
    description: 'The current screen size, orientation, width, or height.',
    short: 'Viewport',
    abbr: 'VP',
    produces: ['string', 'integer'],
    createDefault: () => ({ $viewport: { field: 'size' } }),
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

/** Create the default value for a property source and field type. */
export function createSourceDefault(
  source: PropertySource,
  fieldType: string,
  defaultValue?: unknown,
): unknown {
  return PROPERTY_SOURCES[source].createDefault(fieldType, defaultValue);
}
