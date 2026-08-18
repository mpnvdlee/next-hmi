import { type MouseEvent } from 'react';
import type { SchemaField } from '@shared/types/widgetSchema';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { pathsEqual } from '@config/utils/propertyPath';

export function useParamSelection(path: string[] | undefined, schema: SchemaField) {
  const selection = path && path.length > 0 ? { path, schema } : null;
  const isSelected = useEditorDomainStore(
    (s) => selection != null && pathsEqual(s.selectedParam?.path, selection.path),
  );
  const setSelectedParam = useEditorDomainStore((s) => s.setSelectedParam);

  function onSelect(e: MouseEvent) {
    if (!selection) return;
    e.stopPropagation();
    setSelectedParam(isSelected ? null : selection);
  }

  return { isSelected, onSelect };
}
