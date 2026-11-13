"""A datachange only touches the ancestor composites someone has.

A PLC leaf sits under eight or more registered folders, and the datachange
path used to build a field encoding for every one of them and ask each whether
it was worth patching. An ancestor nobody reads and nothing has cached has
nothing to patch or build, so it is passed over.
"""

from models.datasource import build_var_key
from services.datasource_manager import DatasourceEntry, DatasourceManager

LEAF = "Plant/Line/Cell/Robot/speed"


def _var(name: str) -> dict:
    return {"display_name": name, "node_id": f"ns=2;s={name}", "data_type": "Int32",
            "enabled": True, "writable": False}


def _folder(name: str, children: list) -> dict:
    return {"kind": "folder", "name": name, "node_id": f"ns=2;s={name}", "children": children}


def _config() -> dict:
    """Four nested structs, each with a field of its own, so all register."""
    return {"name": "DS", "type": "opcua-client", "variables": [
        _folder("Plant", [_var("id"), _folder("Line", [_var("rate"), _folder("Cell", [
            _var("mode"), _folder("Robot", [_var("speed")]),
        ])])]),
    ]}


def _setup(monkeypatch) -> tuple[DatasourceManager, DatasourceEntry, list[str]]:
    entry = DatasourceEntry(_config())
    dm = DatasourceManager()
    dm.datasources["DS"] = entry
    patched: list[str] = []
    real = dm._patch_folder_composite
    monkeypatch.setattr(
        dm, "_patch_folder_composite",
        lambda ds, e, folder, *a, **k: (patched.append(folder), real(ds, e, folder, *a, **k)),
    )
    return dm, entry, patched


def test_an_unread_uncached_ancestor_is_not_patched(monkeypatch):
    dm, entry, patched = _setup(monkeypatch)

    dm.update_struct_field("DS", "Plant", ("Line", "Cell", "Robot", "speed"), 5, leaf_path=LEAF)

    # Only the leaf's own route, which is patched into existence as always.
    assert patched == ["Plant"]
    assert build_var_key("DS", "Plant/Line/Cell") not in entry.cache


def test_a_read_ancestor_is_still_built_and_patched(monkeypatch):
    dm, entry, patched = _setup(monkeypatch)
    cell = build_var_key("DS", "Plant/Line/Cell")
    dm.set_client_page("c1", {cell})
    dm.seed_cached_values({build_var_key("DS", "Plant/Line/Cell/mode"): 1})

    dm.update_struct_field("DS", "Plant", ("Line", "Cell", "Robot", "speed"), 5, leaf_path=LEAF)
    assert entry.cache[cell] == {"mode": 1, "Robot": {"speed": 5}}

    dm.update_struct_field("DS", "Plant", ("Line", "Cell", "Robot", "speed"), 6, leaf_path=LEAF)
    assert entry.cache[cell] == {"mode": 1, "Robot": {"speed": 6}}
    assert patched == ["Plant", "Plant/Line/Cell"] * 2


def test_a_cached_ancestor_nobody_reads_is_still_patched(monkeypatch):
    """Cached means kept current, read or not: `snapshot()` serves it."""
    dm, entry, _patched = _setup(monkeypatch)
    line = build_var_key("DS", "Plant/Line")
    dm.seed_cached_values({line: {"rate": 2, "Cell": {"mode": 1, "Robot": {"speed": 0}}}})

    dm.update_struct_field("DS", "Plant", ("Line", "Cell", "Robot", "speed"), 5, leaf_path=LEAF)

    assert entry.cache[line] == {"rate": 2, "Cell": {"mode": 1, "Robot": {"speed": 5}}}
