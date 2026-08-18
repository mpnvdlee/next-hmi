import './style.css';
import { useEffect, useState } from 'react';
import CloseButton from '@shared/components/CloseButton';

function isFullscreen(): boolean {
  return document.fullscreenElement != null;
}

export function FullscreenPrompt() {
  const [open, setOpen] = useState(() => !isFullscreen());

  useEffect(() => {
    if (!open) return;
    function onFullscreenChange() {
      if (isFullscreen()) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!open) return null;

  async function handleEnter() {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      // Browser refused (user gesture missing, unsupported, denied) — just close.
    }
    setOpen(false);
  }

  function handleDismiss() {
    setOpen(false);
  }

  return (
    <div className="fullscreen-prompt-backdrop" onClick={handleDismiss}>
      <div className="fullscreen-prompt-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fullscreen-prompt-modal__header">
          <span className="fullscreen-prompt-modal__title">Enter fullscreen?</span>
          <CloseButton className="fullscreen-prompt-modal__close" onClick={handleDismiss} />
        </div>
        <div className="fullscreen-prompt-modal__body">
          <p className="fullscreen-prompt-modal__description">
            Open the live view in fullscreen for the best experience.
          </p>
        </div>
        <div className="fullscreen-prompt-modal__footer">
          <button
            type="button"
            className="fullscreen-prompt-modal__btn fullscreen-prompt-modal__btn--cancel"
            onClick={handleDismiss}
          >
            Not now
          </button>
          <button
            type="button"
            className="fullscreen-prompt-modal__btn fullscreen-prompt-modal__btn--ok"
            onClick={handleEnter}
          >
            Fullscreen
          </button>
        </div>
      </div>
    </div>
  );
}
