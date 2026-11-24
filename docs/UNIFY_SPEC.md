# Unify — product spec and decisions

Unify is its own product: a standalone Electron app with its own name, data and identity. Its engine started as a copy of the DSH-IDE VS Code extension's code (the DSH repo, now frozen), and that's the only connection. Where this spec says "DSH's behaviour", it means how that inherited engine code already works. It is never a link the product exposes.
Figma: page "Unify" (bridge). Screens 10–25 plus 11b, 26 (setup), 27 (motion). Exports: `.dsh/mockups/unify-logo/`.

## Non-negotiables
- Preserve DSH's agentic behaviour as much as possible (runtimes, tools, delegation, approvals, activity rail ordering, usage maths). The user fine-tuned it. Restyle and restructure, don't reinvent.
- Speed. Fix the ~30 s tool-call stalls (suspects: `extension.ts` askInChat without timeout, `summaries/store.ts:151`, `mcp/delegateServer.ts` fetch without timeout, `acp.ts` 30 s init).
- All frontend work is done by Opus subagents (user rule). Never use Sol.
- User-friendly and transparent. The user should always be able to see what the agents are doing and what they made, without having to dig for it.
  - **Show, don't just tell.** Agents show their work visually wherever they can: screenshots of UI changes, renders, before/after pairs, previews, and images of generated assets. A text-only report is the fallback for work that has nothing to look at. The default prompt tells agents this, and `send_media` / tool images make it cheap to do.
  - **Clear status at a glance.** What's running, what's waiting on the user, what changed and what it cost are all visible in the UI (timeline rows, loaders, usage, knowledge-change rows). Nothing important happens silently.
  - **A generic file tool used on app data says what it's really doing** (2026-11-23). Sometimes an agent uses a plain file tool (Read, Grep, Write, Edit, or the batch `read_file` / `search` / `list_dir`) on Unify's own data instead of a dedicated tool. Then the row describes the real job instead of claiming it read a file. Examples:
    - reading saved transcript parts shows "Refreshing earlier conversation";
    - reading memory notes or the memory index shows "Checking memory";
    - writing or editing them shows "Saving to memory".
    
    Dedicated tools (`read_chat_history`, `checkpoint`, `load_toolpack`, `wait_for_subagents`, `read_file_summaries`) already show under their own names and keep their current rows. They aren't relabeled.
    
    How it works: the engine matches the generic call's path against the app data locations (Unify's data folder, project `.unify/` folders, `transcripts/`, `memory/`, the global vault). It then sets `{ kind, label }` on the tool event, and the renderer has no path rules of its own. The row still expands to show the raw call and its result. Everything else, including the user's project files, keeps the normal "Read `src/foo.ts`" row. Toggle `chat.friendlyInternalRows` (default on).
  - **No duplicate visuals.** An agent knows what the user has already seen. If a subagent already showed an image, the parent does not send it again, and neither does the image strip on its row. Examples are the subagent's own `send_media` or a tool image on its chat row, since those reach the parent as image blocks. The parent refers to it ("the screenshot above") or only shows a newer, different image, such as one taken after its own fix. To make this work, the engine tags each image with where it has already been shown (its media store sha256 plus the surfaces it has been displayed on). `send_media` skips, with a note, any image whose sha256 the user has already seen in that chat. The default prompt explains the rule.
  - Toggle: `chats.showYourWork`, which nudges agents to send visuals (on by default). The duplicate skip is always on.
