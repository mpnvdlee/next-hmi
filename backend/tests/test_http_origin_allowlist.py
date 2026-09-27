"""The $http origin allowlist: POST /api/http-request only reaches what the project names.

The runtime posts a fully resolved url, so the check is on the origin
(scheme + host + port) rather than the stored template. Derivation lives in
``core/http_origins.py``; this file drives it through the real endpoint.
"""
from __future__ import annotations

import api.http_source_api as http_source_api
import core.http_origins as http_origins
import httpx
import pytest
from core.http_origins import HttpOriginPolicy
from core.storage import write_json
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _clean_origin_cache():
    http_origins.invalidate_http_origin_cache()
    yield
    http_origins.invalidate_http_origin_cache()


@pytest.fixture()
def proxy_client(live_project_root):
    app = FastAPI()
    app.include_router(http_source_api.router)
    with TestClient(app) as client:
        yield client


def _http_source(url: str) -> dict:
    return {"$http": {"url": url, "method": "GET", "path": "value"}}


def write_page(root, page_id: str, *urls: str) -> None:
    (root / "pages").mkdir(parents=True, exist_ok=True)
    write_json(
        root / "pages" / f"{page_id}.json",
        {
            "id": page_id,
            "sections": {
                "content": [
                    {
                        "id": f"w{i}",
                        "type": "Label",
                        "properties": {"text": _http_source(url)},
                    }
                    for i, url in enumerate(urls)
                ]
            },
        },
    )
    http_origins.invalidate_http_origin_cache()


def _stub_transport(monkeypatch, handler):
    original = httpx.AsyncClient.__init__

    def patched(self, *args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        original(self, *args, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "__init__", patched)


def _allow_everything_upstream(monkeypatch):
    _stub_transport(monkeypatch, lambda request: httpx.Response(200, json={"v": 1}))


def _post(client, url: str) -> dict:
    resp = client.post("/api/http-request", json={"url": url})
    assert resp.status_code == 200, "a refusal is a 200 body, never an HTTP error"
    return resp.json()


# ── The core rule ─────────────────────────────────────────────────────────────


def test_configured_origin_is_allowed(proxy_client, live_project_root, monkeypatch):
    write_page(live_project_root, "home", "http://plc.local:8080/api/temp")
    _allow_everything_upstream(monkeypatch)

    assert _post(proxy_client, "http://plc.local:8080/api/temp")["ok"] is True


def test_unconfigured_origin_is_refused(proxy_client, live_project_root, monkeypatch):
    write_page(live_project_root, "home", "http://plc.local:8080/api/temp")
    _allow_everything_upstream(monkeypatch)

    payload = _post(proxy_client, "http://evil.example.com/api/temp")
    assert payload["ok"] is False
    assert payload["status"] == 0
    assert "not configured" in payload["error"]
    assert "http://evil.example.com:80" in payload["error"]


def test_refusal_never_performs_the_request(proxy_client, live_project_root, monkeypatch):
    write_page(live_project_root, "home", "http://plc.local/api/temp")
    performed: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        performed.append(str(request.url))
        return httpx.Response(200, json={})

    _stub_transport(monkeypatch, handler)

    assert _post(proxy_client, "http://evil.example.com/")["ok"] is False
    assert performed == []


def test_empty_project_refuses_everything(proxy_client, live_project_root, monkeypatch):
    _allow_everything_upstream(monkeypatch)

    assert _post(proxy_client, "http://plc.local/api/temp")["ok"] is False


# ── Only the origin is pinned ─────────────────────────────────────────────────


@pytest.mark.parametrize(
    "requested",
    [
        "http://plc.local:8080/api/other",
        "http://plc.local:8080/",
        "http://plc.local:8080/api/temp?station=3&deep=1",
        "http://plc.local:8080/api/temp#frag",
    ],
)
def test_same_origin_different_path_or_query_is_allowed(
    proxy_client, live_project_root, monkeypatch, requested
):
    write_page(live_project_root, "home", "http://plc.local:8080/api/temp")
    _allow_everything_upstream(monkeypatch)

    assert _post(proxy_client, requested)["ok"] is True


def test_a_placeholder_in_the_path_still_pins_the_origin(
    proxy_client, live_project_root, monkeypatch
):
    write_page(live_project_root, "home", "http://plc.local/api/{1}/temp")
    _allow_everything_upstream(monkeypatch)

    assert _post(proxy_client, "http://plc.local/api/7/temp")["ok"] is True
    assert _post(proxy_client, "http://other.local/api/7/temp")["ok"] is False


# ── Normalization ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("configured", "requested"),
    [
        ("http://plc.local/x", "http://plc.local:80/x"),
        ("http://plc.local:80/x", "http://plc.local/x"),
        ("https://plc.local/x", "https://plc.local:443/x"),
        ("https://plc.local:443/x", "https://plc.local/x"),
        ("http://PLC.Local/x", "http://plc.local/x"),
        ("http://plc.local/x", "http://PLC.LOCAL/x"),
        ("http://[::1]:9000/x", "http://[::1]:9000/x"),
    ],
)
def test_equivalent_origin_forms_match(
    proxy_client, live_project_root, monkeypatch, configured, requested
):
    write_page(live_project_root, "home", configured)
    _allow_everything_upstream(monkeypatch)

    assert _post(proxy_client, requested)["ok"] is True


