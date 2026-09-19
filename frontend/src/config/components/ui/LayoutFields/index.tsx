import type { ReactNode } from 'react';
import type { LayoutConfig } from '@shared/types/config';
import type { SchemaField } from '@shared/types/widgetSchema';
import type { PropertySource } from '@hmi/utils/propertySourceRegistry';
import { effectiveSizeMode, lengthSuppressed } from '@hmi/components/layoutUtils';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { varBindingOf } from '@config/components/editor/bindingPickerUtils';
import { LAYOUT_PATH_KEY } from '@config/utils/propertyPath';
import PropRow from '../PropRow';
import SchemaFieldRow from '../SchemaFieldRow';
import { alignIcons, justifyIcons } from './alignIcons';
import { COLUMN_ICON, ROW_ICON } from './directionIcons';
import { CONTAINER_DEFAULT_TOKENS } from './containerDefaultTokens';

/** The two axes a size mode can be stored for, named by the `LayoutConfig` key
 *  each sets. */
type SizeAxis = 'width' | 'height';

/** The `LayoutConfig` key holding *axis*'s stored size mode. */
function modeKeyOf(axis: SizeAxis): 'widthMode' | 'heightMode' {
  return axis === 'width' ? 'widthMode' : 'heightMode';
}

/**
 * Which of an axis's two size keys its mode leaves reachable — the one rule
 * behind every read of a stored mode. Axis-blind: the panel no longer knows
 * which axis its parent treats as main (that is `hmi.css`'s call, made at
 * render from the parent's own `data-flow-direction`), so both axes read this
 * the same way.
 *
 * Fixed sizes from the axis's own `width`/`height`; Fill from the `grow`
 * weight; Hug from neither. An unresolved mode (unset, `$var`, `$switch`, a
 * mixed selection) leaves both reachable — either key may be the live one once
 * it resolves, or once this axis turns out to be the one its parent treats as
 * main.
 */
function reachableSizeKeys(mode: string | undefined): { length: boolean; grow: boolean } {
  return {
    length: !lengthSuppressed(mode),
    grow: mode === 'fill' || mode === undefined,
  };
}

const DIRECTION_FIELD: SchemaField = {
  type: 'String',
  format: 'direction',
  label: 'Direction',
  // The first `button-icon` group in the repo. The labels stay as each button's
  // `title`, so the control is still readable without knowing the glyphs.
  display: 'button-icon',
  defaultValue: 'row',
  options: [
    { label: 'Row', value: 'row', icon: ROW_ICON },
    { label: 'Column', value: 'column', icon: COLUMN_ICON },
  ],
};

/**
 * `align-items` and `justify-content` as one icon group each. Two 1-D rows
 * rather than one 2-D picker, so each row states a single question. Only the
 * presentation swaps with the container's `direction` — labels name the position
 * an author can see, glyphs transpose — while storage stays `align`/`justify`.
 */
const ALIGN_FIELD: SchemaField = {
  type: 'String',
  format: 'align',
  label: 'Align',
  display: 'button-icon',
  // The CSS default, and the thing that makes a child's cross-axis `Fill` work
  // without any `alignSelf` of its own.
  defaultValue: 'stretch',
};

const JUSTIFY_FIELD: SchemaField = {
  type: 'String',
  format: 'justify',
  label: 'Distribute',
  display: 'button-icon',
  defaultValue: 'flex-start',
};

/** Positional names, by the screen axis the row's property drives. */
const POSITION_LABELS = {
  horizontal: ['Left', 'Center', 'Right'],
  vertical: ['Top', 'Middle', 'Bottom'],
} as const;

const POSITIONS = ['flex-start', 'center', 'flex-end'] as const;

function positionOptions(vertical: boolean, icons: Record<string, string>) {
  const labels = POSITION_LABELS[vertical ? 'vertical' : 'horizontal'];
  return POSITIONS.map((value, i) => ({ label: labels[i], value, icon: icons[value] }));
}

/** @param vertical - the cross axis runs top-to-bottom (a `row` container). */
function alignOptions(vertical: boolean) {
  const icons = alignIcons(vertical);
  return [
    ...positionOptions(vertical, icons),
    { label: 'Stretch', value: 'stretch', icon: icons.stretch },
  ];
}

/** @param vertical - the main axis runs top-to-bottom (a `column` container). */
function justifyOptions(vertical: boolean) {
  const icons = justifyIcons(vertical);
  return [
    ...positionOptions(vertical, icons),
    { label: 'Space between', value: 'space-between', icon: icons['space-between'] },
    { label: 'Space around', value: 'space-around', icon: icons['space-around'] },
  ];
}

