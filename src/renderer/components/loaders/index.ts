/**
 * Loaders: one per agent action (Figma 02 · Loaders), plus status glyphs drawn in the same cells.
 *
 *   <Loader id={actionLoader[chatAction(id)]} />   blends seamlessly into whatever `id` becomes next
 *   <Loader id="done" /> / <Loader id={undefined} />  the done check / nothing; both morph like loaders
 *   <ChatLoader sessionId=… />                      the loader for what a chat is doing now (or the done check)
 *
 * To add a loader: write a LoaderFrame in definitions.ts (cells with stable keys; reuse g0..g8 / l0..l3 keys
 * where the shapes correspond so the pairing reads as intended), add it to `loaders` and `loaderInfo`, then map
 * an action to it in actions.ts. Morphs need nothing else: morph.ts pairs any two frames cell to cell.
 */
export { Loader, type LoaderProps } from './Loader';
export { ChatLoader } from './ChatLoader';
export { loaders, loaderInfo, glyphs, frameFor, type LoaderId, type LoaderGlyph, type LoaderShape } from './definitions';
export { actionLoader, actionLabel, chatAction, toolAction, type AgentAction } from './actions';
export { morphToken } from './morph';
export type { LoaderCell, LoaderFrame } from './cells';