- Unify is its own thing, with no link to DSH or DSH-IDE. Nothing in the product or its code names DSH, refers to it, imports from it or shares data with it. The user is moving away from that identity and handles migrating old DSH data themselves.
  - **Everything is renamed**, not just what's visible:
    - UI text, errors, notifications, tooltips and OAuth/browser pages;
    - everything agents read: default prompt lines ("DSH batch:", "DSH subagents:", "DSH media:", "DSH IDE, workspace …"), compaction notes, `[DSH: your instructions changed]`, tool descriptions and MCP `serverInfo`/instructions;
    - the MCP server name (`dsh-delegate` becomes `unify`, so tools read `mcp__unify__…`);
    - outbound `User-Agent`/`clientInfo` (`unify`);
    - the data folder (`~/.dsh` becomes `~/.unify`) and project folder (`.dsh/` becomes `.unify/`);
    - env vars (`DSH_*` becomes `UNIFY_*`), headers (`x-dsh-token` becomes `x-unify-token`), on-disk format markers and the sync repo/gist names (`dsh-config`, `dsh-sync` become `unify-*`);
    - code identifiers (`DshSidebarProvider` etc.), file names (`update/dshUpdate.ts`), comments, tests, fixtures and previews (the sample project "DSH");
    - Figma.
  - **No DSH import or compatibility:** remove the "Import from DSH" setup step, the "Shared with DSH" Settings caption and the VS Code data importer (`shim/vscode/importer.ts`).
  - VS Code-only flows that mean nothing in Unify (the DSH-IDE/DSH update prompts, Reload Window, workspace trust, status bar item, "DSH: Restart Runtime" commands) are replaced by the Unify equivalent (the app updater, restart) or removed, not just renamed. The product doesn't mention VS Code or "the extension" either.
  - **One technical exception: the third-party agent runtime.** Unify runs DeepSeek's `@deepseek-ai/dsh` npm package as its agent runtime (`runtime/acp.ts`, `update/dshUpdate.ts`, `runtime/piAi.ts`). Names that belong to that package's own interface stay, because we don't own them:
    - the package names (`@deepseek-ai/dsh`, `dsh-llm-pi-ai`, `dsh-base`);
    - its binary and `--profile acp`;
    - the `DSH_HOME` env var it reads, which Unify points at a folder inside `~/.unify`.
    
    The runtime (DeepSeek Harness) powers every provider except two: Claude always runs through its own CLI, and Codex runs through its own CLI unless the "Run Codex through the agent runtime" option is on. Renaming only changes names. Which runtime each provider uses stays the same.

    Keep them in one small adapter module, with Unify names everywhere else (`agentRuntime`, `runtimeBin`, `runtime/agentRuntimeUpdate.ts`). The product never shows the package's name: the UI says "agent runtime" ("Agent runtime 0.2.1 is installed. Restart it to use it.").
  - Done means `rg -i "dsh" src` only hits that adapter module. This repo's own `.dsh/` dev-tooling folder (the IDE used to build Unify) isn't part of the product.

## Original wishlist
1. Main app + bonus code editor/file navigator (Monaco).
2. Brand: Unify.
3. Multiple chats on screen, draggable like Windows; hold-drag a pane header → layout picker drops down at top centre (pane shown at 50%).
4. Rules, skills and memory in ONE system. Agents add their own skills the same way a user does.
5. Cleaner, more fluid, minimal UI.
6. Images per chat (no global context folder bloat) and shown in the user's own bubble.
7. Better guidance: upload skill folders; rules scoped by audience so delegation rules don't reach subagents.
8. Logo (done).
9. Toolpack Hub: upload/install across devices, install script puts files in place.
10. Decluttered Rules / Toolpacks / Providers.
11. Tool-call stall fixes.

