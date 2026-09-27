import type { IconValue, ImageValue, VideoValue } from '@shared/types/config';
import PathInputField from '@config/components/ui/PathInputField';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { assetName } from '@config/components/editor/assetPickerUtils';
import { BUILTIN_ICON_COMPONENTS } from '@shared/utils/phosphorIconComponents';
import { withBase } from '@shared/utils/runtimeBase';
import { isAbsoluteUrl } from '@shared/utils/imageAsset';
import { unwrapStatic } from '@config/components/editor/propertyValueUtils';

/** The panel's one word for "the selected widgets disagree". Held here rather
 *  than imported from `renderSchemaField`, which renders these fields — reading
 *  its constant back would close an import cycle. */
const MIXED_LABEL = 'Mixed';

/** Read the `{ $static: T }` payload from a static value; a bare value carries
 *  no payload for these fields, so it reads as unset. */
function staticPayload<T>(value: unknown): T | null {
  if (!value || typeof value !== 'object' || !('$static' in (value as object))) return null;
  return (unwrapStatic(value) as T) ?? null;
}

/** The name an icon value goes by in the field — a built-in's name, or a custom
 *  icon's file name. */
function iconName(icon: IconValue | null): string {
  if (!icon) return '';
  return icon.type === 'builtin' ? icon.name : assetName(icon.path);
}

/** Placeholder for a field left unset that has a declared default to fall back
 *  to — the fallback named where a value would be, like every other unset row. */
function defaultPlaceholder(name: string): string | undefined {
  return name ? `${name} · default` : undefined;
}

/** An asset path that names no folder and is not a URL, rooted at `videos/`.
 *  Anything already rooted or absolute is the author's own spelling. */
function rootBareVideoPath(text: string): string {
  if (!text || text.includes('/') || isAbsoluteUrl(text)) return text;
  return `videos/${text}`;
}

/**
 * The glyph itself, beside its name — "gauge" or "play" doesn't identify an
 * icon at a glance. Tracks the typed draft rather than the committed value, so
 * a name that resolves shows up before it is committed and a typo shows up as
 * an empty slot. Imports the icon map directly rather than the lazy accessor
 * in `phosphorIcons.tsx` for the same reason `WidgetIcon` does: the editor
 * route already reaches it, and Suspense would flicker on every keystroke.
 */
