/**
 * Motion foundation. One spring engine; everything that moves goes through it.
 *
 *   springs / SpringToken      tokens (period + damping), pick by role
 *   Spring                     imperative spring: set(target) retargets keeping velocity
 *   createSpring(source, tok)  Solid accessor that springs toward a reactive number
 *   useSpring / driveSpring    component-owned imperative spring; set honouring reduced motion
 *   <Presence when>            Pop in, quick collapse out, stays mounted until the exit ends
 *   <Collapse open>            height reveal; layout below follows
 *   pressable(el)              elastic press to 0.94
 *   flipList(container)        children with data-flip glide to new positions
 *   <AnimatedList each key>    keyed rows: reveal on join, collapse on leave, FLIP on reorder
 *   prefersReducedMotion()    reactive; when true positions snap and only opacity fades
 *
 * Loader crossfade/morph lives with the loaders (components/loaders/LoaderMorph.tsx) and uses the same engine.
 */
export { springs, resolveToken, type SpringToken, type SpringTokenName } from './tokens';
export { Spring } from './spring';
export { createSpring, useSpring, driveSpring, type SpringOptions } from './createSpring';
export { Presence, type PresenceProps } from './Presence';
export { Collapse, type CollapseProps } from './Collapse';
export { pressable } from './press';
export { flipList } from './flip';
export { AnimatedList, type AnimatedListProps } from './AnimatedList';
export { prefersReducedMotion, setAppReducedMotion } from './reducedMotion';
