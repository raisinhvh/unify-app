YOUR FILE LOCKS: ["unify-renderer/screens/knowledge/"]

You ARE the implementation subagent: Unify KNOWLEDGE screen owner.

Working copy: DSH (C:/Users/User/Documents/Projects/AI Stuff/Programs/DSH). `unify-renderer/` is a junction to ../Unify/src/renderer (SolidJS + TS + Vite). Run tsc/vite from the REAL path `C:/Users/User/Documents/Projects/AI Stuff/Programs/Unify/src/renderer`.

An Opus agent started this and was stopped mid-way; its partial work is on disk in `unify-renderer/screens/knowledge/` (KnowledgePanel.tsx, Segmented.tsx, adapter.ts, state.ts, a Figma reference png). Your original brief is `.dsh/briefs-tmp/b4.md` — read it completely; it still applies, EXCEPT the Files screen is another agent's job: you do Knowledge only (Figma frame '21 · Knowledge'). First read what's on disk, keep what's good, finish the rest. WRITE only `screens/knowledge/`. If you need an npm package, don't install it — say so in the report. 12 other agents work in parallel.

Contract change: feature toggles via `feature(id)` from store/features.ts (knowledge.audiences, knowledge.agentWrites). Put the exact engine message types you need in `screens/knowledge/protocol-requests.md` (a backend agent implements them from that file; request/reply TS types with `requestId`).

Definition of done: `KnowledgeScreen` exported from screens/knowledge/KnowledgeScreen.tsx; tree of rules/skills/memory as files; detail reads like an open file (breadcrumb, title, plain sections, hairlines); audience selector; add / import skill folder (drag-in); edit in place; agent changes show with open/undo; `// organic:` comments where renames/creates/deletes should animate; foundation motion helpers only; dev preview entry inside your folder; typecheck clean for your files; screenshots via CDP (`tools/shot.mjs`), compared with Figma (figma_capture_view), fixed for clipping with the Space Mono font, Walnut Dark + Walnut Light. Keep 1–2 screenshots in screens/knowledge/__screens__/, delete temp images. Stop vite/browsers. No git commits. Don't write memory.

Report: files, exported components, protocol requests, screenshot paths, deviations from Figma.