YOUR FILE LOCKS: ["unify-renderer/screens/setup/"]

You ARE the implementation subagent: Unify SETUP WIZARD owner.

Working copy: DSH (C:/Users/User/Documents/Projects/AI Stuff/Programs/DSH). `unify-renderer/` is a junction to ../Unify/src/renderer (SolidJS + TS + Vite). Run tsc/vite from the REAL path `C:/Users/User/Documents/Projects/AI Stuff/Programs/Unify/src/renderer`.

An Opus agent started this and was stopped mid-way; its partial work is on disk in `unify-renderer/screens/setup/` (adapters.ts, setupState.ts — currently a typecheck error: a ToolStatus `state` typed as string instead of ToolState). Your original brief is `.dsh/briefs-tmp/b6.md` — read it completely; it still applies, EXCEPT Settings is another agent's job: you do the first-run Setup wizard only (Figma '26a'–'26f · Setup · Welcome / Providers / Project folder / Tools check / Optional extras / Done'). Required: one working provider account, a project folder (`window.unify.pickFolder()`), CLI tools check with fix buttons; everything else optional/skippable. Welcome = 'The last AI interaction interface you ever install' + Get started. Home IS the background: the wizard is a layer over it, never its own backdrop. WRITE only `screens/setup/`. Protocol requests into `screens/setup/protocol-requests.md` (exact request/reply TS types with `requestId`: tools check + fix, project folder default, setup-complete flag). 12 other agents work in parallel.

Contract change: feature toggles via `feature(id)` / `setFeature(id, value)` from store/features.ts.

Definition of done: `SetupWizard` exported from screens/setup/SetupWizard.tsx plus a `shouldShowSetup()` helper; steps slide/crossfade with springs, interruptible; foundation motion helpers only; dev preview entry in your folder that shows it over the Home background; typecheck clean for your files; screenshots via CDP (`tools/shot.mjs`) of every step, compared with Figma (figma_capture_view), fixed for clipping with Space Mono, Walnut Dark + Walnut Light. Keep 1 screenshot per step in screens/setup/__screens__/, delete temp images. Stop vite/browsers. No git commits. Don't write memory.

Report: files, exported components, protocol requests, Shell wiring instructions (how/when the Shell shows the wizard), screenshot paths, deviations.