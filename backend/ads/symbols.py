"""
ads.symbols — the PLC's symbol and data-type tables, as a browse tree and as
byte addresses.

TwinCAT publishes both tables for upload (index groups 0xF00B and 0xF00E).
A symbol is a named location (``MAIN.stMotor``: index group, offset, size,
type name); a data type describes a struct's fields with their offsets, an
array's bounds, or an alias/enum's base type. Together they turn any member
path — ``MAIN.aAxis[2].stLimits.fMax`` — into the bytes to read or write,
without asking the PLC for a handle per variable.

Browse output has the same shape as an OPC-UA browse (``opcua.browse``):
``node_id`` carries the member path, ``data_type`` the OPC-UA builtin name or
``"struct"``, arrays of structs become ``[n]`` children. The variable tree,
struct routing and the browse import therefore need nothing ADS-specific.

ADS publishes every variable of the program — a real machine runs to over a
million nodes once function-block internals and struct arrays are expanded —
so a full browse is one of three modes:

- **marked**: only what carries a visibility attribute such as
  ``{attribute 'OPC.UA.DA' := '1'}``, on a symbol, a member or a whole type,
  the way TwinCAT's OPC-UA server chooses what to publish. A ``'0'`` hides a
  member below something marked.
- **lazy**: one level at a time (``browse_level``); a struct comes back with
  ``has_children`` and no children until it is browsed itself.
- **all**: everything.
"""

from __future__ import annotations

import math
import re
import struct
from dataclasses import dataclass, field
from typing import Any

from .codecs import ScalarCodec, base_codec

SYMBOL_FLAG_BITVALUE = 0x0002
SYMBOL_FLAG_TYPEGUID = 0x0008
SYMBOL_FLAG_READONLY = 0x0020
SYMBOL_FLAG_ATTRIBUTES = 0x1000

DATATYPE_FLAG_BITVALUES = 0x0020
DATATYPE_FLAG_PROPITEM = 0x0040
DATATYPE_FLAG_TYPEGUID = 0x0080
DATATYPE_FLAG_COPYMASK = 0x0200
DATATYPE_FLAG_METHODINFOS = 0x0800
DATATYPE_FLAG_ATTRIBUTES = 0x1000
DATATYPE_FLAG_STATIC = 0x20000
_SKIPPED_ITEM_FLAGS = DATATYPE_FLAG_BITVALUES | DATATYPE_FLAG_PROPITEM | DATATYPE_FLAG_STATIC

# Deeper than any real type graph; stops a self-referencing alias.
_MAX_TYPE_DEPTH = 32


# ── Upload tables ────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class UploadInfo:
    symbol_count: int
    symbol_size: int
    datatype_count: int
    datatype_size: int


def parse_upload_info(data: bytes) -> UploadInfo:
    return UploadInfo(*struct.unpack_from("<IIII", data))


@dataclass(frozen=True, slots=True)
class SymbolEntry:
    name: str
    index_group: int
    index_offset: int
    size: int
    type_name: str
    flags: int
    comment: str = ""
    # {attribute 'name' := 'value'} pragmas, by lower-cased name.
    attributes: dict[str, str] = field(default_factory=dict, compare=False)


@dataclass(frozen=True, slots=True)
class DataTypeEntry:
    name: str
    type_name: str
    size: int
    offset: int
    flags: int
    array_dims: tuple[tuple[int, int], ...] = ()  # (lower bound, element count)
    sub_items: tuple[DataTypeEntry, ...] = ()
    comment: str = ""
    attributes: dict[str, str] = field(default_factory=dict, compare=False)


_SYMBOL_HEADER = struct.Struct("<IIIIIIHHH")
_DATATYPE_HEADER = struct.Struct("<IIIIIIIIHHHHH")


def _strings(data: bytes, pos: int, lengths: tuple[int, ...]) -> tuple[list[str], int]:
    """NUL-terminated strings of known length, back to back."""
    out: list[str] = []
    for length in lengths:
        out.append(data[pos:pos + length].decode("cp1252", errors="replace"))
        pos += length + 1
    return out, pos


