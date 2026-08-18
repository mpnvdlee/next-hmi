import { useContext } from 'react';
import type { HmiWidgetProps } from '@shared/types/config';
import { PreviewContext } from '@shared/context/PreviewContext';
import { useComponentSlot } from '../../context/ComponentSlotContext';
import { DefinitionScopeContext } from '../../context/DefinitionScopeContext';
import { selfLayoutStyle } from '../layoutUtils';
import { renderRegionChildren } from '../renderRegion';
import { slotKeyOf, slotLabel } from './slotKey';
import styles from './index.module.css';

/**
 * Renders the widgets the caller put in this slot — the placeholder a reusable
 * component drops where the caller's content belongs, so a definition can wrap
 * content it does not own (a card shell around an arbitrary body).
 *
 * The `slot` property names the slot. Instances of the component host their
 * children in the page tree tagged with that name; `ComponentRenderer` groups
 * them and publishes them on {@link ComponentSlotContext}.
 */
export default function ComponentSlot({ properties, layout }: HmiWidgetProps) {
  const isPreview = useContext(PreviewContext);
  const slot = slotKeyOf(properties?.slot);
  const widgets = useComponentSlot(slot);
  const style = selfLayoutStyle(layout);

  if (widgets.length === 0) {
    // In the components editor a definition renders with no caller, so every
    // slot is empty and the shell around them collapses to a hairline — the
    // author cannot see or size the hole they are authoring. Draw an outline
    // there. The operator runtime keeps rendering nothing: an unfilled slot is
    // absent, not an empty box.
    if (!isPreview) return null;
    return (
      <div className={`hmi-component ${styles.slot} ${styles.empty}`} style={style}>
        <span className={styles.emptyLabel}>{slotLabel(slot)}</span>
      </div>
    );
  }

  return (
    <div className={`hmi-component ${styles.slot}`} style={style}>
      {/* Slot content is authored by the caller, not by the definition around
          it, so it is selectable in the editor even though it renders here. */}
      <DefinitionScopeContext.Provider value={false}>
        {renderRegionChildren(widgets)}
      </DefinitionScopeContext.Provider>
    </div>
  );
}
