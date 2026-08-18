import { useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import ModalShell, { ModalCloseButton } from '@config/components/ui/ModalShell';
import { PropsPanelDrawerSlotContext } from '@config/components/ui/ConfigLayout/drawerSlotContext';

interface FieldDrawerProps {
  title: string;
  onClose(): void;
  children: ReactNode;
}

/** `⤢` escape hatch — hosts one tier-3 field's FieldGroup at full width. Portals
 *  into the properties sidebar's own drawer slot so it slides in confined to
 *  that panel, not as a page-wide overlay. */
export default function FieldDrawer({ title, onClose, children }: FieldDrawerProps) {
  const slot = useContext(PropsPanelDrawerSlotContext);

  const drawer = (
    <ModalShell
      onClose={onClose}
      overlayClassName={slot ? 'cfg-field-drawer-overlay' : 'cfg-picker-drawer-overlay'}
      dialogClassName={[
        'cfg-drawer cfg-drawer--md cfg-field-drawer',
        slot && 'cfg-field-drawer--confined',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="cfg-modal-header cfg-field-drawer__header">
        <h2 className="cfg-field-drawer__title">{title}</h2>
        <ModalCloseButton onClose={onClose} />
      </div>
      <div className="cfg-field-drawer__body">{children}</div>
    </ModalShell>
  );

  return slot ? createPortal(drawer, slot) : drawer;
}
