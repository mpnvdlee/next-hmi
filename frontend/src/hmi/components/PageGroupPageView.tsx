import { Suspense, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PageConfig, PageNode, PageGroupConfig, WidgetConfig } from '@shared/types/config';
import type { ComponentPropertySchema } from '@shared/types/componentProperty';
import { resolvePageContext } from '@shared/utils/pageTree';
import { useConfigStore } from '@shared/store/configStore';
import WidgetRenderer from './WidgetRenderer';
import WindowedContent from './WindowedContent';
import { COLUMN_FLOW } from './layoutUtils';
import { PageGroupStackContext, type PageGroupStackEntry } from './PageGroupStackContext';
import { HostPageContext } from '../context/HostPageContext';
import { InputScopeContext, type InputScopeValue } from '../context/InputScopeContext';
import { withDeclaredDefaults } from '../utils/componentPropResolution';
import { ComponentSelfSuspenseContext } from '../context/ComponentSuspenseContext';
import { prefetchWidgetModules, widgetModulesLoaded } from '../registry/widgetRegistry';
import { ContentSpinner } from '@shared/components/Spinner';

type Declarations = Record<string, ComponentPropertySchema> | undefined;

/**
 * Layer declared defaults under the values already in scope, innermost scope
 * first. `withDeclaredDefaults` only fills a key that is still `undefined`, so
 * folding the chain innermost -> outermost is the whole precedence rule in one
 * line: values the action supplied beat every default, and the innermost
 * declaration of a name beats an outer one's.
 *
 * A chain that declares nothing publishes no frame of its own — the inherited
 * one passes through untouched, so an ordinary page keeps costing nothing.
 */
function foldDeclaredDefaults(
  inherited: InputScopeValue | null,
  chain: Declarations[],
): InputScopeValue | null {
  if (!chain.some(Boolean)) return inherited;
  return {
    properties: chain.reduce(
      (acc, declared) => withDeclaredDefaults(acc, declared),
      inherited?.properties ?? {},
    ),
  };
}

interface PageGroupPageViewProps {
  pages: PageNode[];
  requestedId?: string;
  onNavigate: (pageId: string, replace?: boolean) => void;
  emptyMessage?: string;
  /** Whether the nodes shown take input parameters — true only for a page
   *  overlay of the Dialogs folder. Anywhere else a node's declarations are
   *  ignored and its `$componentProp`s read nothing. */
  takesInputs?: boolean;
}