// Both variants of each glyph set, built once: the option arrays are rebuilt on
// every render of the panel otherwise, SVG strings and all, and a fresh
// `options` identity defeats the field row's own memoisation.
const ALIGN_OPTIONS = { row: alignOptions(true), column: alignOptions(false) };
const JUSTIFY_OPTIONS = { row: justifyOptions(false), column: justifyOptions(true) };

const SIZE_MODE_OPTIONS = [
  { label: 'Hug', value: 'hug' },
  { label: 'Fill', value: 'fill' },
  { label: 'Fixed', value: 'fixed' },
];

const SIZE_LABELS: Record<SizeAxis, string> = { width: 'Width', height: 'Height' };

/** Bindable Hug/Fill/Fixed picker for one axis. A plain enum field like
 *  `DIRECTION_FIELD`, so it takes the normal `SchemaFieldRow` path and gets
 *  property-source support for free. `schemaFor` fills in `defaultValue`. */
function sizeModeField(axis: SizeAxis): SchemaField {
  return {
    type: 'String',
    format: 'select',
    label: `${SIZE_LABELS[axis]} mode`,
    display: 'button-text',
    options: SIZE_MODE_OPTIONS,
  };
}

/** The axis a mode pick's `grow`-clearing decision has to consult besides its
 *  own — there are only the two. */
function otherAxisOf(axis: SizeAxis): SizeAxis {
  return axis === 'width' ? 'height' : 'width';
}

/** The Fill weight — one row for the one `grow` there is. It belongs to the
 *  widget rather than to an axis: the panel cannot know which axis its parent
 *  will treat as main, and `grow` counts only along the container's own
 *  direction, so a per-axis row would be claiming the main-axis knowledge the
 *  panel gave up when flow resolution moved into `hmi.css`. It renders below
 *  both axis blocks whenever either axis reaches it, which is why no axis's own
 *  `sizeValueRow` emits it. Built once, for the same reason as
 *  {@link ALIGN_OPTIONS}: a fresh `schema` identity defeats the field row's own
 *  memoisation. */
const GROW_FIELD: LayoutFieldDef = {
  key: 'grow',
  schema: {
    type: 'Float',
    label: 'Fill weight',
    description: 'Counts only along the container’s own direction.',
    min: 0.1,
    step: 0.1,
    defaultValue: 1,
  },
  group: 'self',
};

/**
 * The patch one size-mode pick writes: the mode itself, plus every key the pick
 * puts out of the panel's reach. The mode row is its axis's only writer for its
 * own length, so a length under Hug or Fill is dropped here, same as the
 * runtime lets it — an axis whose mode isn't literally Fixed never has a
 * `width`/`height` for `hmi.css`'s translation block to read either.
 *
 * `grow` is different: one key with one row, kept alive by *either* axis
 * reaching it (`reachableSizeKeys`), so a pick on one axis is not on its own
 * enough to retire it. Clearing it here needs the *other* axis's own stored
 * mode too — `otherMode`, read by the caller — or a Fill on Width would lose
 * its weight the moment Height's mode is switched away from Fill, even though
 * Width still reaches it and the row is still showing.
 *
 * A non-literal mode (`$var`, `$switch`) clears neither: it may resolve to the
 * mode that reads them, so the length keeps its row (see `sizeValueRow`) and
 * the weight keeps its own. The same holds for the *other* axis's mode when
 * deciding `grow`: `otherAmbiguous`, also read by the caller, keeps this from
 * clearing a weight the other axis might still turn out to own once its own
 * binding or selection resolves.
 */
function sizeModePatch(
  axis: SizeAxis,
  value: unknown,
  otherMode: string | undefined,
  otherAmbiguous: boolean,
): Partial<LayoutConfig> {
  const mode = value === '' || value === undefined ? undefined : value;
  const reachable = reachableSizeKeys(typeof mode === 'string' ? mode : undefined);
  const patch: Record<string, unknown> = { [modeKeyOf(axis)]: mode };
  if (!reachable.length) patch[axis] = undefined;
  // The weight's one row answers to both axes — clear the key only once
  // neither axis's mode still reaches it, or a pick on one axis would strand a
  // weight whose still-visible row can no longer show, revert or explain it.
  const otherStillReachesGrow = otherAmbiguous || reachableSizeKeys(otherMode).grow;
  if (!reachable.grow && !otherStillReachesGrow) patch.grow = undefined;
  return patch as Partial<LayoutConfig>;
}

/** A value the panel can only render as a literal — a `$`-sourced one reads as
 *  unset here and the row's own Mixed/binding handling takes over. */
