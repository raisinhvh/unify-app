import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import * as vscode from 'vscode';
import { loginCodex, readCodexTokens } from './codexAuth';

export type OAuthCliProvider = 'codex-cli' | 'claude-cli';
export interface OAuthCliAccount {
  id: string;
  provider: OAuthCliProvider;
  label: string;
  email?: string;
  directory: string;
}

const KEY = 'unify.oauthCliAccounts.v1';
const DEFAULTS = 'unify.oauthCliDefaults.v1';
const detectedCommands = new Map<string, string>();

export function setDetectedCliCommand(provider: string, command: string): void {
  detectedCommands.set(provider, command);
}

/** The Claude Code CLI command. ChatGPT (Codex) accounts run natively and need no CLI. */
export function cliCommand(provider: 'claude-cli'): string {
  const section = vscode.workspace.getConfiguration('unify');
  const setting = vscode.workspace.getConfiguration('unify').get<string>('runtime.claudePath')?.trim();
  if (setting) return setting;
  const detected = detectedCommands.get(provider);
  if (detected) return detected;
  if (process.platform === 'win32') {
    const installed = join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(installed)) return installed;
  }
  return 'claude';
}

/** The environment for a Claude Code CLI child, pointed at the account's isolated config directory. */
export function cliEnv(account: OAuthCliAccount): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.CLAUDE_CONFIG_DIR = account.directory;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  delete env.CLAUDE_CODE_USE_FOUNDRY;
  return env;
}

function execute(account: OAuthCliAccount, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    let done = false;
    const child = spawn(cliCommand('claude-cli'), args, { env: cliEnv(account), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); finish(new Error('Browser sign-in timed out.')); }, timeoutMs);
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(output);
    };
    const read = (data: Buffer): void => { output = (output + data.toString('utf8')).slice(-32768); };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', () => finish(new Error('Claude Code CLI could not start. Check its path in Settings.')));
    child.on('close', code => finish(code === 0 ? undefined : new Error('Sign-in command failed. Check the Claude Code login in a terminal.')));
  });
}

