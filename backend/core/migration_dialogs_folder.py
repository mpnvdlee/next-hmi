"""Format 7 → 8: dialogs become pages in the Dialogs folder.

A dialog used to be its own artifact: an inline entry in ``config.json``'s
``dialogs`` list carrying a ``title``, the ``showCloseButton`` /
``closeOnBackgroundPress`` flags, optional ``componentProperties`` and its
widget tree under ``widgets``, opened and closed by the ``openDialog`` /
``closeDialog`` actions. That artifact is gone. ``dialogs`` is now a second root
of the page index — the same node shape as ``pages`` — and whatever lives under
it is an ordinary page or page group, still shown by ``openDialog`` and closed
by ``closePageOverlay``, the one action that closes either kind of overlay.

Per old dialog this step writes:

- an index node ``{id, type: "page"}`` in place of the inline entry;
- ``dialogs/<id>.json`` — the Dialogs folder keeps its page documents in its own
  directory, beside ``pages/`` — with the title (the id when the dialog carried
  none — a page with no title is dropped by the frontend's node guard), the
  declarations, both close flags
  written explicitly (the old dialog defaulted each to off, a page opened as an
  overlay defaults each to on, so an unset flag must become an explicit
  ``false`` to keep behaving the same), and the widgets as the ``content``
  section.

The widgets are not moved over as they are when there is more than one of
them. A dialog body (``.hmi-modal__content``) laid its top-level widgets out as
a wrapping row, while a page's content section stacks them in a column, so two
buttons side by side would come out one above the other. They are wrapped in a
single ``Container`` that reproduces the old body: a row that wraps, stretch
alignment, the theme's small gap (left unset, which is the Container's own
default of ``--hmi-space-sm``, the same token the dialog body used), no padding
of its own (the modal card still pads the content), and Fill on both axes so it
takes the whole body the way the old row did. A lone top-level widget sizes the
same under either parent, so it is moved as is.

Then every stored action is rewritten, wherever it sits — widget properties,
nested ``onSuccess``/``onFailed``/``onSettled`` lists, menu items, page and
group lifecycle events, ``globalEvents``, component definitions: ``openDialog``
keeps its name but renames ``dialogId`` to ``pageId``, every other field (input
values, size, placement, backdrop, width, height) carried over unchanged;
``closeDialog`` becomes ``closePageOverlay``, which closes a dialog and a page
overlay alike. The one default that moved is written out: an ``openDialog``
without a ``size`` sized its card to the content, where the overlay machinery
now opens an unsized one medium, so it gets ``size: "auto"``. The page keeps
the dialog's id, so every reference still names it. ``openPageOverlay`` actions
predate this step and already name a page in the navigable root, which is the
root that action still offers — they are left alone.

The step is re-runnable: an entry already shaped as an index node is left
alone, and an action already rewritten no longer matches. That is why the
old-shape test for ``openDialog`` is the ``dialogId`` key rather than the type
name, which the rewrite no longer changes. It refuses — failing
the migration, which restores the project and keeps the pre-migration zip —
when a dialog id is not a valid page id, or collides with a page, page group
or another dialog in the index, since either would leave a reference pointing
at the wrong thing. A page *file* whose id is in neither index root is already
an orphan — the next save deletes it — so one sharing a dialog's id is
overwritten rather than refused.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from core.page_index import collect_page_ids, root_nodes
from core.storage import read_json, write_json
from core.validation.ids import is_valid_page_id

STEP_NAME = "dialogs-to-pages"

# Type name each pre-8 dialog action carries afterwards. ``openDialog`` keeps
# its own: the Dialogs folder is still what it opens.
_REWRITTEN_TYPE = {
    "openDialog": "openDialog",
    "closeDialog": "closePageOverlay",
}


def _is_index_node(entry: Any) -> bool:
    return isinstance(entry, dict) and entry.get("type") in ("page", "page-group")


def _is_old_action(value: dict[str, Any]) -> bool:
    """Whether this dict is a dialog action still in its pre-8 shape.

    ``closeDialog`` is gone as a type name, so its presence settles it.
    ``openDialog`` survives the step under its own name, so the field it
    renames is what tells a converted one from an untouched one — see the
    re-runnability note in the module docstring.
    """
    kind = value.get("type")
    if kind == "closeDialog":
        return True
    return kind == "openDialog" and "dialogId" in value


def _rewrite_action(action: dict[str, Any]) -> dict[str, Any]:
    rewritten: dict[str, Any] = {}
    for key, value in action.items():
        if key == "type":
            rewritten[key] = _REWRITTEN_TYPE[value]
        elif key == "dialogId":
            rewritten["pageId"] = value
        else:
            rewritten[key] = value
    # An unsized dialog sized to its content; an unsized overlay opens medium,
    # so the old default has to be written down to survive.
    if action["type"] == "openDialog" and "size" not in action:
        rewritten["size"] = "auto"
    return rewritten


def _rewrite_actions(value: Any) -> tuple[Any, bool]:
    """Return ``value`` with every dialog action rewritten, plus whether any was.

    Walks the whole JSON value rather than the known action slots: actions sit
    under any property key a widget declares as an actions field, inside menu
    items, and in follow-up lists nested to any depth.
    """
    if isinstance(value, list):
        changed = False
        out = []
        for item in value:
            new_item, item_changed = _rewrite_actions(item)
            out.append(new_item)
            changed |= item_changed
        return (out, True) if changed else (value, False)
    if isinstance(value, dict):
        changed = False
        out_dict: dict[str, Any] = {}
        for key, item in value.items():
            new_item, item_changed = _rewrite_actions(item)
            out_dict[key] = new_item
            changed |= item_changed
        if _is_old_action(out_dict):
            return _rewrite_action(out_dict), True
        return (out_dict, True) if changed else (value, False)
    return value, False


def _content_widgets(widgets: list[Any]) -> list[Any]:
    """The dialog's widgets as a page ``content`` section (see module docstring)."""
    if len(widgets) < 2:
        return widgets
    return [
        {
            "id": str(uuid.uuid4()),
            "type": "Container",
            "name": "Content",
            "properties": {},
            "layout": {
                "direction": "row",
                "wrap": True,
                "widthMode": "fill",
                "heightMode": "fill",
                "paddingTop": "0",
                "paddingRight": "0",
                "paddingBottom": "0",
                "paddingLeft": "0",
            },
            "children": widgets,
        }
    ]


