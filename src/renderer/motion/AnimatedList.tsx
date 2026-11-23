/**
 * <AnimatedList each={items()} key={item => item.id}>{item => <Row item={item()} />}</AnimatedList>
 *
 * A keyed list whose rows never snap:
 *   - rows are keyed by `key`, not object identity, so a recomputed array (new objects, same ids) keeps
 *     the same DOM and component state (a chat row's loader keeps morphing instead of being rebuilt);
 *   - a row that joins after the first render reveals its height (Collapse, Reveal token);
 *   - a row that leaves stays at its old place while it collapses, so rows below glide up;
 *   - reordered rows glide to their new place (flipList, Panel token). All of it is interruptible.
 *
 * `children` gets an accessor that always returns the latest item for that key (the last known one while
 * the row is leaving). Each row is wrapped in a Collapse `div[data-flip]`; style it with `itemClass`.
 */
import { createMemo, createSignal, For, onMount, type Accessor, type JSX } from 'solid-js';
import { Collapse } from './Collapse';
import { flipList } from './flip';

export interface AnimatedListProps<T> {
  each: readonly T[];
  key: (item: T) => string;
  children: (item: Accessor<T>) => JSX.Element;
  /** Class of the list container. */
  class?: string;
  /** Class of each row wrapper. */
  itemClass?: string;
}

export function AnimatedList<T>(props: AnimatedListProps<T>): JSX.Element {
  const lastKnown = new Map<string, T>();
  // Keys whose exit collapse has finished; they drop out of the rendered order.
  const [finished, setFinished] = createSignal<ReadonlySet<string>>(new Set());
  const [ready, setReady] = createSignal(false);
  let renderedOrder: string[] = [];

  const current = createMemo(() => {
    const byKey = new Map<string, T>();
    for (const item of props.each) {
      const key = props.key(item);
      byKey.set(key, item);
      lastKnown.set(key, item);
    }
    return byKey;
  });

  // Present keys in their new order, with leaving keys kept after the row that preceded them.
  const order = createMemo<string[]>(() => {
    const present = current();
    const done = finished();
    const merged = [...present.keys()];
    renderedOrder.forEach((key, index) => {
      if (present.has(key) || done.has(key)) return;
      let insertAt = 0;
      for (let back = index - 1; back >= 0; back -= 1) {
        const at = merged.indexOf(renderedOrder[back]);
        if (at >= 0) {
          insertAt = at + 1;
          break;
        }
      }
      merged.splice(insertAt, 0, key);
    });
    renderedOrder = merged;
    return merged;
  });

  const finish = (key: string) => {
    if (current().has(key)) return;
    setFinished(previous => new Set(previous).add(key));
    lastKnown.delete(key);
  };

  // A key that comes back must be able to leave (and animate) again.
  const forgetReturned = createMemo(() => {
    const present = current();
    const done = finished();
    if ([...done].some(key => present.has(key))) {
      queueMicrotask(() => setFinished(previous => new Set([...previous].filter(key => !current().has(key)))));
    }
    return present;
  });

  onMount(() => setReady(true));

  return (
    <div ref={element => flipList(element)} class={props.class}>
      <For each={order()}>
        {key => {
          const appear = ready();
          const item = () => forgetReturned().get(key) ?? (lastKnown.get(key) as T);
          return (
            <Collapse
              open={current().has(key)}
              appear={appear}
              onClosed={() => finish(key)}
              data-flip={key}
              class={props.itemClass}
            >
              {props.children(item)}
            </Collapse>
          );
        }}
      </For>
    </div>
  );
}
