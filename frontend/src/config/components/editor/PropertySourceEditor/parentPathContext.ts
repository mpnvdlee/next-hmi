import { createContext, useContext } from 'react';

export const ParentPathContext = createContext<string[] | undefined>(undefined);

export function useParentPath(): string[] | undefined {
  return useContext(ParentPathContext);
}

export function withSegs(parent: string[] | undefined, ...segs: string[]): string[] | undefined {
  return parent ? [...parent, ...segs] : undefined;
}