def _page_document(dialog: dict[str, Any]) -> dict[str, Any]:
    raw_widgets = dialog.get("widgets")
    widgets = [w for w in raw_widgets if isinstance(w, dict)] if isinstance(raw_widgets, list) else []
    title = dialog.get("title")
    page: dict[str, Any] = {
        "id": dialog["id"],
        # A page with a falsy title is dropped by the frontend's own node guard
        # (`normalizePageNode`), which would take the widgets with it on the next
        # save. The old dialog editor let a title be cleared, so fall back to the
        # id rather than write one.
        "title": title if isinstance(title, str) and title else dialog["id"],
        "showCloseButton": dialog.get("showCloseButton") is True,
        "closeOnBackgroundPress": dialog.get("closeOnBackgroundPress") is True,
    }
    declarations = dialog.get("componentProperties")
    if isinstance(declarations, dict) and declarations:
        page["componentProperties"] = declarations
    page["sections"] = {"content": _content_widgets(widgets)}
    return page


def migrate_dialogs_folder(paths: Mapping[str, Path], project_root: Path) -> Any:
    """The step body. `paths` maps target name -> staged path (see the coordinator)."""
    from core.project_migrations import MigrationFailedError, StepResult

    result = StepResult()
    pages_dir = paths["pages"]
    dialogs_dir = paths["dialogs"]
    config_path = paths["config"]

    new_pages: dict[str, dict[str, Any]] = {}
    if config_path.is_file():
        config = read_json(config_path)
        if not isinstance(config, dict):
            config = None
    else:
        config = None

    if config is not None:
        entries = root_nodes(config, "dialogs")
        taken = collect_page_ids(root_nodes(config, "pages"))
        taken |= collect_page_ids([entry for entry in entries if _is_index_node(entry)])
        converted_index: list[Any] = []
        config_changed = False
        for entry in entries:
            if _is_index_node(entry):
                converted_index.append(entry)
                continue
            if not isinstance(entry, dict):
                config_changed = True
                continue
            dialog_id = entry.get("id")
            if not is_valid_page_id(dialog_id):
                raise MigrationFailedError(
                    project_root,
                    STEP_NAME,
                    Path("config.json"),
                    f"dialog id {dialog_id!r} is not a valid page id",
                )
            if dialog_id in taken:
                raise MigrationFailedError(
                    project_root,
                    STEP_NAME,
                    Path("config.json"),
                    f"dialog id '{dialog_id}' is already used by another page, "
                    "page group or dialog",
                )
            taken.add(dialog_id)
            page = _page_document(entry)
            new_pages[dialog_id] = page
            converted_index.append({"id": dialog_id, "type": "page"})
            config_changed = True
            widget_count = len(entry.get("widgets") or [])
            if widget_count > 1:
                result.diagnostics.append(
                    f"dialog '{dialog_id}': its {widget_count} top-level widgets were "
                    "wrapped in one Container to keep the dialog's wrapping-row layout"
                )
        if config_changed:
            config["dialogs"] = converted_index
        config, actions_changed = _rewrite_actions(config)
        if config_changed or actions_changed:
            write_json(config_path, config)
            result.files_changed.append("config.json")

    for page_id, page in new_pages.items():
        rewritten, _ = _rewrite_actions(page)
        write_json(dialogs_dir / f"{page_id}.json", rewritten)
        result.files_changed.append(f"dialogs/{page_id}.json")

    for label, directory in (("pages", pages_dir), ("dialogs", dialogs_dir)):
        if not directory.is_dir():
            continue
        for path in sorted(directory.rglob("*.json")):
            if label == "dialogs" and path.stem in new_pages:
                continue
            page_doc = read_json(path)
            rewritten, changed = _rewrite_actions(page_doc)
            if changed:
                write_json(path, rewritten)
                result.files_changed.append(f"{label}/{path.name}")

    components_dir = paths["components"]
    if components_dir.is_dir():
        for path in sorted(components_dir.rglob("*.json")):
            definition = read_json(path)
            rewritten, changed = _rewrite_actions(definition)
            if changed:
                write_json(path, rewritten)
                result.files_changed.append(f"components/{path.relative_to(components_dir).as_posix()}")

    return result
