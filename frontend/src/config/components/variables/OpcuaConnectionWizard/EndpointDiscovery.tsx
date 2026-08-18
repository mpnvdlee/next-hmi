import { useCallback, useState } from 'react';
import { apiJson } from '@shared/utils/api';
import type { DiscoveredEndpoint, DiscoveryResult } from '@shared/types/datasource';
import Button from '../../ui/Button';

interface Props {
  address: string;
  onAddressChange: (value: string) => void;
  onSelect: (endpoint: DiscoveredEndpoint) => void;
}

/** Pick the endpoint we auto-select after a discovery: prefer an unsecured one
 *  so the wizard doesn't jump straight to certificate upload, else the first
 *  offered. */
function preferredEndpoint(endpoints: DiscoveredEndpoint[]): DiscoveredEndpoint {
  return endpoints.find((ep) => ep.security_mode === 'None') ?? endpoints[0];
}

export default function EndpointDiscovery({ address, onAddressChange, onSelect }: Props) {
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [endpoints, setEndpoints] = useState<DiscoveredEndpoint[] | null>(null);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  const discover = useCallback(async () => {
    setDiscovering(true);
    setError(null);
    setEndpoints(null);
    setSelectedIdx(null);
    try {
      const res = await apiJson<DiscoveryResult>('/api/datasources/discover', {
        method: 'POST',
        body: { address },
      });
      if (!res.ok) {
        setError(res.error ?? 'Discovery failed');
        return;
      }
      if (res.endpoints.length === 0) {
        setError('No endpoints found at this address.');
        return;
      }
      setEndpoints(res.endpoints);
      const preferred = preferredEndpoint(res.endpoints);
      setSelectedIdx(res.endpoints.indexOf(preferred));
      onSelect(preferred);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Discovery failed');
    } finally {
      setDiscovering(false);
    }
  }, [address, onSelect]);

  return (
    <div className="ds-wizard__discovery">
      <div className="ds-wizard__discover-row">
        <input
          className="cfg-prop-input"
          type="text"
          value={address}
          placeholder="opc.tcp://192.168.1.10:4840 or host:port"
          aria-label="Server address"
          onChange={(e) => onAddressChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (address.trim() && !discovering) void discover();
            }
          }}
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => void discover()}
          disabled={discovering || !address.trim()}
        >
          {discovering ? 'Discovering…' : 'Discover'}
        </Button>
      </div>

      {error && <div className="ds-wizard__discover-error">{error}</div>}

      {endpoints && endpoints.length > 0 && (
        <ul className="ds-wizard__endpoints" role="listbox" aria-label="Discovered endpoints">
          {endpoints.map((ep, i) => {
            const open = ep.security_mode === 'None';
            return (
              <li key={`${ep.endpoint_url}-${ep.security_policy}-${ep.security_mode}-${i}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selectedIdx === i}
                  className={`ds-wizard__endpoint${selectedIdx === i ? ' ds-wizard__endpoint--selected' : ''}`}
                  onClick={() => {
                    setSelectedIdx(i);
                    onSelect(ep);
                  }}
                >
                  <span className="ds-wizard__endpoint-head">
                    <span
                      className={`ds-wizard__badge ds-wizard__badge--${open ? 'open' : 'secure'}`}
                    >
                      {open ? 'No security' : `${ep.security_mode} · ${ep.security_policy}`}
                    </span>
                    {ep.user_tokens.map((tok) => (
                      <span key={tok} className="ds-wizard__token">
                        {tok}
                      </span>
                    ))}
                  </span>
                  {ep.server_name && (
                    <span className="ds-wizard__endpoint-server">{ep.server_name}</span>
                  )}
                  <span className="ds-wizard__endpoint-url">{ep.endpoint_url}</span>
                  {!open && (
                    <span className="ds-wizard__endpoint-note">
                      You'll be asked for certificates on the next step.
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
