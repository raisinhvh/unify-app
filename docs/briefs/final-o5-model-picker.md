# O5: One reusable model picker

Read `docs/briefs/final-o-common.md` first (rules, preview tools, fonts, themes, Figma access, cleanup) and the spec section "One reusable model picker" in `docs/UNIFY_SPEC.md`. Preview port: **5185**. Put dev preview entries in `src/renderer/dev-o5/`.

## Build
`src/renderer/components/ModelPicker.tsx` (+ `modelPicker.css`), exported from `components/index.ts`.

- **Trigger:** one line: provider glyph, model name, and muted effort/speed as separate cells (no `·` separators; the spec forbids dot separators). It must fit narrow spots (composer footer) and wider ones (settings rows); give it a `variant` or `compact` prop rather than two components.
- **Popover** (reuse `components/Popover.tsx`; enters/leaves with a spring per the apple-design skill):
  - a search field, focused on open; filter by name, provider and backend;
  - Smart Auto at the top (only when `smartAutoReady()`);
  - Recents: the last ~5 model ids picked, persisted in renderer settings (a tiny store in `src/renderer/store/recentModels.ts`; reuse the store's existing persistence helper, don't invent one);
  - models grouped by provider, with the provider glyph (`screens/providers/glyphs.tsx` today; another agent may move it to `components/ProviderGlyph.tsx` later, so import it through one line you can change);
  - a footer with effort and speed segmented controls (only when the selected model supports them);
  - full keyboard nav: arrows move, Enter picks, Esc closes, type-to-search.
- **Data:** reuse `screens/chats/models.ts` (`modelOptions`, `effortOptions`, `speedOptions`, `selectModel`, `selectEffort`, `selectSpeed`, `smartAutoId`). Don't duplicate the option logic. Props let callers override value/onChange, so Settings and the setup wizard can bind it to their own fields instead of the active chat.

## Swap it in
- `screens/chats/Composer.tsx` ~274: replace the model, effort and speed `Select`s.
- `screens/chats/ChatPane.tsx` ~142.
- `screens/providers/AccountPage.tsx` ~229 (default model).
- Settings: the three `{/* model-picker: … */}` sites in `screens/settings/SettingsScreen.tsx` (decider model, Smart Auto rank, subagent profile model).
- Setup: `{/* model-picker: default model for new chats */}` in `screens/setup/SetupWizard.tsx`.

## Verify
- Preview the component in all 7 themes, including very long model names, many providers (10+), no Smart Auto, and a model without effort/speed. Capture a contact sheet and look at it yourself (no clipped text in Space Mono).
- Capture each swap site in Walnut Dark and Walnut Light.
- Renderer tsc clean for your files (only allowed foreign error: `../engine/runtime/dependencies.ts(71,33)`).
- Motion audit on the popover open/close and search filtering.
- Clean up vite/Edge and temp files.
