import type { ComponentDefinition } from '@shared/types/componentTypes';
import type { ComponentPropertySchema } from '@shared/types/componentProperty';
import {
  DEFAULT_COMPONENT_CATEGORY,
  DEFAULT_CUSTOM_WIDGET_ICON,
} from '@hmi/registry/widgetRegistry';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { PickerField } from '@config/components/editor/PropertySourceEditor';
import { iconValueLabel } from '@shared/utils/iconValue';
import PanelHeader from '../ui/PanelHeader';
import PropRow from '../ui/PropRow';
import WidgetIcon from '../ui/WidgetIcon';
import ComponentPropertiesEditor from '../componentProperties/ComponentPropertiesEditor';

interface Props {
  component: ComponentDefinition;
  onUpdate: (patch: Partial<ComponentDefinition>) => void;
}

export default function CompositionSchemaEditor({ component, onUpdate }: Props) {
  const openAssetPicker = useEditorDomainStore((state) => state.openAssetPicker);

  function handleRename(name: string) {
    onUpdate({ name });
  }

  function handleDescriptionChange(value: string) {
    onUpdate({ description: value || null });
  }

  function handleCategoryChange(value: string) {
    onUpdate({ category: value || null });
  }

  function handlePickIcon() {
    openAssetPicker('icon', (icon) => onUpdate({ icon }), 'Icon');
  }

  const iconName = component.icon ? iconValueLabel(component.icon) : '';

  function handlePropertiesChange(next: Record<string, ComponentPropertySchema>) {
    onUpdate({ componentProperties: next });
  }

  return (
    <>
      <PanelHeader kind="Component" name={component.name} />

      <div className="cfg-section">
        <div className="cfg-section__title">Identity</div>
        <PropRow label="Name" sourceless>
          <input
            className="cfg-prop-input"
            type="text"
            value={component.name}
            onChange={(e) => handleRename(e.target.value)}
          />
        </PropRow>
      </div>

      <div className="cfg-section">
        <div className="cfg-section__title">App drawer</div>
        <PropRow label="Description" sourceless>
          <input
            className="cfg-prop-input"
            type="text"
            value={component.description ?? ''}
            onChange={(e) => handleDescriptionChange(e.target.value)}
            placeholder="Shown on the app drawer card"
          />
        </PropRow>
        <PropRow label="Category" sourceless>
          <input
            className="cfg-prop-input"
            type="text"
            value={component.category ?? ''}
            onChange={(e) => handleCategoryChange(e.target.value)}
            placeholder={`${DEFAULT_COMPONENT_CATEGORY} (default)`}
          />
        </PropRow>
        <PropRow label="Icon">
          <PickerField
            displayText={
              <span className="cfg-composition-icon-field">
                <span className="cfg-composition-icon-field__preview" aria-hidden="true">
                  <WidgetIcon icon={component.icon} size={16} />
                </span>
                <span>{iconName || `${DEFAULT_CUSTOM_WIDGET_ICON.name} (default)`}</span>
              </span>
            }
            pickTitle="Choose icon"
            onPick={handlePickIcon}
            onClear={component.icon ? () => onUpdate({ icon: null }) : undefined}
          />
        </PropRow>
      </div>

      <ComponentPropertiesEditor
        ownerName={component.name}
        properties={component.componentProperties}
        onChange={handlePropertiesChange}
      />
    </>
  );
}
