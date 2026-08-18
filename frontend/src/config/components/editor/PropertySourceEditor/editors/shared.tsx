import {
  Fragment,
  useContext,
  useEffect,
  useMemo,
  type CSSProperties,
  type ReactNode,
} from 'react';
import FieldGroup from '../../../ui/FieldGroup';
import { sourceFieldGroupProps } from '../../../ui/FieldGroup/sourceFieldProps';
import PropertySourceSelector from '../../PropertySourceSelector';
import { renderSchemaField } from '../../../../utils/renderSchemaField';
import type { SchemaField } from '@shared/types/widgetSchema';
import {
  propertyValuePreview,
  getPropertySource,
  shortenBindingPath,
  substituteWildcards,
  unwrapBranch,
  MAX_PREVIEW_DEPTH,
} from '../../propertyValueUtils';
import type { PropertySource } from '../../propertyValueUtils';
import { isRecord } from '@shared/types/propertyValueGuards';
import PropertySourceEditor from '..';
import { ParentPathContext, useParentPath, withSegs } from '../parentPathContext';
import { primaryType } from '@shared/utils/valueTypes';
import { useUsersDomainStore, type UserGroup } from '@config/store/domains/usersDomainStore';
import { useConfigStore } from '@shared/store/configStore';
import { flattenPages, resolvePageTitle } from '@shared/utils/pageTree';
import {
  COMPARE_OPERAND_SCHEMA,
  OPERATORS,
  type Operator,
  type OpenBindingPicker,
  wrapPicker,
} from './utils';
import { useFieldDiagnostic } from '@config/hooks/usePanelDiagnostics';
import { PanelScopeContext } from '@config/store/panelExpansionStore';

const EMPTY_GROUP_LABELS: Record<string, string> = {};
const EMPTY_GROUPS_LIST: UserGroup[] = [];

/**
 * A variable path is one long token, so inside a clamped summary the only wrap
 * opportunity the browser has is the one `overflow-wrap: anywhere` invents —
 * mid-identifier, and only once the line has already overflowed. Offering an
 * explicit one after each separator keeps a wrapped path readable and lets a
 * line fill up before it breaks.
 */
export function BreakableToken({ text }: { text: string }) {
  const parts = text.split(/(?<=[:/[\]])/);
  if (parts.length < 2) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 && <wbr />}
        </Fragment>
      ))}
    </>
  );
}

/** Tinted keyword span — color is `--cfg-source-<tint>`, applied through the
 *  `--option-color` custom property (see `.kw` rule in FieldGroup/style.css). */
export function Kw({ tint, children }: { tint: string; children: ReactNode }) {
  return (
    <span className="kw" style={{ '--option-color': `var(--cfg-source-${tint})` } as CSSProperties}>
      {children}
    </span>
  );
}

/**
 * Recursive composite-summary renderer — shares `propertyValuePreview`'s
 * `unwrapBranch` for the $if/$switch/$compare shapes, but wraps each
 * construct's own literal tokens (if/then/else, switch cases, compare
 * operator) in a mode-tinted `.kw` span instead of returning a flat string, so
 * nested logic reads at a glance (see property-panel-redesign doc's sandbox
 * parity notes). Non-branching leaves delegate straight to `propertyValuePreview`,
 * unchanged.
 */
interface PreviewLookups {
  groupLabels?: Record<string, string>;
  pageTitles?: Record<string, string>;
}

const EMPTY_LOOKUPS: PreviewLookups = {};