def _attributes(data: bytes, pos: int, end: int) -> dict[str, str]:
    """An attribute block: count, then (name length, value length, name, value).

    A block that would run past *end* is a layout this parser does not know;
    it yields no attributes rather than misreading the entry.
    """
    try:
        (count,) = struct.unpack_from("<H", data, pos)
        pos += 2
        found: dict[str, str] = {}
        for _ in range(count):
            name_len, value_len = data[pos], data[pos + 1]
            (name, value), pos = _strings(data, pos + 2, (name_len, value_len))
            found[name.lower()] = value
    except (struct.error, IndexError):
        return {}
    return found if pos <= end else {}


def parse_symbols(data: bytes) -> list[SymbolEntry]:
    symbols: list[SymbolEntry] = []
    pos = 0
    while pos + _SYMBOL_HEADER.size <= len(data):
        entry_length, group, offset, size, _ads_type, flags, name_len, type_len, comment_len = (
            _SYMBOL_HEADER.unpack_from(data, pos)
        )
        if entry_length == 0:
            break
        (name, type_name, comment), cur = _strings(
            data, pos + _SYMBOL_HEADER.size, (name_len, type_len, comment_len),
        )
        attributes: dict[str, str] = {}
        if flags & SYMBOL_FLAG_ATTRIBUTES:
            if flags & SYMBOL_FLAG_TYPEGUID:
                cur += 16
            attributes = _attributes(data, cur, pos + entry_length)
        symbols.append(SymbolEntry(name, group, offset, size, type_name, flags, comment, attributes))
        pos += entry_length
    return symbols


def _parse_datatype(data: bytes, pos: int) -> DataTypeEntry:
    (
        entry_length, _version, _hash, _type_hash, size, offset, _ads_type, flags,
        name_len, type_len, comment_len, array_dim, sub_count,
    ) = _DATATYPE_HEADER.unpack_from(data, pos)
    (name, type_name, comment), cur = _strings(
        data, pos + _DATATYPE_HEADER.size, (name_len, type_len, comment_len),
    )
    dims: list[tuple[int, int]] = []
    for _ in range(array_dim):
        dims.append(struct.unpack_from("<iI", data, cur))
        cur += 8
    subs: list[DataTypeEntry] = []
    for _ in range(sub_count):
        (sub_length,) = struct.unpack_from("<I", data, cur)
        subs.append(_parse_datatype(data, cur))
        cur += sub_length
    attributes: dict[str, str] = {}
    if flags & DATATYPE_FLAG_ATTRIBUTES:
        # The optional blocks before the attributes, in their fixed order.
        if flags & DATATYPE_FLAG_TYPEGUID:
            cur += 16
        if flags & DATATYPE_FLAG_COPYMASK:
            cur += size
        if flags & DATATYPE_FLAG_METHODINFOS:
            (method_count,) = struct.unpack_from("<H", data, cur)
            cur += 2
            for _ in range(method_count):
                cur += struct.unpack_from("<I", data, cur)[0]
        attributes = _attributes(data, cur, pos + entry_length)
    return DataTypeEntry(name, type_name, size, offset, flags, tuple(dims), tuple(subs), comment, attributes)


def parse_datatypes(data: bytes) -> dict[str, DataTypeEntry]:
    """Data types by lower-cased name: IEC identifiers are case-insensitive."""
    types: dict[str, DataTypeEntry] = {}
    pos = 0
    while pos + 4 <= len(data):
        (entry_length,) = struct.unpack_from("<I", data, pos)
        if entry_length == 0:
            break
        entry = _parse_datatype(data, pos)
        types[entry.name.lower()] = entry
        pos += entry_length
    return types


# ── Type descriptions ────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Leaf:
    codec: ScalarCodec

    @property
    def size(self) -> int:
        return self.codec.size


@dataclass(frozen=True, slots=True)
class ArrayOf:
    element: Description
    dims: tuple[tuple[int, int], ...]
    stride: int

    @property
    def count(self) -> int:
        return math.prod(n for _, n in self.dims)

    @property
    def size(self) -> int:
        return self.stride * self.count

    def flat_index(self, indices: tuple[int, ...]) -> int | None:
        """Row-major position of PLC *indices*, or None when out of bounds."""
        if len(indices) != len(self.dims):
            return None
        flat = 0
        for index, (lower, count) in zip(indices, self.dims, strict=True):
            if not lower <= index < lower + count:
                return None
            flat = flat * count + (index - lower)
        return flat