@pytest.mark.parametrize(
    ("configured", "requested"),
    [
        ("http://plc.local/x", "https://plc.local/x"),
        ("http://plc.local/x", "http://plc.local:8080/x"),
        ("https://plc.local:8443/x", "https://plc.local/x"),
    ],
)
def test_scheme_and_port_are_part_of_the_origin(
    proxy_client, live_project_root, monkeypatch, configured, requested
):
    write_page(live_project_root, "home", configured)
    _allow_everything_upstream(monkeypatch)

    assert _post(proxy_client, requested)["ok"] is False


# ── Everywhere a property can live ────────────────────────────────────────────


def test_origin_from_a_component_is_allowed(proxy_client, live_project_root, monkeypatch):
    (live_project_root / "components" / "group").mkdir(parents=True, exist_ok=True)
    write_json(
        live_project_root / "components" / "group" / "Gauge.json",
        {
            "id": "Gauge",
            "children": [
                {"id": "a", "type": "Label", "properties": {"text": _http_source("http://nested.local/v")}}
            ],
        },
    )
    http_origins.invalidate_http_origin_cache()
    _allow_everything_upstream(monkeypatch)

    assert _post(proxy_client, "http://nested.local/v")["ok"] is True


def test_origin_nested_in_another_sources_wildcards_is_allowed(
    proxy_client, live_project_root, monkeypatch
):
    write_json(
        live_project_root / "config.json",
        {
            "globalEvents": {
                "onLoad": [
                    {
                        "type": "navigate",
                        "target": {
                            "$if": {
                                "condition": {"$static": True},
                                "true": {
                                    "$stringExpr": {
                                        "template": "{a}",
                                        "wildcards": {"a": _http_source("https://deep.local/v")},
                                    }
                                },
                            }
                        },
                    }
                ]
            }
        },
    )
    http_origins.invalidate_http_origin_cache()
    _allow_everything_upstream(monkeypatch)

    assert _post(proxy_client, "https://deep.local/v")["ok"] is True


def test_origin_from_alarms_is_allowed(proxy_client, live_project_root, monkeypatch):
    """alarms.json is not part of the page tree, but its text, its resolutions
    and its trigger binding are all property values (core/validation/domains.py)."""
    write_json(
        live_project_root / "alarms.json",
        {
            "groups": [
                {
                    "id": "g1",
                    "alarms": [
                        {
                            "id": "a1",
                            "title": _http_source("http://alarm-title.local/v"),
                            "resolutions": [_http_source("http://alarm-fix.local/v")],
                            "trigger": {
                                "type": "bool",
                                "source_value": _http_source("http://alarm-trigger.local/v"),
                            },
                        }
                    ],
                }
            ]
        },
    )
    http_origins.invalidate_http_origin_cache()
    _allow_everything_upstream(monkeypatch)

    for url in (
        "http://alarm-title.local/v",
        "http://alarm-fix.local/v",
        "http://alarm-trigger.local/v",
    ):
        assert _post(proxy_client, url)["ok"] is True, url


