/**
 * <PageStack active={key()} pages={keys} axis="y" distance={24} render={key => <Page key={key} />} />
 *
 * Pages stacked on top of each other; switching springs the old page out and the new one in. Pages after the
 * active one wait on the far side (+distance), pages before it on the near side (-distance), so moving down a
 * list slides content up and moving back slides it down. Position uses the Sheet spring, opacity the Panel
 * spring (an opacity, so it still fades under reduced motion while position snaps).
 *
 * A page stays mounted while it is active or still visible; a leaving page is `inert`. Switching again mid-way
 * retargets the same springs, so a page on its way out simply turns around.
 * Used by Settings (sections) and the Setup wizard (steps).
 */
import { createMemo, For, Show, type JSX } from 'solid-js';
import { createSpring } from '../../motion';

export interface PageStackProps<Key extends string> {
  active: Key;
  /** Every page, in order (decides which side a page waits on). */
  pages: readonly Key[];
  axis: 'x' | 'y';
  /** How far, in px, a page travels in and out. */
  distance: number;
  render: (key: Key) => JSX.Element;
  class?: string;
  /** Class on each page wrapper (scrolling, padding). */
  pageClass?: string;
}

export function PageStack<Key extends string>(props: PageStackProps<Key>): JSX.Element {
  const activeIndex = createMemo(() => props.pages.indexOf(props.active));
  return (
    <div class={props.class ? `page-stack ${props.class}` : 'page-stack'}>
      <For each={props.pages}>
        {(key, index) => {
          const isActive = () => props.active === key;
          const side = () => (isActive() ? 0 : index() < activeIndex() ? -1 : 1);
          const opacity = createSpring(() => (isActive() ? 1 : 0), 'panel', { fadeOnly: true });
          const offset = createSpring(() => side() * props.distance, 'sheet', { precision: 100 });
          const mounted = createMemo(() => isActive() || opacity() > 0.01);
          const transform = () => (props.axis === 'x' ? `translate3d(${offset()}px, 0, 0)` : `translate3d(0, ${offset()}px, 0)`);
          return (
            <Show when={mounted()}>
              <div
                class={props.pageClass ? `page-stack-page ${props.pageClass}` : 'page-stack-page'}
                style={{
                  opacity: Math.max(0, Math.min(1, opacity())),
                  transform: transform(),
                  'z-index': isActive() ? 1 : 0,
                }}
                inert={!isActive()}
                aria-hidden={isActive() ? undefined : 'true'}
              >
                {props.render(key)}
              </div>
            </Show>
          );
        }}
      </For>
    </div>
  );
}
