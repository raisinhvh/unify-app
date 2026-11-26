/**
 * <StreamText value={line.text} /> text that arrives in chunks (a streamed edit's line), revealed a few characters
 * per frame so it reads as typing instead of jumping by a chunk every engine update (~50 ms).
 *
 *   - growth that extends what is shown types on, paced to finish within `streamTextCatchUp` ms of each update,
 *     so it keeps up with the stream and never falls behind it;
 *   - anything else (a line edited or shortened) shows at once;
 *   - 'motion.organic.codeEdits' off or reduced motion: shows at once;
 *   - hidden windows (no animation frames): a timer lands the full text.
 *
 * Renders a bare text node written directly per frame: no signal, no re-render of anything around it.
 */
import { createEffect, on, onCleanup, untrack, type JSX } from 'solid-js';
import { organicMode } from './enabled';

/** Each update's new characters are all shown within this (ms). A touch over the engine's 50 ms update interval,
 *  so consecutive chunks join into one continuous run of typing. */
export const streamTextCatchUp = 70;

export function StreamText(props: { value: string }): JSX.Element {
  const node = document.createTextNode(untrack(() => props.value));
  /** Characters shown, fractional so slow rates still advance smoothly. */
  let shown = node.data.length;
  /** Characters per millisecond for the current backlog. */
  let rate = 0;
  let lastTime = 0;
  let frame = 0;
  let fallback = 0;

  const stop = () => {
    cancelAnimationFrame(frame);
    window.clearTimeout(fallback);
    frame = 0;
    fallback = 0;
  };

  const showAll = () => {
    stop();
    const value = untrack(() => props.value);
    shown = value.length;
    if (node.data !== value) node.data = value;
  };

  const step = (now: number) => {
    frame = 0;
    const value = untrack(() => props.value);
    const elapsed = Math.max(0, now - lastTime);
    lastTime = now;
    shown = Math.min(value.length, shown + Math.max(1, rate * elapsed));
    const text = value.slice(0, Math.floor(shown));
    if (node.data !== text) node.data = text;
    if (shown < value.length) frame = requestAnimationFrame(step);
    else stop();
  };

  createEffect(on(() => props.value, value => {
    const current = node.data;
    if (organicMode('codeEdits') !== 'organic' || value.length <= current.length || !value.startsWith(current)) {
      showAll();
      return;
    }
    rate = (value.length - shown) / streamTextCatchUp;
    window.clearTimeout(fallback);
    fallback = window.setTimeout(showAll, streamTextCatchUp + 150);
    if (!frame) {
      lastTime = performance.now();
      frame = requestAnimationFrame(step);
    }
  }, { defer: true }));

  onCleanup(stop);

  return node;
}
