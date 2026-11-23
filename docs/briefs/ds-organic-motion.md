YOUR FILE LOCKS: ["unify-renderer/motion/organic/","unify-renderer/organic-gallery.html"]

You ARE the implementation subagent: Unify ORGANIC MOTION owner.

Working copy: DSH (C:/Users/User/Documents/Projects/AI Stuff/Programs/DSH). `unify-renderer/` is a junction to ../Unify/src/renderer (SolidJS + TS + Vite). Run tsc/vite from the REAL path `C:/Users/User/Documents/Projects/AI Stuff/Programs/Unify/src/renderer`.

An Opus agent started this and was stopped mid-way (last edits ~02:20 today); its partial work is on disk in `unify-renderer/motion/organic/` (15 files). Your full original brief is `docs/briefs/b3.md` — read it completely; it still applies. First read every file already in motion/organic/, keep what's good, finish what's missing, fix what's broken. WRITE only `unify-renderer/motion/organic/` and `unify-renderer/organic-gallery.html`. 12 other agents work in parallel on other folders.

Contract change since that brief: feature toggles are read with `feature(id)` from `store/features.ts` (the engine state field is now `viewState.unifyFeatures`; just use the helper).

Definition of done: every primitive in the brief exists and is exported from motion/organic/index.ts; your files typecheck clean (`npx tsc --noEmit -p .` from the real path; ignore errors in files outside motion/organic/); the gallery runs under vite dev; you captured frames via CDP (see `tools/shot.mjs`), LOOKED at them, fixed clipping/caret misalignment/jumps; ran `.dsh/tools/motion-audit.mjs` on the gallery. Keep 1–3 final screenshots in motion/organic/__screens__/, delete other temp images. Stop vite/browsers. No git commits. Don't write memory.

Report: files, public API (props/signatures), timing constants, audit result, screenshot paths, where each primitive should be wired (component + file).