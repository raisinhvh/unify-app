/**
 * Elastic press: pointer-down springs the element to 0.94, release springs it back (Button token).
 * Uses the CSS `scale` property so it composes with Presence (`transform`) and FLIP (`translate`).
 *
 *   <button ref={pressable}>…</button>          // default depth
 *   <button ref={el => pressable(el, 0.97)}>     // large surfaces press less
 */
import { onCleanup } from 'solid-js';
import { prefersReducedMotion } from './reducedMotion';
import { Spring } from './spring';

export function pressable(element: HTMLElement, depth = 0.94): void {
  const spring = new Spring(1, 'button', 0.1);
  spring.onChange(value => {
    element.style.scale = value === 1 ? '' : String(value);
  });
  const press = (event: PointerEvent) => {
    if (event.button !== 0 || prefersReducedMotion()) return;
    if ((element as HTMLButtonElement).disabled) return;
    spring.set(depth);
  };
  const release = () => spring.set(1);
  element.addEventListener('pointerdown', press);
  element.addEventListener('pointerup', release);
  element.addEventListener('pointerleave', release);
  element.addEventListener('pointercancel', release);
  onCleanup(() => {
    spring.stop();
    element.removeEventListener('pointerdown', press);
    element.removeEventListener('pointerup', release);
    element.removeEventListener('pointerleave', release);
    element.removeEventListener('pointercancel', release);
  });
}