function previewNodes(
  value: unknown,
  fieldType: string | undefined,
  depth = 0,
  lookups: PreviewLookups = EMPTY_LOOKUPS,
): ReactNode {
  if (!isRecord(value)) return propertyValuePreview(value, fieldType, depth);
  if ('$var' in value)
    return <BreakableToken text={propertyValuePreview(value, fieldType, depth)} />;
  if ('$stringExpr' in value) {
    const se = value.$stringExpr as
      { template?: string; wildcards?: Record<string, unknown> } | undefined;
    if (!se?.template || depth >= MAX_PREVIEW_DEPTH)
      return propertyValuePreview(value, fieldType, depth);
    // Template syntax (braces, function names) is the construct's own literal
    // text, so it takes the tint — same rule as `if(`/`switch(` below. What the
    // wildcards resolve to is data, and renders plain.
    let keyCounter = 0;
    return substituteWildcards<ReactNode>(
      se.template,
      se.wildcards ?? {},
      (wildcard) => (
        <Fragment key={keyCounter++}>
          {isRecord(wildcard) && '$var' in wildcard ? (
            // A template concatenates several of these, so each bound path is
            // shortened from the front — unlike a lone `$var` summary, which
            // has the whole row to itself and stays complete.
            <BreakableToken
              text={shortenBindingPath(propertyValuePreview(wildcard, undefined, depth + 1))}
            />
          ) : (
            previewNodes(wildcard, undefined, depth + 1, lookups)
          )}
        </Fragment>
      ),
      (text) => (
        <Kw tint="stringExpr" key={keyCounter++}>
          {text}
        </Kw>
      ),
      (parts) => <>{parts}</>,
    );
  }
  if ('$userGroups' in value) {
    const groupLabels = lookups.groupLabels ?? EMPTY_GROUP_LABELS;
    const groups = (value.$userGroups as { groups?: string[] } | undefined)?.groups ?? [];
    if (groups.length === 0) return <Kw tint="userGroups">everyone</Kw>;
    return (
      <>
        <Kw tint="userGroups">groups: </Kw>
        {groups.map((id) => groupLabels[id] ?? id).join(', ')}
      </>
    );
  }
  if ('$pageIsActive' in value) {
    const pageTitles = lookups.pageTitles ?? EMPTY_GROUP_LABELS;
    const pageId = (value.$pageIsActive as { page?: string } | undefined)?.page;
    return (
      <Kw tint="pageIsActive">{pageId ? (pageTitles[pageId] ?? pageId) : '(current page)'}</Kw>
    );
  }
  if ('$random' in value) {
    if (depth >= MAX_PREVIEW_DEPTH) return <Kw tint="random">random(…)</Kw>;
    const r = value.$random as { min?: unknown; max?: unknown } | undefined;
    return (
      <>
        <Kw tint="random">random(</Kw>
        {previewNodes(r?.min, undefined, depth + 1, lookups)} …{' '}
        {previewNodes(r?.max, undefined, depth + 1, lookups)}
        <Kw tint="random">)</Kw>
      </>
    );
  }
  const branch = unwrapBranch(value);
  if (!branch) return propertyValuePreview(value, fieldType, depth);
  if (typeof branch === 'string') return `${branch}(…)`;
  if (depth >= MAX_PREVIEW_DEPTH) return `${branch.kind}(…)`;
  if (branch.kind === 'if') {
    return (
      <>
        <Kw tint="if">if(</Kw>
        {previewNodes(branch.condition, undefined, depth + 1, lookups)} <Kw tint="if">then</Kw>{' '}
        {previewNodes(branch.trueVal, fieldType, depth + 1, lookups)} <Kw tint="if">else</Kw>{' '}
        {previewNodes(branch.falseVal, fieldType, depth + 1, lookups)}
        <Kw tint="if">)</Kw>
      </>
    );
  }
  if (branch.kind === 'switch') {
    return (
      <>
        <Kw tint="switch">switch(</Kw>
        {previewNodes(branch.value, undefined, depth + 1, lookups)}
        <Kw tint="switch">: </Kw>
        {branch.cases.map((c, i) => (
          <span key={i}>
            {i > 0 && ', '}
            {switchCaseNodes(c.when, c.then, fieldType, depth + 1, lookups)}
          </span>
        ))}
        <Kw tint="switch">, else </Kw>
        {previewNodes(branch.fallback, fieldType, depth + 1, lookups)}
        <Kw tint="switch">)</Kw>
      </>
    );
  }
  return (
    <>
      <Kw tint="compare">compare(</Kw>
      {previewNodes(branch.left, undefined, depth + 1, lookups)}
      {` ${branch.operator} `}
      {previewNodes(branch.right, undefined, depth + 1, lookups)}
      <Kw tint="compare">)</Kw>
    </>
  );
}

/** One `$switch` case as a summary reads it: `"when" → then`, the arrow in the
 *  switch tint like every other construct's own literal tokens. A case with no
 *  condition typed yet says so instead of showing an empty pair of quotes. */
function switchCaseNodes(
  when: unknown,
  then: unknown,
  fieldType: string | undefined,
  depth: number,
  lookups: PreviewLookups,
): ReactNode {
  const whenNode =
    when === '' || when === null || when === undefined ? (
      '(empty) '
    ) : typeof when === 'string' ? (
      // A literal keeps its quotes — that is what separates it on sight from a
      // bound path or a nested expression on the same side of the arrow.
      `"${when}" `
    ) : (
      <>{previewNodes(when, undefined, depth, lookups)} </>
    );
  return (
    <>
      {whenNode}
      <Kw tint="switch">→</Kw> {previewNodes(then, fieldType, depth, lookups)}
    </>
  );
}

