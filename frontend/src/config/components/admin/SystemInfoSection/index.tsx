import AdminSection from '../AdminSection';
import './style.css';

export interface SystemInfo {
  uptime_seconds: number;
  python: string;
  pid: number;
}

interface Props {
  info: SystemInfo | null;
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

export default function SystemInfoSection({ info }: Props) {
  return (
    <AdminSection title="System Information">
      <div className="cfg-admin-info-grid">
        <span className="cfg-admin-info-grid__label">Backend uptime</span>
        <span className="cfg-admin-info-grid__value">
          {info ? formatUptime(info.uptime_seconds) : '—'}
        </span>
        <span className="cfg-admin-info-grid__label">Python version</span>
        <span className="cfg-admin-info-grid__value">{info?.python ?? '—'}</span>
        <span className="cfg-admin-info-grid__label">Process ID</span>
        <span className="cfg-admin-info-grid__value">{info?.pid ?? '—'}</span>
      </div>
    </AdminSection>
  );
}
