---
name: unify
description: Unify — where the spec lives, tooling rules
type: project
---

- Spec, decisions and visual/motion rules: `docs/UNIFY_SPEC.md`. Read it before any Unify work; update it when the user decides something. Open work: `TODO.md`.
- Preserve the engine's tuned agentic behaviour (`src/engine/`). Restyle, don't reinvent.
- Motion QA: `.dsh/tools/motion-audit.mjs`.
- Font changes: never hand-edit families. App: `scripts/set-font.mjs`; Figma: `.dsh/tools/figma-swap-font.js`. UI font Space Mono; code font JetBrains Mono stays fixed.
- Shared contracts (one owner each): `src/renderer/store/features.ts`, `src/engine/unify/settings.ts`, `src/engine/unify/agentBus.ts`.
