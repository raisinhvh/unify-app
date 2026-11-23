# Protocol requests: Toolpacks, Hub, Providers

Messages and fields these three screens need that the engine (`src/engine/sidebar/view.ts`) does not have yet.
The renderer already sends and reads them through typed adapters, so implementing the engine side is enough:

| Screen | Adapter | Types |
| --- | --- | --- |
| Toolpacks | `screens/toolpacks/adapter.ts` | `ToolpackExtension`, `ToolpackRequest` |
| Hub | `screens/hub/hubAdapter.ts` (dev answers: `hubMock.ts`) | `HubState`, `HubRequest`, `HubReply` |
| Providers | `screens/providers/adapter.ts` | `AccountExtension`, `ProviderRequest` |

Every new field is optional; the UI falls back when it is missing. Once added to `view.ts`, the casts in the
adapters (`as unknown as SidebarWebviewMessage`, `as typeof raw & Partial<...>`) can go.

## Toolpacks

Extra optional fields on `SidebarToolpack`:

```ts
interface SidebarToolpack {
  // ...existing fields
  /** Display name. Fallback: the id title-cased ("roblox-studio" -> "Roblox Studio"). */
  name?: string;
  /** Glyph name from screens/toolpacks/glyphs.tsx (roblox, figma, imaging, git, blender, web, engine,
   *  database, browser, issues, audio, sheet, recorder, containers). Fallback: guessed from the id. */
  icon?: string;
  /** Installed version, "2.4.1". */
  version?: string;
  /** Where it came from: "From Toolpack Hub" / "From a folder". */
  source?: 'hub' | 'local';
  /** How many signed-in devices have this pack (sync). Shown as "Synced to N devices". */
  syncedDevices?: number;
  /** Permission per tool group. Fallback: read 'always', write and run 'ask'. */
  permissions?: Partial<Record<'read' | 'write' | 'run', 'always' | 'ask' | 'off'>>;
  tools: {
    name: string;
    description: string;
    /** Group. Fallback: guessed from the name (studio_tree read, figma_execute run, studio_set_x write). */
    kind?: 'read' | 'write' | 'run';
    /** Per-tool switch. Fallback: true. A disabled tool is not offered to agents. */
    enabled?: boolean;
  }[];
}
```

New UI -> engine messages (reply: the next `toolpacksState`):

```ts
| { type: 'toolpackToolEnabled'; id: string; tool: string; enabled: boolean }
| { type: 'toolpackPermission'; id: string; group: 'read' | 'write' | 'run'; policy: 'always' | 'ask' | 'off' }
```

`always` runs the group's tools without approval, `ask` routes them through the approval flow, `off` hides them
from agents (the per-tool switches are kept).

Unchanged and already used: `pickToolpack`, `toolpackAction { id, action: 'enable' | 'disable' | 'reload' | 'remove' }`.

## Hub

Registry: GitHub repo `raisinhvh/unify-hub`. Only the engine talks to it.

```ts
interface HubPack {
  id: string;            // also the installed toolpack id, so the UI can mark it "Installed"
  name: string;
  author: string;
  category: string;      // HubCategory.id
  description: string;
  icon?: string;         // glyph name, as above
  installs: number;
  tools: string[];       // tool names
  version: string;
  updatedAt: number;     // epoch ms, latest version
  publishedAt: number;   // epoch ms, first version ("New" sort)
  license: string;
}
interface HubCategory { id: string; label: string }
interface HubDevice { id: string; label: string; current: boolean }
interface HubState {
  packs: HubPack[];
  categories: HubCategory[];
  featured: string[];    // pack ids, in order (3 are shown)
  authors: number;
  devices: HubDevice[];  // signed-in devices "Your devices" installs to
  fetchedAt: number;
  error?: string;        // registry unreachable etc.; the UI shows it with a retry
}
type HubInstallTarget = 'this' | 'all';
interface HubInstallProgress {
  id: string;
  percent: number;       // 0-100
  state: 'downloading' | 'installing' | 'done' | 'error';
  error?: string;
}
```

UI -> engine:

```ts
| { type: 'hubBrowse'; refresh?: boolean }                     // reply: hubState
| { type: 'hubInstall'; id: string; target: HubInstallTarget; allowScript?: boolean } // reply: hubInstallProgress (repeated), hubInstallResult
| { type: 'hubPublish' }                                       // engine: folder picker, validation, confirm, upload
```

Engine -> UI:

```ts
| { type: 'hubState'; hub: HubState }
| ({ type: 'hubInstallProgress' } & HubInstallProgress)
| { type: 'hubInstallResult'; ok: boolean; id: string; needsScriptConsent?: boolean; scriptName?: string; scriptText?: string; error?: string }
```

A pack that ships an install script and was sent without `allowScript` answers `hubInstallResult` with
`needsScriptConsent`, `scriptName` and `scriptText`; nothing is installed. The Hub shows the script in a dialog
and, if the user agrees, resends `hubInstall` with `allowScript: true`. `ok: false` with `error` shows as the
row's Failed / Retry state.

Install downloads the pack and runs its install script (spec), then sends `toolpacksState` with the new pack and a
final `hubInstallProgress` with `state: 'done'`. With `target: 'all'` the pack is added to the synced set so the
other devices install it too. The UI never uploads anything itself: `hubPublish` is a request, and the engine owns
the confirmation.

### Publish

The UI asks the user to confirm an install before sending `hubInstall` (the pack's install script runs), and shows
Upload only when `viewState.github.signedIn`; signed out it links to Settings instead.

Today the engine answers `hubPublish` with a `hubState` whose `error` is "Publishing is not available yet."
(later "Publishing is limited to approved accounts."). The adapter treats a `hubState` with an `error` that arrives
while a publish is pending as the publish answer: the message shows calmly beside the Upload button, the catalogue
keeps its packs, and the Hub does not show an error. Suggested dedicated reply, which the adapter already handles:

```ts
| { type: 'hubPublishResult'; ok: boolean; message: string; url?: string }
// ok: false, message: 'Publishing is limited to approved accounts.'
// ok: true,  message: 'Published Containers 1.2.0', url: 'https://github.com/…/pull/12'
```

## Providers

Extra optional fields:

```ts
interface SidebarModel {
  // ...existing fields (enabled?: boolean already exists and is read)
  /** Context window in tokens; shown as "1M context". */
  contextWindow?: number;
}
interface SidebarAccount {
  // ...existing fields
  /** Model id that new chats on this account start with. Fallback: none selected. */
  defaultModel?: string;
}
```

New UI -> engine messages (reply: the next `modelState` / `accountsState`):

```ts
| { type: 'setModelEnabled'; modelId: string; enabled: boolean }          // modelState
| { type: 'renameAccount'; accountId: string; label: string }             // accountsState
| { type: 'setAccountDefaultModel'; accountId: string; modelId: string }  // accountsState
| { type: 'signOutAccount'; accountId: string }                           // accountsState + usageState
```

`signOutAccount` is for OAuth accounts (claude-cli, codex-cli): forget the tokens but keep the account, which then
reports `usage[accountId].fix === 'signin'` (the UI's "Signed out" state; "Sign in" sends the existing
`reauthAccount`). API-key accounts use the existing `removeAccount`; Cursor uses `cursorLogout`.

Unchanged and already used: `addAccount`, `addOAuthAccount`, `cursorLogin`, `cursorLogout`, `reauthAccount`,
`removeAccount`, `setDefaultAccount`, `refreshUsage`, `viewProviderUsage`; replies `accountSaved`, `accountsState`,
`usageState`, `modelState`.
