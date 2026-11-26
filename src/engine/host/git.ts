/** GitHub sign-in state and the git executable lookup. */
import type { Host as ExtensionHost } from '../extension';
import * as vscode from 'vscode';
import { findGit, GIT_DOWNLOAD_PAGE, installGit } from '../runtime/git';
import { refreshGithubAuth, type GithubAuth } from '../unify/github';

/** Unify GitHub sign-in as the UI reads it (`viewState.github`). */
export function setGithub(this: ExtensionHost, auth: GithubAuth | undefined, error?: string): void {
  const github = {
    signedIn: !!auth,
    ...(auth ? { login: auth.login, source: auth.source } : {}),
    ...(error ? { error } : {}),
  };
  // Keep viewState (a pane resolved later) and any open pane in step.
  this.sidebar.setGithub(github);
  this.sidebar.postMessage({ type: 'githubState', github });
}

/** Re-checks the GitHub CLI and the pasted token without using the ten-minute cache. */
export async function refreshGithub(this: ExtensionHost): Promise<void> {
  try {
    this.setGithub(await refreshGithubAuth());
  } catch (error) {
    this.setGithub(undefined, error instanceof Error ? error.message : String(error));
  }
}

/** A working git: unify.runtime.gitPath, VS Code's git.path, PATH, the usual install folders, or the copy Unify installed. */
export async function gitPath(this: ExtensionHost): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration('git').get<unknown>('path');
  const vscodeGit = Array.isArray(configured) ? configured.filter((item): item is string => typeof item === 'string') : typeof configured === 'string' ? [configured] : [];
  return findGit(this.context.globalStorageUri.fsPath, [vscode.workspace.getConfiguration('unify').get<string>('runtime.gitPath'), ...vscodeGit]);
}

/** Git for sync, offering to install it when it is missing. Undefined when the user declines or it cannot be installed. */
export async function ensureGit(this: ExtensionHost): Promise<string | undefined> {
  const found = await this.gitPath();
  if (found) return found;
  if (process.platform !== 'win32') {
    const choice = await vscode.window.showWarningMessage('Git is needed to sync with GitHub, and it is not installed.', {
      modal: true, detail: 'Install Git with your package manager (or from git-scm.com), then choose Connect on the Sync page again.',
    }, 'Open download page');
    if (choice === 'Open download page') await vscode.env.openExternal(vscode.Uri.parse(GIT_DOWNLOAD_PAGE));
    return undefined;
  }
  const choice = await vscode.window.showWarningMessage('Git is needed to sync with GitHub, and it is not installed. Install it now?', {
    modal: true, detail: 'Unify downloads MinGit, the portable build of Git for Windows, checks its SHA-256 against the official release, and keeps it in Unify\'s own storage. Nothing else on your PC changes.',
  }, 'Install Git');
  if (choice !== 'Install Git') return undefined;
  try {
    const git = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Installing Git for Unify sync…' },
      () => installGit(this.context.globalStorageUri.fsPath));
    this.output.appendLine(`Installed Git for sync at ${git}.`);
    return git;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(`Installing Git failed: ${message}`);
    const next = await vscode.window.showErrorMessage(`Could not install Git: ${message}`, 'Open download page');
    if (next === 'Open download page') await vscode.env.openExternal(vscode.Uri.parse(GIT_DOWNLOAD_PAGE));
    return undefined;
  }
}