## Decisions (2026-11-23)
- Data: Unify has its own data folder, `~/.unify`, and doesn't read or write `~/.dsh`. The user migrates old DSH data formats themselves; the app has no import from DSH. (This replaces the earlier "share `~/.dsh`" decision.)
- Repo: `Programs/Unify`, private GitHub `raisinhvh/unify` until the first release, then public.
- Auto-update via electron-updater from GitHub Releases.
- Frontend: main agent's choice for best quality, provided agent behaviour is preserved. Plan: move extension-host logic into Electron main with minimal changes; new renderer (TypeScript, fine-grained reactive UI + one spring engine) rebuilt to the Figma screens.
- Editor: Monaco.
- Themes (13, Settings › Appearance): dark — Walnut Dark (default), Graphite, Slate, Moss, Dusk, Tide, Ember, Ink (OLED black); light — Walnut Light, Paper, Linen, Mist, Sage. Monochrome accents, same token structure (`unifyThemes`). Panes must stand apart from each other: the window behind/between panes uses `canvas` (darker than `bg`), panes are outlined with `paneBorder` (stronger than `border`), and light themes add a soft pane shadow.
- Knowledge: agents save skills/memory freely; every change shows as a row in chat (open/undo); everything easy for the user to edit/add (files, folders, skill folders, drag-in).
- Rule audiences: every rule/skill/note targets Everyone, Main agent, Subagents, or a named profile; agents only load what targets them.
- Hub backend: GitHub registry (publish = GitHub sign-in + release; install script runs on download). Registry index lives in a separate public repo `raisinhvh/unify-hub` (create it only after confirming with the user).
- Toolpack updates: the engine compares installed Hub packs with the registry 30 s after start, every 6 h, on Hub open and after each install (`hubCheckUpdates` → `toolpackUpdates`). The notice row lists packs with updates and offers Review (the pack's Hub detail with "What's new": versions, tools added/removed, what it will ask) and Update (all listed, one at a time; each still shows its consent dialogs). Settings › Toolpacks "Auto-update toolpacks" is off by default; when on, updates install unattended except those with a new or changed install/uninstall script or a missing required program, which stay in the notice for the user. Auto-update never installs optional programs.
- Native agent communication: agents talk to each other through Unify itself, not through any provider's built-in system. Any agent can reach any other running agent: parent ↔ child, sibling subagents under the same parent (directly, without going through the parent), and top-level agents in other chats/panes. They can discover who is running (name, task, chat), send a message to a running agent, ask the parent a question, reply, hand off results; every message shows in the chat UI (who → who) and the user can read or step in. Built on DSH's delegation (delegate_task / background tasks / ask_questions), extended with live messaging.
- Disable providers' own agent systems wherever the CLI allows it, so Unify's is the only one: Claude Code via `--disallowedTools` (Agent, Task, Workflow, SendMessage, ListAgents, team tools — DSH already does this in `oauthCli.ts`); Codex: turn off its multi-agent / spawn_agent features in config; same for Cursor, OpenCode and any other runtime that has one. Where a provider can't disable it, keep DSH's prompt rule and its detector (`delegation.ts`) that flags native agent tool calls.
- Heavily customizable: nearly every feature has a toggle or option in Settings (e.g. organic motion and each of its effects, agent-to-agent messaging and who may message whom, auto-saving skills/memory, usage meter, editor, Hub, layout picker, loaders, notifications, per-runtime native-agent blocking). Defaults match the spec; settings are grouped and searchable; each toggle takes effect live and degrades cleanly (turning a feature off hides its UI, never leaves broken gaps). Build every feature behind a setting from the start, not retrofitted.
- Shut down when done: a one-shot `/shutdown` slash command (feature `power.shutdownWhenIdle`; no Settings switch). While armed, every chat and Home show a "Shutting down on finish" bar by the composer with Cancel (it turns into the live countdown), and the title bar shows a small indicator. It waits until every chat and subagent in every pane is idle, with no pending approvals/questions and no running tool processes (pending approvals or questions don't count as finished: it waits, and notifies). Then a 60 s cancellable countdown (overlay + desktop notification), then saves all state and shuts the PC down via the OS (Windows `shutdown /s /t 0`, macOS `osascript … shut down`, Linux `systemctl poweroff`). Reliable: decided in the engine/main process, not the renderer; survives window close/minimise; re-checks idle right before shutting down; if the OS command fails, it retries with a fallback and reports the error. Disarms after firing; never persists across app restarts unless the user opts in.
- Images are first-class (2026-11-23):
  - **One media store, no context folders.** Every image (user attachments, `send_media`, generated images, images returned by tools such as `read_file` and toolpack captures) goes into a content-addressed store at `~/.unify/media/<first 2 hex>/<sha256>.<ext>`. The same image is stored once, however many chats or agents use it. Each chat record lists the media it references; deleting a chat drops its references, and a sweep (on startup and on chat delete) removes files nobody references. This replaces the old global `attachments/` folder and the per-send copies in `media/<chatId>/`. `generate_image` still also writes its file to the project's `.unify/images`, because that file is the deliverable.
  - The renderer loads images through an Electron `unify-media://<sha256>` protocol (with `?thumb=1` for a small cached thumbnail), never as base64 inside viewState.
  - **Subagent chats show their images.** Any tool call that gave a subagent an image shows a small thumbnail on its row in the subagent's chat; click to expand. This holds on every runtime, Claude CLI included. A subagent's `send_media` shows inline in its own chat at the point it was sent.
  - **Subagents send real images to the main agent.** A subagent's `send_media` images, image files its final report names by path or link (like a user attaching them), and image-bearing messages over the agent bus reach the parent as image content blocks in the `delegate_task` result or the next tool result, not as file paths the parent must re-read.
  - **Main chat preview.** When a subagent finishes, its row in the parent chat shows a compact strip of the images it sent the parent ("3 images"), collapsed to small thumbnails; clicking one expands it in place, and an expanded image opens a full viewer. The parent chat no longer gets separate `**label:**` media rows for subagent images.
  - Toggles: `chats.toolImages`, `chats.subagentImageStrip`, `agents.imagesToParent`.
- Range-scoped reading and editing, to save context (2026-11-23):
  - **Explorer returns ranges, not prose.** Besides its short answer, the explorer ends with a structured list of `{ path, startLine, endLine, why }` ranges. Ranges are merged when they overlap and capped at about 12. The engine parses the list and returns it with the `delegate_task` result, so the main agent can act on it directly. Briefs to explorer can ask "return the ranges I need to edit X".
  - **Default tools take ranges.**
    - `read_file` keeps `offset`/`limit` and also accepts `ranges: [{ startLine, endLine }]`, which reads several parts of one file in one call. A small margin of context lines is added, and each part is labelled with its line numbers.
    - A new `edit_range { path, startLine, endLine, expected?, replacement }` replaces only those lines. It is guarded: `expected` (the current text of those lines, or the hash the read returned) must still match, so a stale edit fails loudly instead of landing in the wrong place. If the lines moved, it re-anchors once on the expected text before failing.
    - `batch` read_file supports `ranges` the same way.
  - The DSH rule "read a file natively right before editing it" is satisfied by reading the range that's being edited, not the whole file.
  - Toggles: `tools.rangeEdits`, `agents.explorerRanges`.
- **Explorer is not shown as a subagent.** Under the hood it stays a read-only delegate profile. In the UI it reads as the agent looking something up, not as a hand-off:
  - an inline "Explored" tool-style row in the timeline, with the search/lens loader, the question as its title, and the returned ranges as clickable `file:line` chips that open the Files editor at that range;
  - no subagent chat tab, no image strip, no "who → who" agent label, and it isn't counted in the subagent count or roster badges;
  - its token cost still shows, but under the agent's own usage line (DSH's `explorerTokens`).
- **One reusable model picker** (2026-11-23). Every place that chooses a model uses the same `ModelPicker` component, never a plain `Select`: composer, chat pane header, account default model, Settings (decider model, Smart Auto ranks, subagent profile models) and the setup wizard.
  - **Closed:** a single flat line: provider glyph, model name, then effort/speed in muted text when set (e.g. "Opus 5.5" then muted "High  Fast", separated by spacing, not dots), with a chevron. Truncates with an ellipsis and never wraps. In the composer this one line replaces the separate model, effort and speed dropdowns.
  - **Open:** a popover anchored to the line that springs open. It has a search field (focused, filters as you type), Smart Auto first when ready, then recent models, then all enabled models grouped by provider/account. Rows show the name plus a muted provider or plan hint, and the current model is marked. Effort and speed sit in a footer as flat segmented choices for the highlighted model, and only appear when that model has them.
  - Keyboard: arrows move, Enter picks, Esc closes, and typing filters right away. It closes on pick or on a click outside.
  - Props let each use site turn off what it doesn't need (no Smart Auto in account defaults, no effort/speed in rank lists, an optional "None" row).
- **Provider logos look like the real brand** (2026-11-23). Redraw every provider glyph so it's recognisable at a glance as that company's own mark, not a loose abstraction. Anthropic is its "A\" wordmark-A with the slash, OpenAI its six-loop knot ("flower"), Google Gemini the four-point spark with its curved sides, Mistral the stepped block "M", Cursor its cube, and OpenCode its mark. Self-hosted keeps a neutral server glyph, and any new provider follows the same rules.
  - All marks are drawn in one shared style. They sit on the 16px grid with the same optical size and weight, in monochrome `currentColor` (no brand colours, per the visual rules). Fills or strokes follow whatever the real mark uses, but line weights are matched across the set so no logo looks heavier than another.
  - They must read clearly at 12, 16 and 24px. Check them side by side in every theme.
  - There's one glyph source for the whole app (`components/ProviderGlyph`), used by Providers, Toolpacks, the model picker and usage rows. It replaces the two copies in `screens/providers/glyphs.tsx` and `screens/toolpacks/glyphs.ts`.
- **Toolpack setup** (2026-11-23): a pack's install script does every automatic companion step (Roblox plugin copy, Premiere panel, Blender add-on), and its `setup.json` drives a "Finish setup" checklist in Unify for the manual steps (Figma manifest import, restarts, prerequisites), with Copy/Open buttons and ticks. Contract: `engine/hub/types.ts` "Pack setup". Hub packs in `raisinhvh/unify-hub` ship these (the user approved pushing them). Required programs (ImageMagick, ffmpeg, Python) install automatically: a step's `install` names a winget/brew/pip package, the Hub consent dialog lists the exact commands, required steps install during the pack install, optional ones get an Install button (`engine/hub/packages.ts`). Packages install before the install script runs (so the script can use them), and the script gets 10 minutes (Sound builds its Python environment there). A reinstall keeps the pack's `data/` folder (keys, venvs, downloaded tools). Optional steps never keep setup open, and the checklist shows only what still needs the user: automatic steps that worked are hidden ("Show all steps" lists them). Keys go in a template file the script creates under `data/` (Sound `config.json`, Roblox `opencloud.json`), and the step's Copy button gives its full path. Imaging's script downloads pngquant and Real-ESRGAN into `data/bin`. Roblox audio search is `roblox_search_audio` in the Roblox pack, not Sound. Removing a pack runs its uninstall script (`uninstall.js`/`.ps1`/`.sh`, shown on the install consent too) after the pack stops and before its folder is deleted; it undoes whatever the install script put outside the pack folder (Roblox plugin, Blender add-on, Premiere panel and PlayerDebugMode, restored to its pre-install value). Programs installed via `setup.json` stay.
- **Agents screen** (2026-11-23): its own rail entry. Subagent profiles, the explorer model, and helper models (chat names, review, summaries, decider) all live there, not in Settings. Chat naming falls back to the chat's own model when no name model is set.
- **Composer activity indicators** (2026-11-24): no bar above or inside the chat feed for background work. The composer row reads paperclip, model, effort, then a subagents indicator (bot icon + count) and a background indicator (terminal icon + running count; shells, provider tasks), no words on either, each shown only while it has something and evenly spaced. Each opens a popover like the model picker: subagent rows open that subagent's feed, background rows show elapsed time and Stop.
- **Slash commands** (2026-11-23): the composer has a `/` menu (`/job`, `/permissions`), and `/permissions` opens an approval-mode picker. A running `/job` shows a job bar at the top of the chat.
- **Progress notices** (2026-11-23): long tasks started outside a chat (agent runtime update, setup scripts) show in the notice row with progress (`progressNotice`).
- **Compact usage popover** (2026-11-23): one row per account showing the provider logo and the name centred, then the percent and the bare time ("32m", no "resets in"). Clicking a row opens that account's usage in Providers.
- **Live edit preview in chat** (2026-11-23): while an agent is editing, its timeline shows an "Editing" row (loader, file name or "Multiple files", rolling +N −M, elapsed time) with the change streaming in underneath as a small diff: a few context lines, removed lines in red, added lines in green, with line numbers.
  - It streams while the agent runs: the diff grows as the edit's input arrives from the provider, not after the tool finishes. Motion follows the organic code-edit catalogue (removed lines sweep then collapse, added lines wipe in with the caret on the last line). When the edit lands, the row settles into a finished "Edited" row whose diff collapses to a few lines; click to expand or open it in the Files editor. A failed edit shows its error in red on the row.
  - The same rows show in subagent chats, and a subagent's row in the parent chat shows its current live edit too (one line of diff under the row while it's editing).
  - Toggle: `chats.liveEditPreview` (off: plain tool rows, no diff).
