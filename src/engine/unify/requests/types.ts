/**
 * Message contracts for the Unify screens that the sidebar protocol does not know yet.
 *
 * These mirror the renderer adapters exactly:
 *   screens/files/adapter.ts, screens/knowledge/adapter.ts, screens/hub/hubAdapter.ts,
 *   screens/toolpacks/adapter.ts, screens/providers/adapter.ts,
 *   screens/settings/adapters.ts, screens/setup/adapters.ts.
 *
 * The dispatcher (./index.ts) answers them; every reply echoes the request's `requestId`.
 */

import type { GithubAuth } from '../github';
import type { HubPickItem, HubRegistry, PackSetupState } from '../../hub/types';

export type { GithubAuth };

/** A request from the renderer: an open bag of fields, keyed by `type`. */
export interface UnifyRequestMessage {
  type: string;
  requestId?: string;
  [key: string]: unknown;
}

export type UnifyReply = (message: unknown) => void;

/**
 * Engine facts a request may need. `workspaceRoot` is the open folder; the rest are optional so tests can
 * point the dispatcher at a temporary home instead of the user's real `~/.unify`.
 *
 * The `refresh*`/`openExternal`/`getGithubAuth` callbacks let a request reach engine services that only the
 * extension (or Electron host) owns. A missing callback is reported, never silently ignored.
 */
export interface UnifyRequestContext {
  workspaceRoot: string | undefined;
  /** Extra open folders, watched alongside `workspaceRoot`. */
  workspaceRoots?: string[];
  /** Unify's data home (`~/.unify`) by default. */
  unifyHome?: string;
  /** Unify's state folder; the same as `unifyHome` by default. */
  unifyRoot?: string;
  /** App version reported by getAppInfo; read from package.json when missing. */
  version?: string;
  /** Rebuilds and posts `modelState` (the extension's `refreshModels`). */
  refreshModelState?: () => void;
  /** Refreshes one account's usage, or all of them (the extension's `refreshUsage`). */
  refreshUsageState?: (accountId?: string) => void;
  /** Removes an account completely (record, credentials, default pointer). The extension's `removeAccount`. */
  removeAccount?: (accountId: string) => Promise<void>;
  /** Rebuilds and posts `toolpacksState` (the extension's `postToolpacks`). */
  refreshToolpacks?: () => void;
  /** Adds a freshly installed pack file to the registry so `refreshToolpacks` sees it. */
  installToolpack?: (sourcePath: string) => Promise<void>;
  /** Opens a URL in the user's browser. */
  openExternal?: (url: string) => void | Promise<void>;
  /** The signed-in GitHub account, if any. */
  getGithubAuth?: () => Promise<GithubAuth | undefined>;
  /** Shows a picker to the user and returns the chosen item's id, or undefined when cancelled. */
  pickOption?: (items: HubPickItem[], placeholder: string) => Promise<string | undefined>;
  /** Shows a modal confirmation dialog and returns true only when the user confirms. */
  confirm?: (message: string, detail: string) => Promise<boolean>;
  /** The Hub registry to read; the public GitHub registry when missing. Tests pass their own. */
  hubRegistry?: HubRegistry;
}

/* ---------------------------------------------------------------------------------------------------------------
 * Files (screens/files/adapter.ts)
 */

export interface FileEdit {
  additions: number;
  deletions: number;
}

export interface FileEntry {
  name: string;
  /** Workspace-relative with forward slashes. */
  path: string;
  kind: 'file' | 'dir';
  edited?: FileEdit;
}

export interface FileLineChanges {
  added: number[];
  removed: { afterLine: number; lines: string[] }[];
}

export interface FileDocument {
  path: string;
  content: string;
  language?: string;
  version: string;
  changes?: FileLineChanges;
}

export type WriteResult =
  | { ok: true; version: string }
  | { ok: false; reason: 'conflict'; current: FileDocument }
  | { ok: false; reason: 'error'; message: string };

export type FilesRequest =
  | { type: 'listDir'; requestId: string; path: string }
  | { type: 'readFile'; requestId: string; path: string }
  | { type: 'writeFile'; requestId: string; path: string; content: string; version: string }
  | { type: 'findFiles'; requestId: string; query: string; limit?: number }
  | { type: 'createEntry'; requestId: string; path: string; kind: 'file' | 'dir' }
  | { type: 'renameEntry'; requestId: string; from: string; to: string }
  /** Copies into a folder ('' = root); a taken name becomes "name copy.ext". */
  | { type: 'copyEntry'; requestId: string; from: string; toFolder: string }
  /** Copies absolute paths from outside the project (dropped from the OS) into a folder. */
  | { type: 'importEntries'; requestId: string; sources: string[]; toFolder: string }
  /** Permanent delete; the screen moves entries to the OS trash instead whenever the bridge can. */
  | { type: 'deleteEntry'; requestId: string; path: string };

export type FilesReply =
  /** createEntry / renameEntry / deleteEntry succeeded; `path` is the new (or deleted) project-relative path. */
  | { type: 'entryDone'; requestId: string; path: string; /** importEntries: every copied path. */ paths?: string[] }
  | { type: 'workspaceState'; root: string; name: string }
  | { type: 'dirListing'; requestId: string; path: string; entries: FileEntry[] }
  | { type: 'fileContent'; requestId: string; file: FileDocument }
  | { type: 'fileSaved'; requestId: string; path: string; version: string }
  | { type: 'fileConflict'; requestId: string; current: FileDocument }
  | { type: 'fileMatches'; requestId: string; query: string; paths: string[] }
  | { type: 'filesError'; requestId: string; message: string }
  | { type: 'fileChanged'; /** The watched project folder the path is relative to. */ root?: string; path: string; kind: 'changed' | 'created' | 'deleted'; edited?: FileEdit };