def test_origin_from_recipes_is_allowed(proxy_client, live_project_root, monkeypatch):
    """A recipe parameter's write-back binding is a property value too."""
    write_json(
        live_project_root / "recipes.json",
        {
            "datasetTypes": [
                {
                    "id": "t1",
                    "parameters": [
                        {
                            "name": "Setpoint",
                            "dataType": "float",
                            "binding": _http_source("http://recipe.local/v"),
                        }
                    ],
                }
            ]
        },
    )
    http_origins.invalidate_http_origin_cache()
    _allow_everything_upstream(monkeypatch)

    assert _post(proxy_client, "http://recipe.local/v")["ok"] is True


# ── Dynamic hosts — the documented opt-out ────────────────────────────────────


def test_a_placeholder_in_the_host_opts_that_project_out_of_pinning(
    proxy_client, live_project_root, monkeypatch
):
    """Documented in core/http_origins.py: an author who interpolates the host
    has asked for a host no allowlist can name, so the policy stops pinning."""
    write_page(live_project_root, "home", "http://{1}/api/temp")
    _allow_everything_upstream(monkeypatch)

    assert _post(proxy_client, "http://anything.example.com/api/temp")["ok"] is True
    assert http_origins.http_origin_policy().allows_any_origin is True
    assert http_origins.http_origin_policy().dynamic_templates == ("http://{1}/api/temp",)


@pytest.mark.parametrize(
    "template",
    ["{scheme}://plc.local/x", "http://{h}/x", "http://plc.local:{p}/x"],
)
def test_a_placeholder_anywhere_in_the_origin_counts_as_dynamic(
    live_project_root, template
):
    write_page(live_project_root, "home", template)

    policy = http_origins.http_origin_policy()
    assert policy.allows_any_origin is True
    assert policy.dynamic_templates == (template,)


@pytest.mark.parametrize(
    ("template", "origin"),
    [
        ("https://{user}:pw@plant.local/api", "https://plant.local:443"),
        ("https://api:{token}@plant.local/status", "https://plant.local:443"),
        ("https://{user}:{pass}@plant.local/api", "https://plant.local:443"),
        ("http://{user}@plant.local:8080/api", "http://plant.local:8080"),
    ],
)
def test_templated_credentials_are_not_a_dynamic_host(live_project_root, template, origin):
    """Userinfo is not part of an origin — a source that interpolates its
    basic-auth credentials against a fixed host pins that host like any other
    literal template. Counting the placeholder as a dynamic host turned one
    ordinary credentialed source into a project-wide opt-out."""
    write_page(live_project_root, "home", template)

    policy = http_origins.http_origin_policy()
    assert policy.dynamic_templates == ()
    assert policy.allows_any_origin is False
    assert policy.origins == frozenset({origin})
    assert policy.permits("http://169.254.169.254/latest/meta-data/") is False
    assert policy.permits("http://127.0.0.1:8000/api/datasources") is False
    assert policy.permits("https://attacker.example/x") is False


@pytest.mark.parametrize(
    "template",
    [
        "https://user:pw@plant.local:{port}/api",
        "https://{user}:{pass}@plant.local:{port}/api",
        "https://user:pw@{host}/api",
        "https://{user}:{pass}@{host}/api",
    ],
)
def test_a_placeholder_past_the_userinfo_is_still_an_opt_out(live_project_root, template):
    """Dropping the credentials must not drop the host or the port with them —
    both still decide the origin, so a placeholder in either is the real opt-out."""
    write_page(live_project_root, "home", template)

    policy = http_origins.http_origin_policy()
    assert policy.allows_any_origin is True
    assert policy.dynamic_templates == (template,)


def test_credentialed_template_reaches_only_its_own_host(
    proxy_client, live_project_root, monkeypatch
):
    """Both sides agree: classification and ``normalize_origin`` discard the
    userinfo, so the rendered request matches the pinned origin and nothing else
    does."""
    write_page(live_project_root, "home", "https://{user}:{pass}@plant.local/api")
    _allow_everything_upstream(monkeypatch)

    assert _post(proxy_client, "https://operator:hunter2@plant.local/api")["ok"] is True
    assert _post(proxy_client, "https://plant.local/api")["ok"] is True
    assert _post(proxy_client, "http://127.0.0.1:8000/api/datasources")["ok"] is False


