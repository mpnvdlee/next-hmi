/**
 * PropertiesPanel — right panel of /editor.
 *
 * Auto-generates a form from the selected component's schema (Phase 12.1)
 * and layout sub-panel (Phase 12.2).
 *
 * All field changes update configStore immediately so the live preview
 * reflects them at once. Backend persist is debounced 300 ms (Phase 12.3).
 *
 * The "Change…" button for variable/struct fields opens the
 * VariableBindingPicker overlay (Phase 13).
 *
 * Style: zero style={} props. All classes are cfg-prop-* or editor-props-*.
 */

import { useContext, useEffect, useMemo, useRef } from 'react';
import { FieldPathContext } from '../../ui/FieldGroup/fieldPathContext';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useConfigStore } from '@shared/store/configStore';
import { findWidgetsByIds } from '@shared/store/configStoreHelpers';
import { widgetRegistry } from '@hmi/registry/widgetRegistry';
import {
  copyPropertyValue,
  pastePropertyValue,
  pasteActionValue,
} from '@config/components/ui/SchemaFieldRow/clipboardOps';
import { getAtPath, setAtPath, LAYOUT_PATH_KEY } from '@config/utils/propertyPath';
import type { RequiredFieldEntry, SchemaField } from '@shared/types/widgetSchema';
import type {
  PageConfig,
  PageGroupConfig,
  WidgetConfig,
  LayoutConfig,
  DialogConfig,
  GlobalEventsConfig,
  ActionsConfig,
  ShellConfig,
  ShellRegionConfig,
  ShellRegionId,
  LockedFeedback,
} from '@shared/types/config';
import { LOCKED_FEEDBACK_MODES } from '@shared/types/config';
import PanelHeader from '../../ui/PanelHeader';
import PropRow from '../../ui/PropRow';
import PathInputField from '../../ui/PathInputField';
import GroupsField from '../../ui/GroupsField';
import TextField from '../../ui/TextField';
import { LengthField } from '@config/utils/LengthField';
import { groupSchemaKeys } from '@config/utils/schemaGroups';
import { varBindingOf } from '../bindingPickerUtils';
import CollapsibleSection from '../../ui/CollapsibleSection';
import BoolButtonGroup from '../../ui/BoolButtonGroup';
import Select from '../../ui/Select';
import SchemaFieldRow from '../../ui/SchemaFieldRow';
import {
  findComponentById,
  findContainerComps,
  findInPages,
  flattenComponents,
} from '@shared/utils/widgetTree';
import { findOwningPage, findPageById, resolvePageTitle } from '@shared/utils/pageTree';
import { usePanelDiagnostics, type DiagnosticsArtifact } from '@config/hooks/usePanelDiagnostics';
import { isBuiltinIconId } from '@shared/utils/phosphorIcons';
import { getEdition } from '@shared/utils/runtimeBase';
import WidgetIcon from '../../ui/WidgetIcon';
import ActionsInput from './ActionsInput';
import PanelDiagnosticsBanner from './PanelDiagnosticsBanner';
import MultiComponentPanel from './MultiComponentPanel';
import { classifySelection } from '@config/store/domains/selectionScope';
import ColorInput from '../ColorInput';
import ComponentPropertiesEditor from '../../componentProperties/ComponentPropertiesEditor';
import { ComponentPropertySchemaContext } from '../PropertySourceEditor/componentPropertySchemaContext';

import { LayoutFields } from '../../ui/LayoutFields';
import { CONTAINER_DEFAULT_TOKENS } from '../../ui/LayoutFields/containerDefaultTokens';
import { parseTokenVar, usePanelTokenValues } from '@shared/utils/themeDefaultHint';
import { WidgetOptionsContext } from '../WidgetOptionsContext';
import type { ComponentOption } from '../WidgetOptionsContext';
import { SOURCE_CAPABLE_TYPES } from '@hmi/utils/propertySourceRules';
import { primaryType } from '@shared/utils/valueTypes';
import { PanelScopeContext } from '@config/store/panelExpansionStore';
import { useFieldDiagnostic } from '@config/hooks/usePanelDiagnostics';
import { detectCopyPasteKey } from '@shared/utils/domEvent';
import { EDITOR_NODE_IDS } from '@shared/constants/editorSentinels';

const SECTION_IDS = new Set<string>([EDITOR_NODE_IDS.PAGES, EDITOR_NODE_IDS.DIALOGS]);

const SHELL_REGION_IDS: ShellRegionId[] = ['header', 'leftSidebar', 'rightSidebar', 'footer'];

const SHELL_OVERRIDE_LABELS: Record<ShellRegionId, string> = {
  header: 'Header',
  leftSidebar: 'Left sidebar',
  rightSidebar: 'Right sidebar',
  footer: 'Footer',
};

/** Free-text asset path with the standard edit/clear affordances, so a URL stays
 *  typable without a bespoke button row. */
function AssetPathField({
  value,
  placeholder,
  onChange,
  onBrowse,
}: {
  value: string;
  placeholder: string;
  onChange: (v: string | undefined) => void;
  onBrowse: () => void;
}) {
  return (
    <PathInputField
      value={value}
      placeholder={placeholder}
      titleFromDraft
      onCommit={(text) => {
        const next = text.trim();
        if (next !== value) onChange(next || undefined);
      }}
      pickTitle="Pick image"
      onPick={onBrowse}
      onClear={value ? () => onChange(undefined) : undefined}
    />
  );
}

const SHELL_AREA_PANELS: Record<string, { id: ShellRegionId; label: string }> = {
  [EDITOR_NODE_IDS.HEADER]: { id: 'header', label: 'Header' },
  [EDITOR_NODE_IDS.FOOTER]: { id: 'footer', label: 'Footer' },
  [EDITOR_NODE_IDS.LEFT_SIDEBAR]: { id: 'leftSidebar', label: 'Left sidebar' },
  [EDITOR_NODE_IDS.RIGHT_SIDEBAR]: { id: 'rightSidebar', label: 'Right sidebar' },
};

type CopyPasteHandler = (key: 'c' | 'v', sel: { path: string[]; schema: SchemaField }) => void;

function useCopyPasteShortcut(handle: CopyPasteHandler) {
  const selectedParam = useEditorDomainStore((s) => s.selectedParam);
  const setSelectedParam = useEditorDomainStore((s) => s.setSelectedParam);
  const handleRef = useRef(handle);
  handleRef.current = handle;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setSelectedParam(null);
        return;
      }
      if (!selectedParam) return;
      const key = detectCopyPasteKey(e);
      // A property value has no cut — only copy and paste.
      if (key !== 'c' && key !== 'v') return;
      if (selectedParam.path.length === 0) return;
      e.preventDefault();
      handleRef.current(key, selectedParam);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedParam, setSelectedParam]);
}

