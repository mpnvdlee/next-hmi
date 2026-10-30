"""The datasource pipeline, end to end, against every PLC address-space shape.

For each profile in opcua_plc_profiles — CODESYS, S7-1500, TwinCAT, Kepware,
B&R, a generic edge-case server and every NodeId spelling — against a live
in-process server:

* the browse has the shape the profile promises (types, access, arrays,
  structs and their members, nothing that is not a tag);
* the browse equals the shared fixture the frontend's buildFromBrowse test
  reads, so the two halves are held to one contract;
* the tree the frontend would import, used as a datasource config, reads,
  subscribes and writes every tag it holds.

A profile runs its own server per test, so a failure points at one shape and
one stage.
"""

from __future__ import annotations

import asyncio
import copy
import datetime
import json
import math
from typing import Any

import pytest
from asyncua import Client, ua
from opcua.client_pool import DatasourceOpcuaEngine
from opcua.limits import read_operation_limits
from opcua.values import normalize_value
from services import write_service
from services.datasource_manager import DatasourceEntry, DatasourceManager
from tests.opcua_plc_profiles import (
    FIXTURE_PATH,
    PROFILES,
    Leaf,
    Profile,
    RunningProfile,
    browse_profile,
    load_fixture,
)

PROFILE_IDS = [p.name for p in PROFILES]


# ── Helpers ───────────────────────────────────────────────────────────────────


def _find(entry: dict, path: tuple[str, ...]) -> dict | None:
    node = entry
    for name in path:
        node = next((c for c in node.get("children", []) if c["display_name"] == name), None)
        if node is None:
            return None
    return node


def _walk(entry: dict):
    yield entry
    for child in entry.get("children", []):
        yield from _walk(child)


def _same(actual: Any, expected: Any) -> bool:
    """Equality that allows for Float being single precision on the wire, and
    for a 64-bit integer written as the string a JSON client sends it as."""
    if isinstance(expected, str) and expected.lstrip("-").isdigit() and isinstance(actual, int):
        return actual == int(expected)
    if isinstance(expected, float) and isinstance(actual, (int, float)):
        return math.isclose(actual, expected, rel_tol=1e-6, abs_tol=1e-6)
    if isinstance(expected, list) and isinstance(actual, list):
        return len(actual) == len(expected) and all(
            _same(a, e) for a, e in zip(actual, expected, strict=True)
        )
    return actual == expected


def _cache_form(value: Any) -> Any:
    """What a server value looks like once it has been through the cache."""
    return normalize_value(value)


def _enable_all(tree: list[dict]) -> list[dict]:
    tree = copy.deepcopy(tree)

    def walk(nodes: list[dict]) -> None:
        for node in nodes:
            if node.get("kind") == "folder":
                walk(node.get("children", []))
            else:
                node["enabled"] = True

    walk(tree)
    return tree


class _Pool:
    def __init__(self, engine: DatasourceOpcuaEngine) -> None:
        self._engine = engine

    def get(self, name: str) -> DatasourceOpcuaEngine:
        return self._engine


