/**
 * Loaders: one per agent action (Figma 02 · Loaders).
 *
 *   <Loader id={actionLoader[chatAction(id)]} />   morphs between loaders when the id changes
 *   <ChatLoader sessionId=… />                      the loader for what a chat is doing now (or a status glyph)
 *
 * To add a loader: write a LoaderFrame in definitions.ts (cells with stable keys; reuse g0..g8 / l0..l3 keys
 * where the shapes correspond so morphs look intentional), add it to `loaders` and `loaderInfo`, then map an
 * action to it in actions.ts.
 */
export { Loader, type LoaderProps } from './Loader';
export { ChatLoader } from './ChatLoader';
export { loaders, loaderInfo, type LoaderId } from './definitions';
export { actionLoader, actionLabel, chatAction, toolAction, type AgentAction } from './actions';
export type { LoaderCell, LoaderFrame } from './cells';
