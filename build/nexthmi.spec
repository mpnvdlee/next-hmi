# PyInstaller spec for the NEXT HMI portable binary.
#
# One-folder console build. The launcher (backend/launcher.py) resolves
# the workspace path from ~/.config/nexthmi/runtime.json (or %APPDATA%),
# seeds the workspace from the bundled project-seed/ on first run, sets the env
# vars storage.py reads at import time, and starts uvicorn.
#
# Run from repo root:
#   pyinstaller build/nexthmi.spec --noconfirm --clean
#
# Output: dist/nexthmi/ (one-folder; zip the folder for distribution).
#
# NEXTHMI_EDITION (default "oss") selects the edition. "ee" additionally packages
# the enterprise tree from enterprise/backend/. Note this spec bundles whatever
# is already in frontend/dist/ — building the matching frontend edition
# (NEXTHMI_EDITION=ee npx vite build) is the build script's job, not this file's.
# What *is* this file's job is refusing to package a bundle built for the other
# edition; see "Frontend bundle" below.
# noqa: E501 — PyInstaller's spec format is permissive about line length.

import os
import re
import sys
from pathlib import Path

# PyInstaller injects SPECPATH (the dir holding this spec) at exec time.
spec_dir = Path(SPECPATH).resolve()  # type: ignore[name-defined]  # noqa: F821
repo_root = spec_dir.parent

# Make backend/ importable so collect_submodules() below can resolve our
# in-tree packages (mcp_server, services, …) without the build host
# needing them on PYTHONPATH.
_backend_str = str(repo_root / "backend")
if _backend_str not in sys.path:
    sys.path.insert(0, _backend_str)

# --- Edition -----------------------------------------------------------------
# "oss" (default) is the public AGPL artifact and must contain no enterprise
# code whatsoever. "ee" adds the enterprise tree, which launcher.py reaches via
# importlib when NEXTHMI_EDITION=ee at runtime.
EDITION = os.environ.get("NEXTHMI_EDITION", "oss")
if EDITION not in ("oss", "ee"):
    raise SystemExit(f"Unknown NEXTHMI_EDITION '{EDITION}' — expected 'oss' or 'ee'.")

_enterprise_backend = repo_root / "enterprise" / "backend"
if EDITION == "ee":
    if not (_enterprise_backend / "manager_enterprise.py").is_file():
        raise SystemExit(
            f"NEXTHMI_EDITION=ee but {_enterprise_backend} is missing — "
            "clone the enterprise repository into enterprise/."
        )
    _ee_str = str(_enterprise_backend)
    if _ee_str not in sys.path:
        sys.path.insert(0, _ee_str)

# --- Frontend bundle ---------------------------------------------------------
# frontend/dist/ is built out-of-band, so the SPA sitting there may have been
# built for the *other* edition — and an ee bundle packaged by an oss run would
# put proprietary code inside the AGPL artifact, which is the one thing the
# split exists to prevent. Two independent checks, either of which is enough:
#
#   1. The stamp the build scripts write next to the bundle (build-binary.sh /
#      .ps1 build the SPA for the requested edition and then record it).
#   2. The bundle's own contents. Class selectors declared under
#      enterprise/frontend/ survive minification verbatim, so their presence
#      (or absence) identifies the bundle without trusting any stamp. Derived
#      from the enterprise sources on the build host rather than hardcoded, so
#      the check cannot go stale; on a host without enterprise/ there is
#      nothing to leak in the first place.
frontend_dist = repo_root / "frontend" / "dist"
EDITION_STAMP_NAME = ".nexthmi-edition"

if not (frontend_dist / "index.html").is_file():
    raise SystemExit(
        f"No SPA bundle at {frontend_dist} — run the frontend build first "
        "(build/build-binary.sh does this for you)."
    )

_class_selector = re.compile(r"\.(-?[_a-zA-Z][\w-]{5,})")


def _class_names(root: Path) -> set[str]:
    names: set[str] = set()
    for css in root.rglob("*.css"):
        names |= set(_class_selector.findall(css.read_text(encoding="utf-8", errors="ignore")))
    return names


def _enterprise_markers() -> set[str]:
    ee_frontend = repo_root / "enterprise" / "frontend"
    if not ee_frontend.is_dir():
        return set()
    # Subtract anything core also declares: a name shared with the public tree
    # proves nothing about which edition produced the bundle.
    return _class_names(ee_frontend) - _class_names(repo_root / "frontend" / "src")


def _bundle_contains(markers: set[str]) -> bool:
    for asset in frontend_dist.rglob("*"):
        if asset.suffix not in (".js", ".css") or not asset.is_file():
            continue
        text = asset.read_text(encoding="utf-8", errors="ignore")
        if any(marker in text for marker in markers):
            return True
    return False


