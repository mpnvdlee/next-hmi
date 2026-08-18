import type { ReactNode } from 'react';

export default function ConfigPageMessage({ children }: { children: ReactNode }) {
  return <div className="cfg-empty cfg-empty--page">{children}</div>;
}
