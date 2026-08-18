"""HMI theme configuration models with validation.

Default token values are loaded from ``frontend/src/shared/themeDefaults.json``
— the single source of truth shared with the frontend Theme Editor. To change
a default, edit that file; both the Pydantic models here and the editor's
``themeTokens`` registry pick it up.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic import ValidationError as PydanticValidationError

# ── Defaults loader ───────────────────────────────────────────────────────────

def _resolve_defaults_path() -> Path:
    """Locate ``themeDefaults.json`` in both source checkouts and PyInstaller bundles.

    In a frozen binary, ``__file__`` lives inside the bundle's internal layout
    where ``parents[2]`` doesn't land at the project root — so fall back to
    ``sys._MEIPASS``. The build spec ships the file at the same relative path.
    """
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return Path(meipass) / "frontend" / "src" / "shared" / "themeDefaults.json"
    return (
        Path(__file__).resolve().parents[2]
        / "frontend"
        / "src"
        / "shared"
        / "themeDefaults.json"
    )


_DEFAULTS_PATH = _resolve_defaults_path()


def _load_defaults() -> dict[str, Any]:
    with _DEFAULTS_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


_DEFAULTS: dict[str, Any] = _load_defaults()


def _default(section: str, key: str) -> Any:
    return _DEFAULTS[section][key]


# ── Color validation ──────────────────────────────────────────────────────────

def _validate_color(value: str) -> bool:
    """Check if value is a valid hex or rgb/rgba color."""
    # Hex: #RGB or #RRGGBB
    if re.match(r"^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$", value):
        return True
    # rgb/rgba
    return bool(re.match(r"^rgba?\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)$", value))


def _hex_to_rgb(hex_str: str) -> tuple[int, int, int] | None:
    """Convert #RRGGBB or #RGB to (r, g, b)."""
    hex_str = hex_str.lstrip("#")
    if len(hex_str) == 3:
        hex_str = "".join([c * 2 for c in hex_str])
    if len(hex_str) != 6:
        return None
    try:
        return tuple(int(hex_str[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore
    except ValueError:
        return None


def _contrast_ratio(rgb1: tuple[int, int, int], rgb2: tuple[int, int, int]) -> float:
    """Calculate WCAG contrast ratio between two RGB colors."""
    def luminance(rgb: tuple[int, int, int]) -> float:
        r, g, b = [x / 255.0 for x in rgb]
        r = r / 12.92 if r <= 0.03928 else ((r + 0.055) / 1.055) ** 2.4
        g = g / 12.92 if g <= 0.03928 else ((g + 0.055) / 1.055) ** 2.4
        b = b / 12.92 if b <= 0.03928 else ((b + 0.055) / 1.055) ** 2.4
        return 0.2126 * r + 0.7152 * g + 0.0722 * b

    lum1 = luminance(rgb1)
    lum2 = luminance(rgb2)
    lighter = max(lum1, lum2)
    darker = min(lum1, lum2)
    return (lighter + 0.05) / (darker + 0.05)


def _check_contrast_wcag(
    text_color: str, bg_color: str, level: Literal["AA", "AAA"] = "AA"
) -> tuple[bool, float]:
    """Return (meets_wcag, ratio). ratio >= 4.5 for AA, >= 7.0 for AAA."""
    rgb_text = _hex_to_rgb(text_color)
    rgb_bg = _hex_to_rgb(bg_color)
    
    if rgb_text is None or rgb_bg is None:
        return (True, 0.0)  # Can't validate, assume OK

    ratio = _contrast_ratio(rgb_text, rgb_bg)
    threshold = 7.0 if level == "AAA" else 4.5
    return (ratio >= threshold, ratio)


# ── Schema models ──────────────────────────────────────────────────────────────

class ThemeColors(BaseModel):
    """Editable color tokens for HMI."""

    model_config = ConfigDict(extra="forbid")

    # Backgrounds
    bg: str = Field(default_factory=lambda: _default("colors", "bg"), description="Main background")
    surface: str = Field(default_factory=lambda: _default("colors", "surface"), description="Card/panel background")
    surface_raised: str = Field(default_factory=lambda: _default("colors", "surface_raised"), description="Elevated surface")

    # Text
    text: str = Field(default_factory=lambda: _default("colors", "text"), description="Primary text color")
    text_muted: str = Field(default_factory=lambda: _default("colors", "text_muted"), description="Muted/secondary text")

    # Accents and borders
    accent: str = Field(default_factory=lambda: _default("colors", "accent"), description="Primary accent")
    border: str = Field(default_factory=lambda: _default("colors", "border"), description="Border color")

    # Status colors (semantic)
    ok: str = Field(default_factory=lambda: _default("colors", "ok"), description="Success/OK state")
    warn: str = Field(default_factory=lambda: _default("colors", "warn"), description="Warning state")
    fault: str = Field(default_factory=lambda: _default("colors", "fault"), description="Error/fault state")

    @field_validator("bg", "surface", "surface_raised", "text", "text_muted", "accent", "border", "ok", "warn", "fault")
    @classmethod
    def validate_colors(cls, v: str) -> str:
        if not _validate_color(v):
            raise ValueError(f"Invalid color format: {v}")
        return v


_TYPE_COMBOS = ("heading", "subheading", "body", "caption", "code", "value", "label")
_TEXT_TRANSFORMS = ("none", "uppercase", "lowercase", "capitalize")


class ThemeTypography(BaseModel):
    """Editable typography tokens.

    Seven reusable *combos* (heading, subheading, body, caption, code, value,
    label). Each combo carries its own font family, size, weight,
    letter-spacing, and case so a scenario is configured in one place.
    """

    model_config = ConfigDict(extra="forbid")

    heading_font: str = Field(default_factory=lambda: _default("typography", "heading_font"), description="Heading font family")
    heading_size: str = Field(default_factory=lambda: _default("typography", "heading_size"), description="Heading font size")
    heading_weight: int = Field(default_factory=lambda: _default("typography", "heading_weight"), ge=100, le=900, description="Heading weight")
    heading_tracking: str = Field(default_factory=lambda: _default("typography", "heading_tracking"), description="Heading letter spacing")
    heading_transform: str = Field(default_factory=lambda: _default("typography", "heading_transform"), description="Heading text case")

    subheading_font: str = Field(default_factory=lambda: _default("typography", "subheading_font"), description="Subheading font family")
    subheading_size: str = Field(default_factory=lambda: _default("typography", "subheading_size"), description="Subheading font size")
    subheading_weight: int = Field(default_factory=lambda: _default("typography", "subheading_weight"), ge=100, le=900, description="Subheading weight")
    subheading_tracking: str = Field(default_factory=lambda: _default("typography", "subheading_tracking"), description="Subheading letter spacing")
    subheading_transform: str = Field(default_factory=lambda: _default("typography", "subheading_transform"), description="Subheading text case")

    body_font: str = Field(default_factory=lambda: _default("typography", "body_font"), description="Body font family")
    body_size: str = Field(default_factory=lambda: _default("typography", "body_size"), description="Body font size")
    body_weight: int = Field(default_factory=lambda: _default("typography", "body_weight"), ge=100, le=900, description="Body weight")
    body_tracking: str = Field(default_factory=lambda: _default("typography", "body_tracking"), description="Body letter spacing")
    body_transform: str = Field(default_factory=lambda: _default("typography", "body_transform"), description="Body text case")

    caption_font: str = Field(default_factory=lambda: _default("typography", "caption_font"), description="Caption font family")
    caption_size: str = Field(default_factory=lambda: _default("typography", "caption_size"), description="Caption font size")
    caption_weight: int = Field(default_factory=lambda: _default("typography", "caption_weight"), ge=100, le=900, description="Caption weight")
    caption_tracking: str = Field(default_factory=lambda: _default("typography", "caption_tracking"), description="Caption letter spacing")
    caption_transform: str = Field(default_factory=lambda: _default("typography", "caption_transform"), description="Caption text case")

    code_font: str = Field(default_factory=lambda: _default("typography", "code_font"), description="Code/monospace font family")
    code_size: str = Field(default_factory=lambda: _default("typography", "code_size"), description="Code font size")
    code_weight: int = Field(default_factory=lambda: _default("typography", "code_weight"), ge=100, le=900, description="Code weight")
    code_tracking: str = Field(default_factory=lambda: _default("typography", "code_tracking"), description="Code letter spacing")
    code_transform: str = Field(default_factory=lambda: _default("typography", "code_transform"), description="Code text case")

    value_font: str = Field(default_factory=lambda: _default("typography", "value_font"), description="Value/readout font family")
    value_size: str = Field(default_factory=lambda: _default("typography", "value_size"), description="Value font size")
    value_weight: int = Field(default_factory=lambda: _default("typography", "value_weight"), ge=100, le=900, description="Value weight")
    value_tracking: str = Field(default_factory=lambda: _default("typography", "value_tracking"), description="Value letter spacing")
    value_transform: str = Field(default_factory=lambda: _default("typography", "value_transform"), description="Value text case")

    label_font: str = Field(default_factory=lambda: _default("typography", "label_font"), description="Label font family")
    label_size: str = Field(default_factory=lambda: _default("typography", "label_size"), description="Label font size")
    label_weight: int = Field(default_factory=lambda: _default("typography", "label_weight"), ge=100, le=900, description="Label weight")
    label_tracking: str = Field(default_factory=lambda: _default("typography", "label_tracking"), description="Label letter spacing")
    label_transform: str = Field(default_factory=lambda: _default("typography", "label_transform"), description="Label text case")

    @field_validator(*[f"{c}_font" for c in _TYPE_COMBOS])
    @classmethod
    def validate_font_family(cls, v: str) -> str:
        # Basic validation: ensure it's not empty and looks like a font spec
        if not v or len(v) > 256:
            raise ValueError("Invalid font family specification")
        return v

    @field_validator(*[f"{c}_transform" for c in _TYPE_COMBOS])
    @classmethod
    def validate_text_transform(cls, v: str) -> str:
        if v not in _TEXT_TRANSFORMS:
            raise ValueError(f"Invalid text-transform: {v}")
        return v


class ThemeSpacing(BaseModel):
    """Editable spacing and shape tokens."""

    model_config = ConfigDict(extra="forbid")

    # Spacing scale
    space_sm: str = Field(default_factory=lambda: _default("spacing", "space_sm"), description="Small spacing")
    space_md: str = Field(default_factory=lambda: _default("spacing", "space_md"), description="Medium spacing")
    space_lg: str = Field(default_factory=lambda: _default("spacing", "space_lg"), description="Large spacing")

    # Border radius
    radius_sm: str = Field(default_factory=lambda: _default("spacing", "radius_sm"), description="Small border radius")
    radius_md: str = Field(default_factory=lambda: _default("spacing", "radius_md"), description="Medium border radius")
    radius_lg: str = Field(default_factory=lambda: _default("spacing", "radius_lg"), description="Large border radius")

    # Shadow
    shadow: str = Field(default_factory=lambda: _default("spacing", "shadow"), description="Elevation shadow")


class ThemeConfig(BaseModel):
    """Complete editable theme configuration."""

    model_config = ConfigDict(extra="forbid")

    colors: ThemeColors = Field(default_factory=ThemeColors)
    typography: ThemeTypography = Field(default_factory=ThemeTypography)
    spacing: ThemeSpacing = Field(default_factory=ThemeSpacing)


# ── Request/Response models ────────────────────────────────────────────────────

class ThemeValidationIssue(BaseModel):
    """A single validation finding — used for both errors and warnings.

    ``code`` is a stable machine-readable identifier (a pydantic error
    ``type`` for fatal parse failures, e.g. ``"string_pattern_mismatch"``, or
    a domain code such as ``"contrast-low"``), ``path`` is dotted field
    location (e.g. ``"colors.text"``), and ``message`` is human-readable.
    """

    level: Literal["info", "warning", "error"] = "warning"
    code: str = Field(description="Stable machine-readable finding code")
    path: str = Field(description="Dotted path to the field (e.g. 'colors.text')")
    message: str = Field(description="Human-readable message")


class ThemeValidationResult(BaseModel):
    """Result of theme validation.

    One documented response model covers both fatal parse failures (malformed
    input that never constructs a valid ``ThemeConfig``) and domain-level
    diagnostics — both populate ``errors``/``warnings`` with the same
    ``ThemeValidationIssue`` shape rather than raising a differently-shaped
    HTTP error.
    """

    valid: bool = True
    warnings: list[ThemeValidationIssue] = Field(default_factory=list)
    errors: list[ThemeValidationIssue] = Field(default_factory=list)


def validate_theme(config: ThemeConfig) -> ThemeValidationResult:
    """Validate an already-parsed theme config and return warnings/errors."""
    warnings: list[ThemeValidationIssue] = []
    errors: list[ThemeValidationIssue] = []

    # Check contrast between text colors and background surfaces
    contrast_pairs: list[tuple[str, str, str, str]] = [
        # (text_color, bg_color, text_field_path, bg_field_path)
        (config.colors.text, config.colors.bg, "colors.text", "colors.bg"),
        (config.colors.text, config.colors.surface, "colors.text", "colors.surface"),
        (config.colors.text_muted, config.colors.bg, "colors.text_muted", "colors.bg"),
        (config.colors.text_muted, config.colors.surface, "colors.text_muted", "colors.surface"),
    ]

    for text_color, bg_color, text_field, bg_field in contrast_pairs:
        try:
            meets_aa, ratio = _check_contrast_wcag(text_color, bg_color, level="AA")
            if not meets_aa:
                warnings.append(
                    ThemeValidationIssue(
                        level="warning",
                        code="contrast-low",
                        path=f"{text_field} + {bg_field}",
                        message=f"Contrast ratio {ratio:.2f}:1 is below WCAG AA minimum (4.5:1)",
                    )
                )
        except ValueError:
            pass  # Skip if colors can't be parsed

    return ThemeValidationResult(
        valid=len(errors) == 0,
        warnings=warnings,
        errors=errors,
    )


def validate_theme_payload(payload: dict[str, Any]) -> ThemeValidationResult:
    """Validate a raw (possibly malformed) theme payload.

    Fatal pydantic parse failures (bad color format, unknown fields, out-of-
    range weights, ...) are converted into the same ``ThemeValidationResult``
    shape as domain diagnostics, instead of surfacing FastAPI's differently-
    shaped automatic 422 — so callers have exactly one response model to
    handle regardless of which layer rejected the theme. This unification
    covers any object-shaped ``payload``; a non-object top-level JSON body
    (array, string, number, ...) is still rejected by FastAPI's own 422
    before this function runs, since the endpoint parameter is typed
    ``dict[str, Any]``.
    """
    try:
        config = ThemeConfig.model_validate(payload)
    except PydanticValidationError as e:
        errors = [
            ThemeValidationIssue(
                level="error",
                code=str(err["type"]),
                path=".".join(str(p) for p in err["loc"]),
                message=err["msg"],
            )
            for err in e.errors()
        ]
        return ThemeValidationResult(valid=False, warnings=[], errors=errors)
    return validate_theme(config)
