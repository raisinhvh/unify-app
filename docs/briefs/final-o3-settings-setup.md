# O3: Settings screen + Setup wizard (Opus)

Read `docs/briefs/final-common.md` and `docs/briefs/final-o-common.md` first. Vite port **5183**.

## Task
1. **Settings** (`docs/briefs/ds-settings.md`): `src/renderer/screens/settings/`. It's partly built; continue from what's there.
   - `catalog.ts` 88 is missing the `Power` group. Add it, plus the new features already in `store/features.ts`:
     - `agents.explorerRanges`
     - `tools.rangeEdits`
     - `chats.showYourWork`
     - `chat.friendlyInternalRows`
     - `power.*`
   - **Settings → Power:**
     - the "Shut down when all tasks finish" switch, with a one-line explanation;
     - "Stay armed after restart";
     - while it's armed, the current status from `viewState.shutdown`.
   - **GitHub sign-in row** (Settings → Sync, or a new Accounts → GitHub row, whichever matches the existing sections best):
     - shows `viewState.github`: signed in as `<login>`, from the GitHub CLI or a pasted token;
     - when signed out: a field to paste a personal access token (posts `{ type: 'githubSetToken', token }`), a "Check GitHub CLI again" text button (`githubRefresh`), and one short line on how to make a token (scopes `repo`, `read:user`);
     - when signed in with a pasted token: "Sign out" (`githubSignOut`);
     - `viewState.github.error` shows inline, calmly.
   - **Updates:** a "Check for updates" text button that calls `window.unify.checkForUpdates?.()`. Hide it when that function isn't there.
   - **Data folder row** (`SettingsScreen.tsx` 356): `~/.unify`, with no "Shared with DSH" caption.
   - No dot separators: `SettingsScreen.tsx` 234/322/326 and `ThemePicker.tsx` 16/22.
   - Model fields (decider model, Smart Auto ranks, subagent profile models): keep the current controls. The ModelPicker replaces them next wave. Mark each with `// model-picker:` so it's easy to find.
   - When done, delete `screens/settings/__ref_tmp__/`.
2. **Setup wizard** (`docs/briefs/ds-setup-wizard.md`): `src/renderer/screens/setup/`.
   - `setupState.ts` fails tsc because `ToolStatus.state` is typed as `string`. `adapters.ts` 109/118 has the same problem. `SidebarDependency` is now exported from `protocol.ts`.
   - There's no `SetupWizard.tsx` yet; build it.
   - **Remove the "Import from DSH" step** (`adapters.ts` 127 and the step UI). Unify has no import from DSH.
   - Export `shouldShowSetup()` and `SetupWizard`. The wiring wave mounts it over Home.
   - Model choice in the wizard: use a plain control marked `// model-picker:` for now.

## Files you own
- `src/renderer/screens/settings/`
- `src/renderer/screens/setup/`
- new files under `src/renderer/dev/` whose names start with `o3-` or `screens-o3`

## Reference for style
`src/renderer/screens/providers/`.

## Screenshots
Save the finals to each screen's `__screens__/` folder, in Walnut Dark and Walnut Light:
- Settings: every section, with the Power and GitHub rows in both signed-in and signed-out states.
- Setup: every wizard step.

Compare them against Figma frames 26 (setup) and the Settings frames.