@dataclass(frozen=True, slots=True)
class Member:
    name: str
    offset: int
    description: Description
    attributes: dict[str, str] = field(default_factory=dict, compare=False, repr=False)


@dataclass(frozen=True, slots=True)
class Struct:
    members: tuple[Member, ...]
    size: int
    _by_name: dict[str, Member] = field(default_factory=dict, compare=False, repr=False)
    # The type's own attributes: marking a type marks every instance of it.
    attributes: dict[str, str] = field(default_factory=dict, compare=False, repr=False)

    def member(self, name: str) -> Member | None:
        return self._by_name.get(name.lower())


Description = Leaf | ArrayOf | Struct


@dataclass(frozen=True, slots=True)
class Address:
    """Where a readable value lives and how its bytes decode."""

    index_group: int
    index_offset: int
    codec: ScalarCodec
    count: int | None  # element count for an array, None for a scalar
    writable: bool

    @property
    def size(self) -> int:
        return self.codec.size * (self.count or 1)

    def decode(self, data: bytes) -> Any:
        if self.count is None:
            return self.codec.decode(data)
        step = self.codec.size
        return [self.codec.decode(data[i * step:(i + 1) * step]) for i in range(self.count)]

    def encode(self, value: Any) -> bytes:
        if self.count is None:
            return self.codec.encode(value)
        if not isinstance(value, (list, tuple)) or len(value) != self.count:
            raise ValueError(f"expected a list of {self.count} elements")
        return b"".join(self.codec.encode(v) for v in value)


_ARRAY_TYPE_RE = re.compile(r"ARRAY\s*\[(.+?)\]\s*OF\s+(.+)", re.IGNORECASE | re.DOTALL)
_PATH_TOKEN_RE = re.compile(r"\.?([^.\[\]]+)|\[([^\]]+)\]")


def _parse_bounds(text: str) -> tuple[tuple[int, int], ...] | None:
    dims: list[tuple[int, int]] = []
    for part in text.split(","):
        lo, sep, hi = part.partition("..")
        try:
            lower, upper = int(lo), int(hi)
        except ValueError:
            return None
        if not sep or upper < lower:
            return None
        dims.append((lower, upper - lower + 1))
    return tuple(dims)


def _path_tokens(path: str) -> list[str | tuple[int, ...]] | None:
    """``MAIN.a[1,2].x`` → ``["MAIN", "a", (1, 2), "x"]``; None if malformed."""
    tokens: list[str | tuple[int, ...]] = []
    pos = 0
    while pos < len(path):
        match = _PATH_TOKEN_RE.match(path, pos)
        if match is None:
            return None
        if match.group(1) is not None:
            name = match.group(1).strip()
            # Some library globals are named with a leading dot (".TCPADS_MAXUDP_BUFFSIZE").
            tokens.append("." + name if pos == 0 and path.startswith(".") else name)
        else:
            try:
                tokens.append(tuple(int(i) for i in match.group(2).split(",")))
            except ValueError:
                return None
        pos = match.end()
    return tokens


