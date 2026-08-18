"""Unit tests for the shared JSON Pointer primitives.

These exercise the lazy-create branches that the widget-property write path
relies on but didn't have direct coverage for.
"""

import pytest
from core.exceptions import ConfigValidationError
from mcp_server.json_pointer import escape_token, set_value, split, unescape_token


def test_escape_unescape_roundtrip():
    for raw in ["foo", "a/b", "a~b", "~/~/", ""]:
        assert unescape_token(escape_token(raw)) == raw


def test_split_strips_leading_slash():
    assert split("/a/b/c") == ["a", "b", "c"]


def test_split_unescapes_tokens():
    assert split("/a~1b/c~0d") == ["a/b", "c~d"]


def test_split_rejects_empty_or_root():
    with pytest.raises(ConfigValidationError):
        split("")
    with pytest.raises(ConfigValidationError):
        split("/")


def test_set_value_sets_top_level():
    root: dict = {}
    set_value(root, ["x"], 42)
    assert root == {"x": 42}


def test_set_value_overwrites_existing():
    root = {"x": 1}
    set_value(root, ["x"], 2)
    assert root == {"x": 2}


def test_set_value_lazy_creates_intermediate_dicts():
    root: dict = {}
    set_value(root, ["style", "backgroundColor"], "#fff")
    assert root == {"style": {"backgroundColor": "#fff"}}


def test_set_value_lazy_creates_list_when_next_token_is_digit():
    root: dict = {}
    set_value(root, ["actions", "0", "target"], "page-home")
    assert root == {"actions": [{"target": "page-home"}]}


def test_set_value_extends_list_with_padding_nones():
    root: dict = {"actions": [{"target": "a"}]}
    set_value(root, ["actions", "2", "target"], "c")
    assert root["actions"] == [{"target": "a"}, None, {"target": "c"}]


def test_set_value_rejects_non_numeric_index_into_list():
    root: dict = {"actions": []}
    with pytest.raises(ConfigValidationError):
        set_value(root, ["actions", "first"], "x")


def test_set_value_rejects_descend_into_scalar():
    root = {"label": "hi"}
    with pytest.raises(ConfigValidationError):
        set_value(root, ["label", "nested"], "x")


def test_set_value_creates_list_inside_existing_dict_branch():
    root: dict = {"actions": {"onClick": []}}
    set_value(root, ["actions", "onClick", "0", "type"], "openPage")
    assert root == {"actions": {"onClick": [{"type": "openPage"}]}}


def test_set_value_rejects_sparse_extension_past_growth_cap():
    """Single writes must not be able to balloon an array with thousands of nulls."""
    root: dict = {"actions": []}
    with pytest.raises(ConfigValidationError):
        set_value(root, ["actions", "500"], "way out of bounds")
    # Within the cap is still fine — the cap is small but accommodates a few
    # appends past the current length.
    set_value(root, ["actions", "5"], "ok")
    assert root["actions"][5] == "ok"
