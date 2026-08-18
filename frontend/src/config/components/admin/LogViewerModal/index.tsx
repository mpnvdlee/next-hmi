import { useCallback, useEffect, useRef, useState } from 'react';
import Button from '../../ui/Button';
import ModalShell, { ModalCloseButton } from '../../ui/ModalShell';
import { ContentSpinner } from '@shared/components/Spinner';
import { apiJson } from '@shared/utils/api';
import { withBase } from '@shared/utils/runtimeBase';
import './style.css';

interface LogsResponse {
  path: string;
  lines: string[];
  returned: number;
  total: number;
  truncated: boolean;
}

interface Props {
  onClose: () => void;
}

const TAIL_LINES = 500;

export default function LogViewerModal({ onClose }: Props) {
  const [data, setData] = useState<LogsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLPreElement>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiJson<LogsResponse>(`/api/system/logs?lines=${TAIL_LINES}`);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [data]);

  return (
    <ModalShell onClose={onClose} dialogClassName="cfg-log-viewer">
      <header className="cfg-modal-header">
        <div className="cfg-log-viewer__heading">
          <h2 className="cfg-log-viewer__title">Application logs</h2>
          {data && <span className="cfg-log-viewer__path">{data.path}</span>}
        </div>
        <ModalCloseButton onClose={onClose} />
      </header>

      {loading && !data ? (
        <div className="cfg-log-viewer__body">
          <ContentSpinner variant="cfg" />
        </div>
      ) : (
        <pre ref={bodyRef} className="cfg-log-viewer__body">
          {error
            ? `Failed to load logs: ${error}`
            : data && data.lines.length === 0
              ? 'No log entries yet.'
              : data?.lines.join('\n')}
        </pre>
      )}

      <footer className="cfg-log-viewer__footer">
        <span className="cfg-log-viewer__counter">
          {data
            ? data.truncated
              ? `Showing last ${data.returned} of ${data.total} lines`
              : `${data.total} line${data.total === 1 ? '' : 's'}`
            : ''}
        </span>
        <div className="cfg-log-viewer__actions">
          <a className="cfg-btn" href={withBase('/api/system/logs/download')} download>
            Download full log
          </a>
          <Button onClick={() => void fetchLogs()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </footer>
    </ModalShell>
  );
}
