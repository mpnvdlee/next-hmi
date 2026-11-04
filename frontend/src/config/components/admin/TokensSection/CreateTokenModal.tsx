import { useEffect, useRef, useState } from 'react';
import Button from '@config/components/ui/Button';
import ModalShell from '@config/components/ui/ModalShell';
import { describeError } from '@config/store/projectsStore';
import { clipboardWriteError } from '@shared/utils/clipboard';
import {
  createApiToken,
  createMcpToken,
  type ApiScope,
  type IssuedApiToken,
  type IssuedMcpToken,
  type McpAccess,
} from './tokensApi';
import '@config/components/projects/ProjectsView/projectForm.css';
import './style.css';

interface Props {
  projectId: string;
  /** Whether the project lets MCP write; a Write token is refused until it does.
   *  `null`: the switch could not be read, so the hint says so instead of guessing. */
  mcpEnabled: boolean | null;
  /** A token was issued, so the list behind the dialog is stale. */
  onCreated(): void;
  onClose(): void;
}

const ACCESS_CHOICES: { value: McpAccess; label: string; detail: string }[] = [
  { value: 'read', label: 'Read', detail: 'The agent can look at the project but change nothing.' },
  {
    value: 'write',
    label: 'Write',
    detail: 'The agent can edit pages, variables, alarms and more.',
  },
];

type Kind = 'mcp' | 'api';

const KIND_CHOICES: { value: Kind; label: string; detail: string }[] = [
  { value: 'mcp', label: 'MCP', detail: 'An AI client works on the project over MCP.' },
  {
    value: 'api',
    label: 'API',
    detail: 'An integration (MES, BI, HR) reads or writes data over API v1.',
  },
];

/**
 * API v1 scopes (docs/user/api.md), each with the curl call that exercises it.
 * Read scopes come first, so the example is a harmless read whenever the token
 * has one; only a `users:write`-only token gets the write, labelled as such.
 */
const SCOPE_CHOICES: { value: ApiScope; label: string; example: string }[] = [
  {
    value: 'history:read',
    label: 'Read historian samples',
    example: 'history?variables=DATASOURCE:VARIABLE&start=-1h',
  },
  { value: 'alarms:read', label: 'Read alarm history', example: 'alarms/history' },
  { value: 'recipes:read', label: 'Read recipes', example: 'recipes' },
  { value: 'users:read', label: 'Read users', example: 'users' },
  { value: 'sessions:write', label: 'Sign users in and out on named panels', example: 'panels' },
  {
    value: 'users:write',
    label: 'Create, change and delete users',
    example: `users/jdoe -X PUT -H "Content-Type: application/json" -d '{"groups": ["operator"]}'`,
  },
];

function apiExample(issued: IssuedApiToken) {
  const scope = SCOPE_CHOICES.find((choice) => issued.scopes.includes(choice.value));
  const [path, ...rest] = (scope?.example ?? 'users').split(' ');
  const url = `${window.location.origin}/api/v1/projects/${encodeURIComponent(issued.projectId)}/${path}`;
  return {
    text: [`curl -H "Authorization: Bearer ${issued.token}" "${url}"`, ...rest].join(' '),
    writes: scope?.value === 'users:write',
  };
}

/** The two client setups docs/user/mcp.md lists, filled in for this token. */
function clientConfig(issued: IssuedMcpToken) {
  // The editor is served by the manager that serves /mcp, so its own origin
  // already carries the right scheme and port (HTTPS moves both to :8443).
  const url = `${window.location.origin}/mcp/`;
  const header = `Authorization: Bearer ${issued.token}`;
  return {
    command: `claude mcp add --transport ${issued.transport} nexthmi ${url} --header "${header}"`,
    json: JSON.stringify(
      {
        mcpServers: {
          nexthmi: {
            type: issued.transport,
            url,
            headers: { Authorization: `Bearer ${issued.token}` },
          },
        },
      },
      null,
      2,
    ),
  };
}

/**
 * Mint a bearer token scoped to one project and show it once: an MCP token
 * for an AI client or an API token for an API v1 integration. The manager
 * session is the proof (`POST /api/manager/mcp-tokens`), so no device-admin
 * password is asked for here.
 */
