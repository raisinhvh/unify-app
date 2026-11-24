/**
 * Source Control pane body, modelled on VS Code's panel but kept small:
 *
 *   header      branch chip (switch or create a branch), refresh · sync · more
 *   commit box  message (Ctrl+Enter commits) and a full-width Commit
 *   Staged      files in the index; − unstages
 *   Changes     working-tree files; + stages, trash discards (asks first), the diff button shows the diff
 *   Graph       the last commits with a simple lane per branch
 *
 * Clicking a file row toggles its unified diff inline. Talks to git through bridge().git (src/main/git.ts).
 * Refreshes on window focus, every 5 s while the window is visible, and after every action. Styles: git.css.
 */
import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import {
  bridge,
  type GitActionResult,
  type GitBranchesResult,
  type GitChange,
  type GitCommit,
  type GitDiffResult,
  type GitStatusResult,
  type UnifyGitApi,
} from '../../bridge';
import { Button, Icon, IconButton, Menu, type MenuEntry } from '../../components';
import { Collapse } from '../../motion';
import './git.css';

const REFRESH_MS = 5000;
/** Width of one graph lane, in px. */
const LANE_WIDTH = 10;

type Repo = Extract<GitStatusResult, { repo: true }>;
interface DiffTarget {
  path: string;
  staged: boolean;
  untracked: boolean;
}

function isError(value: object): value is { error: string } {
  return 'error' in value;
}

function gitApi(): UnifyGitApi | undefined {
  try {
    return bridge().git;
  } catch {
    return undefined;
  }
}

/** The file name and the folder it sits in, for a repo-relative path. */
function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf('/');
  return at < 0 ? { name: path, dir: '' } : { name: path.slice(at + 1), dir: path.slice(0, at) };
}

/** Decoration text → a chip: HEAD's branch is highlighted, tags get their own look. */
function chipOf(ref: string): { label: string; kind: 'head' | 'tag' | 'ref' } {
  if (ref.startsWith('HEAD -> ')) return { label: ref.slice('HEAD -> '.length), kind: 'head' };
  if (ref === 'HEAD') return { label: 'HEAD', kind: 'head' };
  if (ref.startsWith('tag: ')) return { label: ref.slice('tag: '.length), kind: 'tag' };
  return { label: ref, kind: 'ref' };
}