- Installer ships unsigned for now; keep a slot in the build config for a code-signing cert later.
- Usage: keep DSH's usage summary (combined %, stacked bar weighted by plan monthly price, per-account rows with reset time coloured by distance). Slim meter in the left rail above Settings opens the popover; Providers tree has a "Usage" overview row; account pages show per-limit bars. All providers that expose usage get bars. OpenCode Go: read limits from opencode.ai/console via a browser sign-in session (like Cursor).
- Home: project folder picker under the composer (breadcrumb chip, defaults to last project). Title in the UI font, bold (`unify/display`).
- Setup wizard on first launch / whenever something required is missing. Required: one working provider account, a project folder, CLI tools check (with fix buttons). Everything else (theme, toolpacks, import) optional and skippable.

## Visual rules
- Walnut Dark; accent #EFE6DA monochrome; wood only in logo and loaders. No AI-isms (dots, sparkles, glow). No pill buttons: text buttons, icon buttons, or flat rows.
- No dot separators anywhere in user-facing text ("Anthropic · Work", "Weekly · Opus", "12s · 3 files"). This covers `·`, `•` and `∙`, and swapping in `|`, `/` or `—` doesn't count as a fix. Show the relationship with layout instead:
  - a title with a muted second line or a muted trailing part (`Anthropic` + muted `Work`);
  - separate cells, columns or label/value rows;
  - plain words where they read naturally ("Updated 2m ago", "Max, $100/mo" becomes plan and price on their own rows);
  - spacing alone (a gap between two differently-styled spans) for short inline meta.
  This applies to the app UI, tooltips, status text, engine-generated labels that reach the UI (usage labels, Smart Auto notes, `/job` labels, model descriptions), fixtures/previews, and the Figma designs. Code comments and Figma frame names don't matter. Everything already built or drawn that uses them gets reworked (TODO 2f).
