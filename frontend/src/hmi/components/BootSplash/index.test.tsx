import { render, screen, act } from '@testing-library/react';
import { useConfigStore } from '@shared/store/configStore';
import BootSplash from './index';
import { markBooted, resetBootHold, useBootHold } from './bootHold';

function setConfig(loaded: boolean, bootLogo?: string) {
  useConfigStore.setState({ loaded, shell: bootLogo ? { bootLogo } : {} });
}

/** The wordmark splits "NEXT" into its own span for the accent colour, so the
 *  product name spans two nodes and getByText cannot see it as one string. */
function wordmark() {
  return document.querySelector('.hmi-boot-splash__title')?.textContent ?? null;
}

describe('BootSplash', () => {
  beforeEach(() => {
    setConfig(true, undefined);
  });

  it('shows the open-source AGPL notice with the product name and source offer by default', () => {
    render(<BootSplash phase="ready" />);
    expect(wordmark()).toBe('NEXT HMI');
    expect(screen.getByText(/AGPL-3\.0/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'next-hmi.com' })).toHaveAttribute(
      'href',
      'https://next-hmi.com',
    );
  });

  it('shows the version and the phase progress readout', () => {
    render(<BootSplash phase="config" />);
    expect(screen.getByText('vdev')).toBeInTheDocument();
    expect(screen.getByText(/Loading configuration · 2\/3/)).toBeInTheDocument();
  });

  it('renders no branding while the project config is still loading', () => {
    setConfig(false);
    render(<BootSplash phase="components" />);
    expect(wordmark()).toBeNull();
    expect(screen.queryByText(/AGPL-3\.0/)).not.toBeInTheDocument();
    // The loading surface itself is still there.
    expect(screen.getByText(/Loading components · 1\/3/)).toBeInTheDocument();
  });

  it('drops the AGPL notice in the ee build but keeps the branding', () => {
    window.__NEXTHMI_EDITION__ = 'ee';
    try {
      render(<BootSplash phase="ready" />);
      expect(wordmark()).toBe('NEXT HMI');
      expect(screen.queryByText(/AGPL-3\.0/)).not.toBeInTheDocument();
    } finally {
      delete window.__NEXTHMI_EDITION__;
    }
  });

  it('shows the project boot logo instead of the product mark and name in the ee build', () => {
    window.__NEXTHMI_EDITION__ = 'ee';
    setConfig(true, 'images/acme.svg');
    try {
      render(<BootSplash phase="ready" />);
      expect(document.querySelector('img')).toHaveAttribute('src', '/assets/images/acme.svg');
      expect(wordmark()).toBeNull();
    } finally {
      delete window.__NEXTHMI_EDITION__;
    }
  });

  it('ignores the boot logo in the oss build, keeping the product branding and notice', () => {
    setConfig(true, 'images/acme.svg');
    render(<BootSplash phase="ready" />);
    expect(document.querySelector('img')).toBeNull();
    expect(wordmark()).toBe('NEXT HMI');
    expect(screen.getByText(/AGPL-3\.0/)).toBeInTheDocument();
  });
});

function Hold() {
  return <span>{String(useBootHold())}</span>;
}

describe('useBootHold', () => {
  beforeEach(() => {
    resetBootHold();
    vi.useFakeTimers();
  });
  afterEach(() => {
    resetBootHold();
    vi.useRealTimers();
  });

  it('holds the splash for 2s from page load, then releases', () => {
    render(<Hold />);
    expect(screen.getByText('true')).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.getByText('true')).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(1100));
    expect(screen.getByText('false')).toBeInTheDocument();
  });

  it('does not hold again for route changes within a booted page load', () => {
    markBooted();
    render(<Hold />);
    expect(screen.getByText('false')).toBeInTheDocument();
  });
});