/** Candidate struct-field keys for a component's struct exports, taken from a
 *  `columns` property (the grid convention: each column's `value` is a row
 *  field). These populate the field tree under a `Struct` export. */
function deriveStructFields(properties: Record<string, unknown> | undefined): string[] {
  const columns = properties?.columns;
  if (!Array.isArray(columns)) return [];
  const fields: string[] = [];
  for (const col of columns) {
    const value =
      col && typeof col === 'object' ? (col as Record<string, unknown>).value : undefined;
    if (typeof value === 'string' && value && !fields.includes(value)) fields.push(value);
  }
  return fields;
}

function buildComponentOptions(containerComps: WidgetConfig[]): ComponentOption[] {
  return flattenComponents(containerComps).flatMap((c) => {
    const entry = widgetRegistry[c.type];
    if (!entry?.exportedProperties?.length) return [];
    return [
      {
        id: c.id,
        name: c.name,
        type: c.type,
        exportedProperties: entry.exportedProperties,
        structFields: deriveStructFields(c.properties),
      },
    ];
  });
}

// ── PropertiesPanel (root component) ─────────────────────────────────────────

/** The banner sits above every panel body rather than inside each branch of
 *  them — it reports on the open *artifact*, which is the same whichever of
 *  its nodes happens to be selected. */
export default function PropertiesPanel() {
  return (
    <>
      <PanelDiagnosticsBanner />
      <PropertiesPanelBody />
    </>
  );
}

