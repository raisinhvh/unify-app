/** The Cursor agent login: model list, launch command, sign-in and sign-out, and sidebar requests for it. */
import type { Host as ExtensionHost } from '../extension';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { AcpRuntime } from '../runtime/acp';
import { parseCursorModelList } from '../unify/cursorModels';
import { ACTIVE_SESSION_KEY, CURSOR_MODELS_KEY } from './constants';

export async function refreshCursorModels(this: ExtensionHost, runtime: AcpRuntime, sessionId: string): Promise<void> {
  const options = runtime.models(sessionId);
  if (!options.length) return;
  this.cursorModels = options.filter(option => option.value !== 'auto').map(option => ({
    name: `Cursor ${option.name}`, provider: 'cursor-acp', backend: option.value, enabled: true,
  }));
  await this.context.workspaceState.update(CURSOR_MODELS_KEY, this.cursorModels);
  this.refreshModels();
}

export function cursorAgentLaunch(this: ExtensionHost): { command: string; args: string[] } {
  const configured = vscode.workspace.getConfiguration('unify').get<string>('runtime.cursorAgentPath')?.trim() || 'agent';
  if (process.platform === 'win32') {
    const root = configured === 'agent' ? join(process.env.LOCALAPPDATA || '', 'cursor-agent')
      : configured.toLowerCase().endsWith('.cmd') || configured.toLowerCase().endsWith('.ps1') ? dirname(configured) : configured;
    const versions = join(root, 'versions');
    if (existsSync(versions)) {
      const latest = readdirSync(versions, { withFileTypes: true }).filter(entry => entry.isDirectory())
        .map(entry => entry.name).sort().reverse().find(version =>
          existsSync(join(versions, version, 'node.exe')) && existsSync(join(versions, version, 'index.js')));
      if (latest) {
        const versionPath = join(versions, latest);
        return {
          command: join(versionPath, 'node.exe'), args: [join(versionPath, 'index.js'), 'acp'],
        };
      }
    }
  }
  return { command: configured, args: ['acp'] };
}

/**
 * Lists the models the signed-in Cursor account can use (`cursor-agent models`: "slug - Name" lines), refreshes
 * the cached list behind `cursorBackends`, and answers like a self-hosted server list (`providerModels`).
 */
export async function listCursorModels(this: ExtensionHost, accountId: string): Promise<void> {
  const post = (models: string[], error?: string) => this.sidebar.postMessage({ type: 'providerModels', accountId, models, ...(error ? { error } : {}) });
  try {
    const output = await this.runCursorCommand('models', undefined, 45000);
    const options = parseCursorModelList(output);
    if (!options.length) throw new Error(/log ?in|sign ?in|auth/i.test(output) ? 'Sign in to Cursor first.' : 'Cursor returned no models.');
    this.cursorModels = options.filter(option => option.value !== 'auto').map(option => ({
      name: `Cursor ${option.name}`, provider: 'cursor-acp', backend: option.value, enabled: true,
    }));
    await this.context.workspaceState.update(CURSOR_MODELS_KEY, this.cursorModels);
    this.refreshModels();
    post(options.map(option => option.value));
  } catch (error) {
    post([], error instanceof Error ? error.message.replace('Open Accounts and try again.', 'Check that you are signed in to Cursor.') : String(error));
  }
}

export function runCursorCommand(this: ExtensionHost, subcommand: 'status' | 'login' | 'logout' | 'models', onOutput?: (text: string) => void, timeoutMs = 30000): Promise<string> {
  const launch = this.cursorAgentLaunch();
  return new Promise<string>((resolve, reject) => {
    let output = '';
    let settled = false;
    const child = spawn(launch.command, [...launch.args.slice(0, -1), subcommand], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(subcommand === 'login' ? { NO_OPEN_BROWSER: '1' } : {}) },
    });
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(output);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`Cursor ${subcommand} timed out.`)); }, timeoutMs);
    const read = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      output = (output + text).slice(-65536);
      onOutput?.(output);
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', () => finish(new Error('Cursor Agent CLI could not start. Check unify.runtime.cursorAgentPath.')));
    child.on('close', code => finish(code === 0 ? undefined : new Error(`Cursor ${subcommand} failed. Open Accounts and try again.`)));
  });
}

