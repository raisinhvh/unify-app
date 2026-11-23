# Files + Editor: engine messages needed

Owner of the renderer side: `screens/files/adapter.ts` (types below are copied from it; keep both in sync).
Until the engine answers, the adapter waits 1.5 s for the first reply, then serves a mock workspace for the
rest of the session. Nothing else in the screen changes once these exist.

Conventions

- Paths are **workspace-relative with forward slashes** (`src/toolpacks/registry.ts`); `''` is the root.
- Every request carries a `requestId`; the reply echoes it. Unknown or failed requests answer `filesError`
  with the same `requestId` (never silence: the adapter treats a timeout as "engine has no Files support").
- Paths outside the workspace root (after resolving `..` and symlinks) must be rejected with `filesError`.
- Already existing and used as is: `{ type: 'openFile'; path: string; line?: number; column?: number }`
  (absolute path) and `viewState.diffs: SidebarDiff[]` (agent edits, for +N −M on rows).

## Shared types

```ts
export interface FileEdit {
  additions: number;
  deletions: number;
}

export interface FileEntry {
  name: string;
  /** Workspace-relative, forward slashes. */
  path: string;
  kind: 'file' | 'dir';
  /** Set when an agent changed the file in a current chat and the change is not reviewed yet. */
  edited?: FileEdit;
}

/** Lines an agent changed, so the editor can tint them. 1-based line numbers in the current content. */
export interface FileLineChanges {
  added: number[];
  /** Removed lines, shown above line `afterLine + 1` (0 = top of the file). */
  removed: { afterLine: number; lines: string[] }[];
}

export interface FileDocument {
  path: string;
  content: string;
  /** Monaco language id; optional, the renderer guesses from the extension. */
  language?: string;
  /** Opaque version (mtime+size or hash). writeFile sends it back to detect conflicts. */
  version: string;
  /** Unreviewed agent changes against the content before the agent's edit. */
  changes?: FileLineChanges;
}
```

## Renderer → engine

```ts
export type FilesRequest =
  /** Direct children of a folder. Honour .gitignore and skip .git/ and node_modules/. */
  | { type: 'listDir'; requestId: string; path: string }
  /** UTF-8 text. Binary or > 2 MB files answer filesError with a readable message. */
  | { type: 'readFile'; requestId: string; path: string }
  /** Write only if the file's current version equals `version`; otherwise answer fileConflict. */
  | { type: 'writeFile'; requestId: string; path: string; content: string; version: string }
  /** Fuzzy file-path search over the workspace (same ignore rules as listDir), best matches first. */
  | { type: 'findFiles'; requestId: string; query: string; limit?: number };
```

## Engine → renderer

```ts
export type FilesReply =
  /** Push on connect and when the workspace changes. `root` is absolute (used to turn diff paths relative). */
  | { type: 'workspaceState'; root: string; name: string }
  | { type: 'dirListing'; requestId: string; path: string; entries: FileEntry[] }
  | { type: 'fileContent'; requestId: string; file: FileDocument }
  | { type: 'fileSaved'; requestId: string; path: string; version: string }
  | { type: 'fileConflict'; requestId: string; current: FileDocument }
  | { type: 'fileMatches'; requestId: string; query: string; paths: string[] }
  | { type: 'filesError'; requestId: string; message: string }
  /**
   * Push (no requestId) when a file changes on disk: agent edit, external editor, create, delete.
   * Debounce per path (~100 ms). The renderer re-lists the parent folder and re-reads the file if open and clean.
   */
  | { type: 'fileChanged'; path: string; kind: 'changed' | 'created' | 'deleted'; edited?: FileEdit };
```

`workspaceState` could instead be two fields on `SidebarViewState` (`workspaceRoot`, `workspaceName`); if the
backend prefers that, tell the Files owner and the adapter reads them from `viewState`.
