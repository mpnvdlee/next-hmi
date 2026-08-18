import asyncio
import multiprocessing
import os
import time
from pathlib import Path

import core.storage as storage
import pytest
from core.exceptions import ConfigValidationError
from core.translations import translation_revision, translation_transaction
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _rest_add_worker(
    project_path: str,
    key: str,
    write_started,
    results,
    delay_write: bool,
) -> None:
    os.environ["NEXTHMI_ACTIVE_PROJECT_PATH"] = project_path
    from api import config_api
    from core.exceptions import ConfigConflictError

    if delay_write:
        original_write_csv = config_api.write_csv

        def delayed_write_csv(path, rows) -> None:
            write_started.set()
            time.sleep(0.35)
            original_write_csv(path, rows)

        config_api.write_csv = delayed_write_csv
    try:
        asyncio.run(config_api.add_translation({"key": key}, "Default"))
        results.put("applied")
    except ConfigConflictError:
        results.put("conflict")
    except Exception as exc:
        results.put(f"error:{type(exc).__name__}:{exc}")


def _mcp_add_worker(project_path: str, key: str, results) -> None:
    os.environ["NEXTHMI_ACTIVE_PROJECT_PATH"] = project_path
    from mcp_server.tools import translations as translation_tools

    async def ignore_change(**_kwargs) -> None:
        return None

    translation_tools.emit_change = ignore_change
    try:
        asyncio.run(translation_tools.translations_add_key("Default", key))
        results.put("applied")
    except Exception as exc:
        results.put(f"error:{type(exc).__name__}:{exc}")


def _rest_put_worker(
    project_path: str,
    body: dict,
    write_started,
    results,
    delay_write: bool,
) -> None:
    os.environ["NEXTHMI_ACTIVE_PROJECT_PATH"] = project_path
    from api import config_api
    from core.exceptions import ConfigConflictError

    if delay_write:
        original_write_csv = config_api.write_csv

        def delayed_write_csv(path, rows) -> None:
            write_started.set()
            time.sleep(0.35)
            original_write_csv(path, rows)

        config_api.write_csv = delayed_write_csv
    try:
        asyncio.run(config_api.put_translations(body, "Default"))
        results.put("applied")
    except ConfigConflictError:
        results.put("conflict")
    except Exception as exc:
        results.put(f"error:{type(exc).__name__}:{exc}")


def _mcp_mutation_worker(project_path: str, mutation: str, results) -> None:
    os.environ["NEXTHMI_ACTIVE_PROJECT_PATH"] = project_path
    from mcp_server.tools import translations as translation_tools

    async def ignore_change(**_kwargs) -> None:
        return None

    translation_tools.emit_change = ignore_change
    try:
        if mutation == "set":
            asyncio.run(
                translation_tools.translations_set_cell(
                    "Default", "Start", "nl-NL", "Gewijzigd"
                )
            )
        elif mutation == "add-language":
            asyncio.run(
                translation_tools.translations_add_language("Default", "fr-FR")
            )
        elif mutation == "delete-language":
            asyncio.run(
                translation_tools.translations_delete_language(
                    "Default", "nl-NL", confirm=True
                )
            )
        else:
            raise AssertionError(f"unknown mutation {mutation}")
        results.put("applied")
    except Exception as exc:
        results.put(f"error:{type(exc).__name__}:{exc}")


@pytest.fixture()
def client(live_project_root: Path):
    from api.config_api import router
    from core.exceptions import register_exception_handlers

    storage.ensure_active_project_dirs()
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(router)
    with TestClient(app) as test_client:
        yield test_client


def _default_path() -> Path:
    return storage.active_translations_dir() / "Default.csv"


def _current_revision() -> str:
    return translation_revision(_default_path())


def test_existing_csv_round_trips_without_format_or_value_loss(client: TestClient) -> None:
    original = [
        ["en-EN", "nl-NL", "de-DE"],
        ["Start", "Starten", "Anfang"],
        ["Quoted; key", 'Regel\n"twee"', ""],
    ]
    storage.write_csv(_default_path(), original)

    loaded = client.get("/api/config/translations")
    assert loaded.status_code == 200

    saved = client.put("/api/config/translations", json=loaded.json())
    assert saved.status_code == 200
    assert saved.json() == loaded.json()
    assert storage.read_csv(_default_path()) == original


