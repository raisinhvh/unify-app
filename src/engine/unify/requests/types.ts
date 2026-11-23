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

/** A request from the renderer: an open bag of fields, keyed by `type`. */
export interface UnifyRequestMessage {
  type: string;
  requestId?: string;
  [key: string]: unknown;
}

export type UnifyReply = (message: unknown) => void;

/**
 * Engine facts a request may need. `workspaceRoot` is the open folder; the rest are optional so tests can
 * point the dispatcher at a temporary home instead of the user's real `~/.dsh`.
 */
export interface UnifyRequestContext {
  workspaceRoot: string | undefined;
  /** `~/.dsh` by default. */
  dshHome?: string;
  /** `~/.dsh/unify` by default. */
  unifyRoot?: string;
  /** App version reported by getAppInfo; read from package.json when missing. */
  version?: string;
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
  | { type: 'findFiles'; requestId: string; query: string; limit?: number };

export type FilesReply =
  | { type: 'workspaceState'; root: string; name: string }
  | { type: 'dirListing'; requestId: string; path: string; entries: FileEntry[] }
  | { type: 'fileContent'; requestId: string; file: FileDocument }
  | { type: 'fileSaved'; requestId: string; path: string; version: string }
  | { type: 'fileConflict'; requestId: string; current: FileDocument }
  | { type: 'fileMatches'; requestId: string; query: string; paths: string[] }
  | { type: 'filesError'; requestId: string; message: string }
  | { type: 'fileChanged'; path: string; kind: 'changed' | 'created' | 'deleted'; edited?: FileEdit };

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

export type KnowledgeRequest =
  | { type: 'knowledgeList' }
  | { type: 'readKnowledge'; requestId: string; id: string; file?: string }
  | { type: 'saveKnowledge'; requestId: string; item: KnowledgeDraft; content: string; file?: string }
  | { type: 'removeKnowledge'; requestId: string; id: string }
  | { type: 'setKnowledgeAudience'; id: string; audiences: Audience[] }
  | { type: 'importSkillFolder'; requestId: string; scope: KnowledgeScope; name: string; files: ImportedFile[] }
  | { type: 'openKnowledge'; id: string; file?: string };

export type KnowledgeReply =
  | { type: 'knowledgeState'; items: KnowledgeItem[] }
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
  | { type: 'toolpackPermission'; id: string; group: ToolKind; policy: ToolPolicy };

/* ---------------------------------------------------------------------------------------------------------------
 * Providers (screens/providers/adapter.ts)
 */

export type ProviderRequest =
  | { type: 'setModelEnabled'; modelId: string; enabled: boolean }
  | { type: 'renameAccount'; accountId: string; label: string }
  | { type: 'setAccountDefaultModel'; accountId: string; modelId: string }
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

export interface DshImportScan {
  toolpacks: string[];
  rules: number;
  skills: number;
  memoryNotes: number;
}

export type ImportKind = 'toolpacks' | 'knowledge';

export interface SetupSummary {
  accounts: string[];
  project?: { name: string; path: string };
  tools: string[];
  theme: string;
  toolpacks: 'imported' | 'skipped';
  knowledge: 'imported' | 'skipped';
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
  HubDevice,
  HubInstallProgress,
  HubInstallTarget,
  HubPack,
  HubPackDetail,
  HubState,
} from '../../hub/types';
