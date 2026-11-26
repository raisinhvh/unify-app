/** Update checks and installs for the app, the agent runtime and toolpacks. */
import type { Host as ExtensionHost } from '../extension';
import * as vscode from 'vscode';
import { currentVersion, installVersion, latestVersion } from '../update/unifyUpdate';
import type { AgentRuntimeOffer } from '../update/plan';
import { compareVersions } from '../update/version';
import { SidebarWebviewMessage } from '../sidebar/provider';

export function checkUpdates(this: ExtensionHost, manual = false): Promise<void> {
  return this.runUpdates(manual).catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(`Unify update failed: ${message}`);
    if (manual) void vscode.window.showErrorMessage(`Unify update failed: ${message}`);
  });
}

/** Overlapping checks share one lookup, but each caller applies its own manual flag. */
export function findUpdates(this: ExtensionHost): Promise<{ agentRuntime?: AgentRuntimeOffer; failures: string[] }> {
  return this.updateCheck ??= (async () => {
    const storage = this.context.globalStorageUri.fsPath;
    const failures: string[] = [];
    const settled = async <T>(label: string, task: Promise<T>): Promise<T | undefined> => {
      try { return await task; }
      catch (error) {
        const message = `${label} update check failed: ${error instanceof Error ? error.message : String(error)}`;
        this.output.appendLine(message);
        failures.push(message);
        return undefined;
      }
    };
    const [installed, latest] = await Promise.all([
      settled('agent runtime', currentVersion(storage)),
      settled('agent runtime', latestVersion()),
    ]);
    const agentRuntime = installed && latest && compareVersions(latest, installed) > 0 ? { current: installed, latest } : undefined;
    return { agentRuntime, failures };
  })().finally(() => { this.updateCheck = undefined; });
}

// Prompts are never awaited while holding updateCheck or updateInstall: an ignored
// notification would otherwise block every later check until the window reloads.
export async function runUpdates(this: ExtensionHost, manual: boolean): Promise<void> {
  if (this.updateInstall) {
    if (manual) void vscode.window.showInformationMessage('An agent runtime update is already installing.');
    return;
  }
  const config = vscode.workspace.getConfiguration('unify');
  const { agentRuntime, failures } = await this.findUpdates();
  const enabled = manual || config.get<boolean>('updates.check', true);
  const skipped = this.context.globalState.get<string>('unify.ide.skippedAgentRuntimeVersion');
  if (!enabled || !agentRuntime || agentRuntime.latest === skipped) {
    if (manual && failures.length) void vscode.window.showWarningMessage(`Could not finish checking for updates. ${failures.join(' ')}`);
    else if (manual) void vscode.window.showInformationMessage('Unify is up to date.');
    return;
  }
  const choice = await vscode.window.showInformationMessage(`Agent runtime ${agentRuntime.latest} is available.`, 'Update', 'Later', 'Skip this version');
  if (choice === 'Skip this version') { await this.context.globalState.update('unify.ide.skippedAgentRuntimeVersion', agentRuntime.latest); return; }
  if (choice !== 'Update') return;
  // Another prompt may have started the same install while this one was open.
  if (this.updateInstall) return;
  const install = this.installUpdates(agentRuntime.latest);
  this.updateInstall = install.finally(() => { this.updateInstall = undefined; }).catch(() => undefined);
  try { await install; }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(`Unify update failed: ${message}`);
    void vscode.window.showErrorMessage(`Unify update failed: ${message}`);
    return;
  }
  const restart = await vscode.window.showInformationMessage(`Agent runtime ${agentRuntime.latest} is installed. Restart it to use it.`, 'Restart runtime');
  if (restart) await this.guarded(() => this.restartRuntime());
}

export async function installUpdates(this: ExtensionHost, latest: string): Promise<void> {
  const storage = this.context.globalStorageUri.fsPath;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Updating agent runtime ${latest}…` }, async progress => {
    progress.report({ message: `Downloading agent runtime ${latest}` });
    const node = await this.ensureNode();
    await installVersion(storage, latest, node, downloads => progress.report({ message: `Downloading agent runtime ${latest} (${downloads} files)` }));
  });
}

/** Checks the Hub for toolpack updates and posts `toolpackUpdates`; installs them when auto-update is on. */
export function checkToolpackUpdates(this: ExtensionHost): void {
  void this.handleUnhandledSidebarMessage({ type: 'hubCheckUpdates', auto: true } as unknown as SidebarWebviewMessage)
    .catch(error => this.output.appendLine(`Toolpack update check failed: ${String(error)}`));
}
