"""Unit tests for slug ID generation (core.ids)."""

from core.ids import slug_id, slugify


def test_slugify_basic():
    assert slugify("Value Display") == "value-display"
    assert slugify("  Tank #3 (top)  ") == "tank-3-top"
    assert slugify("Café Crème") == "cafe-creme"
    assert slugify("already-a-slug") == "already-a-slug"


def test_slugify_empty_is_blank():
    assert slugify("") == ""
    assert slugify("///") == ""


def test_slug_id_bare_when_free():
    assert slug_id("Home", set()) == "home"


def test_slug_id_counter_on_collision():
    taken: set[str] = set()
    first = slug_id("Container", taken)
    taken.add(first)
    second = slug_id("Container", taken)
    taken.add(second)
    third = slug_id("Container", taken)
    assert [first, second, third] == ["container", "container-1", "container-2"]


def test_slug_id_skips_existing_suffixes():
    assert slug_id("box", {"box", "box-1"}) == "box-2"


def test_slug_id_empty_base_falls_back():
    assert slug_id("", set()) == "item"
