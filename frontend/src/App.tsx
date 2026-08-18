import './app-loading.css';
import { lazy, Suspense } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { PageSpinner } from '@shared/components/Spinner';
import { getArea, getMode, routerBasename } from '@shared/utils/runtimeBase';

// AppInner (HMI/editor routing, the widget registry, and everything they pull
// in — including the recharts SDK loader) is lazy so a manager-mode session
// never statically reaches it and never pays its bundle cost (backlog item 22).
const AppInner = lazy(() => import('./AppInner'));
// The manager dashboard is the same SPA bundle served at the origin root
// (window.__NEXTHMI_MODE__ === 'manager'); project instances are proxied under
// /runtime/<slug>/ or /editor/<slug>/ and render the HMI/config app above.
const ManagerApp = lazy(() => import('./manager/ManagerApp'));

export default function App() {
  if (getMode() === 'manager') {
    return (
      <BrowserRouter basename={routerBasename()}>
        <Suspense fallback={<PageSpinner variant="cfg" />}>
          <ManagerApp />
        </Suspense>
      </BrowserRouter>
    );
  }
  return (
    <BrowserRouter basename={routerBasename()}>
      <Suspense fallback={<PageSpinner variant={getArea() === 'editor' ? 'cfg' : 'hmi'} />}>
        <AppInner />
      </Suspense>
    </BrowserRouter>
  );
}
