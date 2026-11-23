# Screens

One folder per route. `chats/` is built; every other route is a **stub** (`stubs.tsx`).

| Route | Status | Figma |
| --- | --- | --- |
| chats (Home + panes + Chats panel) | built | 10, 10b, 11, 11b, 12, 13, 14 |
| files, knowledge, toolpacks, hub, providers, settings, setup | stub | find the frame by name on the Unify page |

## Add a screen

1. Make `screens/<route>/<Name>Screen.tsx` (+ a `<name>.css` it imports). Export one component.
2. In `screens/index.tsx`, point the route at it: `files: () => <FilesScreen />`. Remove its stub entry.
3. A new route also needs its id in `router.ts` (`RouteId`, `routeIds`) and, if it has a rail button,
   an entry in `railRoutes` (order matches Figma Rail 306:785).

The Shell draws the screen inside `.content-screen` (a surface card under the title bar). Home and its
backdrop stay underneath; never draw your own backdrop.

## Use the foundation

- **State**: read `viewState` from `store/` (mirror of the engine's SidebarViewState). Never keep a copy.
- **Talk to the engine**: `post({ type: ... })` from `bridge.ts`. Raw replies: `onHostMessage(listener)`.
  The message types come from the engine's `sidebar/view.ts` via `protocol.ts`.
- **Persist UI state** (open folders, tabs): `readPersisted` / `writePersisted` from `persist.ts`.
- **Components**: `components/` (Button, IconButton, Icon, Menu, Popover, Select, Toggle, Tooltip, Tree,
  loaders). No pills: text buttons, icon buttons, one flat primary.
- **Type**: `.type-display/title/heading/body/label/caption/mono` from `theme/theme.css`; colours only
  through the theme variables (`--bg`, `--surface`, `--raised`, `--text`, `--text2`, `--text3`, `--border`,
  `--hover`, `--accent`, `--warn`, `--add`, `--del`...), so all 7 themes work.
- **Motion** (`motion/`): never CSS-transition a size or position.
  - `createSpring(() => target, 'panel')` for any animated number.
  - `<Presence when>` for things that appear (Pop in, quick exit).
  - `<Collapse open>` for height reveals.
  - `pressable` (via Button/IconButton/TreeItem) for presses.
  - `flipList(container)` for lists that reorder.
  - Reduced motion is handled inside these helpers.

## Not built yet (chats)

- `@` file mentions and `/` slash commands in the composer (no protocol for them yet).
- The job bar above the composer (`viewState.jobs`).
- "Always allow" on approval rows.
- Attach menu entries "Folder as context" and "Screenshot".
- Pop-out of a pane into its own window (button is there, disabled).
