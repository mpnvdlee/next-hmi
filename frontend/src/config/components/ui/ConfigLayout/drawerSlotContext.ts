import { createContext } from 'react';

/** Portal target inside the properties sidebar's own box — lets FieldDrawer
 *  slide in confined to the panel instead of overlaying the whole page. */
export const PropsPanelDrawerSlotContext = createContext<HTMLDivElement | null>(null);
