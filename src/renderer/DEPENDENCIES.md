# Renderer dependencies

Merge these into the root `package.json` of Unify, then delete the temporary
`src/renderer/package.json`, `package-lock.json` and `node_modules/` (all gitignored).
Versions are the ones the renderer was built and tested with.

## dependencies

| Package | Version | Why |
| --- | --- | --- |
| `solid-js` | ^1.9.3 (tested 1.9.20) | UI framework (signals, `render`, `<For>`, `<Show>`...) |
| `markdown-it` | ^14.1.0 (tested 14.3.3) | Assistant message markdown (`screens/chats/markdown.ts`), same parser family as DSH |
| `@fontsource/space-mono` | ^5.3.0 | UI font, bundled locally (`theme/ui-font.ts`) |
| `@fontsource/jetbrains-mono` | ^5.3.0 | Mono font for code, diffs, commands (`theme/fonts.ts`) |
| `monaco-editor` | ^0.52.2 | Files screen code editor (`screens/files/monaco.ts`, lazy-loaded). Workers use Vite `?worker` imports, no plugin or CDN, so the app CSP (`'self'`) is enough |

## devDependencies

| Package | Version | Why |
| --- | --- | --- |
| `vite` | ^6.0.3 (tested 6.4.6) | Dev server (port 5173) and build (`vite.config.ts`, outDir `dist/renderer`) |
| `vite-plugin-solid` | ^2.11.0 | Solid JSX transform |
| `typescript` | ^5.7.2 | Type checking (`tsc --noEmit -p src/renderer/tsconfig.json`) |
| `@types/markdown-it` | ^14.1.2 | Types for markdown-it |
| `@types/node` | ^22.10.0 | `vite.config.ts` and `tools/shot.mjs` |

## Scripts to add

```json
{
  "dev:renderer": "vite --config src/renderer/vite.config.ts",
  "build:renderer": "vite build --config src/renderer/vite.config.ts",
  "typecheck:renderer": "tsc --noEmit -p src/renderer/tsconfig.json",
  "shot": "node src/renderer/tools/shot.mjs"
}
```

## Notes

- `tools/shot.mjs` uses Node's built-in `WebSocket` (Node 22+) and an installed Microsoft Edge; it has no npm deps of its own.
- The Inter text styles in Figma are not bundled: the UI font was switched to Space Mono (`theme/ui-font.ts`). If Inter comes back, add `@fontsource-variable/inter` and import it there.
