# Screens

One folder per route. `screens/index.tsx` maps each route to its screen.

| Route | Folder | Entry | Figma |
| --- | --- | --- | --- |
| chats (Home, panes, Chats panel) | `chats/` | `Home`, `ChatPane`, `ChatsPanel` (drawn by the Shell) | 10, 10b, 11, 11b, 12, 13, 14 |
| files, knowledge, terminal, image | `files/`, `knowledge/`, `terminal/` | not routes: panes in the workspace (`shell/PaneContent.tsx`) use `FilesPanel` + `FilesEditor`, `KnowledgePanel` + `KnowledgeContent`, `TerminalView` | 20, 21 |
| toolpacks | `toolpacks/` | `ToolpacksScreen` | 22 |
| hub | `hub/` | `HubScreen` | 23 |
| providers | `providers/` | `ProvidersScreen` (+ `ProvidersPanel`) | 24, 24b, 24c |
| settings | `settings/` | `SettingsScreen` (+ `SettingsPanel`); rows come from `settings/catalog.ts` | 25, 25b |
| updates | `updates/` | `UpdatesScreen`; state from `updates/updateState.ts` (opened from the rail's Updates button, the version footer, Settings > About and the update notification) | — |
| setup | `setup/` | `SetupWizard` (drawn by the Shell over Home while `shouldShowSetup()`) | 26a–26f |

A new feature toggle in `store/features.ts` shows up in Settings by itself (`settings/catalog.ts`).

Screenshot fixtures (`tools/fixtures/base.json`) persist `setupComplete: true`, so captures open on Home instead of
the setup wizard. Drop it from a fixture to capture the wizard.

## Add a screen

1. Make `screens/<route>/<Name>Screen.tsx` (+ a `<name>.css` it imports). Export one component.
2. In `screens/index.tsx`, point the route at it: `files: () => <FilesScreen />`.
3. A new route also needs its id in `router.ts` (`RouteId`, `routeIds`) and, if it has a rail button,
   an entry in `railRoutes` (order matches Figma Rail 306:785).

The Shell draws the screen inside `.content-screen` (a surface card under the title bar). Home and its
backdrop stay underneath; never draw your own backdrop.

Files, Knowledge and Terminal are no longer routes. They are pane kinds (`shell/layout.ts`), opened from the rail
with `openPane(kind)`, and their bodies come from `shell/PaneContent.tsx`, which reuses the screens' exported
panels and content halves. Persisted `files` or `knowledge` routes migrate to the chats route with that pane open.

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
