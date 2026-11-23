---
name: unify
description: Unify (Electron successor of DSH) — where the spec lives, who builds what, tooling rules
type: project
---

- Spec, decisions and visual/motion rules: `docs/UNIFY_SPEC.md`. Read it before any Unify work; update it when the user decides something. Open work: `TODO.md`.
- Frontend (Figma screens, renderer UI, animation) goes to Opus (no Cursor subagent). All engine, backend and wiring code goes to Deepseek. Opus-family models (main agent included) never write backend code (global rule in workflow/delegation).
- Preserve DSH's agentic behaviour; the user tuned it. Restyle, don't reinvent. Engine = DSH `src/` copied into `src/engine/`.
- Motion QA: `.dsh/tools/motion-audit.mjs`.
- Font changes: never hand-edit families. App: `scripts/set-font.mjs`; Figma: `.dsh/tools/figma-swap-font.js`. UI font Space Mono; code font JetBrains Mono stays fixed.
- Shared contracts (one owner each): `src/renderer/store/features.ts`, `src/engine/unify/settings.ts`, `src/engine/unify/agentBus.ts`.