# ── The browse ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("profile", PROFILES, ids=PROFILE_IDS)
async def test_browse_has_the_shape_the_profile_promises(profile: Profile):
    root = await browse_profile(profile)
    problems: list[str] = []

    for path, leaf in profile.leaves.items():
        node = _find(root, path)
        if node is None:
            problems.append(f"{'/'.join(path)}: missing")
            continue
        if node.get("data_type") != leaf.data_type:
            problems.append(f"{'/'.join(path)}: type {node.get('data_type')!r} ≠ {leaf.data_type!r}")
        if node.get("writable") is not leaf.writable:
            problems.append(f"{'/'.join(path)}: writable {node.get('writable')!r}")
        if node.get("children"):
            problems.append(f"{'/'.join(path)}: a tag must be a leaf, has children")
        if leaf.array_length is None:
            if node.get("is_array"):
                problems.append(f"{'/'.join(path)}: scalar reported as array")
        else:
            if not node.get("is_array"):
                problems.append(f"{'/'.join(path)}: array not reported as one")
            if (node.get("array_length") or 0) != leaf.array_length:
                problems.append(
                    f"{'/'.join(path)}: array_length {node.get('array_length')!r}"
                    f" ≠ {leaf.array_length}"
                )

    for path, members in profile.structs.items():
        node = _find(root, path)
        if node is None:
            problems.append(f"{'/'.join(path)}: struct missing")
            continue
        if node.get("data_type") != "struct":
            problems.append(f"{'/'.join(path)}: type {node.get('data_type')!r}, not a struct")
        names = {c["display_name"] for c in node.get("children", [])}
        if names != members:
            problems.append(f"{'/'.join(path)}: members {sorted(names)} ≠ {sorted(members)}")

    for path, children in profile.folders.items():
        node = root if not path else _find(root, path)
        if node is None:
            problems.append(f"{'/'.join(path)}: folder missing")
            continue
        if node.get("data_type") is not None:
            problems.append(f"{'/'.join(path) or '<root>'}: folder carries a type")
        names = {c["display_name"] for c in node.get("children", [])}
        if names != children:
            problems.append(
                f"{'/'.join(path) or '<root>'}: children {sorted(names)} ≠ {sorted(children)}"
            )

    for path in profile.absent:
        if _find(root, path) is not None:
            problems.append(f"{'/'.join(path)}: must not appear (not a tag)")

    assert not problems, f"{profile.title}:\n  " + "\n  ".join(problems)


@pytest.mark.asyncio
@pytest.mark.parametrize("profile", PROFILES, ids=PROFILE_IDS)
async def test_every_node_id_survives_its_string_form(profile: Profile):
    """Node ids travel as strings through config, REST and WebSocket."""
    root = await browse_profile(profile)
    ids = [node["node_id"] for node in _walk(root)]

    assert len(ids) == len(set(ids)), "a node reachable twice was listed twice"
    for node_id in ids:
        assert ua.NodeId.from_string(node_id).to_string() == node_id


@pytest.mark.asyncio
@pytest.mark.parametrize("profile", PROFILES, ids=PROFILE_IDS)
async def test_browse_matches_the_shared_fixture(profile: Profile):
    """The contract the frontend's buildFromBrowse test is held to."""
    fixture = load_fixture()[profile.name]
    assert await browse_profile(profile) == fixture["browse"], (
        f"The {profile.title} browse no longer matches opcuaBrowseProfiles.json. "
        "If the change is intended, regenerate it deliberately "
        "(see tests/opcua_plc_profiles.py) and re-run the frontend fixture test."
    )


# ── The imported tree, live ───────────────────────────────────────────────────


async def _engine_for(run: RunningProfile, profile: Profile, client: Client):
    fixture = load_fixture()[profile.name]
    tree = _enable_all(fixture["tree"])
    dm = DatasourceManager()
    entry = DatasourceEntry({"name": profile.name, "type": "opcua-client", "variables": tree})
    dm.datasources[profile.name] = entry
    engine = DatasourceOpcuaEngine(profile.name)
    engine.set_datasource_manager(dm)
    engine.attach_client(
        client, {"server_url": run.url}, operation_limits=await read_operation_limits(client)
    )
    root_name = fixture["browse"]["display_name"]
    return engine, dm, entry, root_name


def _registry_path(root_name: str, path: tuple[str, ...]) -> str:
    return "/".join((root_name, *path))


