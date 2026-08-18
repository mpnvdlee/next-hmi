/**
 * HMI Theme types — mirrors backend models.theme
 */

interface ThemeColors {
  bg: string;
  surface: string;
  surface_raised: string;
  text: string;
  text_muted: string;
  accent: string;
  border: string;
  ok: string;
  warn: string;
  fault: string;
}

/**
 * Typography is expressed as seven reusable *combos*. Each combo carries its
 * own font family, size, weight, letter-spacing, and case so a scenario
 * (heading, body, big readout, uppercase label, …) is configured in one place.
 */
interface ThemeTypography {
  heading_font: string;
  heading_size: string;
  heading_weight: number;
  heading_tracking: string;
  heading_transform: string;
  subheading_font: string;
  subheading_size: string;
  subheading_weight: number;
  subheading_tracking: string;
  subheading_transform: string;
  body_font: string;
  body_size: string;
  body_weight: number;
  body_tracking: string;
  body_transform: string;
  caption_font: string;
  caption_size: string;
  caption_weight: number;
  caption_tracking: string;
  caption_transform: string;
  code_font: string;
  code_size: string;
  code_weight: number;
  code_tracking: string;
  code_transform: string;
  value_font: string;
  value_size: string;
  value_weight: number;
  value_tracking: string;
  value_transform: string;
  label_font: string;
  label_size: string;
  label_weight: number;
  label_tracking: string;
  label_transform: string;
}

interface ThemeSpacing {
  space_sm: string;
  space_md: string;
  space_lg: string;
  radius_sm: string;
  radius_md: string;
  radius_lg: string;
  shadow: string;
}

export interface ThemeConfig {
  colors: ThemeColors;
  typography: ThemeTypography;
  spacing: ThemeSpacing;
}

/** One theme in the `/api/themes` index: its id and config. */
export interface ThemeEnvelope {
  id: string;
  config: ThemeConfig;
}

/** Shape returned by `GET /api/themes`: the default id plus every theme. */
export interface ThemesIndex {
  default: string;
  themes: ThemeEnvelope[];
}

/** Shared shape for both errors and warnings — see `ThemeValidationIssue` (backend `models/theme.py`). */
export interface ThemeValidationIssue {
  level: 'info' | 'warning' | 'error';
  code: string;
  path: string;
  message: string;
}

export interface ThemeValidationResult {
  valid: boolean;
  warnings: ThemeValidationIssue[];
  errors: ThemeValidationIssue[];
}