function PropertiesPanelBody() {
  const selectedId = useEditorDomainStore((s) => s.selectedId);
  const selectedIds = useEditorDomainStore((s) => s.selectedIds);
  const pages = useConfigStore((s) => s.pages);
  const header = useConfigStore((s) => s.header);
  const footer = useConfigStore((s) => s.footer);
  const leftSidebar = useConfigStore((s) => s.leftSidebar);
  const rightSidebar = useConfigStore((s) => s.rightSidebar);
  const dialogs = useConfigStore((s) => s.dialogs);
  const structureRev = useConfigStore((s) => s.structureRev);
  const shell = useConfigStore((s) => s.shell);
  const globalEvents = useConfigStore((s) => s.globalEvents);
  const updateComponent = useConfigStore((s) => s.updateComponent);
  const updateComponents = useConfigStore((s) => s.updateComponents);
  const updatePage = useConfigStore((s) => s.updatePage);
  const updatePageGroup = useConfigStore((s) => s.updatePageGroup);
  const renameDialog = useConfigStore((s) => s.renameDialog);

  // Realtime build diagnostics for whichever artifact `selectedId` currently
  // resolves to — mirrors the branching below, but must run unconditionally
  // (before the early returns) since it's a hook.
  const shellDraft = useMemo(
    () => ({ header, footer, leftSidebar, rightSidebar, shell }),
    [header, footer, leftSidebar, rightSidebar, shell],
  );
  // Reuses the previous {kind, draft} wrapper when both are unchanged, so an
  // unrelated store update (e.g. editing a different page while this dialog's
  // panel is open) doesn't allocate a new object and re-trigger
  // usePanelDiagnostics' effect (keyed on referential identity) for content
  // that didn't actually change.
  const diagnosticsArtifactRef = useRef<DiagnosticsArtifact | null>(null);
  const diagnosticsArtifact = useMemo<DiagnosticsArtifact | null>(() => {
    let next: DiagnosticsArtifact | null = null;
    if (selectedId) {
      if (selectedId === EDITOR_NODE_IDS.EVENTS) {
        next = { kind: 'globalEvents', id: 'globalEvents', draft: globalEvents };
      } else if (SHELL_AREA_PANELS[selectedId]) {
        next = { kind: 'shell', id: 'shell', draft: shellDraft };
      } else {
        const dialog = dialogs.find(
          (d) => d.id === selectedId || findComponentById(d.widgets, selectedId),
        );
        if (dialog) {
          next = { kind: 'dialog', id: dialog.id, draft: dialog };
        } else if (
          findComponentById(header, selectedId) ||
          findComponentById(footer, selectedId) ||
          findComponentById(leftSidebar, selectedId) ||
          findComponentById(rightSidebar, selectedId)
        ) {
          next = { kind: 'shell', id: 'shell', draft: shellDraft };
        } else {
          const owningPage = findPageById(pages, selectedId) ?? findOwningPage(pages, selectedId);
          if (owningPage) next = { kind: 'page', id: owningPage.id, draft: owningPage };
        }
      }
    }
    const prev = diagnosticsArtifactRef.current;
    const stable =
      prev && next && prev.kind === next.kind && prev.id === next.id && prev.draft === next.draft
        ? prev
        : next;
    diagnosticsArtifactRef.current = stable;
    return stable;
  }, [
    selectedId,
    dialogs,
    header,
    footer,
    leftSidebar,
    rightSidebar,
    pages,
    globalEvents,
    shellDraft,
  ]);
  usePanelDiagnostics(diagnosticsArtifact);

  const headerOptions = useMemo(() => buildComponentOptions(header), [header]);
  const footerOptions = useMemo(() => buildComponentOptions(footer), [footer]);
  const leftSidebarOptions = useMemo(() => buildComponentOptions(leftSidebar), [leftSidebar]);
  const rightSidebarOptions = useMemo(() => buildComponentOptions(rightSidebar), [rightSidebar]);
  const pageOptions = useMemo(
    () => (selectedId ? buildComponentOptions(findContainerComps(pages, selectedId)) : []),
    [pages, selectedId],
  );

  const areas = useMemo(
    () => ({ pages, header, footer, leftSidebar, rightSidebar, dialogs }),
    [pages, header, footer, leftSidebar, rightSidebar, dialogs],
  );
  // Read through a ref so the walk always sees the current tree while depending only
  // on what can change its answer.
  const areasRef = useRef(areas);
  areasRef.current = areas;

  // Two or more ids can name anything the tree shows, so they are resolved against the
  // project before the panel knows which branch to take. Only the *shape* of the tree
  // decides that answer, so the walk repeats on `structureRev` rather than on every
  // store change — a property write replaces every widget object without moving one,
  // and re-walking the project per keystroke is what this avoids. Only the
  // single-selection case is spared entirely: the branches below resolve their one id
  // directly.
  const multiScope = useMemo(
    () => (selectedIds.length > 1 ? classifySelection(selectedIds, areasRef.current) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- structureRev stands for the tree the ref reads
    [selectedIds, structureRev],
  );

  // `comps` are the widget objects the rows read their values from, and one write
  // replaces all of them (configStore's `updateComponents` maps every area), so they
  // are re-resolved on every store change — a set cached across a write would keep
  // showing pre-edit values. Resolving is also the liveness check on the memo above:
  // an id that has left the tree without a `structureRev` bump (a raw `setState`, say)
  // shows up here as a miss, and the panel reports a mixed selection instead of
  // editing a widget that is gone.
  const multiComps = useMemo(() => {
    if (multiScope?.kind !== 'multi-widget') return null;
    const found = findWidgetsByIds(areas, new Set(multiScope.ids));
    if (found.size !== multiScope.ids.length) return null;
    return multiScope.ids.map((id) => found.get(id) as WidgetConfig);
  }, [multiScope, areas]);

  if (selectedId === EDITOR_NODE_IDS.SETTINGS) {
    return <SettingsPanel />;
  }

  if (selectedId === EDITOR_NODE_IDS.EVENTS) {
    return <GlobalEventsPanel />;
  }

  if (selectedId && SHELL_AREA_PANELS[selectedId]) {
    return <ShellAreaPanel {...SHELL_AREA_PANELS[selectedId]} nodeId={selectedId} />;
  }

  if (multiScope?.kind === 'multi-widget' && multiComps) {
    return (
      <WidgetOptionsContext.Provider value={pageOptions}>
        <MultiComponentPanel comps={multiComps} updateComponents={updateComponents} />
      </WidgetOptionsContext.Provider>
    );
  }
  if (multiScope?.kind === 'multi-widget' || multiScope?.kind === 'multi-mixed') {
    return (
      <div className="cfg-panel-empty">
        {multiScope.ids.length} items selected — select components to edit them together.
      </div>
    );
  }

  if (!selectedId || SECTION_IDS.has(selectedId)) {
    return (
      <div className="cfg-panel-empty">Select a component or page to edit its properties.</div>
    );
  }

  // Dialog by id
  const dialog = dialogs.find((p) => p.id === selectedId);
  if (dialog) {
    return <DialogPanel dialog={dialog} onRename={(title) => renameDialog(dialog.id, title)} />;
  }

  // Pages / components inside pages
  const { page, pageGroup, comp: pageComp } = findInPages(pages, selectedId);
  if (page) {
    return <PagePanel page={page} onRename={(title) => updatePage(page.id, { title })} />;
  }
  if (pageGroup) {
    return (
      <PageGroupPanel
        pageGroup={pageGroup}
        onRename={(title) => updatePageGroup(pageGroup.id, { title })}
      />
    );
  }
  if (pageComp) {
    return (
      <WidgetOptionsContext.Provider value={pageOptions}>
        <ComponentPanel key={pageComp.id} comp={pageComp} updateComponent={updateComponent} />
      </WidgetOptionsContext.Provider>
    );
  }

  // Components inside header
  const headerComp = findComponentById(header, selectedId);
  if (headerComp) {
    return (
      <WidgetOptionsContext.Provider value={headerOptions}>
        <ComponentPanel key={headerComp.id} comp={headerComp} updateComponent={updateComponent} />
      </WidgetOptionsContext.Provider>
    );
  }

  // Components inside footer
  const footerComp = findComponentById(footer, selectedId);
  if (footerComp) {
    return (
      <WidgetOptionsContext.Provider value={footerOptions}>
        <ComponentPanel key={footerComp.id} comp={footerComp} updateComponent={updateComponent} />
      </WidgetOptionsContext.Provider>
    );
  }

  // Components inside left sidebar
  const leftSidebarComp = findComponentById(leftSidebar, selectedId);
  if (leftSidebarComp) {
    return (
      <WidgetOptionsContext.Provider value={leftSidebarOptions}>
        <ComponentPanel
          key={leftSidebarComp.id}
          comp={leftSidebarComp}
          updateComponent={updateComponent}
        />
      </WidgetOptionsContext.Provider>
    );
  }

  // Components inside right sidebar
  const rightSidebarComp = findComponentById(rightSidebar, selectedId);
  if (rightSidebarComp) {
    return (
      <WidgetOptionsContext.Provider value={rightSidebarOptions}>
        <ComponentPanel
          key={rightSidebarComp.id}
          comp={rightSidebarComp}
          updateComponent={updateComponent}
        />
      </WidgetOptionsContext.Provider>
    );
  }

  // Components inside dialogs
  for (const p of dialogs) {
    const comp = findComponentById(p.widgets, selectedId);
    if (comp) {
      return <DialogComponentPanel dialog={p} comp={comp} updateComponent={updateComponent} />;
    }
  }

  return <div className="cfg-panel-empty">Component not found.</div>;
}

function DialogComponentPanel({
  dialog,
  comp,
  updateComponent,
}: {
  dialog: DialogConfig;
  comp: WidgetConfig;
  updateComponent: (id: string, patch: Patch) => void;
}) {
  const options = useMemo(() => buildComponentOptions(dialog.widgets), [dialog.widgets]);
  const componentPropertySchemaValue = useMemo(
    () => ({ properties: dialog.componentProperties ?? {} }),
    [dialog.componentProperties],
  );
  return (
    <WidgetOptionsContext.Provider value={options}>
      <ComponentPropertySchemaContext.Provider value={componentPropertySchemaValue}>
        <FieldPathContext.Provider value={[dialog.title]}>
          <ComponentPanel key={comp.id} comp={comp} updateComponent={updateComponent} />
        </FieldPathContext.Provider>
      </ComponentPropertySchemaContext.Provider>
    </WidgetOptionsContext.Provider>
  );
}

// ── DialogPanel ───────────────────────────────────────────────────────────────

function DialogPanel({
  dialog,
  onRename,
}: {
  dialog: DialogConfig;
  onRename: (t: string) => void;
}) {
  const updateDialog = useConfigStore((s) => s.updateDialog);

  return (
    <FieldPathContext.Provider value={[dialog.title]}>
      <PanelHeader kind="Dialog" name={dialog.title} />
      <div className="cfg-section">
        <div className="cfg-section__title">Dialog</div>
        <PropRow label="Title" sourceless>
          <TextField value={dialog.title} onCommit={onRename} />
        </PropRow>
        <PropRow label="Close on backdrop">
          <BoolButtonGroup
            value={dialog.closeOnBackgroundPress ?? false}
            onChange={(v) => updateDialog(dialog.id, { closeOnBackgroundPress: v })}
          />
        </PropRow>
        <PropRow label="Show close button">
          <BoolButtonGroup
            value={dialog.showCloseButton ?? false}
            onChange={(v) => updateDialog(dialog.id, { showCloseButton: v })}
            labels={['Show', 'Hide']}
          />
        </PropRow>
      </div>
      <ComponentPropertiesEditor
        ownerName={dialog.title}
        properties={dialog.componentProperties ?? {}}
        onChange={(next) => updateDialog(dialog.id, { componentProperties: next })}
      />
    </FieldPathContext.Provider>
  );
}

// ── PagePanel ────────────────────────────────────────────────────────────────

const PAGE_TITLE_SCHEMA: SchemaField = {
  type: 'String',
  label: 'Title',
};

function PagePanel({ page, onRename }: { page: PageConfig; onRename: (t: string) => void }) {
  const updatePage = useConfigStore((s) => s.updatePage);
  const setPageSections = useConfigStore((s) => s.setPageSections);

  const pageRef = useRef(page);
  pageRef.current = page;

  useCopyPasteShortcut((key, { path, schema: targetSchema }) => {
    const topKey = path[0];
    const label = targetSchema.label || topKey;

    if (topKey === '__title__') {
      if (key === 'c') {
        void copyPropertyValue(pageRef.current.title, label);
      } else {
        void pastePropertyValue(targetSchema, label, (v) => onRename(String(v ?? '')));
      }
    }
  });

  function toggleSection(which: 'header' | 'footer', enabled: boolean) {
    if (!enabled) {
      const current = pageRef.current.sections[which] ?? [];
      if (current.length > 0) {
        setPageSections(pageRef.current.id, {
          ...pageRef.current.sections,
          content: [...(pageRef.current.sections.content ?? []), ...current],
          [which]: [],
        });
      }
    }
    updatePage(
      pageRef.current.id,
      which === 'header' ? { showHeader: enabled } : { showFooter: enabled },
    );
  }

  return (
    // The page owns its shellOverride findings — the backend stamps the page id
    // as their owner, since the override is edited here and not in the
    // project-wide Shell area panel (see `_synthetic_owner`).
    <PanelScopeContext.Provider value={page.id}>
      <FieldPathContext.Provider value={[resolvePageTitle(page.title)]}>
        <PanelHeader kind="Page" name={resolvePageTitle(page.title)} />
        <div className="cfg-section">
          <div className="cfg-section__title">Page</div>
          <SchemaFieldRow
            propKey="__title__"
            schema={PAGE_TITLE_SCHEMA}
            sourceless
            value={page.title}
            onChange={(v) => onRename(v as string)}
          />
        </div>
        <div className="cfg-section">
          <div className="cfg-section__title">Layout</div>
          <PropRow label="Show header">
            <BoolButtonGroup
              value={page.showHeader ?? false}
              onChange={(v) => toggleSection('header', v)}
              labels={['Show', 'Hide']}
            />
          </PropRow>
          <PropRow label="Show footer">
            <BoolButtonGroup
              value={page.showFooter ?? false}
              onChange={(v) => toggleSection('footer', v)}
              labels={['Show', 'Hide']}
            />
          </PropRow>
        </div>
        <PageMetadataSection node={page} onPatch={(patch) => updatePage(page.id, patch)} />
        <MainSection node={page} onPatch={(patch) => updatePage(page.id, patch)} />
        <PageShellOverrideSection
          override={page.shellOverride ?? {}}
          onPatch={(patch) => updatePage(page.id, { shellOverride: patch })}
        />
      </FieldPathContext.Provider>
    </PanelScopeContext.Provider>
  );
}

function MainSection({
  node,
  onPatch,
}: {
  node: { mainPadding?: string; mainBackground?: string };
  onPatch: (patch: { mainPadding?: string; mainBackground?: string }) => void;
}) {
  return (
    <div className="cfg-section">
      <div className="cfg-section__title">Main</div>
      <PropRow label="Padding">
        <LengthField
          value={node.mainPadding ?? ''}
          defaultText="0"
          onChange={(v) => onPatch({ mainPadding: (v as string | undefined) || undefined })}
        />
      </PropRow>
      <PropRow label="Background">
        <ColorInput value={node.mainBackground} onChange={(v) => onPatch({ mainBackground: v })} />
      </PropRow>
    </div>
  );
}

function PageShellOverrideSection({
  override,
  onPatch,
}: {
  override: Partial<ShellConfig>;
  onPatch: (next: Partial<ShellConfig> | undefined) => void;
}) {
  function patchRegion(id: ShellRegionId, regionPatch: Partial<ShellRegionConfig> | undefined) {
    const current = override[id] ?? {};
    const next: ShellRegionConfig = regionPatch ? { ...current, ...regionPatch } : {};
    // Drop the region key entirely when its patch ends up empty so the
    // saved config stays minimal.
    const cleaned: ShellRegionConfig = Object.fromEntries(
      Object.entries(next).filter(([, v]) => v !== undefined),
    ) as ShellRegionConfig;
    const merged: Partial<ShellConfig> = { ...override };
    if (Object.keys(cleaned).length === 0) delete merged[id];
    else merged[id] = cleaned;
    onPatch(Object.keys(merged).length === 0 ? undefined : merged);
  }

  // One collapsed section per region rather than a flat list: the same field
  // set as the Shell area panel, four times over, would bury the rest of the
  // page panel. Collapsed, an overridden region still reads as such from its
  // title.
  return (
    <>
      {SHELL_REGION_IDS.map((id) => (
        <CollapsibleSection
          key={id}
          title={`${SHELL_OVERRIDE_LABELS[id]} (this page only)`}
          defaultCollapsed
        >
          <ShellRegionFields
            id={id}
            config={override[id] ?? {}}
            onPatch={(patch) => patchRegion(id, patch)}
            pathPrefix={[id]}
            inheritable
          />
        </CollapsibleSection>
      ))}
    </>
  );
}

function PageMetadataSection({
  node,
  onPatch,
}: {
  node: {
    icon?: string;
    description?: string;
    breadcrumbLabel?: string;
    hidden?: boolean;
    role?: string[];
    order?: number;
  };
  onPatch: (patch: Record<string, unknown>) => void;
}) {
  const openAssetPicker = useEditorDomainStore((s) => s.openAssetPicker);
  const iconId = node.icon;
  const isValidIcon = !iconId || isBuiltinIconId(iconId);

  function pickIcon() {
    openAssetPicker(
      'icon',
      (icon) => {
        if (icon.type === 'builtin' && icon.name) onPatch({ icon: icon.name });
      },
      'Icon',
    );
  }

  return (
    <div className="cfg-section">
      <div className="cfg-section__title">Metadata</div>
      <PropRow
        label="Icon"
        diagnostic={
          isValidIcon ? undefined : { level: 'error', message: `Unknown icon name '${iconId}'` }
        }
      >
        <PathInputField
          value={iconId ?? ''}
          placeholder="Icon name (e.g. gear)"
          onCommit={(text) => {
            const name = text.trim();
            if (name === (iconId ?? '')) return;
            onPatch({ icon: name || undefined });
          }}
          onPick={pickIcon}
          pickTitle="Browse icons"
          onClear={iconId ? () => onPatch({ icon: undefined }) : undefined}
        />
      </PropRow>
      <PropRow label="Description" sourceless>
        <TextField
          value={node.description ?? ''}
          rows={3}
          onCommit={(text) => onPatch({ description: text || undefined })}
          placeholder="Long-form description (used for tooltips, search)"
        />
      </PropRow>
      <PropRow label="Breadcrumb label">
        <TextField
          value={node.breadcrumbLabel ?? ''}
          onCommit={(text) => onPatch({ breadcrumbLabel: text || undefined })}
          placeholder="(defaults to title)"
        />
      </PropRow>
      <PropRow label="Hidden in menu">
        <BoolButtonGroup
          value={node.hidden === true}
          onChange={(v) => onPatch({ hidden: v || undefined })}
        />
      </PropRow>
      <GroupsField
        label="Visible to"
        description="Empty → visible to all users."
        value={node.role}
        onChange={(v) => onPatch({ role: Array.isArray(v) && v.length > 0 ? v : undefined })}
      />
      <PropRow label="Order">
        <TextField
          value={typeof node.order === 'number' ? String(node.order) : ''}
          type="number"
          step={1}
          onCommit={(text) => {
            if (text === '') onPatch({ order: undefined });
            else {
              const n = parseFloat(text);
              onPatch({ order: Number.isFinite(n) ? n : undefined });
            }
          }}
          placeholder="(insertion order)"
        />
      </PropRow>
    </div>
  );
}

function PageGroupPanel({
  pageGroup,
  onRename,
}: {
  pageGroup: PageGroupConfig;
  onRename: (t: string) => void;
}) {
  const updatePageGroup = useConfigStore((s) => s.updatePageGroup);

  return (
    <FieldPathContext.Provider value={[resolvePageTitle(pageGroup.title)]}>
      <PanelHeader kind="Page Group" name={resolvePageTitle(pageGroup.title)} />
      <div className="cfg-section">
        <div className="cfg-section__title">Page Group</div>
        <SchemaFieldRow
          propKey="__title__"
          schema={PAGE_TITLE_SCHEMA}
          sourceless
          value={pageGroup.title}
          onChange={(v) => onRename(v as string)}
        />
        <PropRow label="Show child pages in menu">
          <BoolButtonGroup
            value={pageGroup.showChildPagesInMenu === true}
            onChange={(v) => updatePageGroup(pageGroup.id, { showChildPagesInMenu: v })}
            labels={['Show', 'Hide']}
          />
        </PropRow>
      </div>
      <PageMetadataSection
        node={pageGroup}
        onPatch={(patch) => updatePageGroup(pageGroup.id, patch)}
      />
      <MainSection node={pageGroup} onPatch={(patch) => updatePageGroup(pageGroup.id, patch)} />
    </FieldPathContext.Provider>
  );
}

// ── ComponentPanel ────────────────────────────────────────────────────────────

type Patch = {
  name?: string;
  properties?: Record<string, unknown>;
  layout?: Partial<LayoutConfig>;
};

const NAME_SCHEMA: SchemaField = { type: 'String', label: 'Name' };

function ComponentPanel({
  comp,
  updateComponent,
}: {
  comp: WidgetConfig;
  updateComponent: (id: string, patch: Patch) => void;
}) {
  const openBindingPicker = useEditorDomainStore((s) => s.openBindingPicker);

  const entry = widgetRegistry[comp.type];
  const schema = entry?.schema ?? {};
  const schemaKeys = Object.keys(schema);
  const schemaGroups = groupSchemaKeys(schema);
  const isContainer = comp.type === 'Container';
  const layout = comp.layout ?? {};
  const props = comp.properties ?? {};

  // One getComputedStyle read for every themed default this panel's fields
  // (properties + layout) might show, instead of one per field.
  const tokenValues = usePanelTokenValues([
    ...schemaKeys.map((k) => parseTokenVar(schema[k].defaultValue)),
    ...schemaKeys.map((k) => schema[k].defaultToken),
    ...(isContainer ? Object.values(CONTAINER_DEFAULT_TOKENS) : []),
  ]);

  function patchProp(key: string, value: unknown) {
    updateComponent(comp.id, { properties: { [key]: value } });
  }
  function patchLayout(patch: Partial<LayoutConfig>) {
    updateComponent(comp.id, { layout: patch });
  }
  function patchName(name: string) {
    updateComponent(comp.id, { name });
  }

  const renderSchemaRow = (key: string) => (
    <SchemaFieldRow
      key={key}
      propKey={key}
      schema={schema[key]}
      value={props[key]}
      onChange={(v) => patchProp(key, v)}
      onOpenPicker={
        primaryType(schema[key].type).toLowerCase() === 'struct' ||
        SOURCE_CAPABLE_TYPES.has(primaryType(schema[key].type).toLowerCase())
          ? // `currentBinding` arrives from whichever slot opened the picker — a
            // nested `$if` branch or `$switch` case names its own binding, which
            // the picker cannot read back off `comp.properties[key]`.
            (onPick, currentBinding) =>
              openBindingPicker(comp.id, key, {
                onPick,
                currentBinding,
                filter: {
                  label: schema[key].label,
                  type: schema[key].type,
                  write: (schema[key] as { write?: boolean }).write,
                  requiredFields: (schema[key] as { requiredFields?: RequiredFieldEntry[] })
                    .requiredFields,
                },
              })
          : undefined
      }
      allProperties={props}
      childConfigs={comp.children}
      tokenValues={tokenValues}
    />
  );

  const parentPath = useContext(FieldPathContext);
  const displayName = comp.name || (entry?.name ?? comp.type);

  const compRef = useRef(comp);
  compRef.current = comp;

  useCopyPasteShortcut((key, { path, schema: targetSchema }) => {
    const [topKey, ...subPath] = path;
    const label = targetSchema.label || topKey;

    if (topKey === '__name__') {
      if (key === 'c') {
        void copyPropertyValue(compRef.current.name, label);
      } else {
        void pastePropertyValue(targetSchema, label, (v) => {
          updateComponent(compRef.current.id, { name: String(v ?? '') });
        });
      }
      return;
    }

    if (topKey === LAYOUT_PATH_KEY) {
      const layoutKey = subPath[0] as keyof LayoutConfig | undefined;
      if (!layoutKey) return;
      if (key === 'c') {
        void copyPropertyValue((compRef.current.layout ?? {})[layoutKey], label);
      } else {
        void pastePropertyValue(targetSchema, label, (v) => {
          updateComponent(compRef.current.id, {
            layout: { [layoutKey]: v === '' || v === undefined ? undefined : v },
          });
        });
      }
      return;
    }

    const root = (compRef.current.properties ?? {})[topKey];
    if (key === 'c') {
      const valueAtPath = subPath.length === 0 ? root : getAtPath(root, subPath);
      void copyPropertyValue(valueAtPath, label);
    } else {
      const apply = (v: unknown) => {
        const newRoot = subPath.length === 0 ? v : setAtPath(root, subPath, v);
        updateComponent(compRef.current.id, { properties: { [topKey]: newRoot } });
      };
      if (targetSchema.type === '_action') {
        void pasteActionValue(label, apply);
      } else {
        void pastePropertyValue(targetSchema, label, apply);
      }
    }
  });

  return (
    <PanelScopeContext.Provider value={comp.id}>
      <FieldPathContext.Provider value={[...parentPath, displayName]}>
        <PanelHeader
          icon={<WidgetIcon type={comp.type} size={18} />}
          name={displayName}
          kind={entry?.name ?? comp.type}
        />

        {/* ── Identity ─────────────────────────────────────────────────── */}
        <CollapsibleSection title="Identity">
          <PropRow label="Name" selection={{ path: ['__name__'], schema: NAME_SCHEMA }} sourceless>
            <TextField value={comp.name} onCommit={patchName} />
          </PropRow>
        </CollapsibleSection>
        {schemaGroups.map((group) => (
          <CollapsibleSection key={group.title} title={group.title}>
            {group.keys.map(renderSchemaRow)}
          </CollapsibleSection>
        ))}

        {/* ── Layout ───────────────────────────────────────────────────── */}
        <CollapsibleSection title="Layout">
          <LayoutFields
            mode={isContainer ? 'container' : 'leaf'}
            layout={layout}
            onChange={patchLayout}
            componentId={comp.id}
            tokenValues={tokenValues}
          />
        </CollapsibleSection>
      </FieldPathContext.Provider>
    </PanelScopeContext.Provider>
  );
}

// ── SettingsPanel ─────────────────────────────────────────────────────────────

const SCALE_MIN = 0.5;
const SCALE_MAX = 2.0;
const SCALE_STEP = 0.05;

const LOCKED_FEEDBACK_LABELS: Record<LockedFeedback, string> = {
  flash: 'Marker at pointer',
  toast: 'Notification',
  none: 'None',
};

function SettingsPanel() {
  const hmiScale = useConfigStore((s) => s.shell.hmiScale ?? 1);
  const showScrollbars = useConfigStore((s) => s.shell.showScrollbars === true);
  const lockedFeedback = useConfigStore((s) => s.shell.lockedFeedback ?? 'flash');
  const appTitle = useConfigStore((s) => s.shell.appTitle ?? '');
  const appIcon = useConfigStore((s) => s.shell.appIcon ?? '');
  const bootLogo = useConfigStore((s) => s.shell.bootLogo ?? '');
  const updateShell = useConfigStore((s) => s.updateShell);
  const openAssetPicker = useEditorDomainStore((s) => s.openAssetPicker);

  function commit(next: number) {
    const clamped = Math.min(Math.max(next, SCALE_MIN), SCALE_MAX);
    const stepped = Math.round(clamped / SCALE_STEP) * SCALE_STEP;
    const value = Number(stepped.toFixed(2));
    updateShell({ hmiScale: value === 1 ? undefined : value });
  }

  function browseIcon() {
    openAssetPicker(
      'image',
      (image) => {
        if (image.path) updateShell({ appIcon: image.path });
      },
      'App icon',
    );
  }

  function browseBootLogo() {
    openAssetPicker(
      'image',
      (image) => {
        if (image.path) updateShell({ bootLogo: image.path });
      },
      'Boot logo',
    );
  }

  return (
    <>
      <PanelHeader kind="Settings" />
      <div className="cfg-section">
        <div className="cfg-section__title">Browser</div>
        <PropRow label="Title">
          <TextField
            value={appTitle}
            placeholder="(default)"
            onCommit={(text) => updateShell({ appTitle: text || undefined })}
          />
        </PropRow>
        <PropRow label="Icon">
          <AssetPathField
            value={appIcon}
            placeholder="images/logo.svg or https://…"
            onChange={(v) => updateShell({ appIcon: v })}
            onBrowse={browseIcon}
          />
        </PropRow>
      </div>
      <div className="cfg-section">
        <div className="cfg-section__title">HMI</div>
        <PropRow
          label="Scale"
          description="Zoom factor applied to the entire HMI layout. Use values above 1 to enlarge the interface for distant monitors, or below 1 to fit more content."
        >
          <div className="cfg-settings-scale">
            <input
              type="range"
              min={SCALE_MIN}
              max={SCALE_MAX}
              step={SCALE_STEP}
              value={hmiScale}
              onChange={(e) => {
                const next = Number.parseFloat(e.target.value);
                if (Number.isFinite(next)) commit(next);
              }}
              className="cfg-settings-scale__slider"
              aria-label="HMI scale"
            />
            <input
              type="number"
              min={SCALE_MIN}
              max={SCALE_MAX}
              step={SCALE_STEP}
              value={Number(hmiScale.toFixed(2))}
              onChange={(e) => {
                const next = Number.parseFloat(e.target.value);
                if (Number.isFinite(next)) commit(next);
              }}
              className="cfg-prop-input cfg-settings-scale__input"
              aria-label="HMI scale value"
            />
          </div>
        </PropRow>
        <PropRow
          label="Scrollbars"
          description="Scrollable areas always respond to wheel and touch. Turn this on to also paint the browser’s scrollbars — useful on desktop panels with mouse-only input."
        >
          <BoolButtonGroup
            value={showScrollbars}
            onChange={(v) => updateShell({ showScrollbars: v || undefined })}
            labels={['Visible', 'Hidden']}
          />
        </PropRow>
        <PropRow
          label="Locked feedback"
          description="What an operator gets when they press a component whose Interactable property is false. The component stays dimmed and blocked either way."
        >
          <Select
            value={lockedFeedback}
            onChange={(v) =>
              updateShell({
                lockedFeedback: v === 'flash' ? undefined : (v as LockedFeedback),
              })
            }
          >
            {LOCKED_FEEDBACK_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {LOCKED_FEEDBACK_LABELS[mode]}
              </option>
            ))}
          </Select>
        </PropRow>
      </div>
      {getEdition() === 'ee' && (
        <div className="cfg-section">
          <div className="cfg-section__title">Branding</div>
          <PropRow
            label="Boot logo"
            description="Shown on the HMI boot screen in place of the product logo and name. Leave empty for the default branding."
          >
            <AssetPathField
              value={bootLogo}
              placeholder="images/logo.svg"
              onChange={(v) => updateShell({ bootLogo: v })}
              onBrowse={browseBootLogo}
            />
          </PropRow>
        </div>
      )}
    </>
  );
}

