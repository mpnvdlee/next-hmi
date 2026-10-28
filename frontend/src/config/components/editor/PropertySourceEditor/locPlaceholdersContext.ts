import { createContext } from 'react';

/**
 * Whether a picked translation's `{1}`, `{2}` … are filled here, one binding
 * each. False where the placeholders are filled elsewhere: an alarm's text
 * takes them from the alarm's own values when it fires.
 */
export const LocPlaceholdersContext = createContext(true);
