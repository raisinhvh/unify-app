/**
 * GitHub sign-in for Unify.
 *
 * The personal access token pasted in Settings is preferred when one is stored; otherwise the
 * GitHub CLI's token is used when `gh` is installed and signed in. The `gh` lookup is cached with
 * a short TTL, including when `gh` is unavailable, so it is not spawned on every check. The pasted
 * token goes to the host's secret store when one is installed (Electron's `safeStorage` through the
 * shim's `context.secrets`) and to `<unifyHome()>/github-token` with user-only permissions when it
 * is not.
 *
 * Tokens are never logged. Validation is `GET https://api.github.com/user`,
 * which also yields the login shown in Settings and used by the sync account.
 */
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unifyHome } from './settings';

export interface GithubAuth {
  token: string;
  login: string;
  source: 'gh' | 'token';
}

/** The host's secret storage (`context.secrets`), when the shim has one. */
export interface GithubSecretStore {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const SECRET_KEY = 'unify.github-token';
const TOKEN_FILE = 'github-token';
const API = 'https://api.github.com';
const USER_AGENT = 'unify';
const CACHE_MS = 10 * 60 * 1000;
const GH_CACHE_MS = 60 * 1000;
const GH_TIMEOUT_MS = 5000;

let secretStore: GithubSecretStore | undefined;
let cached: { auth: GithubAuth | undefined; at: number } | undefined;
let ghCached: { token: string | undefined; at: number } | undefined;
let ghPending: Promise<string | undefined> | undefined;
const listeners = new Set<(auth: GithubAuth | undefined) => void>();

/** Called by main with the shim's secret storage; without it the token file is used. */
export function configureGithubSecretStore(store: GithubSecretStore | undefined): void {
  secretStore = store;
  cached = undefined;
}

/** Resolves the signed-in GitHub account, preferring the token saved in Settings. */
export async function getGithubAuth(): Promise<GithubAuth | undefined> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.auth;
  const stored = await readStoredToken();
  if (stored) {
    try {
      const auth: GithubAuth = { token: stored, login: await loginForToken(stored), source: 'token' };
      remember(auth);
      return auth;
    } catch {
      // An invalid pasted token is reported by setGithubToken when it is saved; try the CLI below.
    }
  }
  const ghToken = await cachedGhToken();
  if (ghToken) {
    try {
      const auth: GithubAuth = { token: ghToken, login: await loginForToken(ghToken), source: 'gh' };
      remember(auth);
      return auth;
    } catch {
      // A stale `gh auth token` still means no usable account.
    }
  }
  remember(undefined);
  return undefined;
}

/** Re-checks the stored token and the GitHub CLI, ignoring both caches. */
export async function refreshGithubAuth(): Promise<GithubAuth | undefined> {
  cached = undefined;
  ghCached = undefined;
  ghPending = undefined;
  return getGithubAuth();
}

/**
 * Validates and stores a personal access token. Throws with a readable message
 * when GitHub rejects it, and leaves the previous token in place.
 */
export async function setGithubToken(token: string): Promise<GithubAuth> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('Paste a GitHub personal access token first.');
  const login = await loginForToken(trimmed);
  await writeStoredToken(trimmed);
  const auth: GithubAuth = { token: trimmed, login, source: 'token' };
  remember(auth);
  announce(auth);
  return auth;
}

/** Forgets the pasted token. A signed-in GitHub CLI is still reported afterwards. */
export async function clearGithubToken(): Promise<void> {
  if (secretStore) await secretStore.delete(SECRET_KEY);
  try {
    rmSync(tokenPath(), { force: true });
  } catch {
    // The file may be missing or locked; forgetting the cache is what matters.
  }
  cached = undefined;
  announce(undefined);
}

export function onGithubAuthChange(listener: (auth: GithubAuth | undefined) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function remember(auth: GithubAuth | undefined): void {
  cached = { auth, at: Date.now() };
}

function announce(auth: GithubAuth | undefined): void {
  for (const listener of [...listeners]) {
    try {
      listener(auth);
    } catch {
      // A listener must not break sign-in.
    }
  }
}

/**
 * The `gh auth token` result for a short while, including "no token". Concurrent callers share one
 * spawn so a signed-out or missing `gh` does not add its five-second deadline to every check.
 */
function cachedGhToken(): Promise<string | undefined> {
  if (ghCached && Date.now() - ghCached.at < GH_CACHE_MS) return Promise.resolve(ghCached.token);
  if (!ghPending) {
    ghPending = ghTokenFromCli()
      .then(token => {
        ghCached = { token, at: Date.now() };
        return token;
      })
      .finally(() => {
        ghPending = undefined;
      });
  }
  return ghPending;
}

/** Runs `gh auth token` without a shell, with a short deadline. */
function ghTokenFromCli(): Promise<string | undefined> {
  return new Promise(resolveToken => {
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      resolveToken(value);
    };
    try {
      execFile('gh', ['auth', 'token'], { timeout: GH_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => {
        if (error) {
          finish(undefined);
          return;
        }
        const token = String(stdout).trim();
        finish(token || undefined);
      });
    } catch {
      // Missing binary: fall back to the pasted token.
      finish(undefined);
    }
  });
}

async function loginForToken(token: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${API}/user`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': USER_AGENT,
        'x-github-api-version': '2022-11-28',
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach GitHub to check the token: ${reason}`);
  }
  if (response.status === 401) {
    throw new Error('GitHub rejected this token. Paste a valid personal access token with repo access.');
  }
  if (!response.ok) {
    throw new Error(`GitHub could not check the token (HTTP ${response.status}).`);
  }
  const body = await response.json() as { login?: unknown };
  if (typeof body.login !== 'string' || !body.login) {
    throw new Error('GitHub answered without a login for this token.');
  }
  return body.login;
}

function tokenPath(): string {
  return join(unifyHome(), TOKEN_FILE);
}

async function readStoredToken(): Promise<string | undefined> {
  if (secretStore) {
    const stored = await secretStore.get(SECRET_KEY);
    return stored?.trim() || undefined;
  }
  try {
    return readFileSync(tokenPath(), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

async function writeStoredToken(token: string): Promise<void> {
  if (secretStore) {
    await secretStore.store(SECRET_KEY, token);
    return;
  }
  mkdirSync(unifyHome(), { recursive: true });
  writeFileSync(tokenPath(), token, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tokenPath(), 0o600);
  } catch {
    // Windows ignores POSIX modes; the file is still in the user's own folder.
  }
}