// ── GlobalEventsPanel ─────────────────────────────────────────────────────────

const GLOBAL_EVENT_FIELDS: { eventKey: keyof GlobalEventsConfig; label: string }[] = [
  { eventKey: 'onUserLoggedIn', label: 'User Logged In' },
  { eventKey: 'onUserLoggedOut', label: 'User Logged Out' },
  { eventKey: 'onPageLoaded', label: 'Page Loaded' },
  { eventKey: 'onHmiLoaded', label: 'HMI Loaded' },
  { eventKey: 'onLocaleChanged', label: 'Locale Changed' },
];

function GlobalEventsPanel() {
  const globalEvents = useConfigStore((s) => s.globalEvents);
  const updateGlobalEvents = useConfigStore((s) => s.updateGlobalEvents);

  function handleChange(eventKey: keyof GlobalEventsConfig, value: unknown) {
    const actionsConfig = value as ActionsConfig | undefined;
    updateGlobalEvents({ ...globalEvents, [eventKey]: actionsConfig?.[eventKey] });
  }

  return (
    // Global event handlers belong to no widget node; the backend stamps this
    // same tree-node id on their diagnostics as the owner, so the badge finds a
    // home (see `_synthetic_owner` in backend/api/config_api.py).
    <PanelScopeContext.Provider value={EDITOR_NODE_IDS.EVENTS}>
      <PanelHeader kind="Global Events" />
      <div className="cfg-section">
        <div className="cfg-section__title">Events</div>
        {GLOBAL_EVENT_FIELDS.map(({ eventKey, label }) => (
          // Same shape as a widget's `actions` schema field (see SchemaFieldRow):
          // a plain title row with the add control, no wrapping box for the group.
          <div className="cfg-field-group" key={eventKey}>
            <ActionsInput
              value={{ [eventKey]: globalEvents[eventKey] ?? [] } as ActionsConfig}
              onChange={(v) => handleChange(eventKey, v)}
              eventKey={eventKey}
              eventLabel={label}
              headerTitle={label}
            />
          </div>
        ))}
      </div>
    </PanelScopeContext.Provider>
  );
}