function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

type LayoutKey = keyof LayoutConfig;
type FieldGroup = 'container' | 'self';

interface LayoutFieldDef {
  key: LayoutKey;
  schema: SchemaField;
  group: FieldGroup;
}

/**
 * One plain length row per padding side, in CSS box order.
 *
 * Four independent rows over the four independent keys — no merged "all sides"
 * control over the top of them. Each one is an ordinary `SchemaFieldRow`, so
 * the source pill, the `$var` picker, the Mixed state, the themed default hint
 * and the revert `×` all come from the same place they do for every other
 * layout row, and a side can be bound on its own.
 */
const PADDING_FIELDS: LayoutFieldDef[] = (
  ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const
).map((key) => ({
  key,
  schema: {
    type: 'String',
    format: 'length',
    label: `Padding ${key.slice('padding'.length).toLowerCase()}`,
  },
  group: 'container',
}));

/** The example lengths each axis's rows suggest — the only thing that differs
 *  between the two otherwise identical quadruplets {@link sizeFields} builds. */
const SIZE_PLACEHOLDERS = {
  width: { own: 'e.g. 200px or 100%', min: 'e.g. 100px', max: 'e.g. 400px' },
  height: { own: 'e.g. 80px', min: 'e.g. 80px', max: 'e.g. 400px' },
} as const satisfies Record<SizeAxis, { own: string; min: string; max: string }>;

/**
 * One axis's four rows: the mode picker, then the length, min and max it sizes
 * by. Built rather than written twice so the two axes cannot drift apart — a
 * new key or a changed row shape lands on both at once.
 */
function sizeFields(axis: SizeAxis): LayoutFieldDef[] {
  const Axis = SIZE_LABELS[axis];
  const bound = (key: LayoutKey, label: string, placeholder: string, defaultValue: string) => ({
    key,
    schema: { type: 'String', format: 'length', label, placeholder, defaultValue } as SchemaField,
    group: 'self' as FieldGroup,
  });
  return [
    { key: `${axis}Mode` as LayoutKey, schema: sizeModeField(axis), group: 'self' },
    bound(axis, Axis, SIZE_PLACEHOLDERS[axis].own, 'auto'),
    bound(`min${Axis}` as LayoutKey, `Min ${axis}`, SIZE_PLACEHOLDERS[axis].min, '0'),
    bound(`max${Axis}` as LayoutKey, `Max ${axis}`, SIZE_PLACEHOLDERS[axis].max, 'none'),
  ];
}

const FIELDS: LayoutFieldDef[] = [
  // Container — hidden when mode === 'leaf'
  { key: 'direction', schema: DIRECTION_FIELD, group: 'container' },
  {
    key: 'gap',
    schema: { type: 'String', format: 'length', label: 'Gap', placeholder: 'e.g. 1rem' },
    group: 'container',
  },
  {
    key: 'wrap',
    schema: { type: 'Boolean', format: 'wrap', label: 'Wrap', defaultValue: false },
    group: 'container',
  },
  // Options and labels are direction-dependent, so both are filled in per render
  // by `schemaFor`; what stands here is the half that never changes.
  { key: 'align', schema: ALIGN_FIELD, group: 'container' },
  { key: 'justify', schema: JUSTIFY_FIELD, group: 'container' },
  ...PADDING_FIELDS,
  {
    key: 'radius',
    schema: { type: 'String', format: 'length', label: 'Radius' },
    group: 'container',
  },

  // Self — sizing
  // The mode rows render the same way under every parent: a mode means the
  // same thing everywhere, and `hmi.css` resolves it against the real flow at
  // render, off the parent's own `data-flow-direction`. The panel never knows
  // which axis that will be — see `schemaFor`'s one neutral default hint.
  ...sizeFields('width'),
  ...sizeFields('height'),
];

interface LayoutProps {
  mode: 'container' | 'leaf';
  layout: Partial<LayoutConfig>;
  onChange: (patch: Partial<LayoutConfig>) => void;
  /** Owning component id — enables the variable-binding picker for `$var`
   *  layout values. A multi-selection passes its lead: the id only scopes the
   *  picker's preselect, while the pick itself is applied through `onChange`.
   *  Omitted in composition authoring (where `$var` is forbidden). */
  componentId?: string;
  /** Pre-resolved theme token values, shared with the rest of the panel — see
   *  {@link usePanelTokenValues}. Falls back to a direct (uncached) resolve per
   *  field when omitted. */
  tokenValues?: Record<string, string>;
  /** Layout keys a multi-selection disagrees on, mapped to the source the widgets
   *  still share (null when they differ there too). Those rows read "Mixed" and
   *  ignore `layout`, which carries only the lead widget's values. */
  mixedLayout?: ReadonlyMap<keyof LayoutConfig, PropertySource | null>;
}

