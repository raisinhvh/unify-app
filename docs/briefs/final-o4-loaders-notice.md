# O4: Loaders that morph into each other, and the top notice restyle

Read `docs/briefs/final-o-common.md` first (rules, preview tools, fonts, themes, Figma access, cleanup). Preview port: **5184**. Put dev preview entries in `src/renderer/dev-o4/`; you may import `../dev/mockBridge` but don't edit it.

## Context
- Loaders live in `src/renderer/components/loaders/`. `Loader.tsx` already morphs between loader ids: shared cell keys glide, outgoing-only cells shrink and fade, incoming-only cells pop in. `actions.ts` maps agent actions to loader ids (from Figma's root pluginData `unifyLoadersByAction`). `ChatLoader.tsx` is the chat-row status glyph.
- Figma file: the Unify design file (see `final-o-common.md`). The boards are "Loaders", "01 · subagents" and "03 · Loaders · by action".

## User decisions (final, don't re-ask)
1. **Running glyph:** in the Figma "01 · subagents" loaders, the "running" status glyph doesn't fit. Replace it with one drawn in the same language as the **02 loader glyph** (same cell grid, stroke weight and rhythm). Do it in Figma first, then in code (the subagent running state in the renderer uses whatever glyph that board defines; find it with `rg -n "running" src/renderer/components src/renderer/screens/chats`, but don't edit `screens/chats/`, which another agent owns; if the change needs a chats edit, put the exact patch in your report).
2. **VERY IMPORTANT — seamless morphs.** Every loader must blend into every other loader when the action changes. No hard cuts and no plain crossfade swap (reduced motion is the only exception). Today, pairs that share few cell keys degrade to "everything shrinks out, everything pops in", which reads as a swap. Fix that at the system level:
   - Give every loader the same cell budget and a stable key scheme, so any pair can match cell to cell (e.g. match the leftover cells by nearest position, so every outgoing cell travels to an incoming cell instead of vanishing).
   - Drive the morph with a spring (`motion/` springs the project already uses; follow the apple-design skill: response ~0.35, damping 1.0, no overshoot). Interrupting mid-morph must continue from the current on-screen cells, never restart.
   - Colour/opacity morph on the same curve as position.
   - Also cover state changes: loader → done check, loader → idle, idle → loader in `ChatLoader`.
   - Build a dev page that cycles through all action pairs (and a rapid-interrupt mode) and capture a filmstrip (several frames mid-morph) for at least 6 diverse pairs. Look at the frames yourself; a morph passes only if every frame mid-way looks like a deliberate in-between shape.
   - Run `.dsh/tools/motion-audit.mjs` on that page.
3. **Top notice restyle.** The "red notification at the top" is Unify's DSH-style rounded-pill notice shown at the top of the app (likely the engine error / notice banner in the Shell or TitleBar; find it with `rg -n "notice|engineError|banner|toast" src/renderer --glob "!screens/**"` and by looking at the running app in the mock bridge). The user thinks it looks horrendous. Redesign it in Unify's style: no pill, square-ish corners like the rest of the app, Space Mono, calm colours from the theme (error tone only on an icon/accent, not a red slab), one line with an optional action and dismiss. Draw it in Figma first (frame next to the other app chrome), then build it. It enters and leaves with a spring (slide a few px + fade, height animated so content below doesn't jump). Stack/replace behaviour: a new notice replaces the old one with a morph, not a second pill.

## You own
- `src/renderer/components/loaders/`
- the notice component and its CSS (wherever it lives outside `screens/`; if it's inline in `Shell`/`TitleBar`, extract it to `src/renderer/components/Notice.tsx` + `notice.css` and you own those plus the minimal call-site edit in the Shell/TitleBar)
- `src/renderer/dev-o4/`
- Figma frames for the loaders and the notice

## Verify
- Renderer tsc clean for your files (`npx tsc --noEmit -p .` from `src/renderer`; the only allowed error is `../engine/runtime/dependencies.ts(71,33)` and errors in folders other agents own).
- Screenshots: notice in Walnut Dark and Walnut Light; loader filmstrips. Save the final ones in `src/renderer/components/loaders/__screens__/` and list them in your report.
- Clean up: stop vite/Edge, delete temp audit output.
