import { lazy, Suspense, type ComponentProps } from 'react';

// Lazy boundary for the directory browser (backlog item 22). DirectoryBrowserModal
// statically imports @phosphor-icons/react, and the manualChunks config groups
// every phosphor icon into one ~50 kB gzip `vendor-icons` chunk — so a single
// static edge to it pulls the whole chunk into a route's static closure. This
// modal is the *only* such edge reachable from the manager route (via the three
// project modals below), and it pushed manager over its 150 kB budget.
//
// The browser is a nested modal rendered only after the user clicks "Browse…",
// so deferring its chunk (icons included) to that click costs nothing and drops
// vendor-icons out of the manager closure entirely. Editor/config routes already
// load vendor-icons eagerly via their own chrome icons, so nothing regresses
// there. Importers use this wrapper in place of DirectoryBrowserModal; the render
// site is unchanged because props forward through verbatim.
const DirectoryBrowserModal = lazy(() => import('./DirectoryBrowserModal'));

export default function DirectoryBrowserModalLazy(
  props: ComponentProps<typeof DirectoryBrowserModal>,
) {
  return (
    <Suspense fallback={null}>
      <DirectoryBrowserModal {...props} />
    </Suspense>
  );
}