export function LayoutFields({
  mode,
  layout,
  onChange,
  componentId,
  tokenValues,
  mixedLayout,
}: LayoutProps) {
  const openBindingPicker = useEditorDomainStore((s) => s.openBindingPicker);
  const visible = FIELDS.filter((f) => f.group === 'self' || mode === 'container');
  const isRow = stringOrUndefined(layout.direction) !== 'column';

  /** The literal stored mode for one axis — `undefined` for unset, `$var`-bound,
   *  or (in a multi-selection) disagreeing. Used both to pick this axis's own
   *  rows and, for the *other* axis, to tell `sizeModePatch` whether a pick here
   *  can safely clear the shared `grow`. */
  function literalModeOf(axis: SizeAxis): string | undefined {
    const modeKey = modeKeyOf(axis);
    if (mixedLayout?.has(modeKey)) return undefined;
    const modeValue = layout[modeKey];
    return typeof modeValue === 'string' ? modeValue : undefined;
  }

  /** Whether *axis*'s mode is present but unreadable here — `$var`-bound, or
   *  disagreeing across a multi-selection — as opposed to genuinely never set.
   *  Both read as `undefined` through {@link literalModeOf}, but only the
   *  first has to be assumed capable of reaching `grow`: it may resolve to a
   *  literal Fill same as the axis's own unreadable mode does (`sizeValueRows`
   *  shows a row rather than ruling either key out), so a pick on the *other*
   *  axis must not clear a weight this one might still turn out to own. */
  function modeIsAmbiguous(axis: SizeAxis): boolean {
    const modeKey = modeKeyOf(axis);
    if (mixedLayout?.has(modeKey)) return true;
    const modeValue = layout[modeKey];
    return modeValue !== undefined && typeof modeValue !== 'string';
  }

  // The container token-defaults only apply to Container widgets. Attaching the
  // token as `defaultToken` gives layout rows the same unset→`· default(…)` hint +
  // `×` revert as component props, with the resolved value shown as the
  // (length format's own) placeholder.
  function schemaFor(f: LayoutFieldDef): SchemaField {
    // `direction` decides which screen axis each property drives. A `$var`-bound
    // or mixed direction can be either at runtime; `row` is the CSS default and
    // the safer read.
    const axisKey = isRow ? 'row' : 'column';
    if (f.key === 'align') return { ...ALIGN_FIELD, options: ALIGN_OPTIONS[axisKey] };
    if (f.key === 'justify') return { ...JUSTIFY_FIELD, options: JUSTIFY_OPTIONS[axisKey] };
    // One neutral hint on both axes: the panel no longer knows which one its
    // parent treats as main (that's `hmi.css`'s call at render, off the
    // parent's own `data-flow-direction`), so it can no longer claim a
    // main-axis-flavoured "Hug" versus a cross-axis-flavoured "Fill" default.
    // `hug` is the plain CSS default (`flex-grow: 0`) on whichever axis ends
    // up main; a cross-axis child still stretches by default regardless of
    // this hint, through the parent's own `align-items`.
    if (f.key === 'widthMode' || f.key === 'heightMode') {
      return { ...f.schema, defaultValue: 'hug' };
    }
    const token = mode === 'container' ? CONTAINER_DEFAULT_TOKENS[f.key] : undefined;
    return token ? { ...f.schema, defaultToken: token } : f.schema;
  }

  /**
   * What an axis shows below its mode row: its own length, or a read-only dash
   * naming the mode that derived it instead.
   *
   * Fixed sizes the axis from its own length, so that is what it offers. Hug
   * and Fill both derive it — from the content and from the leftover space
   * respectively — so neither stores a length, and the row says which mode did
   * it rather than offering an editor over a key the runtime drops. The Fill
   * weight is not here: `grow` is one number for the widget, so it renders once
   * below both axes (see {@link GROW_FIELD}).
   *
   * A mode that cannot be read here — a `$var`, a `$switch`, or a mixed
   * selection — shows the length: it may be the live key once the mode
   * resolves, so it stays reachable and `sizeModePatch` does not clear it. A
   * genuinely unset mode is different: {@link effectiveSizeMode} reads it as
   * the same Hug the runtime falls back to once the node has left the
   * pre-mode shape, so only a bare, mode-free node keeps this row live — see
   * the panel/runtime agreement that function exists for.
   */
  function sizeValueRow(axis: SizeAxis, f: LayoutFieldDef): ReactNode {
    const modeKey = modeKeyOf(axis);
    // A mixed mode across a multi-selection has no single `layout` to read —
    // same unresolved treatment `literalModeOf` gives it elsewhere in this file.
    const effectiveMode = mixedLayout?.has(modeKey) ? undefined : effectiveSizeMode(layout, axis);

    // 'fixed', the pre-mode shape's genuinely-unset mode (the runtime sizes it
    // straight off its own `width`/`height`, same as a literal Fixed there), or
    // a mode no read can resolve.
    if (reachableSizeKeys(effectiveMode).length) return renderRow(f, schemaFor(f));

    // Only the two deriving modes reach here — every other mode, unreadable
    // ones included, keeps its length reachable above.
    const derivedBy = effectiveMode === 'fill' ? 'Fill' : 'Hug';
    return (
      <PropRow key={f.key} label={SIZE_LABELS[axis]} sourceless>
        <input
          className="cfg-prop-input cfg-prop-input--hint"
          value="—"
          readOnly
          disabled
          aria-label={`${SIZE_LABELS[axis]} (set by ${derivedBy})`}
        />
      </PropRow>
    );
  }

  function renderRow(
    f: LayoutFieldDef,
    schema: SchemaField,
    /** The patch this row writes, where its key is not the only one it owns —
     *  the size-mode rows, which also clear what their pick puts out of reach. */
    patchFor?: (value: unknown) => Partial<LayoutConfig>,
  ): ReactNode {
    // The row's single writer. The picker routes through it too, so a picked
    // binding lands wherever a typed edit would — including on every widget
    // of a multi-selection.
    const commit = (v: unknown) =>
      onChange(
        patchFor
          ? patchFor(v)
          : {
              [f.key]: v === '' || v === undefined ? undefined : (v as LayoutConfig[typeof f.key]),
            },
      );
    return (
      <SchemaFieldRow
        key={f.key}
        schema={schema}
        value={mixedLayout?.has(f.key) ? undefined : layout[f.key]}
        mixed={mixedLayout?.has(f.key) ? { source: mixedLayout.get(f.key) ?? null } : undefined}
        path={[LAYOUT_PATH_KEY, f.key]}
        onChange={commit}
        onOpenPicker={
          componentId
            ? (onPick, currentBinding) =>
                openBindingPicker(componentId, `${LAYOUT_PATH_KEY}.${f.key}`, {
                  // Layout values live on `comp.layout`, not `comp.properties`,
                  // so the picker can neither read this binding back nor write
                  // it back itself — a slot that opened the picker without a
                  // callback of its own gets `commit` instead of the picker's
                  // `properties[propertyKey]` fallback.
                  onPick: onPick ?? ((binding) => commit({ $var: binding })),
                  filter: { label: f.schema.label, type: f.schema.type },
                  // A nested slot inside the value overrides with its own binding.
                  currentBinding: currentBinding ?? varBindingOf(layout[f.key]),
                })
            : undefined
        }
        tokenValues={tokenValues}
      />
    );
  }

  // One flat list in declaration order: Wrap sits with the other flow rows and
  // each bound sits under the axis it bounds. There is no "Advanced" group —
  // what is left after the raw flex rows went is short enough to read at a
  // glance, and a min/max you have to open a group to find is a min/max you
  // forget you set.
  const rows: ReactNode[] = [];
  for (const f of visible) {
    if (f.key === 'widthMode' || f.key === 'heightMode') {
      const axis: SizeAxis = f.key === 'widthMode' ? 'width' : 'height';
      rows.push(
        renderRow(f, schemaFor(f), (v) => {
          const other = otherAxisOf(axis);
          return sizeModePatch(axis, v, literalModeOf(other), modeIsAmbiguous(other));
        }),
      );
      continue;
    }
    if (f.key === 'width' || f.key === 'height') {
      rows.push(sizeValueRow(f.key, f));
      continue;
    }
    rows.push(renderRow(f, schemaFor(f)));
  }

  // The Fill weight closes the panel, below both axis blocks — `FIELDS` ends
  // with the two of them, so appending here is what "below both" means. It
  // shows whenever either axis reaches `grow`, the very condition
  // `sizeModePatch` clears the key by, so a stored weight always has exactly
  // one row to show, edit and revert it, and never more than one.
  if (
    reachableSizeKeys(literalModeOf('width')).grow ||
    reachableSizeKeys(literalModeOf('height')).grow
  ) {
    rows.push(renderRow(GROW_FIELD, GROW_FIELD.schema));
  }

  return <>{rows}</>;
}
