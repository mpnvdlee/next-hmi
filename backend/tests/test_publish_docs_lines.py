"""``build/publish-docs.py`` keeps one docs copy per minor line, and a patch for
an older line must not take over the root the newest line serves."""

import importlib.util
import json
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[2] / "build" / "publish-docs.py"


@pytest.fixture
def publish(monkeypatch):
    spec = importlib.util.spec_from_file_location("publish_docs", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    def fake_render(out_dir, version, base_url, *, archived):
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "index.html").write_text(version)

    monkeypatch.setattr(module, "render", fake_render)
    return module


def _versions(site: Path) -> list[tuple[str, str]]:
    data = json.loads((site / "versions.json").read_text())
    return [(e["version"], e["path"]) for e in data["versions"]]


def test_patch_overwrites_its_line(publish, monkeypatch, tmp_path):
    monkeypatch.setattr(
        publish, "released_tags", lambda: ["v1.0.1", "v1.0.0", "v0.0.1"]
    )
    assert publish.main(["x", str(tmp_path), "1.0.1"]) == 0
    monkeypatch.setattr(
        publish, "released_tags", lambda: ["v1.0.2", "v1.0.1", "v0.0.1"]
    )
    assert publish.main(["x", str(tmp_path), "1.0.2"]) == 0

    assert sorted(p.name for p in tmp_path.iterdir() if p.is_dir()) == ["v1.0"]
    assert (tmp_path / "v1.0" / "index.html").read_text() == "1.0.2"
    assert (tmp_path / "index.html").read_text() == "1.0.2"
    assert _versions(tmp_path) == [("1.0.2", "/docs"), ("0.0.1", "/docs/v0.0")]


def test_older_line_patch_leaves_the_root(publish, monkeypatch, tmp_path):
    monkeypatch.setattr(publish, "released_tags", lambda: ["v1.1.0", "v1.0.2"])
    assert publish.main(["x", str(tmp_path), "1.1.0"]) == 0
    monkeypatch.setattr(
        publish, "released_tags", lambda: ["v1.1.0", "v1.0.3", "v1.0.2"]
    )
    assert publish.main(["x", str(tmp_path), "1.0.3"]) == 0

    assert (tmp_path / "index.html").read_text() == "1.1.0"
    assert (tmp_path / "v1.0" / "index.html").read_text() == "1.0.3"
    assert _versions(tmp_path) == [("1.1.0", "/docs"), ("1.0.3", "/docs/v1.0")]


def test_candidate_of_a_new_line_takes_the_root(publish, monkeypatch, tmp_path):
    monkeypatch.setattr(publish, "released_tags", lambda: ["v1.0.2"])
    assert publish.main(["x", str(tmp_path), "1.1.0-rc.1"]) == 0

    assert (tmp_path / "index.html").read_text() == "1.1.0-rc.1"
    assert _versions(tmp_path) == [("1.1.0-rc.1", "/docs"), ("1.0.2", "/docs/v1.0")]
