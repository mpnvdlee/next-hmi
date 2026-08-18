import { useCallback, useEffect, useState } from 'react';
import { apiJson } from '@shared/utils/api';
import type { TestConnectionResult } from '@shared/types/datasource';
import Button from '../../ui/Button';

interface TestSettings {
  server_url: string;
  username?: string;
  password?: string;
  security_policy?: string;
  security_mode?: string;
}

type TestState = 'idle' | 'testing' | 'ok' | 'fail';

/** Inline "Test connection" affordance — POSTs the candidate settings to the
 *  live pre-save probe and shows a ✓/✕ result. */
export default function ConnectionTest({ settings }: { settings: TestSettings }) {
  const [state, setState] = useState<TestState>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const { server_url, username, password, security_policy, security_mode } = settings;

  // Stale results are misleading once the inputs change — reset to idle.
  useEffect(() => {
    setState('idle');
    setMessage(null);
  }, [server_url, username, password, security_policy, security_mode]);

  const run = useCallback(async () => {
    setState('testing');
    setMessage(null);
    try {
      const res = await apiJson<TestConnectionResult>('/api/datasources/test-connection', {
        method: 'POST',
        body: { server_url, username, password, security_policy, security_mode },
      });
      if (res.ok) {
        setState('ok');
        setMessage(res.server_name ? `Connected — ${res.server_name}` : 'Connected');
      } else {
        setState('fail');
        setMessage(res.error ?? 'Connection failed');
      }
    } catch (err) {
      setState('fail');
      setMessage(err instanceof Error ? err.message : 'Connection failed');
    }
  }, [server_url, username, password, security_policy, security_mode]);

  return (
    <div className="ds-wizard__test">
      <Button
        variant="neutral"
        size="sm"
        onClick={() => void run()}
        disabled={state === 'testing' || !server_url.trim()}
      >
        {state === 'testing' ? 'Testing…' : 'Test connection'}
      </Button>
      {state !== 'idle' && state !== 'testing' && (
        <span className={`ds-wizard__test-result ds-wizard__test-result--${state}`} role="status">
          {state === 'ok' ? '✓ ' : '✕ '}
          {message}
        </span>
      )}
    </div>
  );
}