export async function cursorLogin(this: ExtensionHost): Promise<void> {
  if (this.cursorAccount.busy) return;
  this.cursorAccount = { ...this.cursorAccount, busy: true, error: undefined, authUrl: undefined };
  await this.refreshAccounts(false);
  let opened = false;
  try {
    await this.runCursorCommand('login', output => {
      if (opened) return;
      const match = output.match(/https:\/\/[^\s\x1b]+/i);
      if (!match) return;
      const url = match[0].replace(/[).,;]+$/, '');
      if (!this.safeCursorAuthUrl(url)) return;
      opened = true;
      this.cursorAccount = { ...this.cursorAccount, authUrl: url };
      void this.refreshAccounts(false);
      void vscode.env.openExternal(vscode.Uri.parse(url));
    }, 300000);
    this.cursorAccount = { ...this.cursorAccount, busy: false };
    await this.refreshAccounts();
    await this.refreshAccount();
  } catch (error) {
    this.cursorAccount = { ...this.cursorAccount, busy: false, error: error instanceof Error ? error.message : String(error) };
    await this.refreshAccounts(false);
    throw error;
  }
}

export function safeCursorAuthUrl(this: ExtensionHost, value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'cursor.com' || url.hostname.endsWith('.cursor.com') || url.hostname === 'cursor.sh' || url.hostname.endsWith('.cursor.sh'));
  } catch { return false; }
}

export async function cursorLogout(this: ExtensionHost): Promise<void> {
  const cursorChats = [...this.chats.values()].filter(chat => chat.record.provider === 'cursor-acp');
  if (cursorChats.length) {
    if (cursorChats.some(chat => chat.running)) throw new Error('Wait for running Cursor chats before disconnecting.');
    if (cursorChats.some(chat => chat.review.pending().length)) throw new Error('Apply or reject pending edits before disconnecting Cursor.');
    const wasActive = cursorChats.some(chat => chat.record.id === this.active?.id);
    for (const chat of cursorChats) await this.unloadChat(chat.record.id);
    if (wasActive) await this.context.workspaceState.update(ACTIVE_SESSION_KEY, undefined);
    this.refreshSessions();
    this.syncActiveView();
  }
  await this.runCursorCommand('logout');
  this.cursorAccount = { connected: false, label: 'Not connected' };
  await this.refreshAccounts();
  await this.refreshAccount();
}

export async function handleCursorRequest(this: ExtensionHost, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (method === 'cursor/ask_question') {
    const questions = Array.isArray(params.questions) ? params.questions as Record<string, unknown>[] : [];
    const answers: { questionId: string; selectedOptionIds: string[] }[] = [];
    for (const question of questions) {
      const options = Array.isArray(question.options) ? question.options as Record<string, unknown>[] : [];
      const items = options.filter(option => typeof option.id === 'string' && typeof option.label === 'string')
        .map(option => ({ label: option.label as string, id: option.id as string }));
      const placeHolder = typeof question.prompt === 'string' ? question.prompt : 'Choose an answer';
      if (question.allowMultiple) {
        const picked = await vscode.window.showQuickPick(items, { placeHolder, canPickMany: true });
        if (!picked) return { outcome: { outcome: 'skipped' } };
        answers.push({ questionId: String(question.id), selectedOptionIds: picked.map(item => item.id) });
      } else {
        const picked = await vscode.window.showQuickPick(items, { placeHolder });
        if (!picked) return { outcome: { outcome: 'skipped' } };
        answers.push({ questionId: String(question.id), selectedOptionIds: [picked.id] });
      }
    }
    return { outcome: { outcome: 'answered', answers } };
  }
  if (method === 'cursor/create_plan') {
    const title = typeof params.name === 'string' ? params.name : 'Cursor plan';
    const plan = typeof params.plan === 'string' ? params.plan : '';
    const choice = await vscode.window.showInformationMessage(title, { modal: true, detail: plan.slice(0, 15000) }, 'Accept plan', 'Reject plan');
    return { outcome: { outcome: choice === 'Accept plan' ? 'accepted' : choice === 'Reject plan' ? 'rejected' : 'cancelled' } };
  }
  throw new Error(`Unsupported Cursor request: ${method}`);
}
