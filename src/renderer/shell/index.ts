/**
 * Shell: the app frame (rail, side panel, content) and the pane workspace.
 *
 *   Shell        the whole window; mount once from App
 *   PaneGrid     the tiled workspace: splits, drag-to-arrange, empty slots (Figma 11, 11b)
 *   PaneContent  what a pane shows by kind (chat, files, knowledge, terminal, image); EmptySlot for empty leaves
 *   layout.ts    the persisted pane layout and the functions that change it (openChat, openPane, closePane, ...)
 *   ShutdownArmRow  the "Shut down when done" switch for the usage popover
 */
export { Shell } from './Shell';
export { PaneGrid, type PaneContext, type EmptySlotContext, type PaneGridProps } from './PaneGrid';
export { PaneContent, EmptySlot } from './PaneContent';
export { ShutdownArmRow } from './ShutdownArmRow';
export {
  applyPreset,
  closePane,
  closeChat,
  focusedChatId,
  focusedPane,
  focusLeaf,
  fillSlot,
  isChatOnScreen,
  layout,
  openChat,
  openChats,
  openPane,
  placePane,
  poppedOutChats,
  pruneChats,
  resetLayout,
  setPoppedOutChats,
  type LayoutState,
  type PaneInstance,
  type PaneKind,
  type PresetId,
} from './layout';