def test_secondary_columns_can_be_reordered_and_missing_values_become_empty(
    client: TestClient,
) -> None:
    storage.write_csv(
        _default_path(),
        [["en-EN", "nl-NL", "de-DE"], ["Start", "Starten", "Anfang"]],
    )

    response = client.put(
        "/api/config/translations",
        json={
            "revision": _current_revision(),
            "languages": [{"code": "en-EN"}, {"code": "de-DE"}, {"code": "nl-NL"}],
            "rows": {"Start": {"en-EN": "Start", "nl-NL": "Begin"}},
        },
    )

    assert response.status_code == 200
    assert storage.read_csv(_default_path()) == [
        ["en-EN", "de-DE", "nl-NL"],
        ["Start", "", "Begin"],
    ]

    renamed = client.put(
        "/api/config/translations",
        json={
            "revision": _current_revision(),
            "languages": [{"code": "en-EN"}, {"code": "fr-FR"}],
            "rows": {
                "Start": {
                    "en-EN": "Start",
                    "de-DE": "",
                    "nl-NL": "Begin",
                    "fr-FR": "Démarrer",
                }
            },
        },
    )
    assert renamed.status_code == 200
    assert storage.read_csv(_default_path()) == [
        ["en-EN", "fr-FR"],
        ["Start", "Démarrer"],
    ]


@pytest.mark.parametrize(
    "languages",
    [
        [{"code": "nl-NL"}, {"code": "en-EN"}],
        [{"code": "fr-FR"}, {"code": "nl-NL"}],
        [{"code": "nl-NL"}],
    ],
)
def test_primary_language_move_rename_or_removal_is_rejected_atomically(
    client: TestClient,
    languages: list[dict[str, str]],
) -> None:
    original = [["en-EN", "nl-NL"], ["Start", "Starten"]]
    storage.write_csv(_default_path(), original)

    response = client.put(
        "/api/config/translations",
        json={
            "revision": _current_revision(),
            "languages": languages,
            "rows": {"Start": {languages[0]["code"]: "Start"}},
        },
    )

    assert response.status_code == 422
    assert "cannot be removed, moved, or renamed" in response.json()["detail"]
    assert storage.read_csv(_default_path()) == original


def test_primary_value_and_key_set_changes_are_rejected_atomically(client: TestClient) -> None:
    original = [["en-EN", "nl-NL"], ["Start", "Starten"]]
    storage.write_csv(_default_path(), original)

    changed_value = client.put(
        "/api/config/translations",
        json={
            "revision": _current_revision(),
            "languages": [{"code": "en-EN"}, {"code": "nl-NL"}],
            "rows": {"Start": {"en-EN": "Begin", "nl-NL": "Beginnen"}},
        },
    )
    assert changed_value.status_code == 422
    assert "cannot be changed" in changed_value.json()["detail"]
    assert storage.read_csv(_default_path()) == original

    renamed_key = client.put(
        "/api/config/translations",
        json={
            "revision": _current_revision(),
            "languages": [{"code": "en-EN"}, {"code": "nl-NL"}],
            "rows": {"Begin": {"en-EN": "Begin", "nl-NL": "Beginnen"}},
        },
    )
    assert renamed_key.status_code == 422
    assert "keys are immutable" in renamed_key.json()["detail"]
    assert storage.read_csv(_default_path()) == original


def test_existing_full_save_requires_loaded_revision(client: TestClient) -> None:
    original = [["en-EN", "nl-NL"], ["Start", "Starten"]]
    storage.write_csv(_default_path(), original)

    response = client.put(
        "/api/config/translations",
        json={
            "languages": [{"code": "en-EN"}, {"code": "nl-NL"}],
            "rows": {"Start": {"nl-NL": "Gewijzigd"}},
        },
    )

    assert response.status_code == 409
    assert "revision is required" in response.json()["detail"]
    assert storage.read_csv(_default_path()) == original

def test_duplicate_primary_text_is_rejected_without_collapsing_rows(client: TestClient) -> None:
    duplicate_rows = [
        ["en-EN", "nl-NL"],
        ["Start", "Starten"],
        ["Start", "Beginnen"],
    ]
    storage.write_csv(_default_path(), duplicate_rows)

    response = client.get("/api/config/translations")

    assert response.status_code == 409
    assert "duplicate translation key 'Start'" in response.json()["detail"]
    assert storage.read_csv(_default_path()) == duplicate_rows