function statusName(letter: GitChange['status']): string {
  switch (letter) {
    case 'M':
      return 'Modified';
    case 'A':
      return 'Added';
    case 'D':
      return 'Deleted';
    case 'R':
      return 'Renamed';
    case 'C':
      return 'Conflicted';
    case 'U':
      return 'Untracked';
  }
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

// ---------------------------------------------------------------------------------------------
// Graph lanes
// ---------------------------------------------------------------------------------------------

interface GraphRow {
  commit: GitCommit;
  /** The lane this commit sits on. */
  column: number;
  /** Lanes with a line coming in from above / going out below. */
  before: boolean[];
  after: boolean[];
}

/**
 * Assigns each commit a lane. `lanes[i]` is the hash lane i is waiting for (its next commit down).
 * A commit joins the lane that waits for it, or opens a free one; its first parent continues the lane, other
 * parents open lanes of their own (merges). Drawn as vertical segments only, so it stays simple.
 */
function layoutGraph(commits: GitCommit[]): { rows: GraphRow[]; width: number } {
  const lanes: (string | undefined)[] = [];
  let width = 0;
  const rows = commits.map((commit): GraphRow => {
    const before = lanes.map(hash => hash !== undefined);
    let column = lanes.indexOf(commit.hash);
    if (column < 0) {
      column = lanes.indexOf(undefined);
      if (column < 0) column = lanes.push(undefined) - 1;
      lanes[column] = commit.hash;
    }
    // Other lanes that waited for this commit end here.
    lanes.forEach((hash, index) => {
      if (index !== column && hash === commit.hash) lanes[index] = undefined;
    });
    const [first, ...others] = commit.parents;
    // A parent another lane already waits for is drawn there, so this lane stops.
    lanes[column] = first && !lanes.includes(first) ? first : undefined;
    for (const parent of others) {
      if (lanes.includes(parent)) continue;
      const free = lanes.indexOf(undefined);
      if (free >= 0) lanes[free] = parent;
      else lanes.push(parent);
    }
    while (lanes.length && lanes[lanes.length - 1] === undefined) lanes.pop();
    const after = lanes.map(hash => hash !== undefined);
    width = Math.max(width, before.length, after.length, column + 1);
    return { commit, column, before, after };
  });
  return { rows, width };
}

/** Centre x of lane `column`, in px. */
function laneX(column: number): number {
  return LANE_WIDTH / 2 + column * LANE_WIDTH;
}

// ---------------------------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------------------------

export function GitView(): JSX.Element {
  const git = gitApi();
  return (
    <div class="git-view">
      <Show when={git} fallback={<p class="git-note">Source Control needs the desktop app.</p>}>
        {api => <GitPanel git={api()} />}
      </Show>
    </div>
  );
}

function GitPanel(props: { git: UnifyGitApi }): JSX.Element {
  const git = props.git;
  const [status, setStatus] = createSignal<GitStatusResult>();
  const [commits, setCommits] = createSignal<GitCommit[]>([]);
  const [message, setMessage] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal<string>();
  /** Open diffs, keyed by `staged:path` or `changes:path`. */
  const [open, setOpen] = createSignal<Record<string, DiffTarget>>({});
  const [diffs, setDiffs] = createSignal<Record<string, GitDiffResult>>({});
  const [stagedOpen, setStagedOpen] = createSignal(true);
  const [changesOpen, setChangesOpen] = createSignal(true);
  const [graphOpen, setGraphOpen] = createSignal(true);
  const [moreOpen, setMoreOpen] = createSignal(false);
  const [moreAnchor, setMoreAnchor] = createSignal<HTMLButtonElement>();
  const [branchOpen, setBranchOpen] = createSignal(false);
  const [branchAnchor, setBranchAnchor] = createSignal<HTMLButtonElement>();
  const [branchList, setBranchList] = createSignal<Extract<GitBranchesResult, { local: string[] }>>({
    current: '',
    local: [],
    remote: [],
  });
  /** The branch-name input replaces the branch chip while it is open. */
  const [creating, setCreating] = createSignal(false);
  let refreshing = false;

  const repo = (): Repo | undefined => {
    const current = status();
    return current && !isError(current) && current.repo ? current : undefined;
  };
  const branch = () => repo()?.branch ?? '';
  const staged = () => repo()?.staged ?? [];
  const unstaged = () => repo()?.unstaged ?? [];
  const canCommit = () => !busy() && message().trim() !== '' && staged().length + unstaged().length > 0;

  const keyOf = (target: DiffTarget) => `${target.staged ? 'staged' : 'changes'}:${target.path}`;
  const stagedTarget = (path: string): DiffTarget => ({ path, staged: true, untracked: false });
  const changeTarget = (change: GitChange): DiffTarget => ({
    path: change.path,
    staged: false,
    untracked: change.status === 'U',
  });

  const loadDiff = async (key: string, target: DiffTarget) => {
    const result = await git.diff(undefined, target.path, { staged: target.staged, untracked: target.untracked });
    // Ignore a result for a row that was closed while it loaded.
    if (open()[key]) setDiffs(current => ({ ...current, [key]: result }));
  };

  /** Reads status, history and any open diffs. Never overlaps itself. */
  const refresh = async (): Promise<void> => {
    if (refreshing) return;
    refreshing = true;
    try {
      const next = await git.status();
      setStatus(next);
      if (isError(next) || !next.repo) return;
      const log = await git.log();
      if (isError(log)) setNotice(log.error);
      else setCommits(log.commits);
      for (const [key, target] of Object.entries(open())) void loadDiff(key, target);
    } finally {
      refreshing = false;
    }
  };

  /** Runs one git action, shows its error, then refreshes. Resolves true when it succeeded. */
  const act = async (task: () => Promise<GitActionResult>): Promise<boolean> => {
    if (busy()) return false;
    setBusy(true);
    setNotice(undefined);
    let ok = false;
    try {
      const result = await task();
      if (isError(result)) setNotice(result.error);
      else ok = true;
    } finally {
      setBusy(false);
      await refresh();
    }
    return ok;
  };

  /** Commit: stages everything first when nothing is staged (VS Code's smart commit). */
  const commit = () => {
    const text = message().trim();
    if (!canCommit()) return;
    void act(async () => {
      if (staged().length === 0) {
        const stagedAll = await git.stage(undefined, null);
        if (isError(stagedAll)) return stagedAll;
      }
      const result = await git.commit(undefined, text);
      if (!isError(result)) setMessage('');
      return result;
    });
  };

  /** Rewrites the last commit with the typed message (or its own message when the box is empty). */
  const amend = () => {
    if (busy()) return;
    void act(async () => {
      const result = await git.commit(undefined, message().trim(), { amend: true });
      if (!isError(result)) setMessage('');
      return result;
    });
  };

  const stagedPaths = () => staged().flatMap(change => (change.origPath ? [change.path, change.origPath] : [change.path]));

  const discardAll = () => {
    const items = unstaged().map(change => ({ path: change.path, untracked: change.status === 'U' }));
    if (items.length === 0) return;
    const count = items.length === 1 ? '1 file' : `${items.length} files`;
    if (!window.confirm(`Discard all changes in ${count}? New files will be deleted. This cannot be undone.`)) return;
    void act(() => git.discard(undefined, items));
  };

  const openBranches = async () => {
    const result = await git.branches();
    if (isError(result)) {
      setNotice(result.error);
      return;
    }
    setBranchList(result);
    setBranchOpen(true);
  };

  const createBranch = async (name: string) => {
    const text = name.trim();
    if (!text) {
      setCreating(false);
      return;
    }
    if (await act(() => git.createBranch(undefined, text))) setCreating(false);
  };

  const branchItems = (): MenuEntry[] => {
    const { current, local, remote } = branchList();
    const entries: MenuEntry[] = [
      { kind: 'group', label: 'Local' },
      ...local.map((name): MenuEntry => ({ id: `branch:${name}`, label: name, checked: name === current })),
    ];
    if (remote.length) {
      entries.push({ kind: 'separator' }, { kind: 'group', label: 'Remote' });
      entries.push(...remote.map((name): MenuEntry => ({ id: `branch:${name}`, label: name })));
    }
    entries.push({ kind: 'separator' }, { id: 'create-branch', label: 'Create branch…' });
    return entries;
  };

  const onBranchPick = (id: string) => {
    setBranchOpen(false);
    if (id === 'create-branch') {
      setCreating(true);
      return;
    }
    const name = id.slice('branch:'.length);
    if (name !== branchList().current) void act(() => git.checkout(undefined, name));
  };

  const moreItems = (): MenuEntry[] => [
    { id: 'pull', label: 'Pull' },
    { id: 'pull-rebase', label: 'Pull (rebase)' },
    { id: 'push', label: 'Push' },
    { id: 'fetch', label: 'Fetch' },
    { kind: 'separator' },
    { id: 'commit', label: 'Commit', hint: 'Ctrl+Enter', disabled: !canCommit() },
    { id: 'commit-amend', label: 'Commit (amend)', disabled: busy() },
    { id: 'undo-commit', label: 'Undo last commit', disabled: busy() },
    { kind: 'separator' },
    { id: 'stage-all', label: 'Stage all', disabled: busy() || unstaged().length === 0 },
    { id: 'unstage-all', label: 'Unstage all', disabled: busy() || staged().length === 0 },
    { id: 'discard-all', label: 'Discard all changes', danger: true, disabled: busy() || unstaged().length === 0 },
    { kind: 'separator' },
    { id: 'stash', label: 'Stash' },
    { id: 'stash-untracked', label: 'Stash (include untracked)' },
    { id: 'stash-pop', label: 'Pop stash' },
  ];

  const onMore = (id: string) => {
    setMoreOpen(false);
    switch (id) {
      case 'pull':
        void act(() => git.pull());
        break;
      case 'pull-rebase':
        void act(() => git.pull(undefined, { rebase: true }));
        break;
      case 'push':
        void act(() => git.push());
        break;
      case 'fetch':
        void act(() => git.fetch());
        break;
      case 'commit':
        commit();
        break;
      case 'commit-amend':
        amend();
        break;
      case 'undo-commit':
        if (window.confirm('Undo the last commit? Its changes stay staged.')) void act(() => git.undoLastCommit());
        break;
      case 'stage-all':
        void act(() => git.stage(undefined, null));
        break;
      case 'unstage-all':
        void act(() => git.unstage(undefined, stagedPaths()));
        break;
      case 'discard-all':
        discardAll();
        break;
      case 'stash':
        void act(() => git.stash(undefined));
        break;
      case 'stash-untracked':
        void act(() => git.stash(undefined, { includeUntracked: true }));
        break;
      case 'stash-pop':
        void act(() => git.stashPop());
        break;
    }
  };

  const onMessageKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      commit();
    }
  };

  const toggleDiff = (target: DiffTarget) => {
    const key = keyOf(target);
    if (open()[key]) {
      setOpen(current => omit(current, key));
      setDiffs(current => omit(current, key));
      return;
    }
    setOpen(current => ({ ...current, [key]: target }));
    void loadDiff(key, target);
  };

  const discard = (change: GitChange) => {
    const extra = change.status === 'U' ? ' The new file will be deleted.' : '';
    if (!window.confirm(`Discard changes to ${change.path}?${extra}`)) return;
    void act(() => git.discard(undefined, [{ path: change.path, untracked: change.status === 'U' }]));
  };

  onMount(() => void refresh());
  // Cheap enough to run while the window is up: a few git reads every 5 s.
  const onFocus = () => void refresh();
  window.addEventListener('focus', onFocus);
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') void refresh();
  }, REFRESH_MS);
  onCleanup(() => {
    window.removeEventListener('focus', onFocus);
    clearInterval(timer);
  });

  return (
    <Show
      when={repo()}
      fallback={
        <Unavailable status={status()} busy={busy()} notice={notice()} onInit={() => void act(() => git.init())} />
      }
    >
      {current => (
        <>
          <header class="git-header">
            <Show
              when={!creating()}
              fallback={
                <input
                  class="git-branch-input"
                  placeholder="New branch name"
                  aria-label="New branch name"
                  ref={element => queueMicrotask(() => element.focus())}
                  onKeyDown={event => {
                    if (event.key === 'Enter') void createBranch(event.currentTarget.value);
                    else if (event.key === 'Escape') setCreating(false);
                  }}
                  onBlur={() => setCreating(false)}
                />
              }
            >
              <button
                type="button"
                ref={setBranchAnchor}
                class="git-branch"
                title={`${current().branch} · switch branch`}
                aria-haspopup="menu"
                aria-expanded={branchOpen()}
                onClick={() => void openBranches()}
              >
                {current().branch}
              </button>
            </Show>
            <span class="git-header-spacer" />
            <IconButton icon="refresh" label="Refresh" size="small" disabled={busy()} onClick={() => void refresh()} />
            <button
              type="button"
              class="git-sync-button"
              title="Pull, then push"
              disabled={busy()}
              onClick={() => void act(() => git.sync())}
            >
              <Icon name="cloud" size={14} />
              <Show when={current().hasUpstream && (current().ahead > 0 || current().behind > 0)}>
                <span>
                  ↓{current().behind} ↑{current().ahead}
                </span>
              </Show>
            </button>
            <IconButton
              ref={setMoreAnchor}
              icon="more"
              label="More"
              size="small"
              active={moreOpen()}
              onClick={() => setMoreOpen(!moreOpen())}
            />
          </header>

          <Show when={notice()}>
            {text => (
              <p class="git-note git-note-error" role="alert">
                {text()}
              </p>
            )}
          </Show>

          <div class="git-commit-box">
            <textarea
              class="git-message"
              rows={3}
              value={message()}
              placeholder={`Message (Ctrl+Enter to commit on ${current().branch})`}
              aria-label="Commit message"
              onInput={event => setMessage(event.currentTarget.value)}
              onKeyDown={onMessageKey}
            />
            <Button variant="primary" class="git-commit-button" disabled={!canCommit()} onClick={commit}>
              Commit
            </Button>
          </div>

          <div class="git-scroll">
            <Section title="Staged" count={staged().length} open={stagedOpen()} onToggle={() => setStagedOpen(!stagedOpen())}>
              <ul class="git-list">
                <For each={staged()} fallback={<li class="git-empty">No staged changes</li>}>
                  {change => {
                    const target = () => stagedTarget(change.path);
                    return (
                      <ChangeRow
                        change={change}
                        open={!!open()[keyOf(target())]}
                        diff={diffs()[keyOf(target())]}
                        disabled={busy()}
                        onToggle={() => toggleDiff(target())}
                        onStageToggle={() => void act(() => git.unstage(undefined, [change.path]))}
                        stageLabel="Unstage"
                      />
                    );
                  }}
                </For>
              </ul>
            </Section>

            <Section title="Changes" count={unstaged().length} open={changesOpen()} onToggle={() => setChangesOpen(!changesOpen())}>
              <ul class="git-list">
                <For each={unstaged()} fallback={<li class="git-empty">No changes</li>}>
                  {change => {
                    const target = () => changeTarget(change);
                    return (
                      <ChangeRow
                        change={change}
                        open={!!open()[keyOf(target())]}
                        diff={diffs()[keyOf(target())]}
                        disabled={busy()}
                        onToggle={() => toggleDiff(target())}
                        onStageToggle={() => void act(() => git.stage(undefined, [change.path]))}
                        stageLabel="Stage"
                        onDiscard={() => discard(change)}
                      />
                    );
                  }}
                </For>
              </ul>
            </Section>

            <Section title="Graph" count={commits().length} open={graphOpen()} onToggle={() => setGraphOpen(!graphOpen())}>
              <CommitGraph commits={commits()} />
            </Section>
          </div>

          <Menu
            anchor={branchAnchor()}
            open={branchOpen()}
            onClose={() => setBranchOpen(false)}
            placement="bottom-start"
            items={branchItems()}
            onSelect={onBranchPick}
          />
          <Menu
            anchor={moreAnchor()}
            open={moreOpen()}
            onClose={() => setMoreOpen(false)}
            placement="bottom-end"
            items={moreItems()}
            onSelect={onMore}
          />
        </>
      )}
    </Show>
  );
}

