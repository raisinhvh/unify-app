/**
 * The "shut down when done" countdown (spec › Shut down when done). The engine decides and counts; this only
 * shows `viewState.shutdown` while its phase is 'countdown' and offers Cancel (cancelShutdown).
 *
 *   <ShutdownOverlay />   mount once in the Shell, above everything but the title bar
 *
 * The whole-window scrim fades on the Modal spring; the card grows from 0.94 on the Sheet spring (no overshoot), and
 * both turn around mid-way when the countdown is cancelled. Seconds roll like an odometer (RollingNumber).
 * Escape cancels too. Reduced motion: the card only fades.
 */
import { createEffect, createSignal, on, onCleanup, type JSX } from 'solid-js';
import { post } from '../bridge';
import { createSpring, prefersReducedMotion, Presence } from '../motion';
import { RollingNumber } from '../motion/organic';
import { viewState } from '../store';
import { Button } from './Button';
import { PowerGlyph } from './TitleBar';
import './shutdownOverlay.css';

function cancelShutdown(): void {
  post({ type: 'cancelShutdown' });
}

export function ShutdownOverlay(): JSX.Element {
  const counting = () => viewState.shutdown?.phase === 'countdown';
  // Keeps the last number on screen while the overlay leaves (the engine clears secondsLeft on cancel).
  const [seconds, setSeconds] = createSignal(viewState.shutdown?.secondsLeft ?? 60);
  createEffect(() => {
    const next = viewState.shutdown?.secondsLeft;
    if (counting() && typeof next === 'number') setSeconds(next);
  });

  // Sheet spring: critically damped, lands just before the Modal-paced scrim. Reduced motion keeps it at 1
  // (the scale spring would otherwise snap to 0.94 while the card is still fading out).
  const cardProgress = createSpring(() => (counting() ? 1 : 0), 'sheet');
  const cardScale = () => (prefersReducedMotion() ? 1 : 0.94 + 0.06 * cardProgress());

  let cancelButton: HTMLButtonElement | undefined;
  createEffect(on(counting, open => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cancelShutdown();
    };
    window.addEventListener('keydown', onKey);
    queueMicrotask(() => cancelButton?.focus());
    onCleanup(() => window.removeEventListener('keydown', onKey));
  }));

  return (
    <Presence when={counting()} from={1} enter="modal" exit="panel">
      <div class="shutdown-overlay" role="alertdialog" aria-modal="true" aria-labelledby="shutdown-title" data-shutdown-overlay>
        <div class="shutdown-card" style={{ scale: String(cardScale()) }}>
          <div class="shutdown-heading">
            <span class="shutdown-glyph">
              <PowerGlyph size={14} />
            </span>
            <span id="shutdown-title" class="type-label">Shutting down</span>
          </div>
          <div class="shutdown-count" aria-live="polite">
            <RollingNumber value={String(seconds())} class="shutdown-seconds" />
            <span class="shutdown-unit type-label">{seconds() === 1 ? 'second' : 'seconds'}</span>
          </div>
          <p class="shutdown-body type-body">
            Every chat and subagent is done. Unify saves your work, then turns the PC off.
          </p>
          <div class="shutdown-actions">
            <Button
              variant="primary"
              ref={element => {
                cancelButton = element;
              }}
              onClick={cancelShutdown}
            >
              Cancel shutdown
            </Button>
          </div>
        </div>
      </div>
    </Presence>
  );
}
