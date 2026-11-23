# Final round: rules for the frontend (Opus) agents

Read `docs/briefs/final-common.md` first. These rules are added on top of it.

## Look and motion
- Read the spec's Visual rules and Motion sections (`docs/UNIFY_SPEC.md`).
- Read the motion skill: `C:\Users\User\AppData\Roaming\Code\User\globalStorage\dsh-local.dsh-ide\oauth\claude-cli\0ed19977-7119-4a05-86e1-210a0ab6b9c1\skills\apple-design\SKILL.md`.
- Use the renderer's own spring engine (`src/renderer/motion/`). No CSS keyframes, no new animation library.
- Springs are interruptible: retarget from the current value, never restart. Reduced motion falls back to a crossfade.
- The visual language:
  - File-system look: trees with guide lines; detail views read like an open file.
  - Walnut themes, monochrome accent `#EFE6DA`.
  - No pill buttons, no glow, no sparkles.
  - No dot separators (`·`, `•`, `∙`) and no `|`, `/` or `—` used in their place. Use muted second parts, separate cells, or spacing.
  - Fonts: `var(--font-ui)` (Space Mono) and `var(--font-mono)`. Never write a family name.
- Figma is the source of truth: page "Unify" (screens 10–27). Use the Figma toolpack tools (`figma_*`) if your profile has them. If it doesn't, say so in your report and work from the existing code and screenshots.

## Feature toggles
Every new UI piece sits behind the toggle the brief names. Read it with `feature(id)` from `src/renderer/store/features.ts`. When the toggle is off, the UI hides cleanly, leaves no gap, and changes live.

## Preview
- Use `src/renderer/tools/shot.mjs` and the mock bridge (`src/renderer/dev/`). If you have Studio-like preview tools, they don't apply; this is a web renderer.
- Use the vite port your brief gives you, so agents running in parallel don't collide.
- Screenshot in Walnut Dark and Walnut Light at least. Look at every screenshot yourself: check for clipped or overflowing text, wrapping, misalignment and empty gaps. Fix problems before you report.
- Motion: run `.dsh/tools/motion-audit.mjs` on what you animated, and fix snaps, layout jumps and restarts.
- Keep only the final screenshots, in the folder your brief names. Delete every other temp image.

## Report
- Files changed.
- What each toggle hides.
- Screenshot paths.
- Motion-audit results.
- Hooks for other owners.
