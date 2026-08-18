import type { ReactNode } from 'react';
import './style.css';
import ConfigPageMessage from '../ConfigPageMessage';
import { ContentSpinner } from '@shared/components/Spinner';

interface Props {
  title?: string;
  actions?: ReactNode;
  children?: ReactNode;
  flush?: boolean;
  className?: string;
  /** Renders a ConfigPageMessage in place of children when set. */
  loadError?: string | null;
  /** Renders a ContentSpinner in place of children when true. */
  loading?: boolean;
}

export default function ConfigWorkspace({
  title = '',
  actions,
  children,
  flush = false,
  className = '',
  loadError,
  loading,
}: Props) {
  const content = loadError ? (
    <ConfigPageMessage>{loadError}</ConfigPageMessage>
  ) : loading ? (
    <ContentSpinner variant="cfg" />
  ) : (
    children
  );

  return (
    <div className={`cfg-workspace${className ? ` ${className}` : ''}`}>
      <div className="cfg-workspace__header">
        <h1 className="cfg-workspace__title">{title || '\u00a0'}</h1>
        {actions && <div className="cfg-workspace__actions">{actions}</div>}
      </div>
      <div className={`cfg-workspace__content${flush ? ' cfg-workspace__content--flush' : ''}`}>
        {content}
      </div>
    </div>
  );
}