// ---------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------

/** What shows instead of the panel: loading, an error, or "not a repository" with an init button. */
function Unavailable(props: { status?: GitStatusResult; busy: boolean; notice?: string; onInit: () => void }): JSX.Element {
  return (
    <Show when={props.status} fallback={<p class="git-note">Loading…</p>}>
      {current => (
        <Show
          when={isError(current()) ? (current() as { error: string }) : undefined}
          fallback={<NoRepo busy={props.busy} notice={props.notice} onInit={props.onInit} />}
        >
          {failed => <p class="git-note git-note-error">{failed().error}</p>}
        </Show>
      )}
    </Show>
  );
}

function NoRepo(props: { busy: boolean; notice?: string; onInit: () => void }): JSX.Element {
  return (
    <div class="git-empty-state">
      <p class="git-empty-title">Not a git repository</p>
      <p class="git-note">The project folder is not under version control yet.</p>
      <Button variant="secondary" disabled={props.busy} onClick={props.onInit}>
        Initialize repository
      </Button>
      <Show when={props.notice}>{text => <p class="git-note git-note-error">{text()}</p>}</Show>
    </div>
  );
}

function Section(props: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <section class="git-section">
      <button type="button" class="git-section-toggle" aria-expanded={props.open} onClick={props.onToggle}>
        <Icon name={props.open ? 'chevron' : 'chevronRight'} size={12} />
        <span class="git-section-title">{props.title}</span>
        <span class="git-badge">{props.count}</span>
      </button>
      <Collapse open={props.open}>{props.children}</Collapse>
    </section>
  );
}

