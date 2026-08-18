import { useMemo, type ReactNode } from 'react';
import { DropIndicatorContext, type DropIndicator } from './dropIndicatorContext';

export function DropIndicatorProvider({
  indicator,
  children,
}: {
  indicator: DropIndicator | null;
  children: ReactNode;
}) {
  const value = useMemo(() => indicator, [indicator]);
  return <DropIndicatorContext.Provider value={value}>{children}</DropIndicatorContext.Provider>;
}
