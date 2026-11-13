"""An array-of-struct element's metadata names its position in the array.

A page bound to a struct array at literal indexes receives only those element
folders' metadata, so the client cannot rank the element names it holds to
tell positions apart: each element carries its own.
"""

from models.datasource import build_var_key
from services.datasource_manager import DatasourceEntry, DatasourceManager


def _var(name: str, node_id: str) -> dict:
    return {"kind": "variable", "display_name": name, "node_id": node_id,
            "data_type": "Float", "enabled": True}


def _struct_array(name: str, indexes: range) -> dict:
    return {"kind": "folder", "name": name, "is_array": True, "children": [
        {"kind": "folder", "name": f"[{i}]", "children": [_var("Speed", f"ns=2;s={name}{i}")]}
        for i in indexes
    ]}


def _manager() -> DatasourceManager:
    mgr = DatasourceManager()
    mgr.datasources["DS"] = DatasourceEntry({"name": "DS", "type": "opcua-client", "variables": [
        # TwinCAT ARRAY[1..10]: position 0 is element [1], and [10] sorts last.
        _struct_array("OneBased", range(1, 11)),
        _struct_array("ZeroBased", range(10)),
        _var("Lonely", "ns=2;s=L"),
    ]})
    return mgr


def _positions(meta: dict) -> dict[str, int]:
    return {key: m["position"] for key, m in meta.items() if "position" in m}


def test_bound_elements_carry_their_positions_without_their_siblings():
    mgr = _manager()

    one_based = mgr.variable_metadata({"DS:OneBased/[2]", "DS:OneBased/[6]"})
    assert _positions(one_based) == {"DS:OneBased/[2]": 1, "DS:OneBased/[6]": 5}
    assert "DS:OneBased/[3]" not in one_based

    zero_based = mgr.variable_metadata({"DS:ZeroBased/[2]", "DS:ZeroBased/[5]"})
    assert _positions(zero_based) == {"DS:ZeroBased/[2]": 2, "DS:ZeroBased/[5]": 5}


def test_only_element_folders_carry_a_position():
    meta = _manager().variable_metadata()
    assert _positions(meta) == {
        **{build_var_key("DS", f"OneBased/[{i}]"): i - 1 for i in range(1, 11)},
        **{build_var_key("DS", f"ZeroBased/[{i}]"): i for i in range(10)},
    }
    # It sits beside `type`, never inside it: the canonical VarType is unchanged.
    assert meta["DS:OneBased/[2]"]["type"] == {
        "kind": "struct", "name": "[2]", "array": False, "fields": ["Speed"],
    }


def test_the_validator_reads_the_same_positions_off_the_full_metadata(monkeypatch):
    """The validator takes the full metadata's types as its registry and ranks
    element names itself; that reading must agree with ``position``."""
    import services.datasource_manager as datasource_module
    from core.validation import structure

    mgr = _manager()
    monkeypatch.setattr(datasource_module, "datasource_manager", mgr)
    monkeypatch.setattr(structure, "_live_registry_cache", None)

    registry, writable = structure._collect_datasource_registry()
    elements = structure._struct_elements_for(registry)

    assert registry["DS"]["OneBased/[2]"]["kind"] == "struct"
    assert writable["DS"]["Lonely"] is False
    positions = _positions(mgr.variable_metadata())
    assert len(positions) == 20
    for key, position in positions.items():
        array_path, _, _ = key.split(":", 1)[1].rpartition("/")
        assert elements.of("DS", array_path)[position] == key.split(":", 1)[1]
