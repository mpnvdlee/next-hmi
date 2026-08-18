import './style.css';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConfigStore } from '@shared/store/configStore';
import { findPageById, resolvePageTitle } from '@shared/utils/pageTree';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useComponentEditorStore } from '@config/store/componentEditorStore';
import { EDITOR_NODE_IDS } from '@shared/constants/editorSentinels';
import { editorPath } from '@shared/utils/runtimeBase';
import useDismissOnOutsideClick from '@config/hooks/useDismissOnOutsideClick';
import type { Diagnostic } from '@config/hooks/usePanelDiagnostics';
import {
  shellAreaNodeIdFor,
  useDiagnosticIndex,
  useProjectDiagnosticsSweep,
} from '@config/hooks/useProjectDiagnostics';
import { Warning } from '@phosphor-icons/react';
import CloseButton from '@shared/components/CloseButton';

function artifactLabel(d: Diagnostic): string {
  switch (d.artifactKind) {
    case 'page': {
      const page = d.artifactId
        ? findPageById(useConfigStore.getState().pages, d.artifactId)
        : undefined;
      return page ? resolvePageTitle(page.title) : (d.artifactId ?? 'Page');
    }
    case 'dialog':
      return `Dialog: ${d.artifactId ?? '?'}`;
    case 'shell':
      return 'Shell';
    case 'globalEvents':
      return 'Global Events';
    case 'component':
      return `Component: ${d.artifactId ?? '?'}`;
    case 'translations':
      return `Translations: ${d.artifactId ?? '?'}`;
    case 'widget-build':
      return `Custom widget: ${d.artifactId ?? '?'}`;
    case 'alarms':
      return 'Alarms';
    case 'recipes':
      return 'Recipes';
    case 'historian':
      return 'Historian';
    case 'users':
      return 'Security';
    default:
      return 'Project';
  }
}

function resolveShellAreaId(widgetId: string | null): string {
  const { header, footer, leftSidebar, rightSidebar } = useConfigStore.getState();
  return (
    shellAreaNodeIdFor(widgetId, { header, footer, leftSidebar, rightSidebar }) ??
    EDITOR_NODE_IDS.SETTINGS
  );
}

// Kinds whose editor is a different route than the page editor's widget tree.
const AWAY_FROM_TREE = new Set([
  'component',
  'translations',
  'alarms',
  'recipes',
  'historian',
  'users',
]);

/** Where a diagnostic lives, and how to get there. Kinds edited outside the
 *  page editor route away from it rather than dead-ending on Settings. */
async function selectDiagnostic(d: Diagnostic, navigate: (to: string) => void) {
  const editor = useEditorDomainStore.getState();
  switch (d.artifactKind) {
    case 'page': {
      if (!d.artifactId) return;
      // May point at a page that hasn't been opened/previewed this session yet.
      await useConfigStore.getState().loadPageContent(d.artifactId);
      editor.previewPage(d.artifactId);
      editor.setSelected(d.widgetId ?? d.artifactId);
      return;
    }
    case 'dialog':
      if (!d.artifactId) return;
      editor.previewPage(d.artifactId);
      editor.setSelected(d.widgetId ?? d.artifactId);
      return;
    case 'shell':
      editor.setSelected(d.widgetId ?? resolveShellAreaId(d.widgetId));
      return;
    case 'globalEvents':
      editor.setSelected(EDITOR_NODE_IDS.EVENTS);
      return;
    case 'component':
      if (!d.artifactId) return;
      navigate(editorPath('/components'));
      // The offending widget only exists once the component is the open tab,
      // so pin the tab and let the store carry the selection into it.
      if (d.widgetId) useComponentEditorStore.getState().selectComponent(d.artifactId, d.widgetId);
      else useComponentEditorStore.getState().openTab(d.artifactId);
      return;
    case 'translations':
      navigate(editorPath('/translations'));
      return;
    case 'alarms':
    case 'recipes':
    case 'historian':
      navigate(editorPath(`/${d.artifactKind}`));
      return;
    case 'users':
      navigate(editorPath('/users'));
      return;
    default:
      // `widget-build` names a custom-widget source file the editor cannot
      // open — the message already carries the compiler error, so stay put.
      return;
  }
}

export default function SaveWarningsPill() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useDismissOnOutsideClick(ref, () => setOpen(false), open);
  // This pill is the single owner of the whole-project sweep; the tree marks
  // read the same store.
  useProjectDiagnosticsSweep();
  const { all: list, errorCount, warningCount, pending, stale } = useDiagnosticIndex();

  const hasIssues = list.length > 0;
  const pillLabel = pending
    ? '…'
    : hasIssues
      ? `${errorCount} error${errorCount === 1 ? '' : 's'} · ${warningCount} warning${warningCount === 1 ? '' : 's'}`
      : 'No issues';
  // While there are unsaved edits, only the artifact open in a panel is
  // re-validated live — everything else still describes the last save.
  const staleNote = stale
    ? 'Unsaved changes — counts outside the panel you are editing are from the last save.'
    : 'Click to view build diagnostics';

  return (
    <div className="cfg-save-warnings" ref={ref}>
      <button
        type="button"
        className={[
          'cfg-save-warnings__pill',
          errorCount > 0
            ? 'cfg-save-warnings__pill--error'
            : hasIssues
              ? ''
              : 'cfg-save-warnings__pill--muted',
          stale ? 'cfg-save-warnings__pill--stale' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={staleNote}
      >
        <Warning size={14} weight={hasIssues ? 'fill' : 'regular'} />
        {pillLabel}
      </button>
      {open && (
        <div className="cfg-save-warnings__panel" role="dialog" aria-label="Build diagnostics">
          <header className="cfg-save-warnings__panel-header">
            <strong>Diagnostics</strong>
            <CloseButton
              tone="config"
              className="cfg-save-warnings__close"
              onClick={() => setOpen(false)}
              label="Close"
            />
          </header>
          {stale && <p className="cfg-save-warnings__stale-note">{staleNote}</p>}
          <div className="cfg-save-warnings__panel-content">
            {pending ? (
              <p className="cfg-save-warnings__empty">Checking project…</p>
            ) : list.length === 0 ? (
              <p className="cfg-save-warnings__empty">No issues across the project.</p>
            ) : (
              <ul className="cfg-save-warnings__list">
                {list.map((d, i) => (
                  <li
                    key={`${d.artifactKind}:${d.artifactId}:${d.widgetId}:${d.propKey}:${d.code}:${i}`}
                    className="cfg-save-warnings__item-row"
                  >
                    <button
                      type="button"
                      className={`cfg-save-warnings__item cfg-save-warnings__item--${d.severity}`}
                      title={
                        AWAY_FROM_TREE.has(d.artifactKind)
                          ? `Open in ${artifactLabel(d)}`
                          : 'Show in widget tree'
                      }
                      onClick={() => {
                        setOpen(false);
                        void selectDiagnostic(d, navigate);
                      }}
                    >
                      <span className="cfg-save-warnings__message">{d.message}</span>
                      <span className="cfg-save-warnings__location">
                        <span className="cfg-save-warnings__location-label">in</span>
                        <span className="cfg-save-warnings__page">{artifactLabel(d)}</span>
                        <span className="cfg-save-warnings__sep">·</span>
                        <span className="cfg-save-warnings__path">{d.breadcrumb}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
