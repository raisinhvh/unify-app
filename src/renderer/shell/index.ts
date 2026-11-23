/**
 * Shell: the app frame (rail, side panel, content) and the tiling pane manager.
 *
 *   Shell        the whole window; mount once from App
 *   PaneGrid     tiled chats with splits and drag-to-arrange (Figma 11, 11b)
 *   layout.ts    the persisted pane layout and the functions that change it (openChat, closeChat, ...)
 */
export { Shell } from './Shell';
export { PaneGrid, type PaneContext, type PaneGridProps } from './PaneGrid';
export {
  closeChat,
  dropChat,
  focusPane,
  isChatOnScreen,
  layout,
  openChat,
  openChats,
  pruneChats,
  setSplit,
  swapChats,
  type LayoutState,
  type PresetId,
} from './layout';
