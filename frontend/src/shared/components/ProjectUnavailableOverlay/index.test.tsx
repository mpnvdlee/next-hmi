import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProjectUnavailableOverlay from './index';
import { useProjectAvailabilityStore } from '@shared/store/projectAvailabilityStore';

afterEach(() => useProjectAvailabilityStore.setState({ reason: null, projectName: null }));

describe('ProjectUnavailableOverlay', () => {
  it('stays out of the way while the project is reachable', () => {
    render(<ProjectUnavailableOverlay />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('names the project and says it is not running', () => {
    useProjectAvailabilityStore.setState({ reason: 'stopped', projectName: 'Line 1' });
    render(<ProjectUnavailableOverlay />);

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Can’t open Line 1');
    expect(dialog).toHaveTextContent('It is not running.');
    // The shared modal card, so it matches every other dialog in the app.
    expect(dialog.querySelector('.name-modal')).not.toBeNull();
  });

  it.each([
    ['crashed', /instance crashed/i],
    ['missing', /folder is missing/i],
    ['unknown', /No project with that id/i],
  ] as const)('explains the %s reason', (reason, message) => {
    useProjectAvailabilityStore.setState({ reason, projectName: 'Line 1' });
    render(<ProjectUnavailableOverlay />);

    expect(screen.getByRole('alertdialog')).toHaveTextContent(message);
  });

  it('falls back to the slug when the manager could not name the project', () => {
    window.__NEXTHMI_BASE__ = '/editor/line-1/';
    useProjectAvailabilityStore.setState({ reason: 'stopped', projectName: null });
    render(<ProjectUnavailableOverlay />);

    expect(screen.getByRole('alertdialog')).toHaveAccessibleName('Can’t open line-1');
    delete window.__NEXTHMI_BASE__;
  });

  it('sends the operator to the projects page', async () => {
    const assign = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      assign,
    } as unknown as Location);
    useProjectAvailabilityStore.setState({ reason: 'stopped', projectName: 'Line 1' });
    render(<ProjectUnavailableOverlay />);

    await userEvent.click(screen.getByRole('button', { name: 'Go to projects' }));

    expect(assign).toHaveBeenCalledWith('/projects');
  });
});
