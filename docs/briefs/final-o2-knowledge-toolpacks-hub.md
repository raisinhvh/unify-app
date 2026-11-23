# O2: Knowledge, Toolpacks and Toolpack Hub screens (Opus)

Read `docs/briefs/final-common.md` and `docs/briefs/final-o-common.md` first. Vite port **5182**.

## Task
Build the three screens in these briefs. Earlier attempts left partial work on disk; continue from it, and don't start over unless it's unusable.
1. **Knowledge** (`docs/briefs/ds-knowledge.md`): `src/renderer/screens/knowledge/`. There's no `KnowledgeScreen.tsx` yet. `adapter.ts` has tsc errors at 171/183/206/229, where its request shapes don't match `protocol-requests.md`. Make the adapter match the real request shapes that `src/engine/unify/requests/` handles. Those are the truth; read that folder.
2. **Toolpacks** (`docs/briefs/ds-toolpacks.md`): `src/renderer/screens/toolpacks/`. `ToolpacksScreen.tsx` fails tsc: `groupTools` and `hasTools` are missing, and the `<Show>` at 264 has a typing error.
3. **Toolpack Hub** (`docs/briefs/ds-toolpack-hub.md`): `src/renderer/screens/hub/`. Only the adapter, mock and protocol-requests exist, so build `HubScreen.tsx`. `hubMock.ts` 34 is missing `description`.
   - Publishing is limited to approved accounts. When the engine refuses ("Publishing is limited to approved accounts."), the publish flow shows that message calmly. It isn't an error toast.
   - Publish needs GitHub sign-in: `viewState.github` (`signedIn`, `login`). When signed out, the publish area says "Sign in to GitHub in Settings to publish" and links to Settings.

## Rules for this task
- No dot separators. `toolpacks.css` 90 (`content: '·'`) and the meta strip in `ToolpacksScreen.tsx` must use layout instead.
- Provider glyphs: keep using the existing `screens/toolpacks/glyphs.ts` for now. Another agent moves every glyph to `components/ProviderGlyph.tsx` next wave.
- No "DSH" in sample data. The mock workspace and sample project use a neutral sample (`acme-app`, for example).
- Don't wire the screens into `screens/index.tsx` or `router.ts`; the wiring wave does that. Preview them through the mock bridge or a dev entry under `src/renderer/dev/` (create `dev/screens-o2.tsx` if you need one).

## Files you own
- `src/renderer/screens/knowledge/`
- `src/renderer/screens/toolpacks/`
- `src/renderer/screens/hub/`
- new files under `src/renderer/dev/` whose names start with `o2-` or `screens-o2`

## Reference for style
`src/renderer/screens/providers/` (reviewed and matches Figma).

## Screenshots
Save the finals to each screen's `__screens__/` folder, in Walnut Dark and Walnut Light. Compare each against its Figma frame.