class SymbolTable:
    def __init__(self, symbols: list[SymbolEntry], datatypes: dict[str, DataTypeEntry]) -> None:
        self.symbols = symbols
        self._by_name = {s.name.lower(): s for s in symbols}
        self._datatypes = datatypes
        self._described: dict[tuple[str, int], Description | None] = {}

    @classmethod
    def from_upload(cls, symbol_data: bytes, datatype_data: bytes) -> SymbolTable:
        return cls(parse_symbols(symbol_data), parse_datatypes(datatype_data))

    def describe(self, type_name: str, size: int = 0, depth: int = 0) -> Description | None:
        """How a value of *type_name* is laid out, or None for a type this
        client cannot show (pointers, references, interfaces, bit fields)."""
        key = (type_name.strip().lower(), size)
        if key not in self._described:
            self._described[key] = self._describe(type_name.strip(), size, depth)
        return self._described[key]

    def _describe(self, name: str, size: int, depth: int) -> Description | None:
        if depth > _MAX_TYPE_DEPTH or name.upper().startswith(("POINTER TO", "REFERENCE TO")):
            return None
        codec = base_codec(name)
        if codec is not None:
            # A size that disagrees means a type this table reads wrongly; skip
            # it rather than show bytes decoded as something they are not.
            return Leaf(codec) if not size or size == codec.size else None
        entry = self._datatypes.get(name.lower())
        if entry is not None:
            return self._describe_entry(entry, depth)
        match = _ARRAY_TYPE_RE.fullmatch(name)
        if match is not None:
            dims = _parse_bounds(match.group(1))
            element = self.describe(match.group(2), 0, depth + 1)
            if dims is None or element is None:
                return None
            return ArrayOf(element, dims, element.size)
        return None

    def _describe_entry(self, entry: DataTypeEntry, depth: int) -> Description | None:
        if entry.array_dims:
            count = math.prod(n for _, n in entry.array_dims)
            if not count:
                return None
            stride = entry.size // count
            element = self.describe(entry.type_name, stride, depth + 1)
            return ArrayOf(element, entry.array_dims, stride) if element is not None else None
        if entry.sub_items:
            members: list[Member] = []
            for item in entry.sub_items:
                # Compiler-generated members (__FB_…__SBINITIALIZED) are not program data.
                if item.flags & _SKIPPED_ITEM_FLAGS or "implicit_inst_var" in item.attributes:
                    continue
                described = self.describe(item.type_name, item.size, depth + 1)
                if described is not None:
                    members.append(Member(item.name, item.offset, described, item.attributes))
            return Struct(tuple(members), entry.size, {m.name.lower(): m for m in members}, entry.attributes)
        if entry.type_name and entry.type_name.lower() != entry.name.lower():
            # Alias or enum: laid out as its base type.
            return self.describe(entry.type_name, entry.size, depth + 1)
        return None

    def _symbol_for(self, tokens: list[str | tuple[int, ...]]) -> tuple[SymbolEntry, int] | None:
        """The symbol a path starts with and how many tokens its name took.

        Symbol names contain dots themselves (``MAIN.stMotor``), so the longest
        leading run of names that is a symbol wins.
        """
        names = 0
        while names < len(tokens) and isinstance(tokens[names], str):
            names += 1
        for taken in range(names, 0, -1):
            symbol = self._by_name.get(".".join(str(t) for t in tokens[:taken]).lower())
            if symbol is not None:
                return symbol, taken
        return None

    def _locate(self, path: str) -> tuple[SymbolEntry, int, Description] | None:
        """The symbol behind member *path*, the member's offset in it and its layout."""
        tokens = _path_tokens(path)
        if not tokens:
            return None
        found = self._symbol_for(tokens)
        if found is None:
            return None
        symbol, taken = found
        if symbol.flags & SYMBOL_FLAG_BITVALUE:
            return None
        walked = self._walk(self.describe(symbol.type_name, symbol.size), tokens[taken:])
        return (symbol, *walked) if walked is not None else None

    @staticmethod
    def _walk(
        description: Description | None, tokens: list[str | tuple[int, ...]],
    ) -> tuple[int, Description] | None:
        """Follow member names and indices into *description*: the offset reached and its layout."""
        if description is None:
            return None
        offset = 0
        for token in tokens:
            if isinstance(token, str):
                member = description.member(token) if isinstance(description, Struct) else None
                if member is None:
                    return None
                offset += member.offset
                description = member.description
            else:
                if not isinstance(description, ArrayOf):
                    return None
                flat = description.flat_index(token)
                if flat is None:
                    return None
                offset += flat * description.stride
                description = description.element
        return offset, description

    def resolve(self, path: str) -> Address | None:
        """The address of the scalar or scalar array at member *path*.

        None when the path names nothing, or a struct (structs are read
        member by member).
        """
        located = self._locate(path)
        if located is None:
            return None
        symbol, offset, description = located
        writable = not symbol.flags & SYMBOL_FLAG_READONLY
        group, base = symbol.index_group, symbol.index_offset + offset
        if isinstance(description, Leaf):
            return Address(group, base, description.codec, None, writable)
        if isinstance(description, ArrayOf) and isinstance(description.element, Leaf):
            if description.stride != description.element.size:
                return None
            return Address(group, base, description.element.codec, description.count, writable)
        return None

    # ── Browse ───────────────────────────────────────────────────────────────

    def _shown_symbols(self, prefix: str) -> list[tuple[SymbolEntry, list[str], Description]]:
        """Symbols below *prefix* this client can show, with their name parts."""
        shown: list[tuple[SymbolEntry, list[str], Description]] = []
        for symbol in self.symbols:
            if prefix and not symbol.name.lower().startswith(prefix + "."):
                continue
            if symbol.flags & SYMBOL_FLAG_BITVALUE:
                continue
            description = self.describe(symbol.type_name, symbol.size)
            if description is None or self._inside_another(symbol):
                continue
            parts = symbol.name.split(".")
            if not parts[0] and len(parts) > 1:
                # A leading dot belongs to the first name, not an unnamed folder.
                parts = ["." + parts[1], *parts[2:]]
            shown.append((symbol, parts, description))
        return shown

    def _inside_another(self, symbol: SymbolEntry) -> bool:
        """Whether *symbol* is also a member of another symbol, which shows it.

        TwinCAT publishes an I/O-linked variable inside a function block
        (``gPlc.emX.bSensor AT %I*``) as a symbol of its own as well, in the
        process image; the function block's node already holds it.
        """
        tokens = _path_tokens(symbol.name) or []
        for taken in range(len(tokens) - 1, 0, -1):
            if not all(isinstance(t, str) for t in tokens[:taken]):
                continue
            parent = self._by_name.get(".".join(str(t) for t in tokens[:taken]).lower())
            if parent is not None:
                return self._walk(self.describe(parent.type_name, parent.size), tokens[taken:]) is not None
        return False

    def browse(self, root: str = "", *, attributes: tuple[str, ...] | None = None) -> list[dict[str, Any]]:
        """The browse nodes below *root* (a symbol-name prefix such as
        ``MAIN`` or ``GVL_HMI``; empty for everything), in upload order.

        With *attributes* (``("OPC.UA.DA",)``), only what one of them marks:
        see the module docstring.
        """
        prefix = root.strip().lower()
        marks = _Marks(attributes) if attributes is not None else None
        top: list[dict[str, Any]] = []
        folders: dict[str, dict[str, Any]] = {}
        for symbol, parts, description in self._shown_symbols(prefix):
            writable = not symbol.flags & SYMBOL_FLAG_READONLY
            if marks is None:
                node = _node(symbol.name, parts[-1], description, writable)
            else:
                state = marks.state(symbol.attributes)
                if state is False or (state is None and not marks.below(description)):
                    continue
                node = _node(symbol.name, parts[-1], description, writable, marks, inside=state is True)
            if node is None:
                continue
            # Folders for the dotted name segments below the root.
            skip = len(prefix.split(".")) if prefix else 0
            siblings = top
            for depth in range(skip, len(parts) - 1):
                folder_id = ".".join(parts[:depth + 1])
                folder = folders.get(folder_id.lower())
                if folder is None:
                    folder = {
                        "node_id": folder_id,
                        "display_name": parts[depth],
                        "data_type": None,
                        "children": [],
                    }
                    folders[folder_id.lower()] = folder
                    siblings.append(folder)
                siblings = folder["children"]
            siblings.append(node)
        return top

    def browse_level(self, path: str = "") -> list[dict[str, Any]]:
        """The nodes one level below *path*: a symbol-name prefix (``""``,
        ``gPlc``) or a struct, struct array or element (``gPlc.stAxis``,
        ``MAIN.aPoints[2]``). A struct node carries ``has_children`` and no
        children; browse its ``node_id`` for them."""
        path = path.strip()
        located = self._locate(path) if path else None
        if located is not None:
            symbol, _offset, description = located
            writable = not symbol.flags & SYMBOL_FLAG_READONLY
            if isinstance(description, Struct):
                candidates = [(f"{path}.{m.name}", m.name, m.description) for m in description.members]
            elif isinstance(description, ArrayOf) and isinstance(description.element, Struct) and len(description.dims) == 1:
                lower, count = description.dims[0]
                candidates = [(f"{path}[{i}]", f"[{i}]", description.element) for i in range(lower, lower + count)]
            else:
                return []
            return [n for p, name, d in candidates if (n := _shallow(p, name, d, writable)) is not None]

        prefix = path.lower()
        skip = len(path.split(".")) if path else 0
        level: list[dict[str, Any]] = []
        folders: set[str] = set()
        for symbol, parts, description in self._shown_symbols(prefix):
            if len(parts) - 1 == skip:
                node = _shallow(symbol.name, parts[-1], description, not symbol.flags & SYMBOL_FLAG_READONLY)
                if node is not None:
                    level.append(node)
                continue
            folder_id = ".".join(parts[:skip + 1])
            if folder_id.lower() not in folders:
                folders.add(folder_id.lower())
                level.append({
                    "node_id": folder_id, "display_name": parts[skip], "data_type": None,
                    "children": [], "has_children": True,
                })
        return level