def test_duplicate_key_creation_is_rejected_atomically(client: TestClient) -> None:
    original = [["en-EN", "nl-NL"], ["Start", "Starten"]]
    storage.write_csv(_default_path(), original)

    response = client.post("/api/config/translations", json={"key": "Start"})

    assert response.status_code == 409
    assert storage.read_csv(_default_path()) == original


def test_rows_can_be_deleted_without_changing_other_identities(client: TestClient) -> None:
    storage.write_csv(
        _default_path(),
        [["en-EN", "nl-NL"], ["Start", "Starten"], ["Stop", "Stoppen"]],
    )

    response = client.delete("/api/config/translations/Start")

    assert response.status_code == 200
    assert storage.read_csv(_default_path()) == [
        ["en-EN", "nl-NL"],
        ["Stop", "Stoppen"],
    ]


def test_primary_language_delete_is_rejected_atomically(client: TestClient) -> None:
    original = [["en-EN", "nl-NL"], ["Start", "Starten"]]
    storage.write_csv(_default_path(), original)

    response = client.delete("/api/config/translations/language/en-EN")

    assert response.status_code == 422
    assert storage.read_csv(_default_path()) == original


def test_language_mutations_target_only_the_selected_dictionary(client: TestClient) -> None:
    default_rows = [["en-EN", "nl-NL"], ["Start", "Starten"]]
    custom_path = storage.active_translations_dir() / "Custom.csv"
    custom_rows = [["en-EN", "de-DE"], ["Start", "Start"]]
    storage.write_csv(_default_path(), default_rows)
    storage.write_csv(custom_path, custom_rows)

    added = client.post("/api/config/translations/language?dict=Custom", json={"code": "fr-FR"})
    assert added.status_code == 200
    assert [language["code"] for language in added.json()["languages"]] == [
        "en-EN",
        "de-DE",
        "fr-FR",
    ]
    assert storage.read_csv(_default_path()) == default_rows

    removed = client.delete("/api/config/translations/language/de-DE?dict=Custom")
    assert removed.status_code == 200
    assert storage.read_csv(custom_path) == [["en-EN", "fr-FR"], ["Start", ""]]
    assert storage.read_csv(_default_path()) == default_rows

    unsafe = client.post("/api/config/translations/language?dict=../Custom", json={"code": "it"})
    assert unsafe.status_code == 422


def test_zero_byte_dictionary_is_malformed_but_absence_remains_distinct(
    client: TestClient,
) -> None:
    _default_path().unlink()
    absent = client.get("/api/config/translations")
    assert absent.status_code == 200
    assert absent.json() == {"languages": [], "rows": {}, "revision": "missing"}

    _default_path().write_bytes(b"")
    malformed = client.get("/api/config/translations")
    assert malformed.status_code == 422
    assert "at least one language column" in malformed.json()["detail"]

    mutations = [
        client.post("/api/config/dictionaries", json={"name": "Custom"}),
        client.post("/api/config/translations", json={"key": "Start"}),
        client.put(
            "/api/config/translations",
            json={
                "revision": _current_revision(),
                "languages": [{"code": "en-EN"}],
                "rows": {},
            },
        ),
        client.post("/api/config/translations/language", json={"code": "nl-NL"}),
        client.delete("/api/config/translations/language/nl-NL"),
        client.delete("/api/config/translations/Start"),
    ]
    assert [response.status_code for response in mutations] == [422, 422, 422, 422, 422, 422]
    assert _default_path().read_bytes() == b""

    diagnostics = client.get("/api/config/validate")
    assert diagnostics.status_code == 200
    assert any(
        item["artifactKind"] == "translations"
        and item["artifactId"] == "Default"
        and "at least one language column" in item["message"]
        for item in diagnostics.json()["diagnostics"]
    )


def test_mcp_zero_byte_dictionary_is_malformed_for_reads_and_mutations(
    live_project_root: Path,
) -> None:
    from mcp_server.tools import translations as translation_tools

    storage.ensure_active_project_dirs()
    _default_path().write_bytes(b"")

    with pytest.raises(ConfigValidationError, match="at least one language column"):
        translation_tools.translations_get("Default")
    with pytest.raises(ConfigValidationError, match="at least one language column"):
        asyncio.run(translation_tools.translations_add_key("Default", "Start"))
    with pytest.raises(ConfigValidationError, match="at least one language column"):
        asyncio.run(
            translation_tools.translations_set_cell("Default", "Start", "nl-NL", "Starten")
        )
    with pytest.raises(ConfigValidationError, match="at least one language column"):
        asyncio.run(translation_tools.translations_delete_key("Default", "Start"))


