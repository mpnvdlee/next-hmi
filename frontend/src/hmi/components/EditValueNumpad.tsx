import { useState } from 'react';
import { useHmiStore, type NumpadRequest } from '@hmi/store/hmiStore';
import { VirtualNumpad } from '@shared/components/VirtualNumpad';

/** The numpad an `editValue` action opens. Lives at the top of HmiView, like the alert. */
export function EditValueNumpad() {
  const request = useHmiStore((s) => s.numpadRequest);
  // Keyed so every request starts with an empty entry.
  return request ? <Panel key={request.id} request={request} /> : null;
}

function Panel({ request }: { request: NumpadRequest }) {
  const [value, setValue] = useState('');
  const close = () => useHmiStore.getState().openNumpad(null);
  return (
    <VirtualNumpad
      isOpen
      value={value}
      onChange={setValue}
      onApply={(raw) => {
        close();
        request.apply(parseFloat(raw));
      }}
      onCancel={close}
      title={request.title}
      unit={request.unit}
      min={request.min}
      max={request.max}
      decimals={request.decimals}
      allowNegative={request.allowNegative}
      currentValue={request.currentValue}
      dockPosition={request.position}
    />
  );
}
