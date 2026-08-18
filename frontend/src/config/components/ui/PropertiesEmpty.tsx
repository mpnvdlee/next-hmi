import type { ReactNode } from 'react';

/**
 * Empty-state placeholder for the right-side properties panels
 * (DatasourcePropertiesPanel, UsersPropertiesPanel, AlarmPropertiesPanel).
 */
export default function PropertiesEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="cfg-ds-props">
      <div className="cfg-panel-empty">{children}</div>
    </div>
  );
}
