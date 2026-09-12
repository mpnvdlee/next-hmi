/* @jsxRuntime classic */
export const schema = {
  slot: {
    type: 'slot' as const,
    label: 'Slot name',
    placeholder: 'content',
    description:
      'Names this slot — pick one of the component’s "Widget slot" properties. Instances get that property as a row in their properties panel, and the widgets put there render here.',
  },
};

export const displayName = 'Component Slot';
export const category = 'Layout & structure';
export const description =
  'Marks where content the caller supplies is rendered. Put one in a reusable component and instances of it gain a named slot — in the widget tree, and in the properties panel when a "Widget slot" property names it.';
export const icon = { type: 'builtin', name: 'frame-corners' } as const;

/** Slot name an unnamed ComponentSlot falls back to, and the slot an instance's
 *  untagged children land in. Mirrors DEFAULT_SLOT_KEY in
 *  @shared/utils/componentSlots, which the editor and the renderer share. */
const DEFAULT_SLOT = 'content';

function slotKeyOf(raw: unknown): string {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_SLOT;
}

/**
 * Renders the widgets the caller put in this slot — the placeholder a reusable
 * component drops where the caller's content belongs, so a definition can wrap
 * content it does not own (a card shell around an arbitrary body).
 *
 * The `slot` property names the slot. Instances of the component host their
 * children in the page tree tagged with that name; the renderer groups them by
 * tag and `useComponentSlot` reads this slot's share back out.
 */
export default function ComponentSlot({ properties, layout }: HmiWidgetProps) {
  const isPreview = useIsPreview();
  const isInstance = useIsComponentInstance();
  const slot = slotKeyOf(properties?.slot);
  const widgets = useComponentSlot(slot);
  const style = selfLayoutStyle(layout);

  if (widgets.length === 0) {
    // In the components editor a definition renders with no caller, so every
    // slot is empty and the shell around them collapses to a hairline — the
    // author cannot see or size the hole they are authoring. Draw an outline
    // there. Nowhere else: a placed instance's unfilled slot is absent on the
    // page, and the editor's UI preview has to show the page the operator gets,
    // not the affordance the definition was authored with.
    if (!isPreview || isInstance) return null;
    return (
      <div className="hmi-component hmi-slot hmi-slot--empty" style={style}>
        <span className="hmi-slot__empty-label">
          {slot.charAt(0).toUpperCase() + slot.slice(1)}
        </span>
      </div>
    );
  }

  return (
    <div
      className="hmi-component hmi-slot"
      style={style}
      data-flow-direction="column"
      data-flow-align="stretch"
    >
      {renderSlotWidgets(widgets)}
    </div>
  );
}