/* ---------------------------------------------------------------------------------------------------------------
 * Knowledge (screens/knowledge/adapter.ts)
 */

export type KnowledgeKind = 'rule' | 'skill' | 'memory';
export type KnowledgeScope = 'global' | 'project';
export type Audience = 'everyone' | 'main' | 'subagents' | `profile:${string}`;

export interface KnowledgeItem {
  id: string;
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  name: string;
  path: string;
  folder?: string;
  description?: string;
  audiences: Audience[];
  files?: string[];
  createdBy?: string;
  createdAt?: number;
  updatedBy?: string;
  updatedAt?: number;
  usedIn?: number;
}

export interface KnowledgeDraft {
  id?: string;
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  name: string;
  folder?: string;
  description?: string;
  audiences: Audience[];
}

export interface ImportedFile {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
}

/** Every request may also carry `project`: the project folder its "project" scope means (default: the open workspace). */
export type KnowledgeRequest =
  | { type: 'knowledgeList' }
  | { type: 'readKnowledge'; requestId: string; id: string; file?: string }
  | { type: 'saveKnowledge'; requestId: string; item: KnowledgeDraft; content: string; file?: string }
  | { type: 'removeKnowledge'; requestId: string; id: string }
  | { type: 'setKnowledgeAudience'; id: string; audiences: Audience[] }
  | { type: 'importSkillFolder'; requestId: string; scope: KnowledgeScope; name: string; files: ImportedFile[] }
  | { type: 'undoKnowledgeChange'; id: string }
  | { type: 'openKnowledge'; id: string; file?: string };

export type KnowledgeReply =
  /** `project`: the folder the project-scope items were read from (none when no project is open). */
  | { type: 'knowledgeState'; project?: string; items: KnowledgeItem[] }
  | { type: 'knowledgeContent'; requestId: string; id: string; file?: string; content: string }
  | { type: 'knowledgeSaved'; requestId: string; item: KnowledgeItem }
  | { type: 'knowledgeRemoved'; requestId: string; id: string }
  | { type: 'knowledgeError'; requestId: string; message: string };

/* ---------------------------------------------------------------------------------------------------------------
 * Toolpacks (screens/toolpacks/adapter.ts)
 */

export type ToolKind = 'read' | 'write' | 'run';
export type ToolPolicy = 'always' | 'ask' | 'off';

export type ToolpackRequest =
  | { type: 'toolpackToolEnabled'; id: string; tool: string; enabled: boolean }
  | { type: 'toolpackPermission'; id: string; group: ToolKind; policy: ToolPolicy }
  /** The setup checklist of one installed pack (`id` = toolpack folder id). Replies `toolpackSetupState`. */
  | { type: 'toolpackSetup'; requestId?: string; id: string }
  /** Every installed pack's checklist that still has pending steps. Replies `toolpackSetupList`. */
  | { type: 'toolpackSetupList'; requestId?: string }
  /**
   * `markDone` / `markTodo`: tick a manual step (persisted in the pack folder's `setup-state.json`).
   * `recheck`: re-evaluate every `check`. `open`: open the step's `open` URL or folder.
   * `rerunScript`: run the pack's install script again and install missing required packages (the user already
   * consented at install). `install`: install one step's package (the button shows the exact command).
   * Replies `toolpackSetupState`, or `toolpackSetupError` with a message.
   */
  | { type: 'toolpackSetupAction'; requestId?: string; id: string; action: 'markDone' | 'markTodo' | 'recheck' | 'open' | 'rerunScript' | 'install'; stepId?: string };

export type ToolpackSetupReply =
  | { type: 'toolpackSetupState'; requestId?: string; setup: PackSetupState | null }
  | { type: 'toolpackSetupList'; requestId?: string; packs: PackSetupState[] }
  | { type: 'toolpackSetupError'; requestId?: string; id: string; message: string };

/* ---------------------------------------------------------------------------------------------------------------
 * Providers (screens/providers/adapter.ts)
 */

export type ProviderRequest =
  | { type: 'setModelEnabled'; modelId: string; enabled: boolean }
  | { type: 'renameAccount'; accountId: string; label: string }
  | { type: 'setAccountDefaultModel'; accountId: string; modelId: string }
  | { type: 'setProviderDefaultModel'; provider: string; modelId: string }
  | { type: 'signOutAccount'; accountId: string };

/* ---------------------------------------------------------------------------------------------------------------
 * Settings / About (screens/settings/adapters.ts)
 */

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'current'; checkedAt: number }
  | { state: 'available'; version: string; notesUrl?: string }
  | { state: 'downloading'; version: string; progress: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string };

export interface AppInfo {
  version: string;
  channel: 'stable' | 'beta' | 'dev';
  dataFolder: string;
  update: UpdateStatus;
}

/* ---------------------------------------------------------------------------------------------------------------
 * Setup (screens/setup/adapters.ts)
 */

export type ToolState = 'checking' | 'found' | 'missing' | 'fixing' | 'error';

export interface ToolStatus {
  id: string;
  description: string;
  state: ToolState;
  version?: string;
  error?: string;
  required: boolean;
}

export interface SetupSummary {
  accounts: string[];
  project?: { name: string; path: string };
  tools: string[];
  theme: string;
}

export interface SetupState {
  complete: boolean;
  defaultProject?: { name: string; path: string };
}

/* ---------------------------------------------------------------------------------------------------------------
 * Hub (screens/hub/hubAdapter.ts, engine/hub/types.ts)
 */

export type {
  HubCategory,
  HubInstallProgress,
  HubPack,
  HubPackDetail,
  HubState,
  PackSetupState,
  PackSetupStep,
  PackSetupStepStatus,
} from '../../hub/types';
