import type { CSSProperties } from 'react';

/** CSSProperties extended with arbitrary CSS custom properties (`--*`). */
export type CSSWithVars = CSSProperties & Record<string, string | number | undefined>;
