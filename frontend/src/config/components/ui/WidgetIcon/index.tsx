import type { IconWeight } from '@phosphor-icons/react';
import { DEFAULT_CUSTOM_WIDGET_ICON, resolveWidgetMetadata } from '@hmi/registry/widgetRegistry';
import { BUILTIN_ICON_COMPONENTS } from '@shared/utils/phosphorIconComponents';
import type { IconValue } from '@shared/types/config';
import { withBase } from '@shared/utils/runtimeBase';

interface WidgetIconProps {
  /** Registered widget type. Its drawer metadata supplies the icon. */
  type?: string;
  /** Explicit metadata icon, used for component definitions before registration/save. */
  icon?: IconValue | null;
  size?: number;
  weight?: IconWeight;
}

/** The single icon renderer for widget/component metadata across config UI surfaces. */
export default function WidgetIcon({ type, icon, size = 14, weight = 'regular' }: WidgetIconProps) {
  const fallbackIcon = type ? resolveWidgetMetadata(type).icon : DEFAULT_CUSTOM_WIDGET_ICON;
  const requestedIcon = icon ?? fallbackIcon;

  if (requestedIcon.type === 'custom') {
    const relativePath = requestedIcon.path.replace(/^\/?assets\//, '');
    return <img src={withBase(`/assets/${relativePath}`)} width={size} height={size} alt="" />;
  }

  const requestedIconId = requestedIcon.name;
  // Renders widget-tree/toolbar thumbnails synchronously across the config
  // UI (often many at once in a list) — imports the icon map directly rather
  // than the lazy HMI-runtime accessor in phosphorIcons.tsx (backlog item 22)
  // to avoid per-thumbnail Suspense flicker.
  const Icon =
    BUILTIN_ICON_COMPONENTS[requestedIconId] ??
    BUILTIN_ICON_COMPONENTS[DEFAULT_CUSTOM_WIDGET_ICON.name];

  return Icon ? <Icon size={size} weight={weight} /> : null;
}
