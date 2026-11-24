/**
 * Source Control: runs `git` for the renderer's Source Control pane. Every call is `execFile('git', args)` (no shell)
 * in the repository root, so paths from `status` are always valid pathspecs. Nothing here throws into the renderer:
 * a failure comes back as `{ error }`.
 *
 * Channels: `unify:git-<name>`, each `(cwd, ...args)`. `cwd` is an optional folder inside the repo (unset = the
 * project folder). Network steps (pull, push, fetch) never prompt for credentials (GIT_TERMINAL_PROMPT=0).
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { devNull } from 'node:os';

export type GitLetter = 'M' | 'A' | 'D' | 'R' | 'C' | 'U';

export interface GitChange {
  path: string;
  status: GitLetter;
  /** Renames and copies: where the file came from. */
  origPath?: string;
}

export type GitStatusResult =
  | { repo: false }
  | {
      repo: true;
      root: string;
      branch: string;
      ahead: number;
      behind: number;
      hasUpstream: boolean;
      staged: GitChange[];
      unstaged: GitChange[];
    }
  | { error: string };

export interface GitCommit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: string;
  /** Decorations from %D, e.g. "HEAD -> main", "origin/main", "tag: v1". */
  refs: string[];
  parents: string[];
}

export type GitLogResult = { commits: GitCommit[] } | { error: string };
export type GitDiffResult = { text: string; truncated: boolean } | { error: string };
export type GitActionResult = { ok: true } | { error: string };
export type GitBranchesResult = { current: string; local: string[]; remote: string[] } | { error: string };