def test_cross_process_rest_adds_do_not_lose_updates(live_project_root: Path) -> None:
    storage.ensure_active_project_dirs()
    context = multiprocessing.get_context("spawn")
    write_started = context.Event()
    results = context.Queue()
    first = context.Process(
        target=_rest_add_worker,
        args=(str(live_project_root), "Start", write_started, results, True),
    )
    second = context.Process(
        target=_rest_add_worker,
        args=(str(live_project_root), "Stop", write_started, results, False),
    )

    first.start()
    assert write_started.wait(timeout=5)
    second.start()
    first.join(timeout=10)
    second.join(timeout=10)

    assert first.exitcode == 0
    assert second.exitcode == 0
    assert sorted([results.get(timeout=2), results.get(timeout=2)]) == ["applied", "applied"]
    assert storage.read_csv(_default_path()) == [
        ["en-EN"],
        ["Start"],
        ["Stop"],
    ]


def test_cross_process_rest_and_mcp_adds_share_one_transaction_lock(
    live_project_root: Path,
) -> None:
    storage.ensure_active_project_dirs()
    context = multiprocessing.get_context("spawn")
    write_started = context.Event()
    results = context.Queue()
    rest = context.Process(
        target=_rest_add_worker,
        args=(str(live_project_root), "Start", write_started, results, True),
    )
    mcp = context.Process(
        target=_mcp_add_worker,
        args=(str(live_project_root), "Stop", results),
    )

    rest.start()
    assert write_started.wait(timeout=5)
    mcp.start()
    rest.join(timeout=10)
    mcp.join(timeout=10)

    assert rest.exitcode == 0
    assert mcp.exitcode == 0
    assert sorted([results.get(timeout=2), results.get(timeout=2)]) == ["applied", "applied"]
    assert storage.read_csv(_default_path()) == [
        ["en-EN"],
        ["Start"],
        ["Stop"],
    ]


def test_cross_process_duplicate_rest_add_has_one_stable_conflict(
    live_project_root: Path,
) -> None:
    storage.ensure_active_project_dirs()
    context = multiprocessing.get_context("spawn")
    write_started = context.Event()
    results = context.Queue()
    processes = [
        context.Process(
            target=_rest_add_worker,
            args=(str(live_project_root), "Start", write_started, results, index == 0),
        )
        for index in range(2)
    ]

    processes[0].start()
    assert write_started.wait(timeout=5)
    processes[1].start()
    for process in processes:
        process.join(timeout=10)

    assert [process.exitcode for process in processes] == [0, 0]
    assert sorted([results.get(timeout=2), results.get(timeout=2)]) == ["applied", "conflict"]
    assert storage.read_csv(_default_path()) == [["en-EN"], ["Start"]]


def test_cross_process_stale_put_put_conflicts_instead_of_overwriting(
    client: TestClient, live_project_root: Path
) -> None:
    storage.write_csv(_default_path(), [["en-EN", "nl-NL"], ["Start", "Starten"]])
    loaded = client.get("/api/config/translations").json()
    first_body = {
        **loaded,
        "rows": {"Start": {"en-EN": "Start", "nl-NL": "Eerste"}},
    }
    second_body = {
        **loaded,
        "rows": {"Start": {"en-EN": "Start", "nl-NL": "Tweede"}},
    }
    context = multiprocessing.get_context("spawn")
    write_started = context.Event()
    results = context.Queue()
    first = context.Process(
        target=_rest_put_worker,
        args=(str(live_project_root), first_body, write_started, results, True),
    )
    second = context.Process(
        target=_rest_put_worker,
        args=(str(live_project_root), second_body, write_started, results, False),
    )

    first.start()
    assert write_started.wait(timeout=5)
    second.start()
    first.join(timeout=10)
    second.join(timeout=10)

    assert [first.exitcode, second.exitcode] == [0, 0]
    assert sorted([results.get(timeout=2), results.get(timeout=2)]) == ["applied", "conflict"]
    assert storage.read_csv(_default_path()) == [
        ["en-EN", "nl-NL"],
        ["Start", "Eerste"],
    ]


