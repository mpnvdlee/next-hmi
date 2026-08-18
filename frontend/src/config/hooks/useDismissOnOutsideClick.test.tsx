import { act, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import useDismissOnOutsideClick from './useDismissOnOutsideClick';

function Harness({ onDismiss }: { onDismiss: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  useDismissOnOutsideClick(menuRef, onDismiss);

  return (
    <>
      <div ref={menuRef}>Menu</div>
      <iframe title="HMI preview" />
    </>
  );
}

describe('useDismissOnOutsideClick', () => {
  it('dismisses when the HMI preview reports a pointer down', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          data: { type: 'preview_pointer_down' },
        }),
      );
    });

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('dismisses after focus moves into an iframe', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);

    const iframe = screen.getByTitle('HMI preview');
    act(() => {
      window.dispatchEvent(new Event('blur'));
      iframe.focus();
      vi.runAllTimers();
    });

    expect(onDismiss).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