const LOG_LIMIT = 50;
const DIFF_LINE_LIMIT = 2000;
const QUICK_TIMEOUT_MS = 20_000;
const NETWORK_TIMEOUT_MS = 120_000;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Runs git without a shell. Resolves with the exit code; rejects only when git cannot be started. */
function run(cwd: string, args: string[], options: { input?: string; timeout?: number } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        timeout: options.timeout ?? QUICK_TIMEOUT_MS,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        // A string code (ENOENT, EACCES...) means git never ran; a numeric one is git's exit status.
        const code: unknown = error?.code;
        if (error && typeof code === 'string') {
          reject(error);
          return;
        }
        resolve({ code: error ? (typeof code === 'number' ? code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/** Stderr (or stdout) of a failed command, first line, for the notice. */
function failure(result: RunResult, fallback: string): string {
  const text = (result.stderr || result.stdout).trim();
  return text ? text.split('\n')[0] : fallback;
}

function startFailure(error: unknown): string {
  const message = describe(error);
  if (message.includes('ENOENT')) return 'Git is not installed or not on PATH.';
  return message;
}

/** The folder to run in: the requested one when it is a directory, else the project folder, else undefined. */
function baseFolder(requested: unknown, getProjectPath: () => string | undefined): string | undefined {
  if (typeof requested === 'string' && requested && isDirectory(requested)) return requested;
  let project: string | undefined;
  try {
    project = getProjectPath();
  } catch {
    project = undefined;
  }
  return project && isDirectory(project) ? project : undefined;
}

/** Top-level folder of the repository containing `folder`, or undefined when it is not inside one. */
async function repoRoot(folder: string): Promise<string | undefined> {
  const result = await run(folder, ['rev-parse', '--show-toplevel']);
  if (result.code !== 0) return undefined;
  const root = result.stdout.trim();
  return root && existsSync(root) ? root : undefined;
}

/** Splits off the first `count` space-separated fields; the rest (a path, which may hold spaces) is returned whole. */
function takeFields(line: string, count: number): { fields: string[]; rest: string } {
  const fields: string[] = [];
  let rest = line;
  for (let index = 0; index < count; index++) {
    const at = rest.indexOf(' ');
    if (at < 0) break;
    fields.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  return { fields, rest };
}

/** Index letter X or worktree letter Y of porcelain v2 `XY`, mapped to the letters the UI shows. */
function letterOf(code: string): GitLetter | undefined {
  switch (code) {
    case 'M':
    case 'T':
      return 'M';
    case 'A':
      return 'A';
    case 'D':
      return 'D';
    case 'R':
      return 'R';
    case 'C':
      return 'R';
    case 'U':
      return 'C';
    default:
      return undefined;
  }
}

/** Parses `git status --porcelain=v2 --branch -z`. */
function parseStatus(output: string): Omit<Extract<GitStatusResult, { repo: true }>, 'repo' | 'root'> {
  const result = {
    branch: '',
    ahead: 0,
    behind: 0,
    hasUpstream: false,
    staged: [] as GitChange[],
    unstaged: [] as GitChange[],
  };
  let oid = '';
  const tokens = output.split('\0');
  for (let index = 0; index < tokens.length; index++) {
    const line = tokens[index];
    if (!line) continue;
    if (line.startsWith('# ')) {
      if (line.startsWith('# branch.oid ')) oid = line.slice('# branch.oid '.length);
      else if (line.startsWith('# branch.head ')) result.branch = line.slice('# branch.head '.length);
      else if (line.startsWith('# branch.upstream ')) result.hasUpstream = true;
      else if (line.startsWith('# branch.ab ')) {
        const [ahead, behind] = line.slice('# branch.ab '.length).split(' ');
        result.ahead = Math.abs(Number(ahead)) || 0;
        result.behind = Math.abs(Number(behind)) || 0;
      }
      continue;
    }
    const kind = line[0];
    if (kind === '?') {
      result.unstaged.push({ path: line.slice(2), status: 'U' });
      continue;
    }
    if (kind !== '1' && kind !== '2' && kind !== 'u') continue;

    // Ordinary: 8 fields before the path. Renamed: 9 before, then the origin path as the next token. Unmerged: 10.
    const fieldCount = kind === '1' ? 8 : kind === '2' ? 9 : 10;
    const { fields, rest } = takeFields(line, fieldCount);
    const xy = fields[1] ?? '..';
    const path = rest;
    let origPath: string | undefined;
    if (kind === '2') origPath = tokens[++index];
    const indexLetter = xy[0] === '.' ? undefined : letterOf(xy[0]);
    const worktreeLetter = xy[1] === '.' ? undefined : letterOf(xy[1]);
    if (kind === 'u') {
      result.unstaged.push({ path, status: 'C' });
      continue;
    }
    if (indexLetter) result.staged.push({ path, status: indexLetter, origPath });
    if (worktreeLetter) result.unstaged.push({ path, status: worktreeLetter, origPath });
  }
  // Detached HEAD: show the short commit instead of "(detached)".
  if (result.branch === '(detached)') result.branch = oid && oid !== '(initial)' ? oid.slice(0, 7) : 'detached';
  return result;
}

async function status(cwd: string | undefined, getProjectPath: () => string | undefined): Promise<GitStatusResult> {
  const folder = baseFolder(cwd, getProjectPath);
  if (!folder) return { repo: false };
  const root = await repoRoot(folder);
  if (!root) return { repo: false };
  const result = await run(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  if (result.code !== 0) return { error: failure(result, 'Could not read the repository status.') };
  return { repo: true, root, ...parseStatus(result.stdout) };
}

/** Parses the %D decoration list ("HEAD -> main, origin/main, tag: v1") into plain names. */
function refsOf(decorations: string): string[] {
  return decorations
    .split(',')
    .map(ref => ref.trim())
    .filter(Boolean);
}

async function log(cwd: string | undefined, getProjectPath: () => string | undefined): Promise<GitLogResult> {
  const folder = baseFolder(cwd, getProjectPath);
  const root = folder ? await repoRoot(folder) : undefined;
  if (!root) return { error: 'Not a git repository.' };
  const format = ['%H', '%h', '%s', '%an', '%ar', '%D', '%P'].join('%x1f');
  const result = await run(root, ['log', `--format=${format}`, '-n', String(LOG_LIMIT), '--all']);
  // An empty repository has no commits yet: git fails, which is not an error for the Graph.
  if (result.code !== 0) {
    return /does not have any commits|bad default revision/.test(result.stderr) ? { commits: [] } : { error: failure(result, 'Could not read the history.') };
  }
  const commits = result.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [hash, short, subject, author, date, decorations, parents] = line.split('\x1f');
      return {
        hash,
        short,
        subject,
        author,
        date,
        refs: refsOf(decorations ?? ''),
        parents: (parents ?? '').split(' ').filter(Boolean),
      };
    });
  return { commits };
}

async function diff(
  cwd: string | undefined,
  getProjectPath: () => string | undefined,
  path: unknown,
  options: { staged?: unknown; untracked?: unknown },
): Promise<GitDiffResult> {
  if (typeof path !== 'string' || !path) return { error: 'Invalid path.' };
  const folder = baseFolder(cwd, getProjectPath);
  const root = folder ? await repoRoot(folder) : undefined;
  if (!root) return { error: 'Not a git repository.' };
  const args = options.untracked
    ? ['diff', '--no-index', '--no-color', '--', devNull, path]
    : ['diff', '--no-color', ...(options.staged ? ['--cached'] : []), '--', path];
  const result = await run(root, args, { timeout: NETWORK_TIMEOUT_MS });
  // `--no-index` exits 1 when the files differ, which is the normal case there.
  if (result.code !== 0 && !(options.untracked && result.code === 1)) {
    return { error: failure(result, 'Could not read the diff.') };
  }
  const lines = result.stdout.split('\n');
  if (lines.length <= DIFF_LINE_LIMIT) return { text: result.stdout, truncated: false };
  return { text: lines.slice(0, DIFF_LINE_LIMIT).join('\n'), truncated: true };
}

/** Runs a repository-wide action in the root and reports its failure. */
async function act(
  cwd: string | undefined,
  getProjectPath: () => string | undefined,
  args: string[],
  options: { input?: string; timeout?: number; fallback: string },
): Promise<GitActionResult> {
  const folder = baseFolder(cwd, getProjectPath);
  const root = folder ? await repoRoot(folder) : undefined;
  if (!root) return { error: 'Not a git repository.' };
  const result = await run(root, args, { input: options.input, timeout: options.timeout });
  return result.code === 0 ? { ok: true } : { error: failure(result, options.fallback) };
}

/** Puts pathspecs after `--` so a file named like an option is never read as one. */
function pathArgs(paths: string[]): string[] {
  return ['--', ...paths];
}

/** The repository root of `cwd` (or the project folder), or undefined when there is no repository. */
async function rootFor(cwd: string | undefined, getProjectPath: () => string | undefined): Promise<string | undefined> {
  const folder = baseFolder(cwd, getProjectPath);
  return folder ? repoRoot(folder) : undefined;
}

async function hasUpstream(root: string): Promise<boolean> {
  return (await run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).code === 0;
}

/** Pushes the current branch. The first push of a branch sets its upstream on origin. */
async function pushBranch(root: string): Promise<RunResult> {
  const args = (await hasUpstream(root)) ? ['push'] : ['push', '--set-upstream', 'origin', 'HEAD'];
  return run(root, args, { timeout: NETWORK_TIMEOUT_MS });
}

/** A branch name git accepts and that cannot be read as an option. */
async function validBranchName(root: string, name: string): Promise<boolean> {
  if (!name || name.startsWith('-')) return false;
  return (await run(root, ['check-ref-format', '--branch', name])).code === 0;
}

async function refExists(root: string, ref: string): Promise<boolean> {
  return (await run(root, ['show-ref', '--verify', '--quiet', ref])).code === 0;
}

function isPathList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
}

/** Installs the `unify:git-*` IPC channels. `getProjectPath` supplies the default folder. */
export function registerGitIpc(getProjectPath: () => string | undefined): void {
  const folderArg = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const safely = async <T>(fallback: (message: string) => T, body: () => Promise<T>): Promise<T> => {
    try {
      return await body();
    } catch (error) {
      console.error(`[unify] git failed: ${describe(error)}`);
      return fallback(startFailure(error));
    }
  };

  ipcMain.handle('unify:git-status', (_event: IpcMainInvokeEvent, cwd: unknown) =>
    safely<GitStatusResult>(error => ({ error }), () => status(folderArg(cwd), getProjectPath)),
  );

  ipcMain.handle('unify:git-log', (_event: IpcMainInvokeEvent, cwd: unknown) =>
    safely<GitLogResult>(error => ({ error }), () => log(folderArg(cwd), getProjectPath)),
  );

  ipcMain.handle('unify:git-diff', (_event: IpcMainInvokeEvent, cwd: unknown, path: unknown, options: unknown) =>
    safely<GitDiffResult>(error => ({ error }), () =>
      diff(folderArg(cwd), getProjectPath, path, (options ?? {}) as { staged?: unknown; untracked?: unknown }),
    ),
  );

  // Stage or unstage paths; `null` means every change (`git add -A`).
  ipcMain.handle('unify:git-stage', (_event: IpcMainInvokeEvent, cwd: unknown, paths: unknown) =>
    safely<GitActionResult>(error => ({ error }), () => {
      if (paths !== null && !isPathList(paths)) return Promise.resolve({ error: 'Invalid paths.' });
      const args = paths === null ? ['add', '-A'] : ['add', ...pathArgs(paths as string[])];
      return act(folderArg(cwd), getProjectPath, args, { fallback: 'Could not stage.' });
    }),
  );

  ipcMain.handle('unify:git-unstage', (_event: IpcMainInvokeEvent, cwd: unknown, paths: unknown) =>
    safely<GitActionResult>(error => ({ error }), async () => {
      if (!isPathList(paths)) return { error: 'Invalid paths.' };
      const folder = baseFolder(folderArg(cwd), getProjectPath);
      const root = folder ? await repoRoot(folder) : undefined;
      if (!root) return { error: 'Not a git repository.' };
      // Before the first commit there is no HEAD to reset to; removing from the index does the same job.
      const hasHead = (await run(root, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
      const args = hasHead ? ['reset', '-q', 'HEAD', ...pathArgs(paths)] : ['rm', '--cached', '-r', '-q', ...pathArgs(paths)];
      const result = await run(root, args);
      return result.code === 0 ? { ok: true } : { error: failure(result, 'Could not unstage.') };
    }),
  );

  // Discards working-tree changes: tracked files go back to the index, untracked files are deleted.
  ipcMain.handle('unify:git-discard', (_event: IpcMainInvokeEvent, cwd: unknown, items: unknown) =>
    safely<GitActionResult>(error => ({ error }), async () => {
      if (!Array.isArray(items) || !items.every(item => item && typeof item.path === 'string' && item.path)) {
        return { error: 'Invalid paths.' };
      }
      const folder = baseFolder(folderArg(cwd), getProjectPath);
      const root = folder ? await repoRoot(folder) : undefined;
      if (!root) return { error: 'Not a git repository.' };
      const tracked = items.filter(item => !item.untracked).map(item => item.path as string);
      const untracked = items.filter(item => item.untracked).map(item => item.path as string);
      if (tracked.length) {
        const result = await run(root, ['checkout', '--', ...tracked]);
        if (result.code !== 0) return { error: failure(result, 'Could not discard changes.') };
      }
      if (untracked.length) {
        const result = await run(root, ['clean', '-f', '-q', ...pathArgs(untracked)]);
        if (result.code !== 0) return { error: failure(result, 'Could not delete the new files.') };
      }
      return { ok: true };
    }),
  );

  // Commit what is staged. The message goes through stdin, so it needs no quoting.
  ipcMain.handle('unify:git-commit', (_event: IpcMainInvokeEvent, cwd: unknown, message: unknown, options: unknown) =>
    safely<GitActionResult>(error => ({ error }), () => {
      const amend = !!(options as { amend?: unknown } | undefined)?.amend;
      const text = typeof message === 'string' ? message.trim() : '';
      if (!text && !amend) return Promise.resolve({ error: 'Enter a commit message.' });
      const args = ['commit', '-F', '-', ...(amend ? ['--amend'] : []), ...(!text ? ['--no-edit'] : [])];
      return act(folderArg(cwd), getProjectPath, args, { input: text, fallback: 'Commit failed.' });
    }),
  );

  ipcMain.handle('unify:git-pull', (_event: IpcMainInvokeEvent, cwd: unknown, options: unknown) =>
    safely<GitActionResult>(error => ({ error }), () => {
      const rebase = !!(options as { rebase?: unknown } | undefined)?.rebase;
      const args = ['pull', rebase ? '--rebase' : '--no-edit'];
      return act(folderArg(cwd), getProjectPath, args, { timeout: NETWORK_TIMEOUT_MS, fallback: 'Pull failed.' });
    }),
  );

  ipcMain.handle('unify:git-push', (_event: IpcMainInvokeEvent, cwd: unknown) =>
    safely<GitActionResult>(error => ({ error }), async () => {
      const root = await rootFor(folderArg(cwd), getProjectPath);
      if (!root) return { error: 'Not a git repository.' };
      const result = await pushBranch(root);
      return result.code === 0 ? { ok: true } : { error: failure(result, 'Push failed.') };
    }),
  );

  // Pull (merge), then push. Stops at the first failure. Without an upstream there is nothing to pull from,
  // so it just pushes, which sets the upstream.
  ipcMain.handle('unify:git-sync', (_event: IpcMainInvokeEvent, cwd: unknown) =>
    safely<GitActionResult>(error => ({ error }), async () => {
      const root = await rootFor(folderArg(cwd), getProjectPath);
      if (!root) return { error: 'Not a git repository.' };
      if (await hasUpstream(root)) {
        const pulled = await run(root, ['pull', '--no-edit'], { timeout: NETWORK_TIMEOUT_MS });
        if (pulled.code !== 0) return { error: failure(pulled, 'Pull failed.') };
      }
      const pushed = await pushBranch(root);
      return pushed.code === 0 ? { ok: true } : { error: failure(pushed, 'Push failed.') };
    }),
  );

  // Local branches, then remote-tracking branches (origin/HEAD left out).
  ipcMain.handle('unify:git-branches', (_event: IpcMainInvokeEvent, cwd: unknown) =>
    safely<GitBranchesResult>(error => ({ error }), async () => {
      const root = await rootFor(folderArg(cwd), getProjectPath);
      if (!root) return { error: 'Not a git repository.' };
      const refs = await run(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
      if (refs.code !== 0) return { error: failure(refs, 'Could not list branches.') };
      const current = await run(root, ['branch', '--show-current']);
      const local: string[] = [];
      const remote: string[] = [];
      for (const ref of refs.stdout.split('\n')) {
        if (ref.startsWith('refs/heads/')) local.push(ref.slice('refs/heads/'.length));
        else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) remote.push(ref.slice('refs/remotes/'.length));
      }
      return { current: current.stdout.trim(), local, remote };
    }),
  );

  // A local branch is switched to; a remote-only name such as origin/foo gets a local tracking branch.
  ipcMain.handle('unify:git-checkout', (_event: IpcMainInvokeEvent, cwd: unknown, branch: unknown) =>
    safely<GitActionResult>(error => ({ error }), async () => {
      if (typeof branch !== 'string' || !branch || branch.startsWith('-')) return { error: 'Invalid branch.' };
      const root = await rootFor(folderArg(cwd), getProjectPath);
      if (!root) return { error: 'Not a git repository.' };
      let args: string[];
      if (await refExists(root, `refs/heads/${branch}`)) args = ['switch', branch];
      else if (await refExists(root, `refs/remotes/${branch}`)) args = ['switch', '--track', branch];
      else return { error: `No branch named ${branch}.` };
      const result = await run(root, args);
      return result.code === 0 ? { ok: true } : { error: failure(result, 'Could not switch branches.') };
    }),
  );

  ipcMain.handle('unify:git-create-branch', (_event: IpcMainInvokeEvent, cwd: unknown, name: unknown) =>
    safely<GitActionResult>(error => ({ error }), async () => {
      const root = await rootFor(folderArg(cwd), getProjectPath);
      if (!root) return { error: 'Not a git repository.' };
      const text = typeof name === 'string' ? name.trim() : '';
      if (!(await validBranchName(root, text))) return { error: 'That is not a valid branch name.' };
      const result = await run(root, ['switch', '-c', text]);
      return result.code === 0 ? { ok: true } : { error: failure(result, 'Could not create the branch.') };
    }),
  );

  // Stashes tracked changes; `includeUntracked` also takes new files (`stash push -u`).
  ipcMain.handle('unify:git-stash', (_event: IpcMainInvokeEvent, cwd: unknown, options: unknown) =>
    safely<GitActionResult>(error => ({ error }), () => {
      const untracked = !!(options as { includeUntracked?: unknown } | undefined)?.includeUntracked;
      const args = ['stash', 'push', ...(untracked ? ['-u'] : [])];
      return act(folderArg(cwd), getProjectPath, args, { fallback: 'Could not stash.' });
    }),
  );

  ipcMain.handle('unify:git-stash-pop', (_event: IpcMainInvokeEvent, cwd: unknown) =>
    safely<GitActionResult>(error => ({ error }), () =>
      act(folderArg(cwd), getProjectPath, ['stash', 'pop'], { fallback: 'Could not pop the stash.' }),
    ),
  );

  // Moves HEAD back one commit and keeps its changes staged.
  ipcMain.handle('unify:git-undo-commit', (_event: IpcMainInvokeEvent, cwd: unknown) =>
    safely<GitActionResult>(error => ({ error }), async () => {
      const root = await rootFor(folderArg(cwd), getProjectPath);
      if (!root) return { error: 'Not a git repository.' };
      const hasParent = (await run(root, ['rev-parse', '--verify', '-q', 'HEAD~1'])).code === 0;
      if (!hasParent) return { error: 'There is no commit to undo.' };
      const result = await run(root, ['reset', '--soft', 'HEAD~1']);
      return result.code === 0 ? { ok: true } : { error: failure(result, 'Could not undo the commit.') };
    }),
  );

  ipcMain.handle('unify:git-fetch', (_event: IpcMainInvokeEvent, cwd: unknown) =>
    safely<GitActionResult>(error => ({ error }), () =>
      act(folderArg(cwd), getProjectPath, ['fetch', '--prune'], { timeout: NETWORK_TIMEOUT_MS, fallback: 'Fetch failed.' }),
    ),
  );

  // Turns the project folder (or `cwd`) into a repository.
  ipcMain.handle('unify:git-init', (_event: IpcMainInvokeEvent, cwd: unknown) =>
    safely<GitActionResult>(error => ({ error }), async () => {
      const folder = baseFolder(folderArg(cwd), getProjectPath);
      if (!folder) return { error: 'No project folder is open.' };
      const result = await run(folder, ['init']);
      return result.code === 0 ? { ok: true } : { error: failure(result, 'Could not initialize the repository.') };
    }),
  );
}