@pytest.mark.parametrize(
    "template",
    ["/api/local-thing", "/api/{id}", "{base}/x", "api/v1/{id}/status"],
)
def test_a_relative_template_is_not_an_opt_out(live_project_root, template):
    """A template with no ``://`` names no origin — and so opts out of nothing.

    Reading its placeholder as an opt-out is what made an ordinary
    ``/api/status/{machineId}`` widen the whole project to any origin.
    """
    write_page(live_project_root, "home", template)

    policy = http_origins.http_origin_policy()
    assert policy.allows_any_origin is False
    assert policy.dynamic_templates == ()
    assert policy.origins == frozenset()


def test_a_relative_template_does_not_open_the_proxy(
    proxy_client, live_project_root, monkeypatch
):
    """End to end: the project holds one relative template and nothing else, so
    every absolute origin is still refused."""
    write_page(live_project_root, "home", "/api/status/{machineId}")
    _allow_everything_upstream(monkeypatch)

    payload = _post(proxy_client, "http://169.254.169.254/latest/meta-data/iam/")
    assert payload["ok"] is False
    assert "not configured" in payload["error"]


# ── Loopback regression: the proxy must not be able to call us ────────────────


def test_a_dynamic_template_does_not_open_loopback():
    """A placeholder host opts out of pinning, but never onto this machine:
    a project instance binds loopback with no auth of its own."""
    policy = HttpOriginPolicy(frozenset(), ("https://{host}/api",))
    assert policy.allows_any_origin
    assert not policy.permits("http://127.0.0.1:8123/api/datasources")
    assert not policy.permits("http://[::1]:8123/api/datasources")
    assert not policy.permits("http://localhost:8123/api/datasources")
    assert not policy.permits("http://169.254.169.254/latest/meta-data/")
    assert not policy.permits("http://0.0.0.0:8123/")
    # Numeric IPv4 spellings inet_aton still resolves without a lookup.
    assert not policy.permits("http://127.1/x")
    assert not policy.permits("http://2130706433/x")
    assert not policy.permits("http://0177.0.0.1/x")
    assert not policy.permits("http://0x7f.0.0.1/x")
    assert policy.permits("https://plant.local/api/line1")


def test_loopback_into_our_own_api_is_refused_when_not_configured(
    proxy_client, live_project_root, monkeypatch
):
    write_page(live_project_root, "home", "http://plc.local/api/temp")
    _allow_everything_upstream(monkeypatch)

    for url in (
        "http://127.0.0.1:9000/api/datasources/Machine",
        "http://localhost:9000/api/users",
        "http://[::1]:9000/api/config/config",
        "http://127.0.0.1/api/config/config",
    ):
        payload = _post(proxy_client, url)
        assert payload["ok"] is False, url
        assert "not configured" in payload["error"], url


def test_loopback_is_allowed_once_the_project_configures_it(
    proxy_client, live_project_root, monkeypatch
):
    write_page(live_project_root, "home", "http://localhost:9000/api/status")
    _allow_everything_upstream(monkeypatch)

    assert _post(proxy_client, "http://localhost:9000/api/status")["ok"] is True
    # Still scoped to the one origin the author named.
    assert _post(proxy_client, "http://127.0.0.1:9000/api/status")["ok"] is False


# ── Redirects: the check runs on every hop ────────────────────────────────────


def test_a_redirect_to_an_unconfigured_origin_is_refused(
    proxy_client, live_project_root, monkeypatch
):
    """A configured host that answers 302 must not be able to hand the proxy an
    origin the project never named — our own API, for one."""
    write_page(live_project_root, "home", "http://plc.local/api/temp")
    performed: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        performed.append(str(request.url))
        if request.url.host == "plc.local":
            return httpx.Response(
                302, headers={"location": "http://127.0.0.1:9000/api/datasources"}
            )
        return httpx.Response(200, json={"password": "s3cret"})

    _stub_transport(monkeypatch, handler)

    payload = _post(proxy_client, "http://plc.local/api/temp")
    assert payload["ok"] is False
    assert payload["body"] is None
    assert "not configured" in payload["error"]
    assert "http://127.0.0.1:9000" in payload["error"]
    assert performed == ["http://plc.local/api/temp"]


