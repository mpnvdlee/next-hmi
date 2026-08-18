import { Suspense, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PageConfig, PageNode, PageGroupConfig, WidgetConfig } from '@shared/types/config';
import { resolvePageContext } from '@shared/utils/pageTree';
import { useConfigStore } from '@shared/store/configStore';
import { useVariableStore } from '../store/variableStore';
import WidgetRenderer from './WidgetRenderer';
import WindowedContent from './WindowedContent';
import { PageGroupStackContext, type PageGroupStackEntry } from './PageGroupStackContext';
import { HostPageContext } from '../context/HostPageContext';
import { ComponentSelfSuspenseContext } from '../context/ComponentSuspenseContext';
import { ContentSpinner } from '@shared/components/Spinner';

interface PageGroupPageViewProps {
  pages: PageNode[];
  requestedId?: string;
  onNavigate: (pageId: string, replace?: boolean) => void;
  emptyMessage?: string;
}

export default function PageGroupPageView({
  pages,
  requestedId,
  onNavigate,
  emptyMessage = 'No page found.',
}: PageGroupPageViewProps) {
  const parentStack = useContext(PageGroupStackContext);

  const { page, pageGroups, fellBackToFirstChild } = useMemo(
    () => resolvePageContext(pages, requestedId),
    [pages, requestedId],
  );

  useEffect(() => {
    if (fellBackToFirstChild && page) {
      onNavigate(page.id, true);
    }
  }, [fellBackToFirstChild, onNavigate, page]);

  // Every navigation widget navigates by URL, regardless of how deeply
  // nested its group is. The stack is the ancestor chain of groups, each
  // entry's `activePage` is the next-lower active node (group or page).
  const stack = useMemo<PageGroupStackEntry[]>(() => {
    if (!page || pageGroups.length === 0) return parentStack;
    const next: PageGroupStackEntry[] = [...parentStack];
    for (let i = 0; i < pageGroups.length; i++) {
      const group = pageGroups[i];
      const activeChild = pageGroups[i + 1] ?? page;
      next.push({
        group,
        activePage: activeChild,
        onNavigate: (childId: string) => onNavigate(childId, false),
      });
    }
    return next;
  }, [parentStack, pageGroups, page, onNavigate]);

  if (!page) {
    return <p className="hmi-no-page">{emptyMessage}</p>;
  }

  return (
    <PageGroupStackContext.Provider value={stack}>
      <ActiveBranch stack={stack} page={page} />
    </PageGroupStackContext.Provider>
  );
}

interface ActiveBranchProps {
  /** Full stack of group entries (outer → innermost) covering the resolved route. */
  stack: PageGroupStackEntry[];
  page: PageConfig;
}

/**
 * Render the active branch from the outermost group down to the active page,
 * wrapping each level in its `PageGroupShell`. Each shell receives the stack
 * slice that ends at its own level — so widgets in that shell's header/footer
 * default to that shell's group (not the deepest one).
 */
function ActiveBranch({ stack, page }: ActiveBranchProps) {
  function buildAt(level: number): ReactNode {
    if (level >= stack.length) return <PageContent page={page} />;
    const entry = stack[level];
    return (
      <PageGroupShell
        key={entry.group.id}
        group={entry.group}
        chromeStack={stack.slice(0, level + 1)}
      >
        {buildAt(level + 1)}
      </PageGroupShell>
    );
  }
  return <>{buildAt(0)}</>;
}

interface PageGroupShellProps {
  group: PageGroupConfig;
  /** Stack slice ending at (and including) this group; scoped to the chrome bands. */
  chromeStack: PageGroupStackEntry[];
  children: ReactNode;
}

