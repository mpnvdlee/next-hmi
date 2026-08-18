import './style.css';
import type { ReactNode } from 'react';

interface ScrollPageProps {
  children: ReactNode;
}

export default function ScrollPage({ children }: ScrollPageProps) {
  return <div className="cfg-scroll-page cfg-flex-col">{children}</div>;
}
