"""
Theme manager — per-theme persistence, validation, and the default-theme pointer.

Each theme is stored as ``<project_root>/themes/<id>.json`` holding a bare
``ThemeConfig``. The id is the file stem. The author-chosen *default* theme id
is recorded in ``config.json``'s
embedded ``project`` block under ``defaultTheme`` (read-and-preserve, matching
``config_api``). Default token values come from the model layer (``ThemeConfig``).

Runtime theme switching is a client-side concern; the backend only knows the
default. On first access the manager seeds ``themes/default.json`` from
defaults if no theme exists yet. A theme file is read as-is: there is no
legacy shape and no read-time normalization.
"""

import logging
import threading

from core.exceptions import ThemeConflictError, ThemeNotFoundError
from core.ids import slug_id
from core.storage import (
    active_config_dir,
    active_themes_dir,
    read_json,
    write_json,
)
from models.theme import ThemeConfig, validate_theme

logger = logging.getLogger(__name__)
_lock = threading.RLock()

_PROJECT_KEY = "project"
_DEFAULT_KEY = "defaultTheme"


def _config_path():
    return active_config_dir() / "config.json"


def _theme_path(theme_id: str):
    return active_themes_dir() / f"{theme_id}.json"


class ThemeManager:
    """Singleton manager for per-theme persistence and the default pointer."""

    # ── Seeding ──────────────────────────────────────────────────────────────

    def _ensure_seeded(self) -> None:
        """Guarantee at least one theme exists."""
        themes_dir = active_themes_dir()
        if themes_dir.exists() and any(themes_dir.glob("*.json")):
            return
        themes_dir.mkdir(parents=True, exist_ok=True)
        write_json(_theme_path("default"), ThemeConfig().model_dump())
        self._set_default_raw("default")
        logger.info("Seeded themes/default.json")

    # ── Listing ─────────────────────────────────────────────────────────────

    def list_ids(self) -> list[str]:
        with _lock:
            self._ensure_seeded()
            return sorted(f.stem for f in active_themes_dir().glob("*.json"))

    def list_all(self) -> list[tuple[str, ThemeConfig]]:
        with _lock:
            self._ensure_seeded()
            result: list[tuple[str, ThemeConfig]] = []
            for f in sorted(active_themes_dir().glob("*.json")):
                try:
                    result.append((f.stem, self._read(f)))
                except Exception as exc:
                    logger.error("Failed to load theme %s: %s", f.stem, exc)
            return result

    # ── Read ────────────────────────────────────────────────────────────────

    def _read(self, path) -> ThemeConfig:
        return ThemeConfig.model_validate(read_json(path))

    def get(self, theme_id: str) -> ThemeConfig:
        with _lock:
            self._ensure_seeded()
            path = _theme_path(theme_id)
            if not path.exists():
                raise ThemeNotFoundError(f"Theme '{theme_id}' not found")
            return self._read(path)

    # ── Default pointer ─────────────────────────────────────────────────────

    def _set_default_raw(self, theme_id: str) -> None:
        """Write ``project.defaultTheme`` into config.json, preserving everything else."""
        path = _config_path()
        config = read_json(path) if path.exists() else {}
        if not isinstance(config, dict):
            config = {}
        project = config.get(_PROJECT_KEY)
        if not isinstance(project, dict):
            project = {}
        project[_DEFAULT_KEY] = theme_id
        config[_PROJECT_KEY] = project
        write_json(path, config)

    def get_default_id(self) -> str:
        with _lock:
            ids = self.list_ids()
            path = _config_path()
            if path.exists():
                config = read_json(path)
                if isinstance(config, dict):
                    project = config.get(_PROJECT_KEY)
                    if isinstance(project, dict):
                        configured = project.get(_DEFAULT_KEY)
                        if isinstance(configured, str) and configured in ids:
                            return configured
            return ids[0] if ids else "default"

    def set_default_id(self, theme_id: str) -> None:
        with _lock:
            self._ensure_seeded()
            if not _theme_path(theme_id).exists():
                raise ThemeNotFoundError(f"Theme '{theme_id}' not found")
            self._set_default_raw(theme_id)
            logger.info("Set default theme to '%s'", theme_id)

    # ── Write ───────────────────────────────────────────────────────────────

    def save(self, theme_id: str, theme: ThemeConfig) -> ThemeConfig:
        """Create or replace the theme at *theme_id*."""
        with _lock:
            self._ensure_seeded()
            validation = validate_theme(theme)
            if not validation.valid:
                raise ValueError(f"Theme validation failed: {validation.errors}")
            write_json(_theme_path(theme_id), theme.model_dump())
            logger.info("Saved theme '%s'", theme_id)
            return theme

    def create(self, name: str, source_id: str | None = None) -> tuple[str, ThemeConfig]:
        """Create a new theme from *source_id* (or defaults), id slugged from *name*."""
        with _lock:
            self._ensure_seeded()
            existing = set(self.list_ids())
            if source_id is not None and source_id not in existing:
                raise ThemeNotFoundError(f"Theme '{source_id}' not found")
            new_id = slug_id(name, existing)
            config = self.get(source_id) if source_id else ThemeConfig()
            write_json(_theme_path(new_id), config.model_dump())
            logger.info("Created theme '%s'%s", new_id, f" from '{source_id}'" if source_id else "")
            return new_id, config

    def delete(self, theme_id: str) -> None:
        with _lock:
            self._ensure_seeded()
            path = _theme_path(theme_id)
            if not path.exists():
                raise ThemeNotFoundError(f"Theme '{theme_id}' not found")
            if len(self.list_ids()) <= 1:
                raise ThemeConflictError("Cannot delete the only theme")
            path.unlink()
            logger.info("Deleted theme '%s'", theme_id)
            if self.get_default_id() == theme_id:
                self._set_default_raw(self.list_ids()[0])


# Singleton instance
theme_manager = ThemeManager()