export default function CreateTokenModal({ projectId, mcpEnabled, onCreated, onClose }: Props) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('mcp');
  const [access, setAccess] = useState<McpAccess>('read');
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  const [issued, setIssued] = useState<IssuedMcpToken | IssuedApiToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const warningRef = useRef<HTMLParagraphElement>(null);

  // Each view takes focus as it appears: the show-once warning after Create,
  // the name field on open and after "Create another".
  useEffect(() => {
    (issued ? warningRef : nameRef).current?.focus();
  }, [issued]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      setIssued(
        kind === 'api'
          ? await createApiToken(projectId, scopes, name)
          : await createMcpToken(projectId, access, name),
      );
      setCopied(null);
      onCreated();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {
      setError(clipboardWriteError());
    }
  }

  const config = issued?.kind === 'mcp' ? clientConfig(issued) : null;
  const example = issued?.kind === 'api' ? apiExample(issued) : null;
  const toggleScope = (scope: ApiScope) =>
    setScopes((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );

  return (
    <ModalShell
      // The token cannot be shown again, so while it is on screen only Done
      // closes the dialog — not Escape, not a stray click on the backdrop.
      onClose={issued ? () => {} : onClose}
      closeOnEscape={!issued}
      dialogClassName="name-modal cfg-flex-col cfg-tokens-modal"
    >
      <div className="name-modal__title">Create token</div>

      {issued ? (
        <>
          <p ref={warningRef} tabIndex={-1} className="project-form__status">
            Copy the token now. Only a hash of it is stored, so it is shown this once — a lost token
            cannot be recovered, only replaced.
          </p>
          <Snippet
            label="Token"
            text={issued.token}
            copied={copied === 'Token'}
            onCopy={() => copy('Token', issued.token)}
          />
          {config && (
            <>
              <Snippet
                label="Claude Code"
                text={config.command}
                copied={copied === 'Claude Code'}
                onCopy={() => copy('Claude Code', config.command)}
              />
              <Snippet
                label="Client config (JSON)"
                text={config.json}
                copied={copied === 'Client config (JSON)'}
                onCopy={() => copy('Client config (JSON)', config.json)}
              />
            </>
          )}
          {example && (
            <>
              <Snippet
                label="Example request"
                text={example.text}
                copied={copied === 'Example request'}
                onCopy={() => copy('Example request', example.text)}
              />
              {example.writes && (
                <p className="project-form__hint">
                  This example changes data: running it creates user <strong>jdoe</strong> in this
                  project, or changes that user&apos;s groups if it exists.
                </p>
              )}
            </>
          )}
          {/* The button already turns into "Copied" on screen; this tells a
              screen reader, without taking a row in the dialog. */}
          <p className="cfg-tokens-sr-only" role="status">
            {copied && `${copied} copied to the clipboard.`}
          </p>
          <p className="project-form__hint">
            The URL is the address this editor is open on. A client on another machine needs one it
            can reach.
          </p>
        </>
      ) : (
        <>
          <label className="project-form__field">
            <span className="project-form__label">Token name</span>
            <input
              ref={nameRef}
              type="text"
              className="cfg-prop-input cfg-prop-input--tall"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={kind === 'api' ? 'HR system' : 'Claude on my laptop'}
              maxLength={200}
            />
            <span className="project-form__hint">So you can tell tokens apart when revoking.</span>
          </label>
          <ChoiceGroup<Kind>
            label="Kind"
            name="token-kind"
            choices={KIND_CHOICES}
            value={kind}
            onChange={setKind}
          />
          {kind === 'mcp' ? (
            <ChoiceGroup<McpAccess>
              label="Access"
              name="mcp-token-access"
              choices={ACCESS_CHOICES}
              value={access}
              onChange={setAccess}
            />
          ) : (
            <fieldset className="project-form__field cfg-tokens-scopes">
              <legend className="project-form__label">Scopes</legend>
              {SCOPE_CHOICES.map((choice) => (
                <label key={choice.value} className="project-form__choice-head">
                  <input
                    type="checkbox"
                    checked={scopes.includes(choice.value)}
                    onChange={() => toggleScope(choice.value)}
                  />
                  <span>{choice.label}</span>
                  <code className="project-form__hint">{choice.value}</code>
                </label>
              ))}
            </fieldset>
          )}
          {kind === 'mcp' && access === 'write' && mcpEnabled === false && (
            <p className="project-form__hint">
              Writes are refused until <strong>MCP enabled</strong> is ticked for this project on
              the dashboard.
            </p>
          )}
          {kind === 'mcp' && access === 'write' && mcpEnabled === null && (
            <p className="project-form__hint">
              Could not read whether <strong>MCP enabled</strong> is ticked for this project. Writes
              are refused until it is; check its row on the dashboard.
            </p>
          )}
        </>
      )}

      {error && <p className="project-form__status project-form__status--error">{error}</p>}

      <div className="name-modal__actions">
        {issued ? (
          <>
            <Button variant="ghost" onClick={() => setIssued(null)}>
              Create another
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Close
            </Button>
            <Button
              variant="primary"
              onClick={create}
              disabled={busy || (kind === 'api' && scopes.length === 0)}
            >
              {busy ? 'Creating…' : 'Create token'}
            </Button>
          </>
        )}
      </div>
    </ModalShell>
  );
}

function ChoiceGroup<T extends string>({
  label,
  name,
  choices,
  value,
  onChange,
}: {
  label: string;
  name: string;
  choices: { value: T; label: string; detail: string }[];
  value: T;
  onChange(value: T): void;
}) {
  return (
    <div className="project-form__choices" role="radiogroup" aria-label={label}>
      {choices.map((choice) => (
        <div
          key={choice.value}
          className={`project-form__choice${
            value === choice.value ? ' project-form__choice--active' : ''
          }`}
        >
          <label className="project-form__choice-head">
            <input
              type="radio"
              name={name}
              value={choice.value}
              checked={value === choice.value}
              onChange={() => onChange(choice.value)}
            />
            <span>{choice.label}</span>
          </label>
          <p className="project-form__choice-detail">{choice.detail}</p>
        </div>
      ))}
    </div>
  );
}

function Snippet({
  label,
  text,
  copied,
  onCopy,
}: {
  label: string;
  text: string;
  copied: boolean;
  onCopy(): void;
}) {
  return (
    <div className="project-form__field">
      <div className="cfg-tokens-snippet__head">
        <span className="project-form__label">{label}</span>
        <Button variant="ghost" size="sm" aria-label={`Copy ${label}`} onClick={onCopy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="cfg-tokens-snippet">{text}</pre>
    </div>
  );
}