- File-system look everywhere: trees with guide lines; detail views read like an open file (breadcrumb, title, plain sections, hairlines).
- Home IS the background of the program. The Home screen (10 · Home: walnut bg, wood-block logo, title, composer) is the bottom layer, always mounted; every screen, side panel, chat pane, menu and the setup wizard is a layer on top of it. Where nothing covers it, Home shows through, unchanged. Closing everything reveals Home. Never redraw a per-screen backdrop. The Welcome screen is only that backdrop, "The last AI interaction interface you ever install" and a Get started button.
- Ships as an installer (NSIS setup wizard), open source (MIT); `run.cmd` launches from source for iteration.
- Fonts: UI font is Space Mono (user's final pick, 2026-11-23; still swappable); code font is JetBrains Mono, fixed. CSS uses `var(--font-ui)` / `var(--font-mono)` only, never a family name. Keep the intended weights (title 800, display 900, label 500); if the UI font lacks them the browser falls back to the nearest real weight.
  - App: `node scripts/set-font.mjs "<Google font>"` (in the Unify repo) installs it from Fontsource and regenerates `src/renderer/theme/ui-font.ts`.
  - Figma: run `.unify/tools/figma-swap-font.js` with figma_execute (edit FAMILY). `unify/*` styles keep their intended weight as `weight: NNN` in the style description.
- Chats tree: max 5 chats per project, then a "Show N more" row.
- Turn edits header: ≤2 files, else "Multiple files +N −M".

## Motion
- Everything that changes on screen animates: springs, bouncy pop-ins, elastic press, merging/splitting bubbles, layout that follows size changes. Interruptible: retarget from current value, never restart or queue.
- Loader icons crossfade/morph into each other on action change, never swap instantly.
- Human-like ("organic") motion for anything the agent changes: it should look like a person is doing it. Never slows or blocks the user: the real value updates at once, the animation is display only, clicking/focusing it finishes instantly, total time is capped, and reduced motion falls back to a crossfade. Catalogue:
  - Rename (file, chat, project, any title): text caret appears at the end, backspaces to the shared prefix (held-key speed, accelerating), short pause, types the new suffix with jittered human timing (pauses after spaces/punctuation), caret blinks once and fades.
  - Created: name is typed in from empty while the row springs open. Deleted: a select-all highlight sweeps the name, then the row collapses.
  - Moved: row lifts (slight scale + shadow) and travels to its new place like it was dragged, then settles.
  - Counters (+N −M, usage, counts): digits roll like an odometer.
  - Code edits in viewers: removed lines get a highlight sweep then collapse; added lines wipe in left to right with the caret riding the last line.
  - Status / loader labels: retype from the shared prefix (fast).
  - Many changes at once: stagger with a small concurrency limit; the rest land instantly.
- Check with `.unify/tools/motion-audit.mjs` (frame-sampled audit: snaps, pop-in/out, layout jumps, restarts, slow/linear motion).
