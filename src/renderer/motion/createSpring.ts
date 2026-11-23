/**
 * Solid bindings for the spring engine.
 *
 *   const width = createSpring(() => open() ? 280 : 0, 'panel');   // reactive number that springs to its source
 *   <div style={{ width: `${width()}px` }} />
 *
 * Every change of the source retargets the same spring (value and velocity kept). With reduced motion the
 * value jumps unless `fadeOnly` says it is an opacity, which still fades on a calm curve.
 */
import { createEffect, createSignal, onCleanup, untrack, type Accessor } from 'solid-js';
import { prefersReducedMotion } from './reducedMotion';
import { Spring } from './spring';
import type { SpringToken, SpringTokenName } from './tokens';

export interface SpringOptions {
  /** This value is an opacity: under reduced motion it still animates (with the calm Control spring). */
  fadeOnly?: boolean;
  /** Distance scale used to decide the spring is at rest (1 for 0..1 values, ~100 for pixels). */
  precision?: number;
}

export function createSpring(
  source: Accessor<number>,
  token: SpringToken | SpringTokenName = 'panel',
  options: SpringOptions = {},
): Accessor<number> {
  const spring = new Spring(untrack(source), token, options.precision ?? 1);
  const [value, setValue] = createSignal(spring.value);
  const stopListening = spring.onChange(next => setValue(next));
  createEffect(() => {
    const target = source();
    if (prefersReducedMotion()) {
      if (options.fadeOnly) spring.set(target, 'control');
      else spring.jump(target);
      return;
    }
    spring.set(target, token);
  });
  onCleanup(() => {
    stopListening();
    spring.stop();
  });
  return value;
}

/** An imperative spring owned by the current component (stopped on cleanup). */
export function useSpring(initial: number, token: SpringToken | SpringTokenName = 'panel', precision = 1): Spring {
  const spring = new Spring(initial, token, precision);
  onCleanup(() => spring.stop());
  return spring;
}

/** Sets a spring's target, honouring reduced motion (snap). */
export function driveSpring(spring: Spring, target: number, token?: SpringToken | SpringTokenName): void {
  if (prefersReducedMotion()) spring.jump(target);
  else spring.set(target, token);
}
