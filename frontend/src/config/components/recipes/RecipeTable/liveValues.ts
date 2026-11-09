import { useEffect } from 'react';
import { clearContextProducer, setContextProducer } from '@hmi/hooks/useWebSocket';


/**
 * Keep a recipe's bound variables hot while the Live column is on.
 *
 * The variable table has to track a virtualizer window; a recipe type renders
 * every parameter it has, so the whole bound set is the priority set and one
 * effect covers it.
 */
export function useRecipePriorityContext(paths: string[], enabled: boolean) {
  // Effect identity has to follow the paths' contents, not the array's, or a
  // re-render with an equal list would re-send the context every time. Only the
  // dependency is joined — the payload sends the array itself, since a browse
  // name may contain any printable separator.
  const key = paths.join('\u001f');

  useEffect(() => {
    if (!enabled) return;
    setContextProducer('recipe-table', { priorityKeys: paths });
    return () => clearContextProducer('recipe-table');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);
}
