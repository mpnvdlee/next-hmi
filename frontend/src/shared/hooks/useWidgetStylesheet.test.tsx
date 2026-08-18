import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { wrapComponentWithStylesheet } from './useWidgetStylesheet';
import { getWidgetStylePath } from '@shared/utils/widgetPaths';
import type { HmiWidgetProps } from '@shared/types/config';

function BaseComponent(_props: HmiWidgetProps) {
  return <div data-testid="widget-body" />;
}

function linksFor(href: string): NodeListOf<HTMLLinkElement> {
  return document.head.querySelectorAll(`link[data-dynamic-stylesheet="${href}"]`);
}

describe('wrapComponentWithStylesheet', () => {
  it('injects the widget stylesheet on mount and removes it after the sole instance unmounts', () => {
    const gauge = { name: 'Gauge', group: null };
    const Wrapped = wrapComponentWithStylesheet(BaseComponent, gauge);
    const href = getWidgetStylePath(gauge);

    const { unmount } = render(<Wrapped {...({} as HmiWidgetProps)} />);
    expect(linksFor(href)).toHaveLength(1);

    unmount();
    expect(linksFor(href)).toHaveLength(0);
  });

  it('shares one link across two mounted instances of the same widget and keeps it until the last unmounts', () => {
    const dial = { name: 'Dial', group: 'controls' };
    const Wrapped = wrapComponentWithStylesheet(BaseComponent, dial);
    const href = getWidgetStylePath(dial);

    const first = render(<Wrapped {...({} as HmiWidgetProps)} />);
    expect(linksFor(href)).toHaveLength(1);

    const second = render(<Wrapped {...({} as HmiWidgetProps)} />);
    expect(linksFor(href)).toHaveLength(1);

    first.unmount();
    expect(linksFor(href)).toHaveLength(1);

    second.unmount();
    expect(linksFor(href)).toHaveLength(0);
  });
});