/** A single `$switch` case, rendered exactly as the collapsed `$switch` summary
 *  renders it — used by the case rows in the switch editor so a collapsed row
 *  and the collapsed field it belongs to read the same. */
export function SwitchCasePreview({
  when,
  then,
  fieldType,
}: {
  when: unknown;
  then: unknown;
  fieldType?: string;
}) {
  return <>{switchCaseNodes(when, then, fieldType, 1, EMPTY_LOOKUPS)}</>;
}

/** Standard collapsed-summary chip: optional color swatch + one line of text. */
export function PreviewText({ children, swatch }: { children: ReactNode; swatch?: string }) {
  return (
    <span className="cfg-field-group__preview">
      {swatch && (
        <span className="cfg-field-group__preview-swatch" style={{ background: swatch }} />
      )}
      <span className="cfg-field-group__preview-text">{children}</span>
    </span>
  );
}

/** Bare kind-name label shown beside the badge while a tier-3 row is expanded. */
export function KindLabel({ children }: { children: ReactNode }) {
  return <span className="cfg-field-group__preview-text">{children}</span>;
}

export function CollapsedPreview({ value, fieldType }: { value: unknown; fieldType: string }) {
  const colorVal = fieldType === 'color' && typeof value === 'string' && value ? value : undefined;
  const groups = useUsersDomainStore((s) => s.draft?.groups ?? s.data?.groups ?? EMPTY_GROUPS_LIST);
  const ensureGroupsLoaded = useUsersDomainStore((s) => s.ensureLoaded);
  const pages = useConfigStore((s) => s.pages);
  useEffect(() => {
    if (isRecord(value) && '$userGroups' in value) ensureGroupsLoaded();
  }, [value, ensureGroupsLoaded]);
  const groupLabels = useMemo(
    () => Object.fromEntries(groups.map((g) => [g.id, g.label])),
    [groups],
  );
  const pageTitles = useMemo(
    () => Object.fromEntries(flattenPages(pages).map((p) => [p.id, resolvePageTitle(p.title)])),
    [pages],
  );
  return (
    <PreviewText swatch={colorVal}>
      {previewNodes(value, fieldType, 0, { groupLabels, pageTitles })}
    </PreviewText>
  );
}

/** Operator row + two BranchEditor operands for $compare left/right. */
export function CompareFields({
  left,
  operator,
  right,
  onChangeLeft,
  onChangeOperator,
  onChangeRight,
  onOpenLeftPicker,
  onOpenRightPicker,
}: {
  left: unknown;
  operator: Operator;
  right: unknown;
  onChangeLeft: (v: unknown) => void;
  onChangeOperator: (op: Operator) => void;
  onChangeRight: (v: unknown) => void;
  onOpenLeftPicker?: OpenBindingPicker;
  onOpenRightPicker?: OpenBindingPicker;
}) {
  const parent = useParentPath();
  const leftPath = withSegs(parent, 'left');
  const rightPath = withSegs(parent, 'right');
  return (
    <>
      <ParentPathContext.Provider value={leftPath}>
        <BranchEditor
          label="This value"
          value={left}
          onChange={onChangeLeft}
          schema={COMPARE_OPERAND_SCHEMA}
          onOpenBindingPicker={onOpenLeftPicker}
        />
      </ParentPathContext.Provider>

      <div className="cfg-operator-row">
        {OPERATORS.map((op) => (
          <button
            key={op.value}
            type="button"
            className={`cfg-operator-row__btn${operator === op.value ? ' cfg-operator-row__btn--active' : ''}`}
            onClick={() => onChangeOperator(op.value as Operator)}
          >
            {op.label}
          </button>
        ))}
      </div>

      <ParentPathContext.Provider value={rightPath}>
        <BranchEditor
          label="That value"
          value={right}
          onChange={onChangeRight}
          schema={COMPARE_OPERAND_SCHEMA}
          onOpenBindingPicker={onOpenRightPicker}
        />
      </ParentPathContext.Provider>
    </>
  );
}

/**
 * CollapsiblePropertyCard — reusable card shell used by both WildcardCard and BranchEditor.
 * Reads its own selection identity (path) from ParentPathContext.
 */
