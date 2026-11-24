# Unify architecture (shared contract)

Unify is the Electron successor to the DSH VS Code extension. Product spec: `docs/UNIFY_SPEC.md`.
Designs: Figma page "Unify" (screens 10–27). Behaviour must match DSH: we keep its engine and change the shell and the UI.

## Layout
```
unify/
  package.json            owner: backend. scripts below. deps incl. solid-js, vite, vite-plugin-solid, monaco-editor
  run.cmd / run.sh         dev launch: install if needed, build engine, start vite + electron
  electron-builder.yml     Windows NSIS installer + portable; mac dmg; linux AppImage
  LICENSE (MIT), README.md
  src/
    engine/               DSH's src/ copied verbatim (extension.ts, runtime/, accounts/, ...). Change only what the shim can't cover.
    shim/vscode/          Minimal `vscode` module implemented for Electron (window, workspace, commands, Uri, EventEmitter, Disposable, ExtensionContext, globalState/secrets, webview views, output channels, ...)
    main/                 Electron main: boots the shim, calls engine activate(), hosts webview views as windows/IPC, native menus, file dialogs, single instance
    preload/              contextBridge API (below)
    renderer/             owner: frontend (Opus). Vite root with its own vite.config.ts; builds to dist/renderer/
  media/                  DSH media/ copied (legacy sidebar.js/css, fonts, icons)
  test/                   DSH tests copied, still passing
```

## Engine ↔ UI protocol
The engine's sidebar provider (`src/engine/sidebar/provider.ts`) talks to its webview with the messages typed in
`src/engine/sidebar/view.ts`: `SidebarWebviewMessage` (UI → engine) and `SidebarHostMessage` (engine → UI), with
`SidebarViewState` as the full state. Unify keeps this protocol unchanged; the new renderer is just another webview client.
Several chats on screen at once use the same protocol per chat: the engine already keeps one runtime per chat; the
backend adds what's needed so more than one chat can be active, keyed by chat id, without changing message shapes
beyond an optional `chatId` field.

Everything below is additive. The renderer re-exports these types through `src/renderer/protocol.ts`; the engine owns
the shapes in `src/engine/sidebar/view.ts`.

### Chat identity and multi-chat semantics
```ts
/** Every UI -> engine message may name the chat it concerns; omitted means the active chat. */
export type SidebarWebviewMessage = SidebarWebviewPayload & { chatId?: string };
```
- Chat-scoped messages, all honouring `chatId`: `sendPrompt`, `cancel`, `applyAll`, `rejectAll`, `applyDiff`,
  `openDiff`, `rejectDiff`, `reviewAll`, `openFile`, `unqueue`, `editMessage`, `selectSession`, `deleteSession`,
  `renameSession`.
- Global engine settings, where `chatId` is ignored: `selectModel`, `selectSpeed`, `selectEffort` (the selected
  model, speed and effort are application-wide, exactly as in DSH), plus every account/provider/settings message.
- A prompt for a non-active chat runs that chat's runtime without changing which tab is active.
- Engine -> UI messages that concern a chat keep carrying `sessionId` (timeline, run state, approvals, questions,
  diffs). The only new chat-keyed host messages are `agentMessage` (uses `chatId`) and `agentRoster` (all chats).
- `SidebarHostMessage` also gained an optional `chatId` on the union, equal to a `sessionId` when a host message is
  posted in reply to a UI message that named a chat.

### Project folders and plans
```ts
/** Workspace folder a chat belongs to, used to group chats in the activity rail. */
export interface SidebarProject {
  name: string;   // folder name, e.g. "Unify"
  path: string;   // absolute folder path
}

/** Subscription plan shown with the account usage numbers. */
export interface SidebarPlan {
  name: string;        // e.g. "Pro"
  monthlyUsd: number;  // 0 for free plans
}

export interface SidebarSession {
  id: string;
  name: string;
  project?: SidebarProject;   // new: groups the chat under its folder
  icon?: string;
  updatedAt?: number;
  messageCount?: number;
  contextTokens?: number;
  explorerTokens?: number;
}

export interface SidebarAccountUsage {
  status: 'ready' | 'unavailable' | 'error';
  metrics: SidebarUsageMetric[];
  detail?: string;
  fix?: 'retry' | 'signin' | 'key' | 'cli' | 'browser';
  fetchedAt: number;
  loading?: boolean;
  plan?: SidebarPlan;         // new: DSH's usage maths reads usage.plan.monthlyUsd
}
```
`sessionState` therefore sends `sessions[].project`, and `usageState` sends `usage[accountId].plan`. A new chat started
from a project folder sends `{ type: 'newSession', project }`; the engine stores it on the session and defaults
sessions created elsewhere to the open workspace folder.

### Feature toggles
```ts
// UI -> engine
| { type: 'setUnifyFeature'; id: string; value: boolean | number | string }

// engine -> UI
| { type: 'unifyFeaturesState'; features: Record<string, boolean | number | string> }

export interface SidebarViewState {
  // ...
  /** Values of Unify's settings (src/engine/unify/settings.ts), separate from DSH's own `features`. */
  unifyFeatures: Record<string, boolean | number | string>;
}

// customizeState may carry the same record; when omitted, the renderer keeps its current values.
| { type: 'customizeState'; /* ...existing fields... */ unifyFeatures?: Record<string, boolean | number | string> }
```
`unifyFeatures` is intentionally not named `features`: `features` is DSH's own toggle record (`SidebarFeatures`) and
stays as is. Values persist in `~/.unify/settings.json` as `{ "features": Record<string, value> }`, are shared by
every window (the engine re-pushes `unifyFeaturesState` on change), and only ids in `ENGINE_FEATURE_DEFAULTS` default;
other ids are stored and mirrored as-is so UI-only toggles survive restarts.

