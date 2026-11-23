# D6: prepare the public Toolpack Hub repo (Deepseek)

Read `docs/briefs/final-common.md` first and follow it.

## Context
The user approved creating the public GitHub repo `raisinhvh/unify-hub` and publishing the toolpacks installed on this PC, after a safety scan. Only `raisinhvh` may publish to it.

**You prepare it locally. Don't create the GitHub repo and don't push.** The main agent reviews your scan and does the push.

## Inputs
- Installed toolpacks: `C:\Users\User\AppData\Roaming\Code\User\globalStorage\dsh-local.dsh-ide\toolpacks\`, which holds `blender`, `figma`, `imaging`, `premiere`, `roblox` and `sound`. Read only; never modify these.
- The Hub registry format:
  - `src/engine/hub/githubRegistry.ts`
  - `src/engine/hub/types.ts`
  - `src/engine/hub/install.ts`
  - `src/engine/hub/fixtures/`

  The repo layout must be exactly what `githubRegistry.ts` reads (index file, per-pack folders, release assets or archives, the install script). Read those files; don't guess.

## Task
1. Build the repo in `C:\Users\User\Documents\Projects\AI Stuff\Programs\unify-hub\`, a new folder next to Unify (outside this working copy):
   - `git init`, main branch `main`;
   - an MIT `LICENSE`;
   - a `README.md` saying what the Hub is, how to install a pack from Unify, and that publishing is limited to approved accounts;
   - `publishers.json` with `{ "publishers": ["raisinhvh"] }`;
   - `.github/CODEOWNERS` with `* @raisinhvh`;
   - a GitHub Actions workflow `.github/workflows/guard.yml` that fails any pull request or push whose actor isn't in `publishers.json`;
   - the registry index and pack folders in the format the engine reads.
2. Copy each toolpack in, leaving out `node_modules`, caches, logs, `.git` and build output. Pack metadata (name, description, tools, version, category, icon) comes from each pack's own manifest. Don't invent descriptions; if there's no description, use the manifest's first sentence or leave the field empty.
3. Safety scan each copied pack and write `SCAN.md` in the repo folder. Don't commit `SCAN.md`; list it in `.git/info/exclude`. Look for:
   - API keys and tokens: `sk-`, `ghp_`, `gho_`, `github_pat_`, `xox`, `AKIA`, `AIza`, PEM blocks, `Bearer`, and high-entropy strings next to key/token/secret/password names;
   - emails;
   - absolute user paths (`C:\Users\`, `/Users/`, `/home/`);
   - machine names;
   - `.env` files.

   For each hit, give the file, line and type, and say whether it's real or a false positive.
   - A pack with a real secret or a personal path that the pack needs to work is **left out entirely**: delete its folder from the repo and list it in `SCAN.md` under "Excluded".
   - A personal path that only appears in a comment or an example may be replaced with a placeholder. List each such edit.
4. Make one local commit: `Initial Toolpack Hub registry`. Use the local repo's git identity as it is; don't set any email or name.
5. Point the engine at the repo: if `src/engine/hub/githubRegistry.ts` has a placeholder repo name, report the exact line to change. Don't edit engine files yourself; another agent owns `src/engine/hub/` right now.

## Files you own
- Everything inside `C:\Users\User\Documents\Projects\AI Stuff\Programs\unify-hub\`. Nothing in the Unify working copy.

## Report
- The repo tree (2 levels).
- The `SCAN.md` contents.
- The included and excluded packs.
- The hook for the engine's repo name.
