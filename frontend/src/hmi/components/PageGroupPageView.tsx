import { Suspense, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PageConfig, PageNode, PageGroupConfig, WidgetConfig } from '@shared/types/config';
import { resolvePageContext } from '@shared/utils/pageTree';
import { useConfigStore } from '@shared/store/configStore';
import WidgetRenderer from './WidgetRenderer';
import WindowedContent from './WindowedContent';
import { PageGroupStackContext, type PageGroupStackEntry } from './PageGroupStackContext';
import { HostPageContext } from '../context/HostPageContext';
import { ComponentSelfSuspenseContext } from '../context/ComponentSuspenseContext';
import { prefetchWidgetModules, widgetModulesLoaded } from '../registry/widgetRegistry';
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

/** Per-page-visit answer to "is this page's widget code in memory?" — see
 *  PageContent for why both halves are keyed by page id. */
interface PageModuleVisit {
  pageId: string;
  ready: boolean;
  timedOut: boolean;
}

// Safety valve for the module load. They are local files, so this only covers a
// fetch that never lands at all; the wait is long enough that a page still
// pulling widget code is never revealed half-built for being merely slow. What
// the reveal then shows is the rest of the page with a hole where the stuck
// widget is — every widget module keeps its own `fallback={null}` boundary, so
// nothing escalates back onto this spinner.
const MODULES_WAIT_MS = 5000;

function PageContent({ page }: PageContentProps) {
  // A page arrives from the index with an empty `content` section and is
  // hydrated lazily on first visit (usePage). Hold a single page-filling spinner
  // until the page has hydrated AND every widget module and component chunk it
  // renders is in memory — then reveal header, content and footer together in
  // one go, instead of reflowing piecemeal as the lazy imports return.
  //
  // Both of those are config and code: local files, milliseconds, never the
  // datasource. The page's *variables* deliberately do not gate the reveal —
  // a slow OPC-UA read would then delay every navigation, which is exactly the
  // stall this used to have. Widgets render with the values the store already
  // holds (they survive navigation) and `DataSettleGate` marks whatever turned
  // out to have no data once the load settles.
  const hydrated = useConfigStore((s) => s.loadedPageIds.has(page.id));
  const sections = page.sections;
  // Widget code is the second thing the reveal waits on, and the one the
  // Suspense boundary below cannot supply: every widget type is a `lazy()` that
  // only starts its import on first render, and `registerCustomWidget` wraps it
  // in its own `fallback={null}` boundary, so a widget still in flight renders
  // a hole rather than escalating here. Prefetching the page's modules — rather
  // than escalating those boundaries — is also what keeps a widget that mounts
  // later (WindowedContent scrolls one in, a visibility gate opens) from
  // blanking the whole page body behind this spinner. The boundary below is
  // left for the shared ComponentRenderer chunk a `$component:` instance
  // waits on.
  // A band that is switched off is never rendered, so its widgets' modules are
  // not something this page is waiting for.
  const showHeader = page.showHeader;
  const showFooter = page.showFooter;
  const nodes = useMemo(
    () => [
      ...(showHeader ? (sections.header ?? []) : []),
      ...(sections.content ?? []),
      ...(showFooter ? (sections.footer ?? []) : []),
    ],
    [sections, showHeader, showFooter],
  );
  // Both answers are latched per page id, not as bare booleans: PageContent is
  // not remounted between two top-level pages, so a plain `true` would carry
  // the previous page's answer — an expired wait included — into the next one.
  // Reset during render rather than from an effect, so the new page never gets
  // a frame of the old page's verdict.
  const [visit, setVisit] = useState<PageModuleVisit>(() => ({
    pageId: page.id,
    ready: false,
    timedOut: false,
  }));
  if (visit.pageId !== page.id) {
    setVisit({ pageId: page.id, ready: false, timedOut: false });
  }
  useEffect(() => {
    if (!hydrated) return;
    const markReady = () =>
      setVisit((v) => (v.pageId === page.id && !v.ready ? { ...v, ready: true } : v));
    if (widgetModulesLoaded(nodes)) {
      markReady();
      return;
    }
    let alive = true;
    void prefetchWidgetModules(nodes).then(() => {
      if (alive) markReady();
    });
    return () => {
      alive = false;
    };
  }, [hydrated, nodes, page.id]);
  useEffect(() => {
    if (!hydrated || visit.ready) return;
    const t = setTimeout(
      () => setVisit((v) => (v.pageId === page.id ? { ...v, timedOut: true } : v)),
      MODULES_WAIT_MS,
    );
    return () => clearTimeout(t);
  }, [hydrated, visit.ready, page.id]);
  // Answered during render, not only from the effect above: navigating back to
  // a page whose modules are all in memory would otherwise flash the body
  // spinner for the one frame before effects run. The walk only happens while
  // the page is still waiting — once latched, the two booleans short-circuit it.
  const modulesOk = visit.ready || visit.timedOut || (hydrated && widgetModulesLoaded(nodes));
  const ready = hydrated && modulesOk;
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