def test_a_redirect_to_a_configured_origin_is_followed(
    proxy_client, live_project_root, monkeypatch
):
    write_page(
        live_project_root, "home", "http://plc.local/api/temp", "http://other.local/v"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "plc.local":
            return httpx.Response(302, headers={"location": "http://other.local/v"})
        return httpx.Response(200, json={"v": 1})

    _stub_transport(monkeypatch, handler)

    assert _post(proxy_client, "http://plc.local/api/temp") == {
        "ok": True, "status": 200, "body": {"v": 1}, "error": None,
    }


def test_a_redirect_to_a_non_http_scheme_is_refused(
    proxy_client, live_project_root, monkeypatch
):
    write_page(live_project_root, "home", "http://plc.local/api/temp")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "file:///etc/passwd"})

    _stub_transport(monkeypatch, handler)

    payload = _post(proxy_client, "http://plc.local/api/temp")
    assert payload["ok"] is False
    assert "scheme" in payload["error"]


# ── Freshness ─────────────────────────────────────────────────────────────────


def test_allowlist_refreshes_when_a_document_changes(
    proxy_client, live_project_root, monkeypatch
):
    write_page(live_project_root, "home", "http://first.local/x")
    _allow_everything_upstream(monkeypatch)
    assert _post(proxy_client, "http://first.local/x")["ok"] is True

    # Rewrite the page with a different origin and drop the cache the way a
    # config write does. The origin that was allowed a moment ago is now gone.
    write_page(live_project_root, "home", "http://second.local/x")

    assert _post(proxy_client, "http://second.local/x")["ok"] is True
    assert _post(proxy_client, "http://first.local/x")["ok"] is False


def test_allowlist_refreshes_without_an_explicit_invalidation(
    proxy_client, live_project_root, monkeypatch
):
    """The cache is keyed on the documents' mtimes, so a write nobody announced
    (direct disk edit, a write path that forgot to call the invalidator) still
    rebuilds it."""
    write_page(live_project_root, "home", "http://first.local/x")
    _allow_everything_upstream(monkeypatch)
    assert _post(proxy_client, "http://first.local/x")["ok"] is True

    page = live_project_root / "pages" / "home.json"
    write_json(
        page,
        {
            "id": "home",
            "sections": {
                "content": [
                    {"id": "w0", "type": "Label", "properties": {"text": _http_source("http://third.local/x")}}
                ]
            },
        },
    )
    import os

    stat = page.stat()
    os.utime(page, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))

    assert _post(proxy_client, "http://third.local/x")["ok"] is True
    assert _post(proxy_client, "http://first.local/x")["ok"] is False


def test_config_write_path_invalidates_the_cache(live_project_root):
    import api.config_api as config_api

    write_page(live_project_root, "home", "http://first.local/x")
    assert http_origins.http_origin_policy().origins == frozenset({"http://first.local:80"})

    write_json(
        live_project_root / "pages" / "home.json",
        {
            "id": "home",
            "sections": {
                "content": [
                    {"id": "w0", "type": "Label", "properties": {"text": _http_source("http://fourth.local/x")}}
                ]
            },
        },
    )
    config_api._invalidate_runtime_cache()

    assert http_origins.http_origin_policy().origins == frozenset({"http://fourth.local:80"})


def test_component_write_path_invalidates_the_cache(live_project_root, monkeypatch):
    """The component API writes a document the allowlist is derived from.

    The mtime fingerprint is frozen throughout, so only an explicit invalidation
    can refresh the policy — that is what a filesystem whose mtime granularity is
    coarser than the edit looks like.
    """
    import api.component_api as component_api
    import core.storage as storage
    import services.component_manager as component_manager_module
    from core.exceptions import register_exception_handlers

    storage.ensure_active_project_dirs()
    monkeypatch.setattr(http_origins, "_fingerprint", lambda documents: frozenset())
    monkeypatch.setattr(
        component_manager_module,
        "component_manager",
        component_manager_module.ComponentManager(),
    )
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(component_api.router)

    def definition(url: str) -> dict:
        return {
            "name": "Gauge",
            "componentProperties": {},
            "children": [
                {"id": "a", "type": "Label", "properties": {"text": _http_source(url)}}
            ],
        }

    with TestClient(app) as client:
        created = client.post("/api/components", json=definition("http://first.local/x"))
        assert created.status_code == 200, created.text
        component_id = created.json()["id"]
        assert http_origins.http_origin_policy().origins == frozenset({"http://first.local:80"})

        updated = client.put(
            f"/api/components/{component_id}", json=definition("http://second.local/x")
        )
        assert updated.status_code == 200, updated.text

    assert http_origins.http_origin_policy().origins == frozenset({"http://second.local:80"})


