/**
 * FLIP list motion: children that change place (reorder, insert above, removal above) glide to their new
 * position on the Panel spring instead of jumping.
 *
 *   <div ref={el => flipList(el)}> <For …>{item => <div data-flip={item.id}>…</div>}</For> </div>
 *
 * How: each child with `data-flip` remembers its layout position (offsetTop/Left, which ignore transforms).
 * After a DOM change the new position is read; the difference is added to that child's `translate` spring,
 * which then settles at 0. A child already moving keeps its velocity (interruptible). Uses the CSS `translate`
 * property so it composes with press (`scale`) and Presence (`transform`). New children are left to Presence.
 */
import { onCleanup } from 'solid-js';
import { prefersReducedMotion } from './reducedMotion';
import { Spring } from './spring';
import type { SpringToken, SpringTokenName } from './tokens';

interface Tracked {
  left: number;
  top: number;
  springX: Spring;
  springY: Spring;
}

export function flipList(container: HTMLElement, token: SpringToken | SpringTokenName = 'panel'): void {
  const tracked = new WeakMap<HTMLElement, Tracked>();
  const live = new Set<HTMLElement>();

  const items = () => [...container.querySelectorAll<HTMLElement>(':scope > [data-flip]')];

  const paint = (element: HTMLElement, state: Tracked) => {
    const x = state.springX.value;
    const y = state.springY.value;
    element.style.translate = Math.abs(x) < 0.01 && Math.abs(y) < 0.01 ? '' : `${x}px ${y}px`;
  };

  const track = (element: HTMLElement) => {
    const state: Tracked = {
      left: element.offsetLeft,
      top: element.offsetTop,
      springX: new Spring(0, token, 100),
      springY: new Spring(0, token, 100),
    };
    state.springX.onChange(() => paint(element, state));
    state.springY.onChange(() => paint(element, state));
    tracked.set(element, state);
    live.add(element);
    return state;
  };

  const measure = () => {
    const reduced = prefersReducedMotion();
    for (const element of items()) {
      const state = tracked.get(element);
      if (!state) {
        track(element);
        continue;
      }
      const left = element.offsetLeft;
      const top = element.offsetTop;
      const deltaX = state.left - left;
      const deltaY = state.top - top;
      state.left = left;
      state.top = top;
      if (reduced || (deltaX === 0 && deltaY === 0)) continue;
      state.springX.offset(deltaX).set(0);
      state.springY.offset(deltaY).set(0);
    }
    for (const element of [...live]) {
      if (!element.isConnected) {
        const state = tracked.get(element);
        state?.springX.stop();
        state?.springY.stop();
        live.delete(element);
      }
    }
  };

  for (const element of items()) track(element);
  const mutations = new MutationObserver(measure);
  mutations.observe(container, { childList: true });
  // Size changes of siblings (a row expanding) move later rows too; re-baseline without animating them,
  // because the expanding row already animates its own height.
  const resizes = new ResizeObserver(() => {
    for (const element of items()) {
      const state = tracked.get(element);
      if (state && !state.springY.moving && !state.springX.moving) {
        state.left = element.offsetLeft;
        state.top = element.offsetTop;
      }
    }
  });
  resizes.observe(container);
  onCleanup(() => {
    mutations.disconnect();
    resizes.disconnect();
    for (const element of live) {
      tracked.get(element)?.springX.stop();
      tracked.get(element)?.springY.stop();
    }
  });
}
