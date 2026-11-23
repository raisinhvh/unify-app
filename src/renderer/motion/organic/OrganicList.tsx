/**
 * <OrganicList each key>{(item, row) => …}</OrganicList> an AnimatedList whose rows behave like a person edits them:
 *
 *   <OrganicList each={files()} key={file => file.path} itemClass="tree-row">
 *     {(file, row) => (
 *       <TreeItem label={
 *         <RetypeText value={file().name} typeOnMount={row.created} deleting={row.leaving()} onDeleted={row.swept} />
 *       } />
 *     )}
 *   </OrganicList>
 *
 *   created   the row joined after the first render: type its name in while the row springs open
 *   leaving   the row was removed: play the select-all sweep, then call swept() and the row collapses
 *   moved     rows that change place lift, travel (FLIP) and settle (liftMoves)
 *
 * Everything else (keyed rows, reveal / collapse, FLIP) is AnimatedList. The rows sit in AnimatedList's own
 * container; this component adds one `display: contents` wrapper around it.
 */
import { onMount, untrack, type Accessor, type JSX } from 'solid-js';
import { AnimatedList } from '../AnimatedList';
import type { OrganicEffect } from './enabled';
import { liftMoves } from './lift';
import { createSweptList } from './sweptList';

export interface OrganicRow {
  /** Joined after the list's first render (type the name in). */
  created: boolean;
  /** Removed and sweeping (pass to RetypeText `deleting`). */
  leaving: Accessor<boolean>;
  /** The sweep finished: let the row collapse (pass to RetypeText `onDeleted`). */
  swept: () => void;
}

export interface OrganicListProps<T> {
  each: readonly T[];
  key: (item: T) => string;
  children: (item: Accessor<T>, row: OrganicRow) => JSX.Element;
  class?: string;
  itemClass?: string;
  /** Lift rows that move (default true; still governed by 'motion.organic.move'). */
  lift?: boolean;
  /** Toggle for the delete sweep (default 'createDelete'). */
  sweepEffect?: OrganicEffect;
}

export function OrganicList<T>(props: OrganicListProps<T>): JSX.Element {
  let wrapper!: HTMLDivElement;
  const list = createSweptList(() => props.each, item => props.key(item), { effect: props.sweepEffect });
  let ready = false;

  onMount(() => {
    ready = true;
    const container = wrapper.firstElementChild;
    if (container instanceof HTMLElement && props.lift !== false) liftMoves(container);
  });

  return (
    <div ref={wrapper} style={{ display: 'contents' }}>
      <AnimatedList each={list.items()} key={props.key} class={props.class} itemClass={props.itemClass}>
        {item => {
          const itemKey = props.key(untrack(item));
          const row: OrganicRow = {
            created: ready,
            leaving: () => list.leaving(itemKey),
            swept: () => list.finish(itemKey),
          };
          return props.children(item, row);
        }}
      </AnimatedList>
    </div>
  );
}