@pytest.mark.asyncio
@pytest.mark.parametrize("profile", PROFILES, ids=PROFILE_IDS)
async def test_imported_tree_reads_every_tag(profile: Profile):
    async with RunningProfile(profile) as run, Client(run.url) as client:
        engine, _dm, entry, root_name = await _engine_for(run, profile, client)
        paths = {_registry_path(root_name, p): p for p in profile.leaves}
        missing = sorted(set(paths) - set(entry.registry))
        assert not missing, f"imported tree lacks: {missing}"
        values = await engine.read_current_values(set(paths))

    problems = []
    for registry_path, path in paths.items():
        leaf: Leaf = profile.leaves[path]
        key = f"{profile.name}:{registry_path}"
        if key not in values:
            problems.append(f"{registry_path}: no value read")
        elif not _same(values[key], _cache_form(leaf.value)):
            problems.append(f"{registry_path}: read {values[key]!r}, server has {leaf.value!r}")
    assert not problems, f"{profile.title}:\n  " + "\n  ".join(problems)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "profile", [p for p in PROFILES if p.structs], ids=[p.name for p in PROFILES if p.structs]
)
async def test_imported_struct_reads_as_one_value(profile: Profile):
    """A struct folder aggregates its members into one object."""
    async with RunningProfile(profile) as run, Client(run.url) as client:
        engine, _dm, entry, root_name = await _engine_for(run, profile, client)
        struct_path, members = next(iter(profile.structs.items()))
        registry_path = _registry_path(root_name, struct_path)
        assert registry_path in entry.folder_registry, "struct did not import as a folder"
        values = await engine.read_current_values({registry_path})

    aggregate = values.get(f"{profile.name}:{registry_path}")
    assert isinstance(aggregate, (dict, list)), aggregate
    if isinstance(aggregate, dict):
        assert set(aggregate) == members


@pytest.mark.asyncio
@pytest.mark.parametrize("profile", PROFILES, ids=PROFILE_IDS)
async def test_imported_tree_follows_server_changes(profile: Profile):
    """A value changed on the PLC reaches the cache through the subscription."""
    target_path, leaf = next(
        (p, leaf)
        for p, leaf in profile.leaves.items()
        if leaf.array_length is None and isinstance(leaf.value, (bool, int, float, str))
    )
    async with RunningProfile(profile) as run, Client(run.url) as client:
        engine, dm, _entry, root_name = await _engine_for(run, profile, client)
        registry_path = _registry_path(root_name, target_path)
        node_id = dm.get_entry(profile.name, registry_path)["node_id"]
        await engine._setup_subscriptions()
        try:
            changed = _changed(leaf.value)
            server_node = run.server.get_node(node_id)
            variant_type = (await server_node.read_data_value()).Value.VariantType
            await server_node.write_value(ua.Variant(changed, variant_type))
            key = f"{profile.name}:{registry_path}"
            for _ in range(100):
                if _same(dm.datasources[profile.name].cache.get(key), changed):
                    break
                await asyncio.sleep(0.05)
            assert _same(dm.datasources[profile.name].cache.get(key), changed), (
                f"{registry_path}: cache still {dm.datasources[profile.name].cache.get(key)!r}"
            )
        finally:
            await engine._teardown_subscriptions()


def _changed(value: Any) -> Any:
    if isinstance(value, bool):
        return not value
    if isinstance(value, int):
        return value - 1 if value > 0 else value + 1
    if isinstance(value, float):
        # A whole number: exact in float32, so a Float tag holds exactly it.
        return float(int(value) + 1)
    return f"{value}!"


@pytest.mark.asyncio
@pytest.mark.parametrize("profile", PROFILES, ids=PROFILE_IDS)
async def test_imported_tree_writes_every_writable_tag(profile: Profile):
    writes = {p: leaf for p, leaf in profile.leaves.items() if leaf.write is not None}
    if not writes:
        pytest.skip("profile declares no writes")
    async with RunningProfile(profile) as run, Client(run.url) as client:
        engine, dm, _entry, root_name = await _engine_for(run, profile, client)
        pool = _Pool(engine)
        problems = []
        for path, leaf in writes.items():
            registry_path = _registry_path(root_name, path)
            outcome = await write_service.write_value(
                dm, pool, profile.name, registry_path, leaf.write
            )
            if not outcome.ok:
                problems.append(f"{registry_path}: write refused ({outcome.reason})")
                continue
            node_id = dm.get_entry(profile.name, registry_path)["node_id"]
            on_server = await run.server.get_node(node_id).read_value()
            if not _same(on_server, leaf.write):
                problems.append(f"{registry_path}: server holds {on_server!r}, wrote {leaf.write!r}")
    assert not problems, f"{profile.title}:\n  " + "\n  ".join(problems)