// ── ShellAreaPanel ───────────────────────────────────────────────────────────
// Surfaces shell-region properties for the selected shell area (header,
// footer, left/right sidebar) in the component tree. The legacy
// header[]/footer[] component arrays remain edited via the tree's child rows;
// this panel covers shell-level props only.

// Synthetic schemas for shell-region fields that accept canonical bindings.
const SHELL_EXPANDED_SCHEMA: SchemaField = {
  type: 'Boolean',
  format: 'expansion',
  label: 'Expanded',
  defaultValue: true,
};

const SHELL_OVERLAY_SCHEMA: SchemaField = {
  type: 'Boolean',
  label: 'Overlay (drawer)',
  defaultValue: false,
};

const SHELL_ENABLED_SCHEMA: SchemaField = {
  type: 'Boolean',
  format: 'enablement',
  label: 'Enabled',
  defaultValue: true,
};

const SHELL_EXPANDED_SIZE_SCHEMA: SchemaField = {
  type: 'String',
  format: 'length',
  label: 'Expanded size',
  defaultValue: 'auto',
};

const SHELL_BACKGROUND_SCHEMA: SchemaField = {
  type: 'Color',
  label: 'Background',
};

const SHELL_FULL_HEIGHT_SCHEMA: SchemaField = {
  type: 'Boolean',
  label: 'Full height',
  defaultValue: false,
};

