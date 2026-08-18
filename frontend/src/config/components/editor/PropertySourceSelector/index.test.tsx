import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import PropertySourceSelector from './index';

beforeAll(() => {
  class IntersectionObserverStub {
    observe() {}
    disconnect() {}
  }
  // @ts-expect-error assigning a test stub
  global.IntersectionObserver = IntersectionObserverStub;
});

describe('PropertySourceSelector', () => {
  it('opens the property-source drawer from the question-mark dropdown action', () => {
    render(
      <PropertySourceSelector
        value="Hello"
        onChange={() => {}}
        fieldType="string"
        forcedSources={['$var', '$loc']}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Static/ }));
    const popup = document.querySelector('.cfg-source-pill__popup');
    const browseButton = screen.getByRole('button', { name: /Browse property sources/ });

    expect(popup?.querySelector('button')).toBe(browseButton);
    fireEvent.click(browseButton);

    expect(screen.getByRole('heading', { name: 'Select source' })).toBeInTheDocument();
    expect(document.querySelector('.cfg-selection-drawer')).toHaveClass('cfg-drawer');
    expect(screen.getByRole('button', { name: 'Flexible sources' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fixed-type sources' })).toBeInTheDocument();
  });

  it('selects a compatible source from the drawer and closes it', () => {
    const onChange = vi.fn();
    render(
      <PropertySourceSelector
        value="Hello"
        onChange={onChange}
        fieldType="string"
        forcedSources={['$var', '$loc']}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Static/ }));
    fireEvent.click(screen.getByRole('button', { name: /Browse property sources/ }));
    fireEvent.click(screen.getByRole('button', { name: /Localizable Text/ }));

    expect(onChange).toHaveBeenCalledWith({ $loc: '' });
    expect(
      screen.queryByRole('heading', { name: 'Select Property Source' }),
    ).not.toBeInTheDocument();
  });

  it('selects the first property-source search result when Enter is pressed', () => {
    const onChange = vi.fn();
    render(
      <PropertySourceSelector
        value="Hello"
        onChange={onChange}
        fieldType="string"
        forcedSources={['$var', '$loc']}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Static/ }));
    fireEvent.click(screen.getByRole('button', { name: /Browse property sources/ }));

    const search = screen.getByRole('searchbox', { name: 'Search property sources' });
    fireEvent.change(search, { target: { value: 'Localizable' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith({ $loc: '' });
    expect(
      screen.queryByRole('heading', { name: 'Select Property Source' }),
    ).not.toBeInTheDocument();
  });

  it('only includes sources allowed by the dropdown', () => {
    render(
      <PropertySourceSelector
        value={{ $var: { path: '' } }}
        onChange={() => {}}
        fieldType="boolean"
        forcedSources={['$var', '$if']}
        includeStatic={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Variable/ }));
    fireEvent.click(screen.getByRole('button', { name: /Browse property sources/ }));

    expect(screen.getByRole('button', { name: /Variable.*live datasource/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /If Condition/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Comparison/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Static Value/ })).not.toBeInTheDocument();
  });
});
