"""Format 10 → 11: the User Badge widget is rebuilt from built-ins.

1.1.0 retires ``UserBadge``. Each one becomes a row ``Container`` holding what
the badge drew, from widgets anyone can restyle:

* an identity row — a ``user`` Icon, then the username and (unless
  ``showGroups`` was off) the group list as Labels, from the badge's text
  overrides or ``$user``. With press actions it is a Button Container that
  runs them.
* a sign-in Button, shown only to the guest, when the badge had ``onSignIn``.
  Since the badge drew its identity *instead of* that button, the identity row
  is then hidden from the guest.
* an icon-only sign-out Button, hidden from the guest, when it had ``onSignOut``.

The outer Container keeps the badge's id, name, layout and visibility, so
anything addressing the node still finds it. The avatar's initials have no
built-in equivalent; the Icon stands in for them.

Walks every stored JSON document whole, like the other steps: a badge can sit
in a shell region, a page, a dialog or a component. Re-runnable: once no
``UserBadge`` node is left, nothing changes.
"""
from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from core.storage import read_json, write_json

_IS_GUEST: dict[str, Any] = {
    "$compare": {"left": {"$user": {"field": "username"}}, "operator": "===", "right": "guest"}
}
_NOT_GUEST: dict[str, Any] = {"$not": {"value": _IS_GUEST}}
# Visibility and interactability are per-node gates every widget carries.
_GATES = ("visible", "interactable")


def _actions(props: dict[str, Any], key: str, event: str) -> list[Any]:
    value = props.get(key)
    actions = value.get(event) if isinstance(value, dict) else None
    return actions if isinstance(actions, list) else []


def _replace(node: dict[str, Any]) -> dict[str, Any]:
    node_id = str(node.get("id", "user"))
    props = node.get("properties") if isinstance(node.get("properties"), dict) else {}
    on_press = _actions(props, "actions", "onPress")
    on_sign_in = _actions(props, "onSignIn", "onSignIn")
    on_sign_out = _actions(props, "onSignOut", "onSignOut")

    texts: list[dict[str, Any]] = [
        {
            "id": f"{node_id}-username",
            "type": "Label",
            "name": "Username",
            "properties": {
                "text": props.get("usernameText", {"$user": {"field": "username"}}),
                "typography": "subheading",
                "wrap": "truncate",
            },
        }
    ]
    if props.get("showGroups", True) is not False:
        texts.append(
            {
                "id": f"{node_id}-groups",
                "type": "Label",
                "name": "Groups",
                "properties": {
                    "text": props.get("groupsText", {"$user": {"field": "groups"}}),
                    "typography": "caption",
                    "wrap": "truncate",
                },
            }
        )

    identity_props: dict[str, Any] = {}
    if on_sign_in:
        identity_props["visible"] = _NOT_GUEST
    if on_press:
        identity_props["actions"] = {"onPress": on_press}
    children: list[dict[str, Any]] = [
        {
            "id": f"{node_id}-identity",
            "type": "ButtonContainer" if on_press else "Container",
            "name": "Identity",
            "properties": identity_props,
            "layout": {
                "direction": "row",
                "align": "center",
                "gap": "0.5rem",
                "wrap": False,
                "widthMode": "hug",
                "heightMode": "hug",
            },
            "children": [
                {
                    "id": f"{node_id}-avatar",
                    "type": "Icon",
                    "name": "Avatar",
                    "properties": {"iconName": "user", "size": 20},
                },
                {
                    "id": f"{node_id}-text",
                    "type": "Container",
                    "name": "Text",
                    "properties": {},
                    "layout": {
                        "direction": "column",
                        "gap": "0px",
                        "wrap": False,
                        "widthMode": "hug",
                        "heightMode": "hug",
                    },
                    "children": texts,
                },
            ],
        }
    ]
    if on_sign_in:
        children.insert(
            0,
            {
                "id": f"{node_id}-sign-in",
                "type": "Button",
                "name": "Sign in",
                "properties": {
                    "visible": _IS_GUEST,
                    "label": props.get("signInLabel", "Log in"),
                    "iconName": props.get("signInIcon") or "lock",
                    "actions": {"onPress": on_sign_in},
                },
                "layout": {"widthMode": "hug", "heightMode": "hug"},
            },
        )
    if on_sign_out:
        children.append(
            {
                "id": f"{node_id}-sign-out",
                "type": "Button",
                "name": "Sign out",
                "properties": {
                    "visible": _NOT_GUEST,
                    "label": "",
                    "iconName": props.get("signOutIcon") or "sign-out",
                    "variant": "outline",
                    "actions": {"onPress": on_sign_out},
                },
                "layout": {"widthMode": "hug", "heightMode": "hug"},
            }
        )

    layout = dict(node["layout"]) if isinstance(node.get("layout"), dict) else {}
    layout.update({"direction": "row", "align": "center", "gap": "0.5rem", "wrap": False})
    if isinstance(props.get("radius"), str) and props["radius"]:
        layout["radius"] = props["radius"]
    out: dict[str, Any] = {
        "id": node_id,
        "type": "Container",
        "name": node.get("name", "User"),
        "properties": {key: props[key] for key in _GATES if key in props},
        "layout": layout,
        "children": children,
    }
    return out


def _rewrite(value: Any) -> tuple[Any, bool]:
    """Return ``value`` with every UserBadge node replaced, plus whether any was."""
    if isinstance(value, list):
        items = [_rewrite(item) for item in value]
        if any(changed for _, changed in items):
            return [item for item, _ in items], True
        return value, False
    if isinstance(value, dict):
        items_by_key = {key: _rewrite(item) for key, item in value.items()}
        changed = any(c for _, c in items_by_key.values())
        out = {key: item for key, (item, _) in items_by_key.items()} if changed else value
        if out.get("type") == "UserBadge":
            return _replace(out), True
        return out, changed
    return value, False


def _rewrite_file(path: Path, label: str, files_changed: list[str]) -> None:
    rewritten, changed = _rewrite(read_json(path))
    if changed:
        write_json(path, rewritten)
        files_changed.append(label)


def migrate_user_badge(paths: Mapping[str, Path], project_root: Path) -> Any:
    """The step body. `paths` maps target name -> staged path (see the coordinator)."""
    from core.project_migrations import StepResult

    result = StepResult()
    config_path = paths["config"]
    if config_path.is_file():
        _rewrite_file(config_path, "config.json", result.files_changed)
    for label in ("pages", "dialogs", "components"):
        directory = paths[label]
        if not directory.is_dir():
            continue
        for path in sorted(directory.rglob("*.json")):
            _rewrite_file(
                path, f"{label}/{path.relative_to(directory).as_posix()}", result.files_changed
            )
    return result
