import { useEffect, useRef, useState } from 'react';
import { apiJson } from '@shared/utils/api';
import { getArea, projectSlug } from '@shared/utils/runtimeBase';
import LogoMark from '@shared/components/LogoMark';
import './style.css';

interface ProjectLite {
  id: string;
  name: string;
}
interface ProjectsResponse {
  projects: ProjectLite[];
}
interface RunningInstance {
  id: string;
  name: string;
  status: string;
}

/**
 * The app's top-left navigation: a plain logo mark + "NEXT HMI" brand followed
 * by the current destination label (Projects / Editor / Settings), which doubles
 * as the trigger for a dropdown listing the primary destinations. Rendered by
 * both the manager SPA and the per-project editor, so it lives in @shared.
 *
 * Links are plain anchors, not router NavLinks: Projects/Settings are manager-SPA
 * pages at the origin root while the editor is a separate document proxied under
 * /editor/<slug>/, so moving between them is a full navigation that must bypass
 * the per-area router basename.
 */
export default function AppTopBarNav() {
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '/';
  const area = getArea();
  const slug = projectSlug();
  const [open, setOpen] = useState(false);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [running, setRunning] = useState<RunningInstance[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Running instances for the Editor menu section. The supervisor lives only on
  // the manager app at the origin root, so this hits an absolute path (bypassing
  // the editor's proxy base) and rides the same-origin manager session cookie.
  // It degrades to an empty list wherever that endpoint isn't reachable (e.g.
  // the dev server, which proxies to a bare instance app).
  useEffect(() => {
    if (!open) return;
    let active = true;
    fetch('/api/manager/running')
      .then((r) => (r.ok ? (r.json() as Promise<{ instances?: RunningInstance[] }>) : null))
      .then((data) => {
        if (!active || !data) return;
        setRunning((data.instances ?? []).filter((i) => i.status === 'running'));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [open]);

  // In the editor the page title is the project's name, which the API carries
  // keyed by slug; on the manager pages it is derived from the path below.
  useEffect(() => {
    if (area !== 'editor' || !slug) return;
    let active = true;
    apiJson<ProjectsResponse>('/api/projects')
      .then((r) => {
        if (!active) return;
        setProjectName(r.projects?.find((p) => p.id === slug)?.name ?? null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [area, slug]);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const itemClass = (on: boolean) => `app-brand__item${on ? ' app-brand__item--active' : ''}`;

  const triggerLabel =
    area === 'editor' ? 'Editor' : pathname.startsWith('/settings') ? 'Settings' : 'Projects';

  return (
    <div className="app-brand" ref={wrapRef}>
      <span className="app-brand__brand">
        <LogoMark className="app-brand__logo" />
        <span className="app-brand__name">
          <span className="app-brand__name-next">NEXT</span> HMI
        </span>
      </span>
      <div className="app-brand__nav">
        <button
          className="app-brand__btn"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Navigation menu"
        >
          <span className="app-brand__title">{triggerLabel}</span>
          <svg
            className="app-brand__caret"
            viewBox="0 0 12 12"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M3 4.5 6 7.5 9 4.5" fill="none" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        {area === 'editor' && projectName && (
          <span className="app-brand__title app-brand__project">
            <span className="app-brand__title-sep">|</span>
            {projectName}
          </span>
        )}
        {open && (
          <div className="app-brand__menu" role="menu">
            <a
              className={itemClass(pathname.startsWith('/projects'))}
              role="menuitem"
              href="/projects"
            >
              Projects
            </a>
            <div className="app-brand__menu-divider" role="separator" />
            {running.length > 0 ? (
              running.map((inst) => (
                <a
                  key={inst.id}
                  className={itemClass(area === 'editor' && slug === inst.id)}
                  role="menuitem"
                  href={`/editor/${inst.id}/`}
                >
                  Editor - {inst.name}
                </a>
              ))
            ) : (
              <span className="app-brand__placeholder">No running projects</span>
            )}
            <div className="app-brand__menu-divider" role="separator" />
            <a
              className={itemClass(pathname.startsWith('/settings'))}
              role="menuitem"
              href="/settings"
            >
              Settings
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
