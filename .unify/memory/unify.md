---
name: unify
description: Unify — where the spec lives, tooling rules
type: project
---

- Spec, decisions and visual/motion rules: `docs/UNIFY_SPEC.md`. Read it before any Unify work; update it when the user decides something. Open work: `TODO.md`.
- Preserve the engine's tuned agentic behaviour (`src/engine/`). Restyle, don't reinvent.
- Hub pack sources (setup.json, install scripts, pack.ts) live in the sibling repo `../unify-hub`, not here; its README documents the setup.json schema.
- UI previews: `node src/renderer/tools/shot.mjs <fixture>` (fixtures in `src/renderer/tools/fixtures`); a blank shot is usually timing — rerun with `--wait 4000`.
- Motion QA: `.unify/tools/motion-audit.mjs`.
- Real-engine repro beside the user's running app: copy `~/.unify/{settings,state,providers,setup}.json` (not secrets) to a temp home, then `env -u ELECTRON_RUN_AS_NODE UNIFY_HOME=<tmp>\home UNIFY_DEV=1 node_modules/electron/dist/electron.exe . --user-data-dir=<tmp>\ud --remote-debugging-port=9334` (needs vite on 5173). The shell has ELECTRON_RUN_AS_NODE set; a separate user-data-dir bypasses single-instance. Drive it with `.unify/tools/cdp-eval.mjs`. The browser mock hides IPC clone errors.
- Font changes: never hand-edit families. App: `scripts/set-font.mjs`; Figma: `.unify/tools/figma-swap-font.js`. UI font Space Mono; code font JetBrains Mono stays fixed.
- Shared contracts (one owner each): `src/renderer/store/features.ts`, `src/engine/unify/settings.ts`, `src/engine/unify/agentBus.ts`.
