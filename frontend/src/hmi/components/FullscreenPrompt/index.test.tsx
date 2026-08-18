import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FullscreenPrompt } from './index';

function setFullscreenElement(el: Element | null) {
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    value: el,
  });
}

describe('FullscreenPrompt', () => {
  afterEach(() => {
    setFullscreenElement(null);
  });

  it('renders the prompt when the document is not fullscreen', () => {
    render(<FullscreenPrompt />);
    expect(screen.getByText('Enter fullscreen?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fullscreen' })).toBeInTheDocument();
  });

  it('renders nothing when the document is already fullscreen on mount', () => {
    setFullscreenElement(document.body);
    const { container } = render(<FullscreenPrompt />);
    expect(container.firstChild).toBeNull();
  });

  it('requests fullscreen and closes when the Fullscreen button is clicked', async () => {
    const user = userEvent.setup();
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    document.documentElement.requestFullscreen = requestFullscreen;

    render(<FullscreenPrompt />);
    await user.click(screen.getByRole('button', { name: 'Fullscreen' }));

    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Enter fullscreen?')).not.toBeInTheDocument();
  });

  it('closes gracefully when requestFullscreen is rejected', async () => {
    const user = userEvent.setup();
    document.documentElement.requestFullscreen = vi.fn().mockRejectedValue(new Error('denied'));

    render(<FullscreenPrompt />);
    await user.click(screen.getByRole('button', { name: 'Fullscreen' }));

    expect(screen.queryByText('Enter fullscreen?')).not.toBeInTheDocument();
  });

  it('dismisses via the "Not now" button', async () => {
    const user = userEvent.setup();
    render(<FullscreenPrompt />);

    await user.click(screen.getByRole('button', { name: 'Not now' }));

    expect(screen.queryByText('Enter fullscreen?')).not.toBeInTheDocument();
  });

  it('dismisses via the close button', async () => {
    const user = userEvent.setup();
    render(<FullscreenPrompt />);

    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByText('Enter fullscreen?')).not.toBeInTheDocument();
  });

  it('dismisses via a backdrop click', async () => {
    const user = userEvent.setup();
    const { container } = render(<FullscreenPrompt />);

    await user.click(container.querySelector('.fullscreen-prompt-backdrop') as HTMLElement);

    expect(screen.queryByText('Enter fullscreen?')).not.toBeInTheDocument();
  });

  it('does not dismiss when clicking inside the modal card', async () => {
    const user = userEvent.setup();
    render(<FullscreenPrompt />);

    await user.click(screen.getByText('Enter fullscreen?'));

    expect(screen.getByText('Enter fullscreen?')).toBeInTheDocument();
  });

  it('dismisses on Escape key', () => {
    render(<FullscreenPrompt />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByText('Enter fullscreen?')).not.toBeInTheDocument();
  });

  it('closes automatically when a fullscreenchange event reports fullscreen is active', () => {
    render(<FullscreenPrompt />);

    setFullscreenElement(document.body);
    fireEvent(document, new Event('fullscreenchange'));

    expect(screen.queryByText('Enter fullscreen?')).not.toBeInTheDocument();
  });
});