_stamp_file = frontend_dist / EDITION_STAMP_NAME
_stamped = _stamp_file.read_text(encoding="utf-8").strip() if _stamp_file.is_file() else None
if _stamped and _stamped != EDITION:
    raise SystemExit(
        f"{frontend_dist} was built for edition '{_stamped}' but this is a "
        f"'{EDITION}' build — rebuild the SPA (NEXTHMI_EDITION={EDITION} npm run build "
        "in frontend/) before packaging."
    )

_markers = _enterprise_markers()
if _markers:
    _has_enterprise_spa = _bundle_contains(_markers)
    if EDITION == "oss" and _has_enterprise_spa:
        raise SystemExit(
            f"{frontend_dist} contains enterprise SPA code and this is the public "
            "AGPL build — rebuild the SPA with NEXTHMI_EDITION unset before packaging."
        )
    if EDITION == "ee" and not _has_enterprise_spa:
        raise SystemExit(
            f"{frontend_dist} is an oss SPA bundle but this is an 'ee' build — "
            "rebuild it with NEXTHMI_EDITION=ee before packaging."
        )
elif _stamped is None:
    print(f"[spec] warning: cannot verify the edition of {frontend_dist} (no stamp, no markers)")

# --- Bundled data files ------------------------------------------------------
# Format: list of (source-on-host, destination-inside-bundle) tuples.
datas: list[tuple[str, str]] = [
    (str(frontend_dist), "frontend/dist"),
    (str(repo_root / "project-seed"), "project-seed"),
    # Theme defaults are shared between the SPA's Theme Editor and the
    # backend's pydantic validation models; models/theme.py reads it via
    # sys._MEIPASS when frozen.
    (
        str(repo_root / "frontend" / "src" / "shared" / "themeDefaults.json"),
        "frontend/src/shared",
    ),
]

# esbuild binary — drop in the host-platform binary so the runtime widget
# compiler can shell out to it. The build script (build-binary.sh /
# build-binary.ps1) copies a fresh esbuild into build/_vendor/ before
# invoking PyInstaller. Missing binary is non-fatal; the launcher falls
# back to ``which esbuild`` on PATH.
_esbuild_name = "esbuild.exe" if sys.platform == "win32" else "esbuild"
_vendored_esbuild = repo_root / "build" / "_vendor" / _esbuild_name
if _vendored_esbuild.is_file():
    datas.append((str(_vendored_esbuild), "."))

# Optional version stamp — build script may drop one in.
_version_file = repo_root / "build" / "_vendor" / "version.txt"
if _version_file.is_file():
    datas.append((str(_version_file), "."))

# --- Hidden imports ----------------------------------------------------------
# uvicorn's autoloaders pick implementations at import time via importlib;
# PyInstaller's static scanner can't see them. Spell them out so the frozen
# binary actually has working HTTP + WebSocket protocol stacks.
hiddenimports = [
    # The two ASGI apps. launcher._load_edition_app() imports them by name
    # through importlib so that core.storage's import-time path constants are
    # computed only after the launcher has set the env vars they read — which
    # also means nothing in the frozen entrypoint's static graph reaches them.
    # Without these two names the binary ships no application at all and dies
    # on first launch with ModuleNotFoundError.
    "main",
    "manager",
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.protocols.websockets.wsproto_impl",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
]

# --- collect-all packages ----------------------------------------------------
# Pull in dynamic submodules + data files for libraries with native
# extensions or runtime imports PyInstaller can't trace statically.
from PyInstaller.utils.hooks import collect_all, collect_submodules  # noqa: E402

_collect_targets = [
    "mcp",
    "watchfiles",
    "tree_sitter",
    "tree_sitter_typescript",
]

# --- LGPL components: shipped replaceable, never frozen (release item 1a) -----
# asyncua (LGPL-3.0-or-later) is the OPC-UA client; zeroconf (LGPL-2.1-or-later)
# powers LAN peer discovery. LGPL only permits a proprietary combined work if
# the recipient can replace the LGPL component and relink — which a frozen PYZ
# archive forbids. So carve both out: ship each as a loose package directory
# under lgpl/ on the runtime sys.path (the Python analogue of a replaceable
# shared library), exclude them from Analysis so nothing reaches the PYZ, and
# have launcher._prepend_lgpl_path() add the folder when frozen. asyncua is
# pure Python; zeroconf ships compiled extensions that travel with it as loose
# files. Applies to both editions — one spec, and a conditional costs more to
# maintain than it saves. The AGPL build satisfies LGPL automatically, but the
# commercial artifact strictly needs this.
import importlib.util as _ilu  # noqa: E402

