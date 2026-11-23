YOUR FILE LOCKS: ["unify-renderer/screens/files/","unify-renderer/package.json","unify-renderer/package-lock.json","unify-renderer/DEPENDENCIES.md"]

You ARE the implementation subagent: Unify FILES + EDITOR screen owner.

Working copy: DSH (C:/Users/User/Documents/Projects/AI Stuff/Programs/DSH). `unify-renderer/` is a junction to ../Unify/src/renderer (SolidJS + TS + Vite). Run tsc/vite from the REAL path `C:/Users/User/Documents/Projects/AI Stuff/Programs/Unify/src/renderer`.

An Opus agent started this and was stopped mid-way; its partial work is on disk in `unify-renderer/screens/files/` (FilesScreen, FilesPanel, FilesEditor, monaco.ts, adapter.ts, state.ts, preview entry…). Your original brief is `.dsh/briefs-tmp/b4.md` — read it completely; it still applies, EXCEPT the Knowledge screen is now another agent's job: you do Files + Editor only (Figma frame '20 · Files + Editor'). First read every file already in screens/files/, keep what's good, finish the rest, fix what's broken. WRITE only `screens/files/`, renderer `package.json`/`package-lock.json`/`DEPENDENCIES.md`. 12 other agents work in parallel.

Contract change: feature toggles via `feature(id)` from store/features.ts (engine state field is now `viewState.unifyFeatures`). Put the exact engine message types you need in `screens/files/protocol-requests.md` (a backend agent implements them from that file — keep it current and precise, request/reply TS types, include a `requestId` for request/reply pairs).

Definition of done: `FilesScreen` exported from screens/files/FilesScreen.tsx; tree with guide lines, tabs, Monaco themed from theme variables for all 7 themes, code font var(--font-mono), agent-edited files marked, editor.enabled/editor.minimap honoured; `// organic:` comments where renames/creates/deletes should animate; your files typecheck clean (ignore errors outside your folder); preview via vite dev, screenshots via CDP (`tools/shot.mjs`), compared against Figma (figma_capture_view on that frame) and fixed for clipping/overflow with the Space Mono UI font, checked in Walnut Dark + Walnut Light. Keep 1–2 final screenshots in screens/files/__screens__/, delete temp images. Stop vite/browsers. No git commits. Don't write memory.

Report: files, exported components, protocol requests (exact TS types), screenshot paths, deviations from Figma.