export function CollapsiblePropertyCard({
  title,
  hideLabel,
  description,
  value,
  onChange,
  schema,
  forcedSources,
  includeStatic,
  onOpenBindingPicker,
  sourceless,
  staticEditor,
  actions,
}: {
  title: string;
  /** Drops the label line above the box for rows in a list, where position —
   *  not a name — identifies the entry. `title` still names the drawer and
   *  feeds the collapsed summary. */
  hideLabel?: boolean;
  /** Explanatory copy between the title and the box — see `FieldGroup`. */
  description?: ReactNode;
  value: unknown;
  onChange: (v: unknown) => void;
  schema: SchemaField;
  forcedSources?: PropertySource[];
  includeStatic?: boolean;
  onOpenBindingPicker?: OpenBindingPicker;
  /** Object-name/identifier fields (e.g. alarm title) hide the badge even though switchable. */
  sourceless?: boolean;
  /** Override the auto-derived (`renderSchemaField`) static-mode editor. */
  staticEditor?: ReactNode;
  /** Extra row actions (e.g. a list item's remove `×`) — they land in the same
   *  bordered button column as the drawer and picker buttons. */
  actions?: ReactNode;
}) {
  const currentSource = getPropertySource(value) as PropertySource;
  const path = useParentPath();
  const widgetId = useContext(PanelScopeContext);
  const diagnostic = useFieldDiagnostic(widgetId, path);
  const fieldType = primaryType(schema.type);
  const selection = path ? { path, schema } : undefined;
  // Content-tier shape follows this branch/case/operand's own current source —
  // a plain $static/$var leaf inside an $if renders inline, not boxed, same
  // as a top-level leaf (redesign doc's Content-tier model).
  const { tier, summary, kindLabel, drawerTitle } = sourceFieldGroupProps({
    source: currentSource,
    title,
    value,
    fieldType,
  });
  // Collapsed on load; FieldGroup's session store restores anything the user
  // expands while the page is open.
  const defaultExpanded = false;

  const sourceSelector = sourceless ? undefined : (
    <PropertySourceSelector
      value={value}
      onChange={onChange}
      fieldType={fieldType}
      defaultValue={schema.defaultValue}
      forcedSources={forcedSources}
      includeStatic={includeStatic}
      label={schema.label}
      compact
    />
  );

  const editor = (
    <PropertySourceEditor
      value={value}
      onChange={onChange}
      source={currentSource}
      schema={schema}
      onOpenBindingPicker={onOpenBindingPicker}
      staticEditor={
        currentSource === 'static'
          ? (staticEditor ?? renderSchemaField(schema, value, onChange))
          : undefined
      }
    />
  );

  return (
    <FieldGroup
      label={hideLabel ? undefined : title}
      description={description}
      tier={tier}
      selection={selection}
      sourceless={sourceless}
      diagnostic={diagnostic}
      defaultExpanded={defaultExpanded}
      summary={summary}
      kindLabel={kindLabel}
      badge={sourceSelector}
      actions={actions}
      drawerTitle={drawerTitle}
    >
      {editor}
    </FieldGroup>
  );
}

/**
 * BranchEditor — inline expression editor for $if branches and $switch cases.
 */
export function BranchEditor({
  label,
  value,
  onChange,
  schema,
  onOpenBindingPicker,
}: {
  label: string;
  value: unknown;
  onChange: (v: unknown) => void;
  schema: SchemaField;
  onOpenBindingPicker?: OpenBindingPicker;
}) {
  const branchPicker = wrapPicker(onOpenBindingPicker, (b) => onChange({ $var: b }), value);
  return (
    <CollapsiblePropertyCard
      title={label}
      value={value}
      onChange={onChange}
      schema={schema}
      onOpenBindingPicker={branchPicker}
    />
  );
}

/** Mini prop card for a single string-expression wildcard. */
export function WildcardCard({
  wcKey,
  value,
  onChange,
  onOpenBindingPicker,
  schema,
  forcedSources,
}: {
  wcKey: string;
  value: unknown;
  onChange: (v: unknown) => void;
  onOpenBindingPicker?: OpenBindingPicker;
  schema: SchemaField;
  forcedSources: PropertySource[];
}) {
  return (
    <CollapsiblePropertyCard
      title={`{${wcKey}}`}
      value={value}
      onChange={onChange}
      schema={schema}
      forcedSources={forcedSources}
      includeStatic
      onOpenBindingPicker={onOpenBindingPicker}
    />
  );
}