_LGPL_PKGS = ("asyncua", "zeroconf")
for _lgpl_pkg in _LGPL_PKGS:
    _lgpl_spec = _ilu.find_spec(_lgpl_pkg)
    if _lgpl_spec is None or not _lgpl_spec.origin:
        raise SystemExit(
            f"LGPL carve-out: '{_lgpl_pkg}' is not importable on the build host — "
            "install backend/requirements.txt before packaging."
        )
    datas.append((str(Path(_lgpl_spec.origin).parent), f"lgpl/{_lgpl_pkg}"))

# The LGPL obliges us to ship its licence texts and to make the replaceability
# and source offer legible. These land at lgpl/ (root "lgpl", so they survive
# the post-Analysis _is_lgpl filter, which only strips the "asyncua"/"zeroconf"
# roots).
for _lgpl_doc in (
    "build/lgpl/LICENSE-LGPL-3.0.txt",
    "build/lgpl/LICENSE-GPL-3.0.txt",
    "build/lgpl/LICENSE-LGPL-2.1.txt",
    "build/lgpl-OFFER.txt",
):
    datas.append((str(repo_root / _lgpl_doc), "lgpl"))

# mcp_server.tools.* and mcp_server.prompts.* are loaded by string via
# importlib.import_module() in mcp_server.server.import_all(), so static
# analysis misses them. Force-collect every submodule of our own package.
hiddenimports += collect_submodules("mcp_server")

# launcher._load_edition_app() reaches both ee entrypoints through
# importlib.import_module(), so static analysis misses them and everything they
# pull in. Only ever added for the ee edition.
if EDITION == "ee":
    hiddenimports += [
        "manager_enterprise",
        "main_enterprise",
        *collect_submodules("nexthmi_enterprise"),
    ]
_collected_datas: list = []
_collected_binaries: list = []
_collected_hiddens: list = []
for _pkg in _collect_targets:
    try:
        _d, _b, _h = collect_all(_pkg)
    except Exception:
        # Skip absent packages quietly so the spec is portable across the
        # MVP build matrix and any future trimmed-down editions.
        continue
    _collected_datas += _d
    _collected_binaries += _b
    _collected_hiddens += _h

# --- Analysis ----------------------------------------------------------------
backend_dir = repo_root / "backend"
pathex = [str(backend_dir)]
# The oss artifact is the one with a legal constraint on it: an AGPL build
# published to everyone must contain no proprietary code. Excluding the package
# by name makes that structural rather than a matter of nothing importing it.
edition_excludes = (
    []
    if EDITION == "ee"
    else ["nexthmi_enterprise", "manager_enterprise", "main_enterprise"]
)
if EDITION == "ee":
    pathex.append(str(_enterprise_backend))

a = Analysis(  # noqa: F821
    [str(backend_dir / "launcher.py")],
    pathex=pathex,
    binaries=_collected_binaries,
    datas=datas + _collected_datas,
    hiddenimports=hiddenimports + _collected_hiddens,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter",
        "matplotlib",
        "PIL",
        "IPython",
        "jupyter",
        "pytest",
        "test",
        "tests",
        *edition_excludes,
    ],
    noarchive=False,
    optimize=0,
)

# LGPL carve-out, part two (see the loose-ship block above). The packages were
# deliberately *not* excluded from Analysis, so PyInstaller followed into them
# and collected their dependency closure (ifaddr, aiofiles, aiosqlite, … — the
# ones nothing else imports) into the archive. Now strip the LGPL packages
# themselves back out: their pure modules, their compiled extensions
# (zeroconf's .so), and their bundled data (asyncua's nodesets) all ship loose
# under lgpl/ instead, so leaving copies in the archive would both defeat
# replaceability (the frozen importer resolves before sys.path, so the embedded
# copy would always win over the loose one) and double the payload.


def _is_lgpl(dest: str) -> bool:
    # dest is a module name ("asyncua.ua") in a.pure or a bundle path
    # ("zeroconf/_dns...so", "asyncua/schemas/...xml") in a.binaries / a.datas.
    root = dest.replace("\\", "/").split("/", 1)[0].split(".", 1)[0]
    return root in _LGPL_PKGS


a.pure = [entry for entry in a.pure if not _is_lgpl(entry[0])]
a.binaries = [entry for entry in a.binaries if not _is_lgpl(entry[0])]
a.datas = [entry for entry in a.datas if not _is_lgpl(entry[0])]

pyz = PYZ(a.pure)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="nexthmi",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

# Distinct output folders per edition. One spec produces two artifacts under two
# different licences and two signing certificates; sharing dist/nexthmi/ would
# let an ee build silently overwrite the public one.
coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="nexthmi" if EDITION == "oss" else "nexthmi-enterprise",
)
