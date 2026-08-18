"""End-to-end tests for the MCP page write tools.

Exercises the full 0-5 flow: idempotency → validate → confirm → lock-protected
apply → notify → cache. Storage is redirected to ``tmp_path`` via monkeypatch.
"""

import asyncio
from pathlib import Path

import core.storage as storage
import core.validation.structure as structure
import pytest
from mcp_server import idempotency, locks
from mcp_server.tools import pages as pages_tools
from mcp_server.tools._common import merge_patch


@pytest.fixture(autouse=True)
def _isolated_workspace(monkeypatch, tmp_path: Path, live_project_root: Path):
    storage.ensure_active_project_dirs()
    widget_build = tmp_path / "widget-build"
    widget_build.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(storage, "WIDGET_BUILD_DIR", widget_build)
    monkeypatch.setattr(structure, "WIDGET_SCHEMAS_PATH", widget_build / "widget-schemas.json")

    # Write a minimal manifest so validators recognize the widget types we use.
    manifest = {
        "version": 2,
        "builtin": {
            "Container": {
                "name": "Container",
                "category": "Layout",
                "schema": {"title": {"type": "string"}},
            },
            "Button": {
                "name": "Button",
                "category": "Controls",
                "schema": {"label": {"type": "string"}, "actions": {"type": "actions"}},
            },
        },
        "custom": {},
    }
    import json
    (widget_build / "widget-schemas.json").write_text(json.dumps(manifest), encoding="utf-8")

    locks.reset_for_tests()
    idempotency.reset_for_tests()
    yield
    locks.reset_for_tests()
    idempotency.reset_for_tests()


def _run(coro):
    return asyncio.run(coro)


def test_merge_patch_applies_nested_null_when_replacing_a_scalar():
    target = {"settings": "legacy"}
    merge_patch(target, {"settings": {"obsolete": None}})
    assert target == {"settings": {}}


def test_pages_create_writes_file_and_returns_slug():
    response = _run(pages_tools.pages_create(title="Home"))
    assert response["result"] == "applied"
    page_id = response["page_id"]
    assert page_id == "home"
    assert (storage.active_pages_dir() / f"{page_id}.json").exists()


def test_pages_create_registers_in_config_index():
    response = _run(pages_tools.pages_create(title="Home"))
    page_id = response["page_id"]
    config = storage.read_json(storage.active_config_dir() / "config.json")
    assert {"id": page_id, "type": "page"} in config["pages"]


def test_pages_create_defaults_title_to_new_page():
    response = _run(pages_tools.pages_create())
    page = storage.read_json(storage.active_pages_dir() / f"{response['page_id']}.json")
    assert page["title"] == "New Page"


def test_pages_add_widget_defaults_name_from_manifest_name():
    created = _run(pages_tools.pages_create())
    page_id = created["page_id"]
    add = _run(
        pages_tools.pages_add_widget(
            page_id=page_id,
            widget={"type": "Button"},
            index=0,
        )
    )
    page = storage.read_json(storage.active_pages_dir() / f"{page_id}.json")
    assert page["sections"]["content"][0]["name"] == "Button"
    assert add["widget_id"]


def test_pages_add_widget_defaults_children_for_container():
    created = _run(pages_tools.pages_create())
    page_id = created["page_id"]
    _run(
        pages_tools.pages_add_widget(
            page_id=page_id,
            widget={"type": "Container"},
            index=0,
        )
    )
    page = storage.read_json(storage.active_pages_dir() / f"{page_id}.json")
    container = page["sections"]["content"][0]
    assert container["children"] == []


def test_pages_add_widget_preserves_explicit_name_and_children():
    created = _run(pages_tools.pages_create())
    page_id = created["page_id"]
    _run(
        pages_tools.pages_add_widget(
            page_id=page_id,
            widget={"type": "Container", "name": "Wrapper", "children": []},
            index=0,
        )
    )
    page = storage.read_json(storage.active_pages_dir() / f"{page_id}.json")
    assert page["sections"]["content"][0]["name"] == "Wrapper"


def test_pages_add_widget_assigns_slug_and_validates():
    created = _run(pages_tools.pages_create())
    page_id = created["page_id"]
    response = _run(
        pages_tools.pages_add_widget(
            page_id=page_id,
            widget={"type": "Container", "properties": {"title": "Home"}},
            index=0,
        )
    )
    assert response["result"] == "applied"
    assert response["widget_id"] == "container"
    page = storage.read_json(storage.active_pages_dir() / f"{page_id}.json")
    assert page["sections"]["content"][0]["id"] == response["widget_id"]