@pytest.mark.asyncio
@pytest.mark.parametrize("profile", PROFILES, ids=PROFILE_IDS)
async def test_imported_tree_refuses_writes_to_read_only_tags(profile: Profile):
    read_only = {
        p: leaf
        for p, leaf in profile.leaves.items()
        if not leaf.writable and leaf.array_length is None
        and isinstance(leaf.value, (bool, int, float, str))
    }
    if not read_only:
        pytest.skip("profile has no read-only scalar")
    async with RunningProfile(profile) as run, Client(run.url) as client:
        engine, dm, _entry, root_name = await _engine_for(run, profile, client)
        pool = _Pool(engine)
        for path, leaf in read_only.items():
            registry_path = _registry_path(root_name, path)
            outcome = await write_service.write_value(
                dm, pool, profile.name, registry_path, _changed(leaf.value)
            )
            assert outcome.reason == write_service.REASON_READ_ONLY, (
                f"{registry_path}: {outcome}"
            )
            node_id = dm.get_entry(profile.name, registry_path)["node_id"]
            assert _same(await run.server.get_node(node_id).read_value(), leaf.value)


# ── Value forms the HMI displays ──────────────────────────────────────────────


def test_localized_text_displays_its_text():
    """Status texts, alarm messages and device info are LocalizedText."""
    assert normalize_value(ua.LocalizedText("Tür offen", "de")) == "Tür offen"


def test_node_id_and_qualified_name_display_in_their_string_form():
    assert normalize_value(ua.NodeId("Tag", 3)) == "ns=3;s=Tag"
    assert normalize_value(ua.QualifiedName("Speed", 2)) == "2:Speed"


@pytest.mark.asyncio
async def test_a_verified_datetime_write_is_confirmed():
    """Verify compared a datetime with the cache's string form, and so failed
    every time — on a recipe download with verification, every DateTime."""
    from tests.opcua_plc_profiles import GENERIC

    async with RunningProfile(GENERIC) as run, Client(run.url) as client:
        engine, dm, _entry, root_name = await _engine_for(run, GENERIC, client)
        outcome = await write_service.write_value(
            dm, _Pool(engine), GENERIC.name, f"{root_name}/Types/DateTime",
            "2026-03-04T05:06:07Z", verify=True,
        )
        on_server = await run.server.get_node("ns=2;i=1113").read_value()

    assert outcome.ok, outcome.reason
    assert on_server == datetime.datetime(2026, 3, 4, 5, 6, 7, tzinfo=datetime.UTC)


@pytest.mark.asyncio
async def test_a_datetime_and_a_counter_beyond_two_to_the_53_read_in_their_browser_form():
    """ISO 8601 UTC with milliseconds — the form the write path parses — and
    the decimal string a JSON client can carry exactly, verified on write."""
    from tests.opcua_plc_profiles import GENERIC

    async with RunningProfile(GENERIC) as run, Client(run.url) as client:
        engine, dm, _entry, root_name = await _engine_for(run, GENERIC, client)
        stamp, counter = f"{root_name}/Types/DateTime", f"{root_name}/Types/UInt64"
        outcome = await write_service.write_value(
            dm, _Pool(engine), GENERIC.name, counter, str(2**63), verify=True,
        )
        values = await engine.read_current_values({stamp, counter})

    assert outcome.ok, outcome.reason
    assert values == {
        f"{GENERIC.name}:{stamp}": "2026-01-02T03:04:05.000Z",
        f"{GENERIC.name}:{counter}": "9223372036854775808",
    }


@pytest.mark.asyncio
async def test_an_element_write_returns_siblings_beyond_two_to_the_53_as_integers():
    """The cache holds those siblings as strings; the patched array must go
    back to the server as the integers it holds, or the write is refused."""
    from tests.opcua_plc_profiles import GENERIC

    async with RunningProfile(GENERIC) as run, Client(run.url) as client:
        node = await run.server.nodes.objects.add_variable(
            ua.NodeId("Counters", 2), "Counters",
            ua.Variant([2**63, 1, 2**64 - 1], ua.VariantType.UInt64),
        )
        await node.set_writable()
        engine, dm, _entry, _root_name = await _engine_for(run, GENERIC, client)
        dm.datasources[GENERIC.name] = DatasourceEntry({
            "name": GENERIC.name,
            "type": "opcua-client",
            "variables": [{
                "kind": "variable", "display_name": "Counters", "node_id": "ns=2;s=Counters",
                "data_type": "UInt64", "is_array": True, "array_length": 3,
                "enabled": True, "writable": True,
            }],
        })
        outcome = await write_service.write_value(
            dm, _Pool(engine), GENERIC.name, "Counters[1]", "7", verify=True,
        )
        on_server = await node.read_value()

    assert outcome.ok, outcome.reason
    assert on_server == [2**63, 7, 2**64 - 1]