function PageGroupShell({ group, chromeStack, children }: PageGroupShellProps) {
  const header = group.header ?? [];
  const footer = group.footer ?? [];
  // Chromeless groups still expose `data-page-group-id` via a layout-neutral
  // wrapper (`display: contents`) so tooling can find every group in the tree.
  // The `.hmi-main:has(.hmi-page-group-shell)` rule deliberately matches only
  // chrome-bearing wrappers — chromeless groups don't impose the flex layout.
  if (header.length === 0 && footer.length === 0) {
    return (
      <div className="hmi-page-group-mark" data-page-group-id={group.id}>
        {children}
      </div>
    );
  }
  return (
    <div className="hmi-page-group-shell" data-page-group-id={group.id}>
      {header.length > 0 && (
        <header className="hmi-page-group-shell__header">
          <PageGroupStackContext.Provider value={chromeStack}>
            {header.map((widget) => (
              <WidgetRenderer key={widget.id} node={widget} />
            ))}
          </PageGroupStackContext.Provider>
        </header>
      )}
      <div className="hmi-page-group-shell__content">{children}</div>
      {footer.length > 0 && (
        <footer className="hmi-page-group-shell__footer">
          <PageGroupStackContext.Provider value={chromeStack}>
            {footer.map((widget) => (
              <WidgetRenderer key={widget.id} node={widget} />
            ))}
          </PageGroupStackContext.Provider>
        </footer>
      )}
    </div>
  );
}

interface PageContentProps {
  page: PageConfig;
}

// Safety valve: if the backend never acks this page's context (down, no
// bindings, an old build without context_ready, ...), reveal anyway rather
// than spin forever.
const CONTEXT_READY_WAIT_MS = 1200;

function PageContent({ page }: PageContentProps) {
  // A page arrives from the index with an empty `content` section and is
  // hydrated lazily on first visit (usePage). Hold a single page-filling spinner
  // until the page has hydrated, every component chunk it uses has mounted, AND
  // this page's own variables have been delivered (context_ready echoing this
  // page's id — see HmiView's set_context effect) — then reveal header, content
  // and footer together in one go, with widgets already carrying their live
  // values. This keeps the page from reflowing piecemeal: no bands popping in
  // behind their own spinner (they share one boundary with self-suspense
  // disabled) and no labels growing from empty→value a beat after the spinner
  // clears — for every navigation, not just the first page of the session.
  const hydrated = useConfigStore((s) => s.loadedPageIds.has(page.id));
  const contextReady = useVariableStore((s) => s.contextReadyPageIds.includes(page.id));
  // Tracks which page's wait timed out — comparing against the *current*
  // page.id below means navigating away before a stale timer fires can't leak
  // a stale "ready" into the next page (PageContent isn't remounted per page).
  const [timedOutPageId, setTimedOutPageId] = useState<string | null>(null);
  useEffect(() => {
    if (!hydrated || contextReady) return;
    const t = setTimeout(() => setTimedOutPageId(page.id), CONTEXT_READY_WAIT_MS);
    return () => clearTimeout(t);
  }, [hydrated, contextReady, page.id]);
  const ready = hydrated && (contextReady || timedOutPageId === page.id);
  const sections = page.sections;
  const renderWidget = (widget: WidgetConfig) => <WidgetRenderer key={widget.id} node={widget} />;
  return (
    <HostPageContext.Provider value={page.id}>
      <div className="hmi-page" data-page-id={page.id}>
        {ready ? (
          <Suspense fallback={<ContentSpinner />}>
            <ComponentSelfSuspenseContext.Provider value={false}>
              {page.showHeader && (
                <header className="hmi-page__header">
                  {(sections.header ?? []).map(renderWidget)}
                </header>
              )}
              <main className="hmi-page__content">
                <WindowedContent items={sections.content ?? []} render={renderWidget} />
              </main>
              {page.showFooter && (
                <footer className="hmi-page__footer">
                  {(sections.footer ?? []).map(renderWidget)}
                </footer>
              )}
            </ComponentSelfSuspenseContext.Provider>
          </Suspense>
        ) : (
          <ContentSpinner />
        )}
      </div>
    </HostPageContext.Provider>
  );
}
