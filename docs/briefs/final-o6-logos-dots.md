# O6: Provider logos and no dot separators

Read `docs/briefs/final-o-common.md` first (rules, preview tools, fonts, themes, Figma access, cleanup) and the spec sections "Provider logos look like the real brand" and Visual rules "No dot separators" in `docs/UNIFY_SPEC.md`. Preview port: **5186**. Put dev preview entries in `src/renderer/dev-o6/`.

## Part A: provider logos
- Move the glyphs from `screens/providers/glyphs.tsx` to `src/renderer/components/ProviderGlyph.tsx` (export `ProviderGlyph`, `providerGlyph`, `providerGlyphs`, `ProviderGlyphName`), export it from `components/index.ts`, and update every importer (`rg -n "providers/glyphs|from './glyphs'" src/renderer`). Delete the old file.
- Redraw each mark so it reads as the real brand, in one matched single-colour style (currentColor, same optical weight and padding): Anthropic (A\), OpenAI (knot), Gemini (spark), Mistral (M), Cursor (cube), OpenCode, self-hosted (generic server). Draw them in Figma first (a "Provider glyphs" frame), then export the paths.
- Point Providers, Toolpacks and the ModelPicker (if present in `components/ModelPicker.tsx`) at it.
- Verify at 12/16/24 px in all 7 themes as one contact sheet; look at it yourself.

## Part B: remove dot separators
Rework every UI `·`, `•` or `∙` with layout, not another glyph: a muted second part, separate cells, label/value rows or spacing. Ignore code comments and Figma frame names.
1. **Figma first:** `figma_find` every TEXT node containing those characters across all pages and redraw each one. Keep a list of changes (frame, old text, new layout) in your report. Export before/after for Providers, Usage, Toolpacks, Chat tool rows and Settings.
2. **Renderer:** re-run `rg -n "·|•|∙" src/renderer` first. Known sites: `screens/providers/adapter.ts` (`accountTitle`, usage account cell) together with `AccountPage.tsx` (which splits on `' · '`) and `.pv-sep`; `UsagePage.tsx`; `screens/providers/preview.tsx`; `components/UsageMeter.tsx`; `screens/settings/SettingsScreen.tsx`; `ThemePicker.tsx`; `screens/toolpacks/toolpacks.css` (`content: '·'`) and the meta strip in `ToolpacksScreen.tsx`; `motion/organic/galleryApp.tsx`; and tool-row details in `src/renderer/tools/fixtures/*.json`. Also `screens/knowledge/`, `screens/hub/` and `screens/chats/` if they have any.
3. Engine strings are handled by another agent; if a UI string with a dot comes from the engine, list it in your report instead of editing the engine.

## Verify
- `rg -n "·|•|∙" src/renderer` hits only comments.
- Screenshots of Providers, Usage, Toolpacks, Settings, Knowledge and Hub in Walnut Dark and Walnut Light; look at them yourself for clipping and alignment.
- Renderer tsc clean for your files (only allowed foreign error: `../engine/runtime/dependencies.ts(71,33)`).
- Clean up vite/Edge and temp files.
