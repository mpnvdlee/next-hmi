import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { PageSpinner } from '@shared/components/Spinner';
import { editorPath } from '@shared/utils/runtimeBase';
import { clearThemePreview } from '@shared/utils/themeTokens';
// Every config view renders below this router, so importing the stdlib
// manifest's editor half here is what guarantees a whole schema — labels,
// options, defaults — to the properties panel and the binding picker, whichever
// view reaches them. It costs the HMI routes nothing: they never load this
// module. The preview iframe route sits outside and needs none of it.
import '@hmi/registry/stdlibEditorMetadata';
import '../styles/config.css';

// At module scope, not in an effect: this runs before any config view renders,
// so the live-preview iframe EditorView mounts can never read a preview payload
// left behind by an earlier session. The preview route is a separate lazy chunk
// that never imports this module, so the iframe itself never clears the key.
clearThemePreview();

const EditorView = lazy(() => import('./EditorView'));
const VariablesView = lazy(() => import('./VariablesView'));
const TranslationsView = lazy(() => import('./TranslationsView'));
const AdminView = lazy(() => import('./AdminView'));
const UsersView = lazy(() => import('./UsersView'));
const ThemesView = lazy(() => import('./ThemesView'));
const AlarmsView = lazy(() => import('./AlarmsView'));
const HistorianView = lazy(() => import('./HistorianView'));
const RecipesView = lazy(() => import('./RecipesView'));
const ComponentsView = lazy(() => import('./ComponentsView'));
const ConfigShell = lazy(() => import('../components/shell/ConfigShell'));

export default function ConfigRoutes() {
  return (
    <Suspense fallback={<PageSpinner variant="cfg" />}>
      <Routes>
        <Route path="" element={<ConfigShell />}>
          <Route index element={<Navigate to={editorPath('/editor')} replace />} />
          <Route path="editor" element={<EditorView />} />
          <Route path="datasources" element={<VariablesView />} />
          <Route path="translations" element={<TranslationsView />} />
          <Route path="theme" element={<ThemesView />} />
          <Route path="alarms" element={<AlarmsView />} />
          <Route path="historian" element={<HistorianView />} />
          <Route path="recipes" element={<RecipesView />} />
          <Route path="components" element={<ComponentsView />} />
          <Route path="admin" element={<AdminView />} />
          <Route path="users" element={<UsersView />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