def test_alarm_and_recipe_config_write_paths_invalidate_the_cache(
    live_project_root, monkeypatch
):
    """Both PUTs rewrite a document the allowlist is derived from.

    The mtime fingerprint is frozen throughout, the same stand-in for a coarse
    filesystem ``test_component_write_path_invalidates_the_cache`` uses, so only
    an explicit invalidation can refresh the policy.
    """
    import api.alarm_api as alarm_api
    import api.recipe_api as recipe_api
    import core.storage as storage
    import services.alarm_manager as alarm_manager_module
    import services.recipe_manager as recipe_manager_module
    from core.exceptions import register_exception_handlers

    storage.ensure_active_project_dirs()
    monkeypatch.setattr(http_origins, "_fingerprint", lambda documents: frozenset())
    monkeypatch.setattr(
        alarm_manager_module, "alarm_manager", alarm_manager_module.AlarmManager()
    )
    monkeypatch.setattr(
        recipe_manager_module, "recipe_manager", recipe_manager_module.RecipeManager()
    )
    monkeypatch.setattr(alarm_api, "alarm_manager", alarm_manager_module.alarm_manager)
    monkeypatch.setattr(recipe_api, "recipe_manager", recipe_manager_module.recipe_manager)

    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(alarm_api.router)
    app.include_router(recipe_api.router)

    with TestClient(app) as client:
        alarms = client.put(
            "/api/alarms/config",
            json={
                "groups": [
                    {
                        "id": "g1",
                        "alarms": [
                            {"id": "a1", "title": _http_source("http://from-alarms.local/x")}
                        ],
                    }
                ]
            },
        )
        assert alarms.status_code == 200, alarms.text
        assert "http://from-alarms.local:80" in http_origins.http_origin_policy().origins

        recipes = client.put(
            "/api/recipes/config",
            json={
                "datasetTypes": [
                    {
                        "id": "t1",
                        "parameters": [
                            {
                                "label": "Setpoint",
                                "dataType": "float",
                                "binding": _http_source("http://from-recipes.local/x"),
                            }
                        ],
                    }
                ]
            },
        )
        assert recipes.status_code == 200, recipes.text
        assert "http://from-recipes.local:80" in http_origins.http_origin_policy().origins


def test_switching_project_switches_the_allowlist(live_project_root, tmp_path, monkeypatch):
    import core.storage as storage

    write_page(live_project_root, "home", "http://first.local/x")
    assert http_origins.http_origin_policy().origins == frozenset({"http://first.local:80"})

    other = tmp_path / "other-project"
    other.mkdir()
    write_page(other, "home", "http://other.local/x")
    monkeypatch.setattr(storage, "_active_project_path", lambda: other)

    assert http_origins.http_origin_policy().origins == frozenset({"http://other.local:80"})


def test_no_live_project_refuses_everything(monkeypatch):
    import core.storage as storage

    def boom():
        raise storage.NoLiveProjectError("No live project is configured")

    monkeypatch.setattr(storage, "_active_project_path", boom)

    policy = http_origins.http_origin_policy()
    assert policy.origins == frozenset()
    assert policy.allows_any_origin is False
    assert policy.permits("http://plc.local/x") is False


# ── normalize_origin unit coverage ────────────────────────────────────────────


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("http://a.com/x", "http://a.com:80"),
        ("https://a.com/x", "https://a.com:443"),
        ("HTTP://A.COM:8080/x", "http://a.com:8080"),
        ("http://user:pw@a.com/x", "http://a.com:80"),
        ("http://[2001:db8::1]/x", "http://[2001:db8::1]:80"),
        ("  https://a.com/x  ", "https://a.com:443"),
        ("file:///etc/passwd", None),
        ("ftp://a.com/x", None),
        ("not-a-url", None),
        ("/relative", None),
        ("http:///x", None),
        ("http://a.com:notaport/x", None),
    ],
)
def test_normalize_origin(url, expected):
    assert http_origins.normalize_origin(url) == expected
