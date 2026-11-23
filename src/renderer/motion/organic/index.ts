/**
 * Organic ("human-like") motion: things the agent changes look like a person did them on a shared screen.
 * Display only: the real value is there at once, a press / focus finishes the animation, time is capped,
 * reduced motion crossfades, each effect has its toggle (motion.organic.*), and only a few run at once.
 *
 *   planRetype(from, to, seed)      pure timing engine: backspace to the shared prefix, beat, type the suffix
 *   <RetypeText value>              rename / created (typeOnMount) / deleted (deleting + onDeleted) / status (speed="fast")
 *   <Caret phase>                   thin caret: solid while typing, one blink, fade
 *   <RollingNumber value>           odometer counters ("+12", "−3", "0:42", "34%")
 *   liftMoves(container)            moved rows lift, travel (flipList) and settle
 *   <OrganicList each key>          AnimatedList + created / leaving / moved wiring for rows with names
 *   createSweptList(source, key)    hold removed items until their sweep has played
 *   <EditedLines each key>          live code: removed lines sweep then collapse, added lines wipe in with a caret
 *   claimOrganicSlot()              scheduler: ≤ 3 at once, staggered starts, overflow lands instantly
 *   organicMode(effect)             'organic' | 'crossfade' | 'instant' for an effect right now
 */
export {
  planRetype,
  retypeTiming,
  caretTiming,
  caretTail,
  sharedPrefixLength,
  seededRandom,
  hashText,
  type RetypePlan,
  type RetypeStep,
  type RetypePhase,
  type RetypeOptions,
} from './timing';
export { RetypeText, followWidth, sweepHold, type RetypeTextProps } from './RetypeText';
export { Caret, type CaretPhase, type CaretProps } from './Caret';
export { RollingNumber, parseCounter, type RollingNumberProps } from './RollingNumber';
export { liftMoves, movedKeys, liftScale } from './lift';
export { OrganicList, type OrganicListProps, type OrganicRow } from './OrganicList';
export { createSweptList, type SweptList, type SweptListOptions } from './sweptList';
export { EditedLines, codeEditTiming, type EditedLinesProps } from './EditedLines';
export { claimOrganicSlot, organicScheduling, organicSlotsInUse, type OrganicTicket } from './scheduler';
export { organicEnabled, organicMode, isOnScreen, type OrganicEffect, type OrganicMode } from './enabled';