class _Marks:
    """Which attribute names make a node visible in a marked browse."""

    def __init__(self, names: tuple[str, ...]) -> None:
        self._names = tuple(n.strip().lower() for n in names if n.strip())
        self._below: dict[int, bool] = {}

    def state(self, attributes: dict[str, str]) -> bool | None:
        """True when marked, False when marked ``'0'``, None when unmarked."""
        for name in self._names:
            value = attributes.get(name)
            if value is not None:
                return value.strip() != "0"
        return None

    def below(self, description: Description) -> bool:
        """Whether anything inside *description* is marked (cached per layout)."""
        key = id(description)
        if key not in self._below:
            self._below[key] = False  # a recursive type ends here
            if isinstance(description, ArrayOf):
                found = self.below(description.element)
            elif isinstance(description, Struct):
                found = self.state(description.attributes) is True or any(
                    (state := self.state(m.attributes)) is True or (state is None and self.below(m.description))
                    for m in description.members
                )
            else:
                found = False
            self._below[key] = found
        return self._below[key]


def _node(
    path: str, name: str, description: Description, writable: bool,
    marks: _Marks | None = None, inside: bool = True,
) -> dict[str, Any] | None:
    """The browse node for *description*. With *marks*, only what is marked
    or *inside* something marked; an unmarked struct appears as the way to
    marked members below it."""
    if isinstance(description, Leaf):
        return _leaf(path, name, description.codec, writable) if inside else None
    if isinstance(description, Struct):
        if marks is not None:
            inside = inside or marks.state(description.attributes) is True
            if not inside and not marks.below(description):
                return None
        children = []
        for m in description.members:
            state = marks.state(m.attributes) if marks is not None else None
            if state is False:
                continue
            child = _node(f"{path}.{m.name}", m.name, m.description, writable, marks, inside or state is True)
            if child is not None:
                children.append(child)
        if not children:
            return None
        return {"node_id": path, "display_name": name, "data_type": "struct", "children": children, "writable": False}
    element = description.element
    if isinstance(element, Leaf):
        if description.stride != element.size or not inside:
            return None
        node = _leaf(path, name, element.codec, writable)
        node["is_array"] = True
        node["array_length"] = description.count
        return node
    if isinstance(element, Struct) and len(description.dims) == 1:
        if marks is not None and not inside and not marks.below(element):
            return None
        lower, count = description.dims[0]
        children = [
            child
            for index in range(lower, lower + count)
            if (child := _node(f"{path}[{index}]", f"[{index}]", element, writable, marks, inside)) is not None
        ]
        if not children:
            return None
        return {
            "node_id": path,
            "display_name": name,
            "data_type": "struct",
            "children": children,
            "writable": False,
            "is_array": True,
        }
    # Multi-dimensional struct arrays and arrays of arrays have no tree shape here.
    return None


def _shallow(path: str, name: str, description: Description, writable: bool) -> dict[str, Any] | None:
    """*description*'s node without its children, for a one-level browse."""
    if isinstance(description, Struct):
        if not description.members:
            return None
        return {
            "node_id": path, "display_name": name, "data_type": "struct",
            "children": [], "writable": False, "has_children": True,
        }
    if isinstance(description, ArrayOf) and isinstance(description.element, Struct):
        if len(description.dims) != 1 or not description.element.members:
            return None
        return {
            "node_id": path, "display_name": name, "data_type": "struct",
            "children": [], "writable": False, "has_children": True, "is_array": True,
        }
    return _node(path, name, description, writable)


def _leaf(path: str, name: str, codec: ScalarCodec, writable: bool) -> dict[str, Any]:
    return {"node_id": path, "display_name": name, "data_type": codec.type_name, "children": [], "writable": writable}