def test_pages_add_widget_rejects_unknown_type():
    from core.exceptions import ConfigValidationError

    created = _run(pages_tools.pages_create())
    page_id = created["page_id"]
    with pytest.raises(ConfigValidationError):
        _run(
            pages_tools.pages_add_widget(
                page_id=page_id,
                widget={"type": "DoesNotExist"},
                index=0,
            )
        )


def test_pages_add_widget_position_args_require_exactly_one():
    from core.exceptions import ConfigValidationError

    created = _run(pages_tools.pages_create())
    page_id = created["page_id"]
    with pytest.raises(ConfigValidationError):
        _run(
            pages_tools.pages_add_widget(
                page_id=page_id,
                widget={"type": "Container"},
            )
        )


def test_pages_set_widget_property_via_json_pointer():
    created = _run(pages_tools.pages_create())
    page_id = created["page_id"]
    add = _run(
        pages_tools.pages_add_widget(
            page_id=page_id,
            widget={"type": "Container", "properties": {"title": "old"}},
            index=0,
        )
    )
    wid = add["widget_id"]
    _run(
        pages_tools.pages_set_widget_property(
            page_id=page_id,
            widget_id=wid,
            property="/title",
            value="new",
        )
    )
    page = storage.read_json(storage.active_pages_dir() / f"{page_id}.json")
    assert page["sections"]["content"][0]["properties"]["title"] == "new"


def test_pages_set_widget_property_returns_warnings_for_unknown_var():
    created = _run(pages_tools.pages_create())
    page_id = created["page_id"]
    add = _run(
        pages_tools.pages_add_widget(
            page_id=page_id,
            widget={"type": "Button", "properties": {"label": "x"}},
            index=0,
        )
    )
    wid = add["widget_id"]
    response = _run(
        pages_tools.pages_set_widget_property(
            page_id=page_id,
            widget_id=wid,
            property="/label",
            value={"$var": {"path": "DoesNotExist:X/Y"}},
        )
    )
    assert response["result"] == "applied"
    assert any("unknown datasource" in w["message"] for w in response["warnings"])


def test_pages_add_widget_returns_empty_warnings_when_clean():
    created = _run(pages_tools.pages_create())
    page_id = created["page_id"]
    response = _run(
        pages_tools.pages_add_widget(
            page_id=page_id,
            widget={"type": "Button", "properties": {"label": "ok"}},
            index=0,
        )
    )
    assert response["result"] == "applied"
    assert response["warnings"] == []


def test_pages_delete_is_two_step_and_removes_from_index():
    created = _run(pages_tools.pages_create())
    page_id = created["page_id"]
    # Dry-run
    dry = _run(pages_tools.pages_delete(page_id=page_id))
    assert dry["result"] == "dry_run"
    assert (storage.active_pages_dir() / f"{page_id}.json").exists()
    config = storage.read_json(storage.active_config_dir() / "config.json")
    assert any(n.get("id") == page_id for n in config["pages"])
    # Confirmed delete
    applied = _run(pages_tools.pages_delete(page_id=page_id, confirm=True))
    assert applied["result"] == "applied"
    assert not (storage.active_pages_dir() / f"{page_id}.json").exists()
    config = storage.read_json(storage.active_config_dir() / "config.json")
    assert not any(n.get("id") == page_id for n in config["pages"])


def test_pages_delete_widget_dry_run_then_apply():
    created = _run(pages_tools.pages_create())
    page_id = created["page_id"]
    add = _run(
        pages_tools.pages_add_widget(
            page_id=page_id,
            widget={"type": "Container", "properties": {"title": "X"}},
            index=0,
        )
    )
    wid = add["widget_id"]
    dry = _run(pages_tools.pages_delete_widget(page_id=page_id, widget_id=wid))
    assert dry["result"] == "dry_run"
    page = storage.read_json(storage.active_pages_dir() / f"{page_id}.json")
    assert any(w.get("id") == wid for w in page["sections"]["content"])

    applied = _run(
        pages_tools.pages_delete_widget(page_id=page_id, widget_id=wid, confirm=True)
    )
    assert applied["result"] == "applied"
    page = storage.read_json(storage.active_pages_dir() / f"{page_id}.json")
    assert page["sections"]["content"] == []


def test_idempotency_returns_cached_response():
    response_1 = _run(
        pages_tools.pages_create(title="X", idempotency_key="idk-1")
    )
    # Repeat with the same key — should return the cached response with the
    # same UUID page_id, not generate a second page.
    response_2 = _run(
        pages_tools.pages_create(title="X", idempotency_key="idk-1")
    )
    assert response_1 == response_2
    config = storage.read_json(storage.active_config_dir() / "config.json")
    matches = [n for n in config["pages"] if n.get("id") == response_1["page_id"]]
    assert len(matches) == 1