export default function PageGroupPageView({
  pages,
  requestedId,
  onNavigate,
  emptyMessage = 'No page found.',
  takesInputs = false,
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

  // Values an `openDialog` action supplied, published by `ModalStack` —
  // the base every declared default layers under.
  const inheritedScope = useContext(InputScopeContext);

  // Declarations come from `pageGroups` — the trail `resolvePageContext`
  // returned for *this* view — never from `stack`, which is prefixed by
  // `parentStack`. Inside an overlay that prefix is the background page's
  // groups, whose parameters have nothing to do with what the overlay shows.
  const chromeOffset = stack.length - pageGroups.length;

  // Scope for each shell's own header/footer band, aligned with `stack`. Chrome
  // sits outside the page, so the active page's declarations are not in its
  // chain — only its own group's, then its ancestors'.
  const chromeScopes = useMemo(
    () =>
      stack.map((_, level) => {
        const index = level - chromeOffset;
        if (index < 0 || !takesInputs) return inheritedScope;
        return foldDeclaredDefaults(
          inheritedScope,
          pageGroups
            .slice(0, index + 1)
            .reverse()
            .map((group) => group.componentProperties),
        );
      }),
    [stack, chromeOffset, pageGroups, inheritedScope, takesInputs],
  );

  const pageScope = useMemo(
    () =>
      takesInputs
        ? foldDeclaredDefaults(inheritedScope, [
            page?.componentProperties,
            ...[...pageGroups].reverse().map((group) => group.componentProperties),
          ])
        : inheritedScope,
    [page, pageGroups, inheritedScope, takesInputs],
  );

  if (!page) {
    return <p className="hmi-no-page">{emptyMessage}</p>;
  }

  return (
    <PageGroupStackContext.Provider value={stack}>
      <ActiveBranch stack={stack} chromeScopes={chromeScopes} page={page} pageScope={pageScope} />
    </PageGroupStackContext.Provider>
  );
}

interface ActiveBranchProps {
  /** Full stack of group entries (outer → innermost) covering the resolved route. */
  stack: PageGroupStackEntry[];
  /** Input scope for each stack level's chrome bands, same indexing as `stack`. */
  chromeScopes: (InputScopeValue | null)[];
  page: PageConfig;
  /** Input scope for the active page's own widgets. */
  pageScope: InputScopeValue | null;
}

/**
 * Render the active branch from the outermost group down to the active page,
 * wrapping each level in its `PageGroupShell`. Each shell receives the stack
 * slice that ends at its own level — so widgets in that shell's header/footer
 * default to that shell's group (not the deepest one).
 */
function ActiveBranch({ stack, chromeScopes, page, pageScope }: ActiveBranchProps) {
  function buildAt(level: number): ReactNode {
    if (level >= stack.length) return <PageContent page={page} inputScope={pageScope} />;
    const entry = stack[level];
    return (
      <PageGroupShell
        key={entry.group.id}
        group={entry.group}
        chromeStack={stack.slice(0, level + 1)}
        chromeScope={chromeScopes[level] ?? null}
        activePageId={page.id}
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
  /** Input scope for the chrome bands — this group's parameters and its
   *  ancestors', but never the active page's. */
  chromeScope: InputScopeValue | null;
  /** Deepest active page under this group — the page its chrome bands decorate. */
  activePageId: string;
  children: ReactNode;
}

function PageGroupShell({
  group,
  chromeStack,
  chromeScope,
  activePageId,
  children,
}: PageGroupShellProps) {
  const header = group.header ?? [];
  const footer = group.footer ?? [];
  // Chromeless groups still expose `data-page-group-id` via a layout-neutral
  // wrapper (`display: contents`) so tooling can find every group in the tree,
  // and the active page keeps flexing against `.hmi-main` directly.
  if (header.length === 0 && footer.length === 0) {
    return (
      <div className="hmi-page-group-mark" data-page-group-id={group.id}>
        {children}
      </div>
    );
  }
  // Header and footer are the same band under the same three providers; a
  // provider added to one and not the other is invisible until a group renders
  // the band that was missed.
  const band = (Tag: 'header' | 'footer', widgets: WidgetConfig[]) =>
    widgets.length > 0 && (
      <Tag className={`hmi-page-group-shell__${Tag}`} {...COLUMN_FLOW}>
        <HostPageContext.Provider value={activePageId}>
          <PageGroupStackContext.Provider value={chromeStack}>
            <InputScopeContext.Provider value={chromeScope}>
              {widgets.map((widget) => (
                <WidgetRenderer key={widget.id} node={widget} />
              ))}
            </InputScopeContext.Provider>
          </PageGroupStackContext.Provider>
        </HostPageContext.Provider>
      </Tag>
    );

  return (
    <div className="hmi-page-group-shell" data-page-group-id={group.id}>
      {band('header', header)}
      <div className="hmi-page-group-shell__content">{children}</div>
      {band('footer', footer)}
    </div>
  );
}

interface PageContentProps {
  page: PageConfig;
  /** Scope published to the page's own widgets: the values supplied to the
   *  overlay, with the page's declared defaults under them and its groups'
   *  under those. Computed by the view, which holds the whole group trail. */
  inputScope: InputScopeValue | null;
}

/** Per-page-visit answer to "is this page's widget code in memory?" — see
 *  PageContent for why both halves are keyed by page id. */
interface PageModuleVisit {
  pageId: string;
  ready: boolean;
  timedOut: boolean;
}

// Safety valve for both halves of the reveal wait: the module load, and (below)
// the page's own content fetch. Widget modules are local files, so this mostly
// covers a fetch that never lands at all; the wait is long enough that a page
// still pulling widget code is never revealed half-built for being merely slow.
// What the reveal then shows is the rest of the page with a hole where the
// stuck widget is — every widget module keeps its own `fallback={null}`
// boundary, so nothing escalates back onto this spinner. A page whose content
// fetch itself failed reveals the same way: `hydrated` never turns true on its
// own, so this valve is the only way back short of navigating away and back.
const MODULES_WAIT_MS = 5000;

function PageContent({ page, inputScope }: PageContentProps) {
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
  // Not gated on `hydrated`: a page whose content fetch failed never sets it,
  // and this is the only clock counting down for that half too.
  useEffect(() => {
    if (visit.ready) return;
    const t = setTimeout(
      () => setVisit((v) => (v.pageId === page.id ? { ...v, timedOut: true } : v)),
      MODULES_WAIT_MS,
    );
    return () => clearTimeout(t);
  }, [visit.ready, page.id]);
  // Answered during render, not only from the effect above: navigating back to
  // a page whose modules are all in memory would otherwise flash the body
  // spinner for the one frame before effects run. The walk only happens while
  // the page is still waiting — once latched, the two booleans short-circuit it.
  // `timedOut` alone (without `hydrated`) is what reveals a page stuck on a
  // failed content fetch instead of spinning until it's navigated away from.
  const ready = visit.timedOut || (hydrated && (visit.ready || widgetModulesLoaded(nodes)));
  const renderWidget = (widget: WidgetConfig) => <WidgetRenderer key={widget.id} node={widget} />;
  return (
    <HostPageContext.Provider value={page.id}>
      <InputScopeContext.Provider value={inputScope}>
        <div className="hmi-page" data-page-id={page.id}>
          {ready ? (
            <Suspense fallback={<ContentSpinner />}>
              <ComponentSelfSuspenseContext.Provider value={false}>
                {page.showHeader && (
                  <header
                    className="hmi-page__header"
                    {...COLUMN_FLOW}
                  >
                    {(sections.header ?? []).map(renderWidget)}
                  </header>
                )}
                <main
                  className="hmi-page__content"
                  {...COLUMN_FLOW}
                >
                  <WindowedContent items={sections.content ?? []} render={renderWidget} />
                </main>
                {page.showFooter && (
                  <footer
                    className="hmi-page__footer"
                    {...COLUMN_FLOW}
                  >
                    {(sections.footer ?? []).map(renderWidget)}
                  </footer>
                )}
              </ComponentSelfSuspenseContext.Provider>
            </Suspense>
          ) : (
            <ContentSpinner />
          )}
        </div>
      </InputScopeContext.Provider>
    </HostPageContext.Provider>
  );
}
