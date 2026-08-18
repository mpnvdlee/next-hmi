import type { IconValue, ImageValue } from '@shared/types/config';
import PathInputField from '@config/components/ui/PathInputField';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { assetName } from '@config/components/editor/assetPickerUtils';
import { BUILTIN_ICON_COMPONENTS } from '@shared/utils/phosphorIconComponents';
import { withBase } from '@shared/utils/runtimeBase';

/** The panel's one word for "the selected widgets disagree". Held here rather
 *  than imported from `renderSchemaField`, which renders these fields — reading
 *  its constant back would close an import cycle. */
const MIXED_LABEL = 'Mixed';

/** Read the `{ $static: T }` payload from a static value, tolerating bare values. */
function staticPayload<T>(value: unknown): T | null {
  if (value && typeof value === 'object' && '$static' in (value as Record<string, unknown>)) {
    return ((value as Record<string, unknown>).$static as T) ?? null;
  }
  return null;
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
  mixed = false,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  /** Property name the picker shows before its own action. */
  label?: string;
  /** A multi-selection whose widgets hold different icons. The input reads "Mixed"
   *  where its name prompt would be — an empty glyph slot alone is exactly how a
   *  widget with no icon at all looks, and picking one overwrites every selection. */
  mixed?: boolean;
}) {
  const openPicker = useEditorDomainStore((s) => s.openAssetPicker);
  const icon = staticPayload<IconValue>(value);
  const committed = icon ? (icon.type === 'builtin' ? icon.name : assetName(icon.path)) : '';

  return (
    <PathInputField
      value={committed}
      placeholder={mixed ? MIXED_LABEL : 'Icon name (e.g. gear)'}
      renderPrefix={(draft) => <IconGlyph icon={icon} name={draft} />}
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
 * Static editor for `image`-typed fields. Typable for the same reason the icon
 * field is: an image can be a project asset picked from the browser *or* a path
 * the author types (an `images/…` file not yet in the picker, or a remote URL).
 * Committing text stores a bare `{ path }`; the `✎` button opens the asset picker.
 */
export function ImageStaticField({
  value,
  onChange,
  label,
  mixed = false,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  /** Property name the picker shows before its own action. */
  label?: string;
  /** A multi-selection whose widgets hold different images — see
   *  {@link IconStaticField}. */
  mixed?: boolean;
}) {
  const openPicker = useEditorDomainStore((s) => s.openAssetPicker);
  const image = staticPayload<ImageValue>(value);
  const committed = image?.path ?? '';

  return (
    <PathInputField
      value={committed}
      placeholder={mixed ? MIXED_LABEL : 'images/logo.svg or https://…'}
      titleFromDraft
      onCommit={(text) => {
        const path = text.trim();
        if (path === committed) return;
        onChange(path ? { $static: { path } } : undefined);
      }}
      pickTitle="Pick image"
      onPick={() => openPicker('image', (val) => onChange({ $static: val }), label)}
      onClear={committed ? () => onChange(undefined) : undefined}
    />
  );
}
