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
  client_certificate?: string;
  client_private_key?: string;
  client_private_key_password?: string;
  server_certificate?: string;
}

type TestState = 'idle' | 'testing' | 'ok' | 'fail';

/** Inline "Test connection" affordance — POSTs the candidate settings to the
 *  live pre-save probe and shows a ✓/✕ result. */
export default function ConnectionTest({ settings }: { settings: TestSettings }) {
  const [state, setState] = useState<TestState>('idle');
  const [message, setMessage] = useState<string | null>(null);

  // Stale results are misleading once the inputs change — reset to idle.
  // The caller memoizes `settings` from those same inputs, so it is
  // referentially stable and safe as the sole dependency.
  useEffect(() => {
    setState('idle');
    setMessage(null);
  }, [settings]);

  const run = useCallback(async () => {
    setState('testing');
    setMessage(null);
    try {
      const res = await apiJson<TestConnectionResult>('/api/datasources/test-connection', {
        method: 'POST',
        body: settings,
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
  }, [settings]);

  return (
    <div className="ds-wizard__test">
      <Button
        variant="neutral"
        size="sm"
        onClick={() => void run()}
        disabled={state === 'testing' || !settings.server_url.trim()}
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