function ChangeRow(props: {
  change: GitChange;
  open: boolean;
  diff?: GitDiffResult;
  disabled: boolean;
  onToggle: () => void;
  onStageToggle: () => void;
  /** "Stage" or "Unstage": the label of the +/− button. */
  stageLabel: string;
  onDiscard?: () => void;
}): JSX.Element {
  const parts = () => splitPath(props.change.path);
  return (
    <li class="git-change" classList={{ open: props.open }}>
      <div class="git-row">
        <button type="button" class="git-row-main" title={props.change.path} aria-expanded={props.open} onClick={props.onToggle}>
          <span class="git-name">{parts().name}</span>
          <Show when={parts().dir}>
            <span class="git-dir">{parts().dir}</span>
          </Show>
        </button>
        <span class="git-row-actions">
          <IconButton
            icon={props.stageLabel === 'Stage' ? 'plus' : 'minimize'}
            label={props.stageLabel}
            size="small"
            disabled={props.disabled}
            onClick={props.onStageToggle}
          />
          <Show when={props.onDiscard}>
            <IconButton icon="trash" label="Discard changes" size="small" disabled={props.disabled} onClick={() => props.onDiscard?.()} />
          </Show>
          <IconButton icon="file" label={props.open ? 'Hide diff' : 'Show diff'} size="small" onClick={props.onToggle} />
        </span>
        <span class={`git-status git-status-${props.change.status}`} title={statusName(props.change.status)}>
          {props.change.status}
        </span>
      </div>
      <Collapse open={props.open} class="git-diff-wrap">
        <Show when={props.diff} fallback={<p class="git-note">Loading diff…</p>}>
          {result => <DiffView result={result()} />}
        </Show>
      </Collapse>
    </li>
  );
}