function IconGlyph({ icon, name }: { icon: IconValue | null; name: string }) {
  if (icon?.type === 'custom' && icon.path && assetName(icon.path) === name) {
    const relativePath = icon.path.replace(/^\/?assets\//, '');
    return (
      <span className="cfg-icon-field__glyph">
        <img src={withBase(`/assets/${relativePath}`)} width={16} height={16} alt="" />
      </span>
    );
  }
  const Glyph = BUILTIN_ICON_COMPONENTS[name];
  return <span className="cfg-icon-field__glyph">{Glyph && <Glyph size={16} />}</span>;
}

/**
 * Static editor for `icon`-typed fields. Always a typable name input: typing a
 * name commits a built-in `{ type: 'builtin', name }` on blur/Enter, and the
 * `✎` button opens the icon asset picker for browsing built-ins and custom
 * SVGs. A custom (file) icon shows its file name in the same input — editing it
 * replaces the custom icon with a built-in by name; leaving it untouched
 * commits nothing, so the custom icon is preserved.
 */
export function IconStaticField({
  value,
  onChange,
  label,
  defaultValue,
  mixed = false,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  /** Property name the picker shows before its own action. */
  label?: string;
  /** The schema's declared default, previewed while the field is unset. */
  defaultValue?: unknown;
  /** A multi-selection whose widgets hold different icons. The input reads "Mixed"
   *  where its name prompt would be — an empty glyph slot alone is exactly how a
   *  widget with no icon at all looks, and picking one overwrites every selection. */
  mixed?: boolean;
}) {
  const openPicker = useEditorDomainStore((s) => s.openAssetPicker);
  const icon = staticPayload<IconValue>(value);
  const committed = iconName(icon);
  const fallback = mixed ? null : staticPayload<IconValue>(defaultValue);
  const fallbackName = iconName(fallback);

  return (
    <PathInputField
      value={committed}
      placeholder={
        mixed ? MIXED_LABEL : (defaultPlaceholder(fallbackName) ?? 'Icon name (e.g. gear)')
      }
      renderPrefix={(draft) =>
        !draft && fallback ? (
          <IconGlyph icon={fallback} name={fallbackName} />
        ) : (
          <IconGlyph icon={icon} name={draft} />
        )
      }
      onCommit={(text) => {
        const name = text.trim();
        if (name === committed) return;
        onChange(name ? { $static: { type: 'builtin', name } } : undefined);
      }}
      pickTitle="Pick icon"
      onPick={() => openPicker('icon', (val) => onChange({ $static: val }), label)}
      onClear={committed ? () => onChange(undefined) : undefined}
    />
  );
}

/**
 * Static editor for a path-valued asset field. Typable for the same reason the
 * icon field is: the value can be a project asset picked from the browser *or*
 * a path the author types (a file not yet in the picker, or a remote URL).
 * Committing text stores a bare `{ path }`; the `✎` button opens the asset picker.
 */
function PathAssetStaticField({
  kind,
  placeholder,
  pickTitle,
  normalize = (text) => text,
  value,
  onChange,
  label,
  defaultValue,
  mixed = false,
}: {
  /** Asset kind the picker browses, and the folder the value belongs to. */
  kind: 'image' | 'video';
  placeholder: string;
  pickTitle: string;
  /** Applied to committed text before storing — see {@link rootBareVideoPath}. */
  normalize?: (text: string) => string;
  value: unknown;
  onChange: (v: unknown) => void;
  /** Property name the picker shows before its own action. */
  label?: string;
  /** The schema's declared default, previewed while the field is unset. */
  defaultValue?: unknown;
  /** A multi-selection whose widgets hold different assets — see
   *  {@link IconStaticField}. */
  mixed?: boolean;
}) {
  const openPicker = useEditorDomainStore((s) => s.openAssetPicker);
  const committed = staticPayload<{ path?: string }>(value)?.path ?? '';
  const fallbackPath = mixed ? '' : (staticPayload<{ path?: string }>(defaultValue)?.path ?? '');

  return (
    <PathInputField
      value={committed}
      placeholder={mixed ? MIXED_LABEL : (defaultPlaceholder(fallbackPath) ?? placeholder)}
      titleFromDraft
      onCommit={(text) => {
        const path = normalize(text.trim());
        if (path === committed) return;
        onChange(path ? { $static: { path } } : undefined);
      }}
      pickTitle={pickTitle}
      onPick={() => {
        // `openAssetPicker` is overloaded per kind, so the literal has to reach
        // it narrowed rather than as the union this component is keyed on.
        const apply = (val: ImageValue | VideoValue) => onChange({ $static: val });
        if (kind === 'video') openPicker('video', apply, label);
        else openPicker('image', apply, label);
      }}
      onClear={committed ? () => onChange(undefined) : undefined}
    />
  );
}

type PathAssetFieldProps = Omit<
  Parameters<typeof PathAssetStaticField>[0],
  'kind' | 'placeholder' | 'pickTitle' | 'normalize'
>;

/** Static editor for `image`-typed fields. */
export function ImageStaticField(props: PathAssetFieldProps) {
  return (
    <PathAssetStaticField
      kind="image"
      placeholder="images/logo.svg or https://…"
      pickTitle="Pick image"
      {...props}
    />
  );
}

/** Static editor for `video`-typed fields — the image field's twin, with a bare
 *  filename rooted at `videos/` rather than the resolver's default `images/`. */
export function VideoStaticField(props: PathAssetFieldProps) {
  return (
    <PathAssetStaticField
      kind="video"
      placeholder="videos/clip.mp4 or https://…"
      pickTitle="Pick video"
      normalize={rootBareVideoPath}
      {...props}
    />
  );
}