Engine defaults (`src/engine/unify/settings.ts::ENGINE_FEATURE_DEFAULTS`):
```ts
'agents.messaging': true,
'agents.messaging.scope': 'everyone',       // 'everyone' | 'same-chat' | 'parent-child'
'agents.blockNativeAgents': true,
'agents.maxParallel': 4,
'knowledge.agentWrites': true,              // false makes memory/skill edits ask for approval
'knowledge.audiences': true,
'notifications.desktop': true,
'power.shutdownWhenIdle': false,
'power.rememberArmed': false,
```
`notifications.desktop` is real: while the window is unfocused, the engine shows an Electron `Notification` for a new
approval/question request and for a finished turn. It runs in Electron's main process, so it imports `electron`
dynamically and silently does nothing in hosts without Electron (tests, the VS Code extension). No renderer IPC is
needed; if a future renderer-build wants to raise notifications itself, add a `notify(title, body)` method to the
`window.unify` preload API (main-process IPC to the same `Notification`) and leave the engine path unchanged.
`knowledge.agentWrites` gates the automatic approval of edits inside memory/skill vaults in `decideApprovalInner`.

### "Always allow" approval rows
```ts
// UI -> engine
| { type: 'approvalResponse'; id: string; allow: boolean; always?: boolean }
```
`always: true` with `allow: true` stores a rule for the command's prefix in the request's project folder; later
requests whose command has the same prefix are approved without asking. Only shell commands can be remembered.
The prefix is the first two whitespace-separated words (`git status --short` -> `git status`; `commandPrefix` in
`src/engine/sidebar/allowRules.ts`). Rules persist in `~/.unify/approvals.json`:
```json
{
  "rules": [
    { "project": "C:\\Users\\me\\Projects\\Unify", "prefix": "git status", "createdAt": 1730000000000 }
  ]
}
```
`project` is the absolute workspace folder path, `createdAt` is epoch milliseconds. A missing or malformed file reads
as no rules; writes go through a temporary file and rename.

### Agent messaging
```ts
/** src/engine/unify/agentBus.ts */
export interface AgentInfo {
  id: string;                 // chat id for top-level agents, delegate task id for subagents
  name: string;               // "Main", "Sol", "explorer"
  task: string;               // short description of the current task
  chatId: string;             // chat the agent belongs to
  parentId?: string;          // undefined for top-level agents
  state: 'running' | 'waiting' | 'idle';
}

export interface AgentMessage {
  id: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  text: string;
  replyToId?: string;         // set when this message answers another one
  sentAt: number;             // epoch milliseconds
}

// engine -> UI additions
| { type: 'agentMessage'; chatId: string; message: AgentMessage }
| { type: 'agentRoster'; agents: AgentInfo[] }
```
Every top-level chat registers as `{ id: chatId, name: 'Main', task: chat title, chatId, state }`; the engine updates
`state`/`task` as the chat runs, gets renamed or is auto-named, and unregisters it when the chat unloads or closes.
`agentRoster` is posted whenever the roster changes and again on `ready`. Messages another agent sent to a chat's agent
are prepended to that chat's next prompt as a "Messages from other agents" block (once, before `User request`), and
only while `agents.messaging` is on.

### Screen data requests (unknown messages)
Any UI message the engine has no `case` for goes through
`handleUnifyRequest(message, reply, { workspaceRoot })` from `src/engine/unify/requests/index.ts` (true = handled);
an unhandled message is written to the engine output channel. New screens therefore need no change in
`extension.ts`. Request/response types are in `src/engine/unify/requests/types.ts` and documented next to the
renderer adapters.

### Lost replies and stalls
Approval and question requests the user never answers reject/skip themselves after 10 minutes
(`APPROVAL_TIMEOUT_MS` in `extension.ts`), so a lost reply cannot hang a turn forever. The same timeout resolves the
renderer's approval/question cards.

## Preload API (window.unify)
```ts
window.unify = {
  post(message: SidebarWebviewMessage): void          // same as vscode.postMessage
  onMessage(listener: (message: SidebarHostMessage) => void): () => void
  getState<T>(): T | undefined; setState<T>(value: T): void   // webview state, persisted per window
  platform: 'win32' | 'darwin' | 'linux'
  window: { minimize(): void; maximize(): void; close(): void; isMaximized(): Promise<boolean> }
  pickFolder(): Promise<string | undefined>
  openExternal(url: string): void
}
```
`acquireVsCodeApi()` is also exposed (wrapping the same calls) so the legacy DSH sidebar runs untouched.

## Renderer modes
- Dev: main loads `http://localhost:5173` (vite) when `UNIFY_DEV=1`, else `dist/renderer/index.html`.
- `UNIFY_LEGACY=1` (or when the new renderer build is missing) loads DSH's own sidebar HTML so the app always works.

## Data
Own data folder `~/.unify` (accounts, rules, memory, toolpacks, chats); nothing is shared with DSH's `~/.dsh`.
VS Code `globalState`/`secrets` map to `~/.unify/state.json` and `~/.unify/secrets.json` (Electron `safeStorage`).
