import './style.css';
import {
  createContext,
  useContext,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { SchemaField } from '@shared/types/widgetSchema';
import { useParamSelection } from '@config/hooks/useParamSelection';
import { PanelScopeContext, usePanelFieldExpanded } from '@config/store/panelExpansionStore';
import FieldDrawer from '../../editor/PropertiesPanel/FieldDrawer';
import { ChevronIcon, ExpandIcon } from '../actionIcons';
import { FieldPathContext } from './fieldPathContext';

export type FieldGroupTier = 1 | 2 | 3;

/** The nearest FieldGroup's trailing `__actions` slot element, so a leaf editor
 *  deep in the box body can render its own pick/clear buttons into the shared
 *  designated button column instead of inside the padded content area. Null when
 *  an editor renders standalone (no FieldGroup wrapper) — see `FieldActions`. */
const FieldActionsSlotContext = createContext<HTMLElement | null>(null);

/** Renders a leaf editor's trailing action buttons into the enclosing
 *  FieldGroup's designated `__actions` column (via portal) so every field's
 *  buttons align in the same flush, bordered slot. Falls back to an inline
 *  group of the same class when there is no FieldGroup ancestor. */
export function FieldActions({ children }: { children: ReactNode }) {
  const slot = useContext(FieldActionsSlotContext);
  if (!children) return null;
  if (slot) return createPortal(children, slot);
  return <div className="cfg-field-group__actions">{children}</div>;
}

/** The nearest labelled FieldGroup's title-row slot, so a list editor rendered
 *  inside the box can put its add control behind the field's title instead of
 *  trailing the list. Null when there is no labelled ancestor — see
 *  `FieldHeaderActions`. */
const FieldHeaderSlotContext = createContext<HTMLElement | null>(null);

/** Renders a list editor's add control into the enclosing FieldGroup's title
 *  row (via portal) — the same "add control behind the title" shape the action
 *  list, the component-property list and the historian's tracked variables use.
 *  Falls back to rendering in place when there is no labelled ancestor. */
export function FieldHeaderActions({ children }: { children: ReactNode }) {
  const slot = useContext(FieldHeaderSlotContext);
  if (!children) return null;
  if (slot) return createPortal(children, slot);
  return <div className="cfg-field-group__header-actions">{children}</div>;
}

export interface FieldGroupSelection {
  path: string[];
  schema: SchemaField;
}

const EMPTY_SCHEMA: SchemaField = { type: 'string', label: '' };

interface Props {
  /** Slot label shown above the box (e.g. a property name, "Condition", "This value").
   *  Omit for rows with no semantic slot name of their own — e.g. an action list
   *  item, whose only identity is its own kind (see `kindLabel`). */
  label?: string;
  /** Explanatory copy for this field, rendered between the label and the box —
   *  never inside the box, where it would fight the control for the content slot. */
  description?: ReactNode;
  /** Content-tier shape — governs what click-2 does (see propertyPanel design doc). */
  tier: FieldGroupTier;
  /**
   * Selection identity for click-to-select + Ctrl+C copy/paste. Omit for rows
   * that cannot be selected (e.g. synthetic editors) — click then activates
   * the control directly on the first click instead of a two-step select/edit.
   */
  selection?: FieldGroupSelection;
  /**
   * Explicit per-field opt-in that hides the badge/type-popup entirely —
   * reserved for object-name / identifier fields (component name, alarm code,
   * property key, …). Every other field keeps its badge, even non-switchable
   * plain settings (their badge is just non-interactive).
   */
  sourceless?: boolean;
  /** Badge slot — e.g. `<PropertySourceBadge>` or the mode-pill trigger. */
  badge?: ReactNode;
  /** Trailing row actions — reset `×`, binding picker `✎`, drawer `⤢`. */
  actions?: ReactNode;
  /** Controls that sit behind the label on the title row — the add button of a
   *  field that owns a list (cases, options). Descendant editors reach the same
   *  slot through `FieldHeaderActions`. Needs a `label` to have a row to sit on. */
  headerActions?: ReactNode;
  /** Own or descendant diagnostic — renders the error/warning dot on the badge,
   *  the `message` as its tooltip (see `usePanelDiagnostics`).
   *  `nested` (set when every diagnostic targets a sub-slot of a composite
   *  expression, e.g. an `$if` condition, rather than the field's own
   *  top-level value) suppresses the text underline — the badge dot alone
   *  marks it, matching the "don't recurse into a flagged slot" noise-control
   *  rule: the box that actually owns the empty/wrong value gets the full
   *  mark, its ancestors just a dot. */
  diagnostic?: { level: 'error' | 'warning'; message: string; nested?: boolean };
  /** Forces the selected accent even without an exact `selection` match — e.g. an
   *  action row whose currently-selected param is a descendant field, not itself. */
  forceSelected?: boolean;
  /** Stacks content vertically instead of the default inline row (multi-control rows, e.g. case lists). */
  block?: boolean;
  /** Tier-3 only: collapsed one-line recursive summary shown while not expanded. */
  summary?: ReactNode;
  /** Tier-3 only: when set (or when the row has a `label` to fall back on),
   *  auto-renders a `⤢` action that opens a `FieldDrawer` hosting the same
   *  `children` at full width. While open, the inline row shows the `summary`
   *  (not the live editor) so only one editor instance is mounted. A row with
   *  neither keeps the chevron alone. */
  drawerTitle?: string;
  /** Tier-3 only: short kind name (e.g. "If Condition", "Open Dialog") shown
   *  inline beside the badge while expanded, in the same content slot `summary`
   *  occupies while collapsed — mirrors the sandbox's `KIND_LABELS[f.kind]`. */
  kindLabel?: ReactNode;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** Tier-1/2 inline control, or tier-3 nested `FieldGroup` tree. */
  children: ReactNode;
}

export default function FieldGroup({
  label,
  description,
  tier,
  selection,
  sourceless,
  badge,
  actions,
  headerActions,
  diagnostic,
  forceSelected,
  block,
  summary,
  drawerTitle,
  kindLabel,
  defaultExpanded,
  expanded: expandedProp,
  onExpandedChange,
  children,
}: Props) {
  const isError = diagnostic?.level === 'error';
  const isWarning = !isError && diagnostic?.level === 'warning';
  // A nested diagnostic (the empty/wrong value lives inside a composite
  // sub-slot, not this field's own top-level value) marks the badge dot only
  // — the text underline stays reserved for the box that owns the value.
  const showFullMark = (isError || isWarning) && !diagnostic?.nested;

  // Identity/appearance props a drawer copy of this field must mirror exactly
  // (collected once so the drawer instance below can't drift from the inline one).
  const sharedProps = {
    label,
    description,
    tier,
    selection,
    sourceless,
    diagnostic,
    forceSelected,
    block,
    badge,
    headerActions,
    kindLabel,
  };
  const { isSelected, onSelect } = useParamSelection(
    selection?.path,
    selection?.schema ?? EMPTY_SCHEMA,
  );
  // Session-scoped expand memory: keyed by panel scope + this field's identity
  // so the open/closed state survives switching between components (but resets
  // on reload). Falls back to local state when the field has no stable identity.
  const scope = useContext(PanelScopeContext);
  const parentPath = useContext(FieldPathContext);
  const identity = selection ? selection.path.join('/') : label;
  const storeKey = tier === 3 && identity != null ? `${scope}::${identity}` : undefined;
  const [storedExpanded, setStoredExpanded] = usePanelFieldExpanded(storeKey);
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded ?? false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [actionsEl, setActionsEl] = useState<HTMLDivElement | null>(null);
  const [headerEl, setHeaderEl] = useState<HTMLDivElement | null>(null);
  // An unlabelled group has no title row of its own, so it passes the labelled
  // ancestor's slot straight through instead of shadowing it with null — a list
  // editor nested under one still lands on the nearest real title row.
  const inheritedHeaderEl = useContext(FieldHeaderSlotContext);
  const expanded =
    expandedProp ??
    (storeKey ? (storedExpanded ?? defaultExpanded ?? false) : uncontrolledExpanded);
  const selected = (selection ? isSelected : false) || !!forceSelected;
  const contentRef = useRef<HTMLDivElement>(null);

  function setExpanded(next: boolean) {
    if (expandedProp === undefined) {
      if (storeKey) setStoredExpanded(next);
      else setUncontrolledExpanded(next);
    }
    onExpandedChange?.(next);
  }

  function activate() {
    if (tier === 3) {
      setExpanded(!expanded);
      return;
    }
    // Discover the tier-1/2 control rendered into the content slot rather than
    // requiring callers to wire up a ref — FieldActions already portals
    // trailing buttons out of this slot, so the first input/select/textarea/
    // button found here is the real control.
    contentRef.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
  }

  function handleRowMouseDown(e: MouseEvent) {
    if (selection && !selected) {
      // Selecting a different field must dismiss any in-progress text edit on
      // the previously-selected field — blurring it commits/closes it (its
      // onBlur fires) instead of leaving a stranded active input. preventDefault
      // below then blocks focus-on-mousedown for click-1 so an inner editable
      // control doesn't become the active element — keeps detectCopyPasteKey()
      // seeing a non-editable target right after selecting, so Ctrl+C still
      // copies the param.
      const active = document.activeElement;
      if (active instanceof HTMLElement && !e.currentTarget.contains(active)) {
        active.blur();
      }
      e.preventDefault();
    }
  }

  function handleRowClick(e: MouseEvent) {
    e.stopPropagation();
    if (!selection) {
      activate();
      return;
    }
    if (!selected) {
      onSelect(e);
      return;
    }
    activate();
  }

  const groupClassName = [
    'cfg-field-group',
    `cfg-field-group--tier${tier}`,
    selected ? 'cfg-field-group--selected' : '',
    sourceless ? 'cfg-field-group--sourceless' : '',
    showFullMark && isError ? 'cfg-field-group--invalid' : '',
    showFullMark && isWarning ? 'cfg-field-group--warning' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const showBadge = !sourceless && badge != null;
  const showNest = tier === 3 && expanded;

  // Every collapsable (tier-3) field carries a chevron that toggles the inline
  // nest, plus — for the fields that name a drawer — a button that pops the
  // whole editor out at full width. Drawer title falls back to the field label
  // (e.g. action rows have no explicit drawerTitle); a row with neither
  // (a `$switch` case) gets the chevron only.
  const resolvedDrawerTitle = drawerTitle ?? label ?? '';
  const pathSegment =
    resolvedDrawerTitle || (typeof kindLabel === 'string' ? kindLabel : undefined);
  const fullPath = pathSegment ? [...parentPath, pathSegment] : parentPath;
  const drawerHeaderTitle = fullPath.length > 0 ? fullPath.join(' › ') : resolvedDrawerTitle;
  const chevronButton =
    tier === 3 ? (
      <button
        type="button"
        className={`cfg-row-action-btn cfg-row-action-btn--stretch cfg-row-action-btn--chevron${
          expanded ? ' is-open' : ''
        }`}
        title={expanded ? 'Collapse' : 'Expand'}
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(!expanded);
        }}
      >
        <ChevronIcon />
      </button>
    ) : null;
  const drawerButton =
    tier === 3 && resolvedDrawerTitle ? (
      <button
        type="button"
        className="cfg-row-action-btn cfg-row-action-btn--stretch"
        title="Expand in drawer"
        onClick={(e) => {
          e.stopPropagation();
          setDrawerOpen(true);
        }}
      >
        <ExpandIcon />
      </button>
    ) : null;
  const rowActions =
    chevronButton || drawerButton || actions ? (
      <>
        {chevronButton}
        {drawerButton}
        {actions}
      </>
    ) : null;

  return (
    <FieldActionsSlotContext.Provider value={actionsEl}>
      <FieldHeaderSlotContext.Provider value={label ? headerEl : inheritedHeaderEl}>
        <FieldPathContext.Provider value={fullPath}>
          <div className={groupClassName}>
            {label && (
              <div className="cfg-field-group__header">
                <div className="cfg-field-group__label">{label}</div>
                {/* Always rendered so a descendant list editor can portal its add
                  control here; hidden via CSS (`:empty`) when nothing lands. */}
                <div className="cfg-field-group__header-actions" ref={setHeaderEl}>
                  {headerActions}
                </div>
              </div>
            )}
            {description && <p className="cfg-field-group__desc">{description}</p>}
            <div className="cfg-field-group__box">
              <div
                className={`cfg-field-group__row${block ? ' cfg-field-group__row--block' : ''}`}
                onMouseDown={handleRowMouseDown}
                onClick={handleRowClick}
              >
                {showBadge && (
                  <span
                    className={`cfg-field-group__badge${
                      isError
                        ? ' cfg-field-group__badge--invalid'
                        : isWarning
                          ? ' cfg-field-group__badge--warning'
                          : ''
                    }`}
                    title={diagnostic?.message}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {badge}
                  </span>
                )}
                <div className="cfg-field-group__content" ref={contentRef}>
                  {tier === 3 ? (expanded ? kindLabel : summary) : children}
                </div>
                {/* Always rendered so descendant leaf editors can portal their own
                buttons here; hidden via CSS (`:empty`) when nothing lands in it. */}
                <div
                  className="cfg-field-group__actions"
                  ref={setActionsEl}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                  {rowActions}
                </div>
              </div>
              {/* While the drawer hosts the live editor, keep the inline body as the
              collapsed summary so only one editor instance is mounted at a time. */}
              {showNest && (
                <div className="cfg-field-group__nest">{drawerOpen ? summary : children}</div>
              )}
            </div>
            {drawerOpen && tier === 3 && (
              <FieldDrawer title={drawerHeaderTitle} onClose={() => setDrawerOpen(false)}>
                {/* Distinct scope so the drawer copy's expand state never collides
                  with the inline field's session key (drawer always opens expanded). */}
                <PanelScopeContext.Provider value={`${scope}::drawer`}>
                  <FieldGroup {...sharedProps} defaultExpanded>
                    {children}
                  </FieldGroup>
                </PanelScopeContext.Provider>
              </FieldDrawer>
            )}
          </div>
        </FieldPathContext.Provider>
      </FieldHeaderSlotContext.Provider>
    </FieldActionsSlotContext.Provider>
  );
}