const SHELL_DEFAULT_STATES = ['expanded', 'collapsed', 'hidden'] as const;

// The collapsed fallback differs by axis: sidebars collapse to zero width,
// header/footer keep their content height.
const SHELL_COLLAPSED_SIZE_SCHEMAS: Record<'auto' | 'zero', SchemaField> = {
  auto: { type: 'String', format: 'length', label: 'Collapsed size', defaultValue: 'auto' },
  zero: { type: 'String', format: 'length', label: 'Collapsed size', defaultValue: '0' },
};

/** Empty static text means "unset" — keep it out of the saved config. */
function blankToUndefined(v: unknown): unknown {
  return typeof v === 'string' && v.trim() === '' ? undefined : v;
}

/**
 * The bindable fields of one shell region. Shared by the project-wide Shell
 * area panel and a page's per-page override so the two can't drift.
 *
 * `pathPrefix` puts the region into each field's diagnostic/selection path.
 * The shell panel edits one region and leaves it empty; the override panel
 * edits all four in a single page panel and prefixes with the region id, which
 * is exactly the shape the backend reports (`/shellOverride/<region>/<field>`).
 */
function ShellRegionFields({
  id,
  config,
  onPatch,
  pathPrefix = [],
  inheritable = false,
}: {
  id: ShellRegionId;
  config: ShellRegionConfig;
  onPatch: (patch: Partial<ShellRegionConfig>) => void;
  pathPrefix?: string[];
  /** True for the per-page override, where an unset field means "inherit the
   *  project shell" rather than "take the built-in default". Values are then
   *  stored as picked — collapsing a default back to `undefined` would make
   *  the override unable to say `enabled: true` over a project-wide `false`. */
  inheritable?: boolean;
}) {
  const openBindingPicker = useEditorDomainStore((s) => s.openBindingPicker);
  const scope = useContext(PanelScopeContext);
  const at = (key: string) => [...pathPrefix, key];
  const defaultStateDiagnostic = useFieldDiagnostic(scope, at('defaultState'));

  // Synthetic id+key for the binding picker overlay. The picker uses these
  // strings only as a target identifier — there is no real component lookup.
  const bindingTargetId = `__shell_${pathPrefix.join('_')}${id}__`;

  return (
    <>
      <SchemaFieldRow
        path={at('enabled')}
        schema={SHELL_ENABLED_SCHEMA}
        value={config.enabled}
        // `true` is the default — store it as unset so the saved config stays
        // minimal and matches what the old static toggle wrote.
        onChange={(v) => onPatch({ enabled: !inheritable && v === true ? undefined : v })}
        onOpenPicker={(onPick, currentBinding) =>
          openBindingPicker(bindingTargetId, 'enabled', {
            onPick,
            currentBinding: currentBinding ?? varBindingOf(config.enabled),
            filter: { label: 'Enabled', type: 'Boolean' },
          })
        }
      />

      <PropRow label="Default state" diagnostic={defaultStateDiagnostic}>
        <Select
          value={config.defaultState ?? (inheritable ? '' : 'expanded')}
          onChange={(v) =>
            onPatch({
              defaultState: (v as 'expanded' | 'collapsed' | 'hidden') || undefined,
            })
          }
        >
          {/* Only the override can be cleared back to "unset" — the project
              shell has no outer config to fall back to. */}
          {inheritable && <option value="">inherit</option>}
          {SHELL_DEFAULT_STATES.map((state) => (
            <option key={state} value={state}>
              {state}
            </option>
          ))}
        </Select>
      </PropRow>

      <SchemaFieldRow
        path={at('expandedSize')}
        schema={SHELL_EXPANDED_SIZE_SCHEMA}
        value={config.expandedSize}
        onChange={(v) => onPatch({ expandedSize: blankToUndefined(v) })}
        onOpenPicker={(onPick, currentBinding) =>
          openBindingPicker(bindingTargetId, 'expandedSize', {
            onPick,
            currentBinding: currentBinding ?? varBindingOf(config.expandedSize),
            filter: { label: 'Expanded size', type: 'String' },
          })
        }
      />

      <SchemaFieldRow
        path={at('collapsedSize')}
        schema={SHELL_COLLAPSED_SIZE_SCHEMAS[id === 'header' || id === 'footer' ? 'auto' : 'zero']}
        value={config.collapsedSize}
        onChange={(v) => onPatch({ collapsedSize: blankToUndefined(v) })}
        onOpenPicker={(onPick, currentBinding) =>
          openBindingPicker(bindingTargetId, 'collapsedSize', {
            onPick,
            currentBinding: currentBinding ?? varBindingOf(config.collapsedSize),
            filter: { label: 'Collapsed size', type: 'String' },
          })
        }
      />

      {(id === 'leftSidebar' || id === 'rightSidebar') && (
        <SchemaFieldRow
          path={at('fullHeight')}
          schema={SHELL_FULL_HEIGHT_SCHEMA}
          value={config.fullHeight}
          onChange={(v) => onPatch({ fullHeight: !inheritable && v === false ? undefined : v })}
          onOpenPicker={(onPick, currentBinding) =>
            openBindingPicker(bindingTargetId, 'fullHeight', {
              onPick,
              currentBinding: currentBinding ?? varBindingOf(config.fullHeight),
              filter: { label: 'Full height', type: 'Boolean' },
            })
          }
        />
      )}

      <SchemaFieldRow
        path={at('background')}
        schema={SHELL_BACKGROUND_SCHEMA}
        value={config.background}
        onChange={(v) => onPatch({ background: blankToUndefined(v) })}
        onOpenPicker={(onPick, currentBinding) =>
          openBindingPicker(bindingTargetId, 'background', {
            onPick,
            currentBinding: currentBinding ?? varBindingOf(config.background),
            filter: { label: 'Background', type: 'Color' },
          })
        }
      />

      <SchemaFieldRow
        path={at('expanded')}
        schema={SHELL_EXPANDED_SCHEMA}
        value={config.expanded}
        onChange={(v) => onPatch({ expanded: v as ShellRegionConfig['expanded'] })}
        onOpenPicker={(onPick, currentBinding) =>
          openBindingPicker(bindingTargetId, 'expanded', {
            onPick,
            currentBinding: currentBinding ?? varBindingOf(config.expanded),
            filter: { label: 'Expanded', type: 'Boolean' },
          })
        }
      />

      <SchemaFieldRow
        path={at('overlay')}
        schema={SHELL_OVERLAY_SCHEMA}
        value={config.overlay}
        onChange={(v) => onPatch({ overlay: v as ShellRegionConfig['overlay'] })}
        onOpenPicker={(onPick, currentBinding) =>
          openBindingPicker(bindingTargetId, 'overlay', {
            onPick,
            currentBinding: currentBinding ?? varBindingOf(config.overlay),
            filter: { label: 'Overlay', type: 'Boolean' },
          })
        }
      />
    </>
  );
}

function ShellAreaPanel({
  id,
  label,
  nodeId,
}: {
  id: ShellRegionId;
  label: string;
  nodeId: string;
}) {
  const shell = useConfigStore((s) => s.shell);
  const updateShell = useConfigStore((s) => s.updateShell);

  return (
    // These region fields belong to no widget node; the backend stamps this
    // same tree-node id on their diagnostics as the owner, so the badge finds a
    // home (see `_synthetic_owner` in backend/api/config_api.py).
    <PanelScopeContext.Provider value={nodeId}>
      <PanelHeader kind="Shell area" name={label} />

      <div className="cfg-section">
        <div className="cfg-section__title">Region</div>
        <ShellRegionFields
          id={id}
          config={shell[id] ?? {}}
          onPatch={(patch) =>
            updateShell({ [id]: { ...(shell[id] ?? {}), ...patch } } as Partial<ShellConfig>)
          }
        />
      </div>
    </PanelScopeContext.Provider>
  );
}
