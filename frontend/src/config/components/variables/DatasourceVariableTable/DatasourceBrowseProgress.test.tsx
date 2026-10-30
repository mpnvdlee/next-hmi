import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import DatasourceBrowseProgress from './DatasourceBrowseProgress';

describe('DatasourceBrowseProgress', () => {
  it('is indeterminate until the first report arrives', () => {
    render(<DatasourceBrowseProgress progress={{ percent: null, nodes: 0, level: 0 }} />);

    const bar = screen.getByRole('progressbar');
    // No value attribute is what makes a native <progress> indeterminate.
    expect(bar).not.toHaveAttribute('value');
    expect(screen.getByText('Browsing PLC…')).toBeInTheDocument();
    expect(screen.queryByText(/nodes/)).not.toBeInTheDocument();
  });

  it('shows the percentage and the counts once the walk reports', () => {
    render(<DatasourceBrowseProgress progress={{ percent: 42, nodes: 318, level: 3 }} />);

    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '42');
    expect(screen.getByText('Browsing PLC… 42%')).toBeInTheDocument();
    expect(screen.getByText('318 nodes · level 3')).toBeInTheDocument();
  });

  it('renders as a status region', () => {
    render(<DatasourceBrowseProgress progress={{ percent: 5, nodes: 1, level: 1 }} />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText('1 node · level 1')).toBeInTheDocument();
  });
});