@pytest.mark.parametrize("mutation", ["set", "add-language", "delete-language"])
def test_cross_process_stale_put_conflicts_after_mcp_mutation(
    client: TestClient, live_project_root: Path, mutation: str
) -> None:
    storage.write_csv(_default_path(), [["en-EN", "nl-NL"], ["Start", "Starten"]])
    stale = client.get("/api/config/translations").json()
    context = multiprocessing.get_context("spawn")
    results = context.Queue()
    process = context.Process(
        target=_mcp_mutation_worker,
        args=(str(live_project_root), mutation, results),
    )
    process.start()
    process.join(timeout=10)
    assert process.exitcode == 0
    assert results.get(timeout=2) == "applied"

    stale["rows"]["Start"]["nl-NL"] = "Stale overwrite"
    response = client.put("/api/config/translations", json=stale)

    assert response.status_code == 409
    assert "changed" in response.json()["detail"]


def test_translation_transaction_is_same_thread_reentrant(live_project_root: Path) -> None:
    storage.ensure_active_project_dirs()
    path = _default_path()

    with translation_transaction(path), translation_transaction(path):
        assert storage.read_csv(path) == [["en-EN"]]


def test_nested_transaction_exception_releases_for_cross_process_retry(
    live_project_root: Path,
) -> None:
    storage.ensure_active_project_dirs()
    path = _default_path()
    with pytest.raises(RuntimeError, match="nested failure"):  # noqa: SIM117 -- no autofix offered for this 3-level nesting, left as-is per the mechanical-only policy for this family
        with translation_transaction(path):
            with translation_transaction(path):
                raise RuntimeError("nested failure")

    context = multiprocessing.get_context("spawn")
    results = context.Queue()
    process = context.Process(
        target=_mcp_add_worker,
        args=(str(live_project_root), "Start", results),
    )
    process.start()
    process.join(timeout=10)

    assert process.exitcode == 0
    assert results.get(timeout=2) == "applied"
    assert storage.read_csv(path) == [["en-EN"], ["Start"]]


def test_atomic_csv_replace_failure_preserves_previous_dictionary(
    live_project_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage.ensure_active_project_dirs()
    path = _default_path()
    original = [["en-EN", "nl-NL"], ["Start", "Starten"]]
    storage.write_csv(path, original)

    def fail_replace(_source: Path, _destination: Path) -> None:
        raise OSError("simulated interruption before atomic replace")

    monkeypatch.setattr(storage.os, "replace", fail_replace)
    with pytest.raises(OSError, match="simulated interruption"):
        storage.write_csv(path, [["en-EN", "nl-NL"], ["Start", "Beginnen"]])

    assert storage.read_csv(path) == original
    assert not list(path.parent.glob("Default.csv.*.tmp"))


def test_failed_rest_transaction_rolls_back_and_releases_the_lock(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = [["en-EN"], ["Start"]]
    storage.write_csv(_default_path(), original)
    original_replace = storage.os.replace

    def fail_replace(_source: Path, _destination: Path) -> None:
        raise OSError("simulated transaction failure")

    monkeypatch.setattr(storage.os, "replace", fail_replace)
    with pytest.raises(OSError, match="simulated transaction failure"):
        client.post("/api/config/translations", json={"key": "Stop"})
    assert storage.read_csv(_default_path()) == original

    monkeypatch.setattr(storage.os, "replace", original_replace)
    retry = client.post("/api/config/translations", json={"key": "Stop"})
    assert retry.status_code == 200
    assert storage.read_csv(_default_path()) == [["en-EN"], ["Start"], ["Stop"]]


@pytest.mark.asyncio
async def test_mcp_cell_mutation_uses_the_same_immutable_primary_rule(
    live_project_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from mcp_server.tools import translations as translation_tools

    storage.ensure_active_project_dirs()
    storage.write_csv(_default_path(), [["en-EN", "nl-NL"], ["Start", "Starten"]])

    with pytest.raises(ConfigValidationError, match="immutable key column"):
        await translation_tools.translations_set_cell("Default", "Start", "en-EN", "Begin")

    async def ignore_change(**_kwargs) -> None:
        return None

    monkeypatch.setattr(translation_tools, "emit_change", ignore_change)
    await translation_tools.translations_set_cell("Default", "Start", "nl-NL", "Beginnen")
    assert storage.read_csv(_default_path()) == [
        ["en-EN", "nl-NL"],
        ["Start", "Beginnen"],
    ]
