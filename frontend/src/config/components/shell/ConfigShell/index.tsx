import './style.css';
import { useEffect, useMemo } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { useProjectStore } from '@shared/store/projectStore';
import VariableBindingPicker from '@config/components/editor/VariableBindingPicker';
import WidgetPropPicker from '@config/components/editor/WidgetPropPicker';
import IconSourcePicker from '@config/components/editor/IconSourcePicker';
import ImageSourcePicker from '@config/components/editor/ImageSourcePicker';
import { ConfigToastStack } from '../ConfigToastStack';
import { ConfigUpdatedBanner } from '../ConfigUpdatedBanner';
import ConfigTopBar from '../ConfigTopBar';
import SaveWarningsPill from '../SaveWarningsPill';
import { editorPath, getArea, projectSlug, withBase } from '@shared/utils/runtimeBase';
import {
  NotePencil,
  Database,
  Globe,
  ShieldCheck,
  Users,
  Palette,
  Bell,
  Cube,
  ChartLine,
  Flask,
} from '@phosphor-icons/react';
import { useUsersDomainStore } from '@config/store/domains/usersDomainStore';
import { useSaveErrorToast } from './useSaveErrorToast';
import Button from '@config/components/ui/Button';

interface NavItem {
  to: string;
  icon: React.ReactNode;
  title: string;
  end?: boolean;
}

function useNavItems(): NavItem[] {
  return useMemo(() => {
    // Paths are area-aware: root-relative under the /editor/<slug> base, under
    // /config on the legacy mount (see editorPath).
    const items: NavItem[] = [
      {
        to: editorPath('/editor'),
        icon: <NotePencil size={22} weight="fill" />,
        title: 'Editor',
        end: true,
      },
      {
        to: editorPath('/components'),
        icon: <Cube size={22} weight="fill" />,
        title: 'Components',
      },
      {
        to: editorPath('/datasources'),
        icon: <Database size={22} weight="fill" />,
        title: 'Datasources',
      },
      {
        to: editorPath('/translations'),
        icon: <Globe size={22} weight="fill" />,
        title: 'Translations',
      },
      { to: editorPath('/theme'), icon: <Palette size={22} weight="fill" />, title: 'Themes' },
      { to: editorPath('/users'), icon: <Users size={22} weight="fill" />, title: 'Users' },
      { to: editorPath('/admin'), icon: <ShieldCheck size={22} weight="fill" />, title: 'Admin' },
    ];
    // Runtime-data sections sit after Theme (index 4), next to each other.
    items.splice(
      5,
      0,
      { to: editorPath('/alarms'), icon: <Bell size={22} weight="fill" />, title: 'Alarms' },
      { to: editorPath('/recipes'), icon: <Flask size={22} weight="fill" />, title: 'Recipes' },
      {
        to: editorPath('/historian'),
        icon: <ChartLine size={22} weight="fill" />,
        title: 'Historian',
      },
    );
    return items;
  }, []);
}

export default function ConfigShell() {
  const navItems = useNavItems();
  const dirty = useProjectStore((s) => s.dirty);
  const saving = useProjectStore((s) => s.saving);
  const past = useProjectStore((s) => s.past);
  const future = useProjectStore((s) => s.future);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const saveAll = useProjectStore((s) => s.saveAll);
  const usersDirty = useUsersDomainStore((s) => s.dirty);
  const usersSaving = useUsersDomainStore((s) => s.saving);
  const saveUsers = useUsersDomainStore((s) => s.save);
  const discardUsers = useUsersDomainStore((s) => s.discard);

  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  useSaveErrorToast();

  // Warn before closing/refreshing when there are unsaved changes
  useEffect(() => {
    if (!dirty && !usersDirty) return;
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dirty, usersDirty]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      if (e.key === 's') {
        e.preventDefault();
        if (dirty && !saving) saveAll();
      } else if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (canUndo) undo();
      } else if (e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        if (canRedo) redo();
      } else if (e.key === 'y') {
        e.preventDefault();
        if (canRedo) redo();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dirty, saving, canUndo, canRedo, undo, redo, saveAll]);

  return (
    <div className="cfg-shell">
      <ConfigTopBar
        leftContent={<SaveWarningsPill />}
        status={
          <>
            {dirty && !saving && <span className="cfg-header__unsaved">● Unsaved changes</span>}
            {usersDirty && <span className="cfg-header__unsaved">● Unsaved security changes</span>}
          </>
        }
      >
        {usersDirty && (
          <>
            <Button variant="ghost" disabled={usersSaving} onClick={discardUsers}>
              Discard users
            </Button>
            <Button
              variant="primary"
              disabled={usersSaving}
              onClick={() => void saveUsers().catch(() => undefined)}
            >
              {usersSaving ? 'Saving users…' : 'Save users'}
            </Button>
          </>
        )}
        <button
          className="cfg-header__btn"
          title="Undo (Ctrl+Z)"
          disabled={!canUndo}
          onClick={undo}
          aria-label="Undo"
        >
          ↶
        </button>
        <button
          className="cfg-header__btn"
          title="Redo (Ctrl+Y / Ctrl+Shift+Z)"
          disabled={!canRedo}
          onClick={redo}
          aria-label="Redo"
        >
          ↷
        </button>
        <button
          className={`cfg-header__save-btn${dirty ? ' cfg-header__save-btn--dirty' : ''}`}
          disabled={saving}
          onClick={saveAll}
          title="Save all changes"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          className="cfg-header__save-btn"
          onClick={() => {
            const slug = getArea() === 'editor' ? projectSlug() : null;
            window.open(slug ? `/runtime/${slug}/` : withBase('/'), '_blank');
          }}
          title="Open live version"
          aria-label="Open live version"
        >
          ↗ Live View
        </button>
        {/* Push-to-peer is deferred: the peers API still assumes a single
            "live project" per side and needs reworking for the running-set
            model (manager-to-manager, explicit per-project selection). */}
      </ConfigTopBar>

      <ConfigUpdatedBanner />

      <div className="cfg-shell__body">
        <nav className="cfg-nav" aria-label="Config navigation">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `cfg-nav__link${isActive ? ' cfg-nav__link--active' : ''}`
              }
              title={item.title}
              aria-label={item.title}
            >
              {item.icon}
            </NavLink>
          ))}
        </nav>
        <div className="cfg-shell__content">
          <Outlet />
        </div>
      </div>
      <VariableBindingPicker />
      <WidgetPropPicker />
      <IconSourcePicker />
      <ImageSourcePicker />
      <ConfigToastStack />
    </div>
  );
}