function DiffView(props: { result: GitDiffResult }): JSX.Element {
  if (isError(props.result)) return <p class="git-note git-note-error">{props.result.error}</p>;
  const { text, truncated } = props.result;
  const lines = text.split('\n');
  return (
    <div class="git-diff">
      <Show when={text.trim()} fallback={<p class="git-note">No text changes.</p>}>
        <For each={lines}>{line => <div class={`git-diff-line ${diffClass(line)}`}>{line || ' '}</div>}</For>
        <Show when={truncated}>
          <div class="git-diff-line git-diff-meta">… diff cut short</div>
        </Show>
      </Show>
    </div>
  );
}

function diffClass(line: string): string {
  if (line.startsWith('+++ ') || line.startsWith('--- ')) return 'git-diff-meta';
  if (line.startsWith('@@')) return 'git-diff-hunk';
  if (line.startsWith('+')) return 'git-diff-add';
  if (line.startsWith('-')) return 'git-diff-del';
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'git-diff-meta';
  return '';
}

function CommitGraph(props: { commits: GitCommit[] }): JSX.Element {
  const graph = createMemo(() => layoutGraph(props.commits));
  const columns = createMemo(() => Array.from({ length: graph().width }, (_, index) => index));
  return (
    <ol class="git-commits">
      <For each={graph().rows} fallback={<li class="git-empty">No commits yet</li>}>
        {row => {
          const isHead = row.commit.refs.some(ref => ref === 'HEAD' || ref.startsWith('HEAD -> '));
          return (
            <li class="git-commit">
              <div class="git-lanes" style={{ width: `${graph().width * LANE_WIDTH}px` }}>
                <For each={columns()}>
                  {column => (
                    <>
                      <Show when={row.before[column]}>
                        <span class="git-lane git-lane-top" style={{ left: `${laneX(column) - 1}px` }} />
                      </Show>
                      <Show when={row.after[column]}>
                        <span class="git-lane git-lane-bottom" style={{ left: `${laneX(column) - 1}px` }} />
                      </Show>
                    </>
                  )}
                </For>
                <span class="git-dot" classList={{ head: isHead }} style={{ left: `${laneX(row.column) - 4}px` }} />
              </div>
              <div class="git-commit-text">
                <div class="git-commit-top">
                  <span class="git-subject" title={row.commit.subject}>{row.commit.subject}</span>
                  <For each={row.commit.refs.map(chipOf)}>
                    {chip => <span class={`git-chip git-chip-${chip.kind}`} title={chip.label}>{chip.label}</span>}
                  </For>
                </div>
                <span class="git-meta" title={`${row.commit.short} · ${row.commit.author} · ${row.commit.date}`}>
                  {row.commit.author} · {row.commit.date}
                </span>
              </div>
            </li>
          );
        }}
      </For>
    </ol>
  );
}