/** Like `execute`, but resolves with the output whatever the exit code: `auth status` reports a sign-out with exit 1. */
function capture(account: OAuthCliAccount, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(cliCommand('claude-cli'), args, { env: cliEnv(account), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Claude Code CLI timed out.')); }, timeoutMs);
    child.stdout.on('data', data => { output = (output + data.toString('utf8')).slice(-32768); });
    child.stderr.on('data', data => { output = (output + data.toString('utf8')).slice(-32768); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', () => { clearTimeout(timer); resolve(output); });
  });
}

/**
 * Whether an account's stored sign-in is confirmed gone: Claude Code says it is signed out, or the ChatGPT
 * auth.json is missing or unusable. Anything that could be transient (a timeout, a network error) is `unknown`,
 * so callers never remove an account on a bad moment.
 */
export async function checkOAuthAccount(account: OAuthCliAccount): Promise<'valid' | 'invalid' | 'unknown'> {
  if (account.provider === 'codex-cli') {
    try { await readCodexTokens(account.directory); return 'valid'; } catch { return 'invalid'; }
  }
  try {
    const info = JSON.parse((await capture(account, ['auth', 'status', '--json'], 15000)).trim()) as { loggedIn?: unknown };
    if (info.loggedIn === false) return 'invalid';
    return info.loggedIn === true ? 'valid' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Same provider and email, compared without case. Accounts without an email never match. */
function sameEmail(a: string | undefined, b: string | undefined): boolean {
  const left = a?.trim().toLowerCase();
  return !!left && left === b?.trim().toLowerCase();
}

/**
 * OAuth credentials live in one isolated directory per account: Claude Code's config directory, or the ChatGPT
 * (Codex) auth.json that Unify signs in to natively.
 */
export class OAuthCliAccounts {
  constructor(private readonly context: vscode.ExtensionContext) {}

  list(provider?: OAuthCliProvider): OAuthCliAccount[] {
    const value = this.context.globalState.get<OAuthCliAccount[]>(KEY, []);
    return (provider ? value.filter(item => item.provider === provider) : value).filter(item =>
      item && typeof item.id === 'string' && typeof item.directory === 'string');
  }

  get(id: string): OAuthCliAccount | undefined { return this.list().find(item => item.id === id); }

  getDefault(provider: OAuthCliProvider): OAuthCliAccount | undefined {
    const defaults = this.context.globalState.get<Record<string, string>>(DEFAULTS, {});
    return this.get(defaults[provider]) || this.list(provider)[0];
  }

  async add(provider: OAuthCliProvider, label: string, email?: string): Promise<OAuthCliAccount> {
    const cleanLabel = label.trim();
    if (!cleanLabel) throw new Error('Account name is required.');
    const account: OAuthCliAccount = {
      id: `${provider}:${randomUUID()}`, provider, label: cleanLabel, email: email?.trim() || undefined,
      directory: join(this.context.globalStorageUri.fsPath, 'oauth', provider, randomUUID()),
    };
    await mkdir(account.directory, { recursive: true });
    try {
      await this.login(account);
    } catch (error) {
      await rm(account.directory, { recursive: true, force: true });
      throw error;
    }
    // Signing in again with the same email refreshes the existing account's credentials, not a second record.
    const existing = this.list(provider).find(item => sameEmail(item.email, account.email));
    if (existing) {
      await mkdir(existing.directory, { recursive: true });
      await cp(account.directory, existing.directory, { recursive: true, force: true });
      await rm(account.directory, { recursive: true, force: true });
      return existing;
    }
    await this.context.globalState.update(KEY, [...this.list(), account]);
    if (!this.getDefault(provider)) await this.setDefault(provider, account.id);
    return account;
  }

  /**
   * One-time cleanup: keeps one record per provider + email (the provider's default, else the newest) and deletes
   * the other directories. Returns how many records were removed.
   */
  async collapseDuplicates(): Promise<number> {
    const groups = new Map<string, OAuthCliAccount[]>();
    for (const account of this.list()) {
      if (!account.email?.trim()) continue;
      const key = `${account.provider}\n${account.email.trim().toLowerCase()}`;
      groups.set(key, [...(groups.get(key) ?? []), account]);
    }
    const dropped = new Map<string, OAuthCliAccount>();
    const explicit = this.context.globalState.get<Record<string, string>>(DEFAULTS, {});
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      // Only a default the user chose counts; otherwise the newest record (added last) is kept.
      const keep = group.find(item => item.id === explicit[group[0].provider]) ?? group[group.length - 1];
      for (const account of group) if (account.id !== keep.id) dropped.set(account.id, keep);
    }
    if (!dropped.size) return 0;
    for (const account of this.list()) {
      const keep = dropped.get(account.id);
      if (keep) await rm(account.directory, { recursive: true, force: true });
    }
    await this.context.globalState.update(KEY, this.list().filter(item => !dropped.has(item.id)));
    const defaults = this.context.globalState.get<Record<string, string>>(DEFAULTS, {});
    const next = { ...defaults };
    for (const [provider, id] of Object.entries(defaults)) {
      const keep = dropped.get(id);
      if (keep) next[provider] = keep.id;
    }
    await this.context.globalState.update(DEFAULTS, next);
    return dropped.size;
  }

  async reauth(id: string): Promise<OAuthCliAccount> {
    const existing = this.get(id);
    if (!existing) throw new Error('Account not found.');
    const account = { ...existing };
    await this.login(account);
    await this.context.globalState.update(KEY, this.list().map(item => item.id === id ? account : item));
    return account;
  }

  private async login(account: OAuthCliAccount): Promise<void> {
    if (account.provider === 'codex-cli') {
      const tokens = await loginCodex(account.directory, {
        openUrl: async url => {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        },
      });
      account.email = tokens.email || account.email;
      return;
    }
    await execute(account, ['auth', 'login', '--claudeai', ...(account.email ? ['--email', account.email] : [])], 300000);
    const status = await execute(account, ['auth', 'status', '--json'], 15000);
    const info = JSON.parse(status) as { loggedIn?: boolean; email?: string; authMethod?: string };
    if (!info.loggedIn || info.authMethod !== 'claude.ai') throw new Error('Claude Code did not report a subscription sign-in.');
    account.email = info.email || account.email;
  }

  async setDefault(provider: OAuthCliProvider, id: string): Promise<void> {
    if (this.get(id)?.provider !== provider) throw new Error('Account does not belong to this provider.');
    const defaults = this.context.globalState.get<Record<string, string>>(DEFAULTS, {});
    await this.context.globalState.update(DEFAULTS, { ...defaults, [provider]: id });
  }

  async remove(id: string): Promise<void> {
    const account = this.get(id);
    if (!account) return;
    const base = resolve(this.context.globalStorageUri.fsPath, 'oauth', account.provider);
    const child = relative(base, resolve(account.directory));
    if (!child || child.startsWith('..') || child.includes(':')) throw new Error('Account storage path is invalid.');
    if (account.provider === 'claude-cli') await execute(account, ['auth', 'logout'], 15000).catch(() => undefined);
    await rm(account.directory, { recursive: true, force: true });
    const remaining = this.list().filter(item => item.id !== id);
    await this.context.globalState.update(KEY, remaining);
    const defaults = this.context.globalState.get<Record<string, string>>(DEFAULTS, {});
    if (defaults[account.provider] === id) {
      const next = remaining.find(item => item.provider === account.provider);
      if (next) defaults[account.provider] = next.id; else delete defaults[account.provider];
      await this.context.globalState.update(DEFAULTS, defaults);
    }
  }
}
