// The dialog frame (header, body, footer, success screen) is the OPC-UA
// wizard's, so both connection dialogs look alike.
import '../OpcuaConnectionWizard/style.css';
import { useId, useRef, useState } from 'react';
import { PanelScopeContext } from '@config/store/panelExpansionStore';
import {
  defaultDatasource,
  type AdsClientSettings,
  type DatasourceSettings,
} from '@shared/types/datasource';
import ModalShell, { ModalCloseButton } from '../../ui/ModalShell';
import Button from '../../ui/Button';
import PropRow from '../../ui/PropRow';
import AdsSettingsForm from '.';

interface Props {
  existingNames: string[];
  onCreate: (name: string, settings: Partial<DatasourceSettings>) => void | Promise<void>;
  onBrowseVariables: (name: string) => void;
  onClose: () => void;
}

/** Create an `ads-client` datasource: name plus its connection settings. */
export default function AdsConnectionDialog({
  existingNames,
  onCreate,
  onBrowseVariables,
  onClose,
}: Props) {
  const [name, setName] = useState('');
  const [settings, setSettings] = useState(
    () => defaultDatasource('ads-client', '').settings as AdsClientSettings,
  );
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // Its own scope: Advanced starts collapsed, whatever the properties panel has open.
  const scope = `ads-create-dialog-${useId()}`;

  const trimmedName = name.trim();
  const nameTaken = existingNames.some((n) => n.toLowerCase() === trimmedName.toLowerCase());
  const canCreate = trimmedName !== '' && !nameTaken && settings.host.trim() !== '';

  async function handleCreate() {
    if (!canCreate) return;
    setCreating(true);
    try {
      await onCreate(trimmedName, { ...settings, host: settings.host.trim() });
      setCreated(true);
    } finally {
      setCreating(false);
    }
  }

  if (created) {
    return (
      <ModalShell onClose={onClose} dialogClassName="ds-wizard">
        <header className="cfg-modal-header">
          <h2 className="ds-wizard__title">Connection created</h2>
          <ModalCloseButton onClose={onClose} />
        </header>
        <div className="ds-wizard__body">
          <p className="ds-wizard__success">
            <span className="ds-wizard__success-mark" aria-hidden>
              ✓
            </span>
            <span>
              <strong>{trimmedName}</strong> was created and is connecting. Browse the PLC now to
              add variables, or do it later from the variable table.
            </span>
          </p>
        </div>
        <footer className="ds-wizard__footer ds-wizard__footer--end">
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onBrowseVariables(trimmedName);
              onClose();
            }}
          >
            Browse variables
          </Button>
        </footer>
      </ModalShell>
    );
  }

  return (
    <ModalShell onClose={onClose} dialogClassName="ds-wizard" initialFocusRef={nameInputRef}>
      <header className="cfg-modal-header">
        <h2 className="ds-wizard__title">Add Beckhoff ADS connection</h2>
        <ModalCloseButton onClose={onClose} />
      </header>
      <div className="ds-wizard__body ds-ads-dialog__body">
        <div className="cfg-section">
          <PropRow label="Name" sourceless>
            <input
              ref={nameInputRef}
              className="cfg-prop-input"
              type="text"
              value={name}
              placeholder="e.g. LinePLC"
              onChange={(e) => setName(e.target.value)}
            />
          </PropRow>
          {nameTaken && (
            <span className="ds-wizard__error">A datasource with this name already exists.</span>
          )}
        </div>
        <PanelScopeContext.Provider value={scope}>
          <AdsSettingsForm
            settings={settings}
            onChange={(key, value) => setSettings((prev) => ({ ...prev, [key]: value }))}
          />
        </PanelScopeContext.Provider>
      </div>
      <footer className="ds-wizard__footer ds-wizard__footer--end">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!canCreate || creating}
          onClick={() => void handleCreate()}
        >
          {creating ? 'Creating…' : 'Create connection'}
        </Button>
      </footer>
    </ModalShell>
  );
}
