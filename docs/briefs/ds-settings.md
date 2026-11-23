YOUR FILE LOCKS: ["unify-renderer/screens/settings/"]

You ARE the implementation subagent: Unify SETTINGS screen owner.

Working copy: DSH (C:/Users/User/Documents/Projects/AI Stuff/Programs/DSH). `unify-renderer/` is a junction to ../Unify/src/renderer (SolidJS + TS + Vite). Run tsc/vite from the REAL path `C:/Users/User/Documents/Projects/AI Stuff/Programs/Unify/src/renderer`.

An Opus agent started this and was stopped mid-way; its partial work is on disk in `unify-renderer/screens/settings/` (SettingsScreen.tsx, SettingControls.tsx, ThemePicker.tsx, PageStack.tsx, catalog.ts, adapters.ts, settings.css, and Figma reference images in `__ref_tmp__/`). Your original brief is `docs/briefs/b6.md` — read it completely; it still applies, EXCEPT the Setup wizard is another agent's job: you do Settings only (Figma '25 · Settings', '25b · Themes'). First read what's on disk, keep what's good, finish the rest. WRITE only `screens/settings/`. Protocol requests go into `screens/settings/protocol-requests.md` (exact request/reply TS types with `requestId`). 12 other agents work in parallel.

Contract change since that brief: write toggles ONLY through `setFeature(id, value)` from store/features.ts (it now posts `setUnifyFeature`; the engine mirrors values as `viewState.unifyFeatures`; read with `feature(id)`). Don't post 'setFeature' yourself — that name is DSH's own older toggle message.

Definition of done: `SettingsScreen` exported from screens/settings/SettingsScreen.tsx; UI generated from `featureDefinitions` (grouped, searchable, boolean → Toggle, options → Select, number → stepper), Appearance with the 7-theme picker (animated colour crossfade, reuse theme/), Accounts shortcuts, About/updates; no gaps when features are off; foundation motion helpers only; dev preview entry in your folder; typecheck clean for your files; screenshots via CDP (`tools/shot.mjs`) of several groups, search active, theme picker, compared with Figma (figma_capture_view), fixed for clipping with Space Mono, Walnut Dark + Walnut Light. Delete `__ref_tmp__/` when done; keep 1–2 screenshots in screens/settings/__screens__/. Stop vite/browsers. No git commits. Don't write memory.

Report: files, exported components, protocol requests, screenshot paths, deviations.