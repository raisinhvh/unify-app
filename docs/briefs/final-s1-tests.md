# S1: test infrastructure fixes (Sol)

Read `docs/briefs/final-common.md` first and follow it. You are the only agent that writes tests this round. Engine agents are changing code in parallel, so don't edit any file under `src/`.

## Task
1. Update `test/run.mjs` so it imports the test files that exist but aren't run:
   - `./agent-bus.test.mjs`
   - `./power.test.mjs`
   - `./hub.test.mjs`
   - `./unify-requests.test.mjs`

   Check whether `package.json`'s `build:test` bundles the modules these tests import. If a module is missing, don't edit package.json (another agent owns it). List the exact entry points to add.
2. `test/features.test.mjs` fails at about line 151. Find out why:
   - If the test still expects pre-Unify DSH behaviour that the engine changed on purpose, update the test to the new behaviour and explain the change.
   - If it's a real engine bug, leave the test as it is and report the bug with file:line.
3. `test/claude-args.test.mjs` reads the user's real settings file. Make it use a temp folder. `src/engine/unify/settings.ts` now honours the `UNIFY_HOME` env var and exports `resetUnifySettingsCache()`. In the test:
   - set `UNIFY_HOME` to a fresh temp folder;
   - call the reset;
   - restore both afterwards.

   Check every other test for reads or writes to the real `~/.dsh`, `~/.unify` or `%APPDATA%`, and move them to temp folders the same way.
4. Run `npm test` and report the full summary. Some failures may come from engine work in progress by other agents. Name the file each one comes from; don't fix engine code.

## Files you own
- `test/` (all files)

## Reference for style
`test/power.test.mjs`.
