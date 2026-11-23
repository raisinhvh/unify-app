# Unify

Unify is the desktop successor to the DSH VS Code extension. It runs the whole
DeepSeek Harness agent engine — the same chats, accounts, models, rules, memory,
toolpacks, summaries and review flow — inside Electron, with a new native shell
and UI.

The engine in `src/engine/` is DSH's `src/` unchanged apart from small, documented
changes. It is compiled against `src/shim/vscode/`, a `vscode` API implementation
that maps the extension's host services onto Electron: the current project folder,
JSON settings and state, the OS keychain, dialogs, output channels and the
sidebar webview.

## Run from source

On Windows:

```bat
run.cmd
```

On macOS and Linux:

```sh
chmod +x run.sh
./run.sh
```

Both scripts install dependencies when `node_modules` is missing, build the
engine, main and preload bundles with esbuild, start the Vite dev server when
`src/renderer/vite.config.ts` exists, and launch Electron. Engine changes rebuild
and restart the app. Without a new renderer the app loads DSH's own sidebar HTML,
so it always runs.

Set `UNIFY_LEGACY=1` to force that legacy sidebar. Pass `--project <folder>` to
open a different working folder, and `--screenshot <path>` to save a PNG of the
window after startup.

## Build the installer

```sh
npm run dist
```

`electron-builder` writes the Windows NSIS installer and portable executable to
`release/` (macOS `dmg` and Linux `AppImage` via `npm run dist:mac` and
`npm run dist:linux`). The installer is a normal wizard: choose the folder,
desktop shortcut and Start menu entry.

## Tests

```sh
npm test
```

This compiles the engine's test modules and runs DSH's test suite (301 tests).

## Data

Unify shares `~/.dsh` with DSH: accounts, rules, memory, toolpacks, chats and
settings stay in one place. On first launch it imports DSH state from VS Code
(`globalStorage/state.vscdb` and the extension's global storage folder), so
existing accounts carry over. Secrets held in VS Code's encrypted secret storage
cannot be decrypted outside VS Code; the setup status lists the accounts that
need signing in again.

Unify's own files live in `~/.dsh/unify/` (`settings.json`, `state.json`,
`secrets.json`, `renderer-state.json`, `logs/`). Secrets are encrypted with
Electron `safeStorage`.

## License

MIT. Copyright (c) 2026 raisinhvh.
