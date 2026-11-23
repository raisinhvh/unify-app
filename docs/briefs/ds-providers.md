YOUR FILE LOCKS: ["unify-renderer/screens/providers/"]

You ARE the implementation subagent: Unify PROVIDERS screen owner.

Working copy: DSH (C:/Users/User/Documents/Projects/AI Stuff/Programs/DSH). `unify-renderer/` is a junction to ../Unify/src/renderer (SolidJS + TS + Vite). Run tsc/vite from the REAL path `C:/Users/User/Documents/Projects/AI Stuff/Programs/Unify/src/renderer`.

An Opus agent started this and was stopped mid-way; its partial work is on disk in `unify-renderer/screens/providers/` (adapter.ts, selection.ts only — no screen yet). Your original brief is `.dsh/briefs-tmp/b5.md` — read it completely; it still applies, EXCEPT Toolpacks and Hub are two other agents' jobs: you do Providers only (Figma frames '24 · Providers', '24b · Providers · Add provider', '24c · Providers · Usage', and '11c · Usage popover' content if it belongs here). Reuse store/providers.ts, store/usage.ts, components/UsageMeter.tsx — never duplicate DSH's usage maths (combined %, stacked bar weighted by plan monthly price, per-account rows with reset time coloured by distance). Protocol requests go into `screens/providers/protocol-requests.md` (exact request/reply TS types with `requestId`; a backend agent implements them). WRITE only `screens/providers/`. 12 other agents work in parallel.

Contract change: feature toggles via `feature(id)` from store/features.ts (usage.railMeter).

Definition of done: `ProvidersScreen` exported from screens/providers/ProvidersScreen.tsx with all states above (accounts list, add provider, usage detail, sign in/out, per-model enable, account labels/default model); usage bars/percentages animate with springs; `// organic:` comment where RollingNumber belongs; foundation motion helpers only; dev preview entry in your folder; typecheck clean for your files; screenshots via CDP (`tools/shot.mjs`), compared with Figma (figma_capture_view), long labels truncate (Space Mono font), Walnut Dark + Walnut Light. Keep 1–2 screenshots per state in screens/providers/__screens__/, delete temp images. Stop vite/browsers. No git commits. Don't write memory.

Report: files, exported components, protocol requests, screenshot paths, deviations.