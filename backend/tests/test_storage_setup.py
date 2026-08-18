from pathlib import Path

import core.storage as storage


def test_ensure_active_project_dirs_creates_default_translation(live_project_root: Path) -> None:
    storage.ensure_active_project_dirs()

    default_csv = storage.active_translations_dir() / "Default.csv"
    assert default_csv.exists()
    rows = storage.read_csv(default_csv)
    assert rows == [["en-EN"]]


def test_ensure_active_project_dirs_creates_pages_directory(live_project_root: Path) -> None:
    storage.ensure_active_project_dirs()
    assert storage.active_pages_dir().is_dir()


def test_ensure_active_project_dirs_creates_external_libraries_directory(
    live_project_root: Path,
) -> None:
    storage.ensure_active_project_dirs()
    assert storage.active_external_libraries_dir().is_dir()