# ── The built-in test server ──────────────────────────────────────────────────

_TEST_SERVER_TYPES = [
    t["name"]
    for t in json.loads(
        (FIXTURE_PATH.parent / "opcuaBuiltinTypes.json").read_text(encoding="utf-8")
    )["types"]
    if t["inOpcuaTypes"]
]


def _test_server_config(port: int) -> dict:
    """Every type the test-server editor offers, plus each container shape."""
    return {
        "name": "Sim",
        "type": "opcua-test-server",
        "settings": {"port": port, "endpoint_path": "/nexthmi/sim/"},
        "variables": [
            {
                "kind": "folder",
                "name": "Types",
                "children": [
                    {"kind": "variable", "display_name": t, "data_type": t,
                     "writable": i % 2 == 0, "enabled": True}
                    for i, t in enumerate(_TEST_SERVER_TYPES)
                ],
            },
            {
                "kind": "folder",
                "name": "Motor",
                "children": [
                    {"kind": "variable", "display_name": "speed", "data_type": "Double",
                     "writable": True, "enabled": True},
                    {"kind": "folder", "name": "limits", "children": [
                        {"kind": "variable", "display_name": "max", "data_type": "Double",
                         "writable": True, "enabled": True},
                    ]},
                ],
            },
            {"kind": "variable", "display_name": "Levels", "data_type": "Float",
             "is_array": True, "array_length": 6, "writable": True, "enabled": True},
            {"kind": "variable", "display_name": "Log", "data_type": "Int32",
             "is_array": True, "writable": False, "enabled": True},
        ],
    }


def _shape_of_config(nodes: list[dict]) -> list:
    out = []
    for node in nodes:
        if node.get("kind") == "folder":
            out.append(("folder", node["name"], _shape_of_config(node.get("children", []))))
        else:
            out.append((
                "variable", node["display_name"], node["data_type"], bool(node.get("writable")),
                bool(node.get("is_array")), node.get("array_length"),
            ))
    return out


def _shape_of_browse(nodes: list[dict]) -> list:
    out = []
    for node in nodes:
        if node.get("data_type") is None:
            out.append(("folder", node["display_name"], _shape_of_browse(node["children"])))
        else:
            out.append((
                "variable", node["display_name"], node["data_type"], bool(node.get("writable")),
                bool(node.get("is_array")), node.get("array_length"),
            ))
    return out


@pytest.mark.asyncio
async def test_the_built_in_test_server_browses_back_to_its_own_config():
    """Configure a tree on the test server, browse it: the same tree comes back.

    The test server is how an engineer builds screens before the PLC exists,
    so what it publishes has to be what Browse PLC would later import from
    the real thing.
    """
    from opcua.test_server import TestServerInstance
    from tests.opcua_plc_profiles import free_url

    port = int(free_url("sim").split(":")[2].split("/")[0])
    config = _test_server_config(port)
    expected = _shape_of_config(copy.deepcopy(config["variables"]))
    instance = TestServerInstance("Sim")
    await instance.start(config)
    try:
        engine = DatasourceOpcuaEngine("Sim")
        async with Client(f"opc.tcp://127.0.0.1:{port}/nexthmi/sim/") as client:
            engine.attach_client(client, {})
            root = await engine.browse()
    finally:
        await instance.stop()

    # The test server's own folders hang off Objects next to the standard
    # Server object; compare the configured ones.
    names = {n[1] for n in expected}
    browsed = [n for n in root["children"] if n["display_name"] in names]
    assert _shape_of_browse(browsed) == expected