def test_pages_set_metadata_merge_patch_null_deletes():
    created = _run(pages_tools.pages_create(title="Home", route="/home"))
    page_id = created["page_id"]
    _run(
        pages_tools.pages_set_metadata(
            page_id=page_id,
            patch={"title": "Renamed", "route": None},
        )
    )
    page = storage.read_json(storage.active_pages_dir() / f"{page_id}.json")
    assert page["title"] == "Renamed"
    assert "route" not in page


# ── Missing/unindexed page mutation semantics (item 10) ─────────────────────


def test_pages_set_metadata_on_absent_id_is_not_found_and_writes_nothing():
    from core.exceptions import ConfigNotFoundError

    with pytest.raises(ConfigNotFoundError):
        _run(pages_tools.pages_set_metadata(page_id="nope", patch={"title": "X"}))
    assert list(storage.active_pages_dir().glob("*.json")) == []


def test_pages_add_widget_on_absent_id_is_not_found_and_writes_nothing():
    from core.exceptions import ConfigNotFoundError

    with pytest.raises(ConfigNotFoundError):
        _run(
            pages_tools.pages_add_widget(
                page_id="nope", widget={"type": "Button"}, index=0
            )
        )
    assert list(storage.active_pages_dir().glob("*.json")) == []


def test_pages_set_widget_property_on_absent_id_is_not_found_and_writes_nothing():
    from core.exceptions import ConfigNotFoundError

    with pytest.raises(ConfigNotFoundError):
        _run(
            pages_tools.pages_set_widget_property(
                page_id="nope", widget_id="w1", property="/label", value="x"
            )
        )
    assert list(storage.active_pages_dir().glob("*.json")) == []


def test_pages_delete_widget_on_absent_id_is_not_found_and_writes_nothing():
    from core.exceptions import ConfigNotFoundError

    with pytest.raises(ConfigNotFoundError):
        _run(
            pages_tools.pages_delete_widget(page_id="nope", widget_id="w1", confirm=True)
        )
    assert list(storage.active_pages_dir().glob("*.json")) == []


def test_pages_add_widget_on_unindexed_file_is_not_found():
    """A page file present on disk but absent from the config.json index —
    an index/file mismatch — mutates as not-found rather than editing the
    orphan file (only pages_create may create *and* index a page)."""
    from core.exceptions import ConfigNotFoundError

    orphan = {"id": "orphan", "title": "Orphan", "sections": {"content": []}}
    storage.write_json(storage.active_pages_dir() / "orphan.json", orphan)
    # No config.json exists yet in this fresh workspace, so the page index is
    # empty — "orphan" is unambiguously unindexed.

    with pytest.raises(ConfigNotFoundError):
        _run(
            pages_tools.pages_add_widget(
                page_id="orphan", widget={"type": "Button"}, index=0
            )
        )
    # The orphan file is untouched — no widget was silently added to it.
    unchanged = storage.read_json(storage.active_pages_dir() / "orphan.json")
    assert unchanged == orphan


def test_pages_add_widget_retry_after_not_found_stays_not_found():
    """A not-found error is never cached as a successful response, so a retry
    with the same idempotency_key raises again instead of resurrecting a
    cached success for a page that was never created."""
    from core.exceptions import ConfigNotFoundError

    for _ in range(2):
        with pytest.raises(ConfigNotFoundError):
            _run(
                pages_tools.pages_add_widget(
                    page_id="nope",
                    widget={"type": "Button"},
                    index=0,
                    idempotency_key="retry-1",
                )
            )
    assert list(storage.active_pages_dir().glob("*.json")) == []


def test_concurrent_mutations_on_missing_page_both_fail_closed():
    """Two concurrent mutations against the same missing page_id are
    serialized by the per-page lock and both resolve to not-found — neither
    wins a race to implicitly create the page."""
    from core.exceptions import ConfigNotFoundError

    async def _both():
        return await asyncio.gather(
            pages_tools.pages_add_widget(page_id="nope", widget={"type": "Button"}, index=0),
            pages_tools.pages_set_metadata(page_id="nope", patch={"title": "X"}),
            return_exceptions=True,
        )

    results = _run(_both())
    assert all(isinstance(r, ConfigNotFoundError) for r in results)
    assert list(storage.active_pages_dir().glob("*.json")) == []
