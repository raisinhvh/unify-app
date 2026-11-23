# Media contract (owner: main agent)

Spec: `docs/UNIFY_SPEC.md` → Decisions → "Images are first-class". Engine side and renderer side build against this file; change it only through the main agent.

## Store (engine, `src/engine/unify/media/`)
- Files: `~/.unify/media/<sha256[0..2]>/<sha256>.<ext>`; thumbnails `~/.unify/media/thumbs/<sha256>.webp` (longest side 256 px), made lazily.
- Index: `~/.unify/media/index.json` → `{ [sha256]: { mimeType, bytes, width?, height?, refs: string[] } }`. A ref is a chat id (subagent media is referenced by its parent chat id).
- API:
  ```ts
  export interface MediaRecord { hash: string; mimeType: string; bytes: number; width?: number; height?: number }
  export interface MediaStore {
  	/** Stores bytes once (dedupe by sha256) and adds `ref`. */
  	put(bytes: Buffer, mimeType: string, ref: string): Promise<MediaRecord>;
  	/** Same, reading a file from disk (copy, never move). */
  	putFile(path: string, ref: string): Promise<MediaRecord>;
  	/** Absolute path of the stored file, for runtimes that need a path (e.g. a CLI image argument). Read-only for agents. */
  	pathOf(hash: string): string | undefined;
  	/** Drops every ref held by a chat (chat deleted). */
  	release(ref: string): Promise<void>;
  	/** Deletes files with no refs. Runs on startup and after release(). */
  	sweep(): Promise<number>;
  }
  ```
- Migration: none. Old DSH `attachments/` and `media/<chatId>/` files are left alone (DSH still uses them); Unify just stops writing there.

## Electron protocol (`src/main/`)
- `unify-media://<sha256>` serves the original; `unify-media://<sha256>?thumb=1` serves the thumbnail. Registered as a privileged, secure, read-only scheme. Unknown hashes → 404. Hashes must match `/^[0-9a-f]{64}$/`.

## Protocol types (`src/engine/sidebar/view.ts`; renderer mirrors them in `src/renderer/protocol.ts`)
```ts
/** `file` is now the URL `unify-media://<hash>`, so existing <img src={media.file}> keeps working. */
export interface SidebarMedia { name: string; mimeType: string; file: string; hash?: string; width?: number; height?: number }

// Tool rows that gave an agent an image (read_file image, toolpack image content, captures):
SidebarToolEvent.media?: SidebarMedia[];
SidebarSubagentTool.media?: SidebarMedia[];

// A subagent's own feed: a send_media call becomes a message with media.
SidebarSubagent.messages[i].media?: SidebarMedia[];

// Images the subagent sent to its parent (send_media and image-bearing bus messages), in order.
SidebarSubagent.sentToParent?: SidebarMedia[];

// subagentEvent gains:
{ type: 'subagentEvent'; ...; media?: SidebarMedia[]; sentToParent?: SidebarMedia[] }
```

## Behaviour
- A subagent's `send_media`: stored, shown in its own feed (message with `media`), appended to `sentToParent`, and — when `agents.imagesToParent` is on — handed to the parent agent as image content blocks: in the `delegate_task` result for foreground runs, or appended to the parent's next tool result (same path as inbox mail) for background runs. It no longer posts a `**label:**` `mediaMessage` into the parent chat.
- Images over 1568 px on the long side are downscaled for the agent copy only (the store keeps the original).
- Toggles: `chats.toolImages` (UI: thumbnails on tool rows), `chats.subagentImageStrip` (UI: strip on the finished subagent row), `agents.imagesToParent` (engine).
