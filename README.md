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

## Publish a release

Versions are written `VX.Y` (stored in `package.json` as `X.Y.0`, since Electron
and the updater need semver). One command does the whole release:

```sh
npm run release -- V1.1
```

It sets the version, runs the tests, builds, packages `Unify-Setup-VX.Y.exe` and
`Unify-VX.Y-Portable.exe`, commits the working tree, tags `VX.Y`, pushes to
`main` of the repository in `package.json` (`raisinhvh/unify-app`, created if
missing) and creates the GitHub release with the installer, portable exe,
blockmap and `latest.yml`. Installed copies update from that release.

Options: `--notes "text"` (default: commit subjects since the last tag),
`--skip-tests`, and `--dry-run` (build only; nothing is committed or uploaded).
Needs the GitHub CLI signed in (`gh auth login`).

## Tests

```sh
npm test
```

This compiles the engine's test modules and runs DSH's test suite (301 tests).

## Data

Unify keeps its data in `~/.unify` (or `UNIFY_HOME`) and doesn't read or write
DSH's `~/.dsh`: `settings.json`, `state.json`, `secrets.json`,
`renderer-state.json`, `logs/`, global rules (`AGENTS.md`) and memory
(`memory/`), and `storage/` (accounts, toolpacks, usage log, summaries).
Secrets are encrypted with Electron `safeStorage`. Per-project data lives in
the repo's `.unify/` folder.

## License

MIT. Copyright (c) 2026 raisinhvh.
