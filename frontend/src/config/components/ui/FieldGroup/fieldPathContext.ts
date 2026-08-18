import { createContext } from 'react';

/** Breadcrumb of display names from the panel root (component/dialog/page name)
 *  down through nested tier-3 fields — shown in the FieldDrawer header so a
 *  drawer opened several levels deep still reads as "Button › Actions › Label". */
export const FieldPathContext = createContext<string[]>([]);
