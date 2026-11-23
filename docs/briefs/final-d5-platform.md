# D5: platform — GitHub sign-in, editor bridge, app updater, main wiring, Mac readiness (Deepseek)

Read `docs/briefs/final-common.md` first and follow it. Background: `docs/briefs/ds-platform-verification.md` (last round's brief for these folders).

## Task
1. **GitHub sign-in** (user decision: `gh` CLI token first, else a pasted personal access token; no device flow).
   - New module `src/engine/unify/github.ts`:
     ```ts
     export interface GithubAuth { token: string; login: string; source: 'gh' | 'token' }
     export async function getGithubAuth(): Promise<GithubAuth | undefined>;
     export async function setGithubToken(token: string): Promise<GithubAuth>;   // validates with GET https://api.github.com/user, throws a clear error if invalid
     export async function clearGithubToken(): Promise<void>;
     export function onGithubAuthChange(listener: (auth: GithubAuth | undefined) => void): () => void;
     ```
     - `gh` path: run `gh auth token`, with a 5 s timeout and no shell. On a missing binary or a non-zero exit, fall back to the pasted token.
     - Validate the token with `GET /user` to get the login. Cache the result for 10 min.
     - Store the pasted token with Electron `safeStorage` if the shim offers a secret store (check the shim's `context.secrets`). Otherwise store it in `<unifyHome()>/github-token` with user-only file permissions. Never log it.
     - User-Agent `unify`.
   - In the shim: wherever `vscode.authentication.getSession('github', …)` is implemented (it returns `undefined` today), return a session from `getGithubAuth()` (`accessToken`, `account.label` = login). This makes Settings → Sync and Hub publishing work.
2. **Editor bridge** (user decision: back the editor stubs with the Files editor). Contract in `src/engine/sidebar/view.ts`:
   - UI → engine: `editorState`.
   - Engine → UI: `editorOpen`, `editorDiff`.
   - In the shim:
     - `window.activeTextEditor`, `visibleTextEditors`, `tabGroups` and the change events mirror the latest `editorState`. Provide a minimal `TextDocument` (`uri`, `fileName`, `languageId` from the extension, `getText()` reading from disk, `lineCount`), and selection from the message.
     - `window.showTextDocument(uri, { selection })` posts `editorOpen`.
     - `commands.executeCommand('vscode.diff', left, right, title)` posts `editorDiff`.
     - Find how the shim sends messages to the renderer (the webview `postMessage` path) and receives `editorState`. If you need a hook in `extension.ts` / `sidebar/provider.ts`, write it under "Hooks for other owners".
   - The engine's `runtime/editorContext.ts` reads `activeTextEditor`, so agents get current-file context again. Check that it works with your objects.
3. **App updater** (spec: "Auto-update via electron-updater from GitHub Releases"; user: drop the VSIX self-updater):
   - Add `electron-updater` to `package.json` dependencies.
   - New `src/main/updater.ts`:
     - check `raisinhvh/unify` GitHub Releases on startup (after 10 s) and every 6 h, packaged builds only;
     - download in the background;
     - when ready, show one notification through the existing `window.unify.notify` / main-process Notification path ("Unify <version> is ready. Restart to update.") with a restart action if the notification path supports actions;
     - log errors and never show them (the repo is private until release).
   - Expose `unify:check-for-updates` IPC for a Settings button, and preload it as `window.unify.checkForUpdates()`.
   - Don't delete `update/extensionUpdate.ts` yourself; `extension.ts` still imports it. Add the removal hook to your report.
4. **Main wiring:** in `src/main/index.ts`, call `registerMediaSchemes()` (before ready) and `installMediaProtocol()` (after ready) from `src/main/mediaProtocol.ts`. Another agent is writing that file now; if it doesn't exist yet when you build, create a stub with exactly those two exported functions that throws `not implemented`, and say so.
5. **Mac readiness** (user: Windows only for now, but anticipate Mac). Audit `src/main/`, `src/preload/`, `src/shim/`, `scripts/` and `electron-builder.yml` for Windows-only assumptions:
   - `\` paths;
   - `.cmd` / `.exe` without a platform check;
   - the menu (macOS needs the app menu with Quit/Hide and an Edit menu so copy/paste work);
   - `Ctrl` shortcuts that should be `CmdOrCtrl`;
   - the title bar (`titleBarStyle: 'hiddenInset'` and traffic lights on mac);
   - the `window-all-closed` behaviour;
   - icon formats.

   Fix what's safe. Make sure `electron-builder.yml` has a working mac target (dmg + zip, arm64 + x64, `.icns` icon, an unsigned placeholder signing slot).
6. **Cleanup:**
   - Delete these `%TEMP%` folders: `unify-work`, `unify-dump`, `unify-npm-cache`, `unify-electron-cache`, `unify-shot-edge-profile`, and any `dsh-*\unify-work`. The user approved this.
   - Check `scripts/dump-state.mjs` and `scripts/inspect-state.mjs`. Delete them if nothing references them and they were one-off debugging; keep `set-font`. Report what you did.
7. Rerun `npm test` and `npm run build` (the last round's "requests.ts missing" blocker is fixed), then `npm run dist` (Windows NSIS + portable, unsigned). Report the artifacts in `release/` and their sizes.

## Files you own
- `src/shim/`
- `src/main/` (except `mediaProtocol.ts`)
- `src/preload/`
- `src/engine/unify/github.ts` (new)
- `package.json` and `package-lock.json`
- `electron-builder.yml`
- `build/`
- `scripts/`
- `run.cmd`, `run.sh`

## Reference for style
`src/shim/vscode/` (the existing shim files).

## Extra checks
- `npm run build` prints BUILD_OK.
- `npm test` totals.
- The `npm run dist` result.
- Stop any electron process you started.
