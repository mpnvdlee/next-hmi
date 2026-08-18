import type { ReactNode } from 'react';
import './style.css';

interface AdminSectionProps {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}

export default function AdminSection({ title, actions, children }: AdminSectionProps) {
  return (
    <section className="cfg-admin-section cfg-flex-col">
      <div className="cfg-section-header">
        <h2 className="cfg-admin-section__title">{title}</h2>
        {actions && <div className="cfg-section-header__actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
