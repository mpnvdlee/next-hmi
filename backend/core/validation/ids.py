import re

_USER_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_PAGE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_DICT_NAME_RE = re.compile(r"^[A-Za-z0-9_\- ]+$")
_WIDGET_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_DATASOURCE_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_COMPONENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
# Internal spaces allowed, but not leading/trailing (they don't round-trip as
# directory names on every platform) — total length 1..64.
_COMPONENT_FOLDER_RE = re.compile(r"^[A-Za-z0-9_-](?:[A-Za-z0-9_\- ]{0,62}[A-Za-z0-9_-])?$")

USER_ID_MAX_LEN = 64
DICT_NAME_MAX_LEN = 64


def is_valid_user_id(value: object) -> bool:
    """Return True if value is a safe user/group ID."""
    return (
        isinstance(value, str)
        and bool(_USER_ID_RE.match(value))
        and len(value) <= USER_ID_MAX_LEN
    )


def is_valid_page_id(value: object) -> bool:
    return isinstance(value, str) and bool(_PAGE_ID_RE.match(value))


def is_valid_dict_name(value: object) -> bool:
    return (
        isinstance(value, str)
        and bool(_DICT_NAME_RE.match(value))
        and len(value) <= DICT_NAME_MAX_LEN
    )


def is_valid_widget_name(value: object) -> bool:
    return isinstance(value, str) and bool(_WIDGET_NAME_RE.match(value))


def is_valid_datasource_name(value: object) -> bool:
    return isinstance(value, str) and bool(_DATASOURCE_NAME_RE.match(value))


def is_valid_component_id(value: object) -> bool:
    return isinstance(value, str) and bool(_COMPONENT_ID_RE.match(value))


def is_valid_component_folder(value: object) -> bool:
    """Return True if value is a safe component folder path.

    Unlimited nesting is supported via ``/``-joined segments (e.g. ``"A/B/C"``);
    each segment is validated independently against the same rules as a
    single-level folder name.
    """
    if not isinstance(value, str) or not value:
        return False
    return all(_COMPONENT_FOLDER_RE.match(seg) for seg in value.split("/"))
