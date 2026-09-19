// Renders real built-in widgets; bind the SDK and resolve their modules.
import '../../../widgets/testSdk';
import { Suspense } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ComponentSelfSuspenseContext } from '../context/ComponentSuspenseContext';
import { widgetRegistry, registerCustomWidget, type CustomWidgetManifestEntry } from './widgetRegistry';
import builtinWidgetsManifest from '../../generated/builtinWidgetsManifest.json';

/**
 * Which boundary catches a widget whose module is still in flight. Each `it`
 * uses a type no earlier case has loaded — a resolved module never suspends,
 * so a shared type would make the assertions vacuous.
 */
function renderWidget(type: string, selfBoundary: boolean) {
  const Entry = widgetRegistry[type].component;
  return render(
    <MemoryRouter>
      <Suspense fallback={<div>page-spinner</div>}>
        <ComponentSelfSuspenseContext.Provider value={selfBoundary}>
          <Entry id="w1" properties={{}} layout={{}} />
        </ComponentSelfSuspenseContext.Provider>
      </Suspense>
    </MemoryRouter>,
  );
}

describe('widget module boundary', () => {
  it('never reaches the surrounding spinner, page content included', async () => {
    // The page gate prefetches a page's modules before revealing it, so what
    // this covers is every load that starts after the reveal — a type the
    // prefetch could not see, one whose first load rejected, one mounted later
    // by a `visible` gate opening. Escalating any of those would blank the
    // whole page body — header, content and footer — to draw one widget.
    const { container } = renderWidget('Gauge', false);

    expect(screen.queryByText('page-spinner')).toBeNull();
    await waitFor(() => expect(container.innerHTML).not.toBe(''));
    expect(screen.queryByText('page-spinner')).toBeNull();
  });

  it('pops in silently where self-suspense is on (chrome, dialogs)', async () => {
    renderWidget('RingGauge', true);

    expect(screen.queryByText('page-spinner')).toBeNull();
    // Still nothing once it lands: its own fallback was null, not the spinner.
    await waitFor(() => expect(screen.queryByText('page-spinner')).toBeNull());
  });

  it('keeps a recompiled widget silent, even under the page boundary', async () => {
    const manifest = builtinWidgetsManifest as unknown as CustomWidgetManifestEntry[];
    const entry = manifest.find((row) => row.name === 'StatusPill')!;
    const { unmount } = renderWidget('StatusPill', true);
    await waitFor(() => expect(screen.queryByText('page-spinner')).toBeNull());
    unmount();

    // A `widget_updated` recompile re-registers the type under instances that
    // are already on screen: the fresh `lazy` suspends every one of them. Same
    // boundary, same silence — saving a widget in the editor must re-render
    // that widget, not blank the page body around it.
    registerCustomWidget(entry);

    renderWidget('StatusPill', false);
    expect(screen.queryByText('page-spinner')).toBeNull();
    await waitFor(() => expect(screen.queryByText('page-spinner')).toBeNull());
  });
});
