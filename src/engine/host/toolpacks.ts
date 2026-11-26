/** Toolpack access for chats: bridging pack tools into agents, enabling packs, running pack tools and file summaries. */
import type { Host as ExtensionHost } from '../extension';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import { DelegateResult, DelegateToolInfo } from '../delegate/host';
import { SEND_MEDIA_TOOL } from '../runtime/media';
import { GENERATE_IMAGE_TOOL } from '../runtime/imageGen';
import { skipToolListChanged } from '../runtime/promptPrefix';
import { SUMMARY_TOOL } from '../summaries/store';
import { listToolpacks } from '../toolpacks/sync-state';
import { installedHubPacks } from '../unify/requests/toolpacks';
import { describePackTools, LOAD_TOOLPACK, loadToolpackTool, packCommands, RUN_TOOLPACK_TOOL, runToolpackTool } from '../toolpacks/access';
import { SidebarToolEvent } from '../sidebar/view';
import { requestPaths } from '../unify/requests/state';
import type { Chat } from './types';

/**
 * Tools every agent's bridge offers, subagents included: file summaries, media, image generation when a ChatGPT (Codex) account
 * is connected, and toolpacks listed one line per pack. Tools of packs turned on in the owner's chat are offered directly.
 */
export function bridgeTools(this: ExtensionHost, owner?: string): DelegateToolInfo[] {
  const tools: DelegateToolInfo[] = this.summariesOn() ? [SUMMARY_TOOL, SEND_MEDIA_TOOL] : [SEND_MEDIA_TOOL];
  if (this.oauthAccounts.list('codex-cli').length) tools.push(GENERATE_IMAGE_TOOL);
  const packs = this.toolpacks.running();
  if (packs.length) {
    const chat = owner ? this.chatForOwner(owner) : undefined;
    let descriptors = this.toolpacks.packDescriptors(new Set(chat?.record.toolpacks || []));
    if (chat && owner === chat.ownerId && skipToolListChanged(chat.record.provider, chat.record.initTools)) {
      descriptors = descriptors.filter(tool => chat.record.initTools?.some(name => name === tool.name || name.endsWith(`__${tool.name}`)));
    }
    tools.push(loadToolpackTool(packs), runToolpackTool, ...descriptors);
  }
  return tools;
}

/** The chat a bridge owner belongs to; a subagent's is its parent chat. */  export function chatForOwner(this: ExtensionHost, owner: string): Chat | undefined {
  return [...this.childRuns].find(item => item.owner === owner)?.parent ?? [...this.chats.values()].find(item => item.ownerId === owner);
}

/** Turns on packs in a chat and returns the ones that were newly turned on. */
export function enablePacks(this: ExtensionHost, chat: Chat, ids: string[]): string[] {
  const on = chat.record.toolpacks || [];
  const added = ids.filter(id => !on.includes(id));
  if (added.length) { chat.record.toolpacks = [...on, ...added]; void this.saveSession(chat.record); }
  return added;
}

/** Packs the user named as "/pack" in a message, turned on for the rest of the chat. */
export function turnOnPacks(this: ExtensionHost, chat: Chat, prompt: string): string[] {
  return this.enablePacks(chat, packCommands(prompt, this.toolpacks.running().map(pack => pack.id)));
}

export function loadToolpacks(this: ExtensionHost, chat: Chat, args: Record<string, unknown>, stable = false): DelegateResult {
  const asked = (Array.isArray(args.packs) ? args.packs : [args.packs ?? args.pack]).filter((item): item is string => typeof item === 'string').map(item => item.trim().toLowerCase());
  const running = new Set(this.toolpacks.running().map(pack => pack.id));
  const found = asked.filter(id => running.has(id));
  const missing = asked.filter(id => !running.has(id));
  if (!found.length) return { text: `No such running toolpack: ${missing.join(', ') || '(none given)'}. Available: ${[...running].join(', ') || '(none)'}.`, isError: true };
  this.enablePacks(chat, found);
  const tools = describePackTools(this.toolpacks.packDescriptors(new Set(found)));
  const skipListChanged = stable && skipToolListChanged(chat.record.provider, chat.record.initTools);
  return { text: `${missing.length ? `Not available: ${missing.join(', ')}.\n\n` : ''}Loaded ${found.join(', ')} for this chat. ${skipListChanged ? `Call these tools through ${RUN_TOOLPACK_TOOL}. ` : ''}Tools:\n\n${tools}`, skipListChanged };
}

export function runPackTool(this: ExtensionHost, chat: Chat, args: Record<string, unknown>): Promise<DelegateResult> | DelegateResult {
  const tool = typeof args.tool === 'string' ? args.tool.trim() : '';
  const pack = this.toolpacks.packOf(tool);
  if (!pack) return { text: `Unknown toolpack tool "${tool}". Call ${LOAD_TOOLPACK} first to see tool names.`, isError: true };
  if (!chat.record.toolpacks?.includes(pack)) return { text: `Toolpack "${pack}" is not loaded. Call ${LOAD_TOOLPACK} with it first.`, isError: true };
  const toolArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments as Record<string, unknown> : {};
  return this.toolpacks.call(tool, toolArgs);
}

/** Handles the toolpack tools shared by main agents and subagents, or returns undefined for other tools. */
export function packCall(this: ExtensionHost, chat: Chat, tool: string, args: Record<string, unknown>, stable = false): Promise<DelegateResult> | DelegateResult | undefined {
  if (tool === LOAD_TOOLPACK) return this.loadToolpacks(chat, args, stable);
  if (tool === RUN_TOOLPACK_TOOL) return this.runPackTool(chat, args);
  if (this.toolpacks.owns(tool)) return this.toolpacks.call(tool, args);
  return undefined;
}

export function summariesOn(this: ExtensionHost): boolean { return this.feature('fileSummaries'); }

/** Queues a file an agent just read in `cwd` for a summary. */
export function noteRead(this: ExtensionHost, cwd: string, path: unknown): void {
  if (typeof path === 'string' && path && this.summariesOn()) this.summaries?.request(cwd, path);
}

export async function readSummaries(this: ExtensionHost, chat: Chat, args: Record<string, unknown>): Promise<DelegateResult> {
  if (!this.summariesOn() || !this.summaries) return { text: 'File summaries are turned off.', isError: true };
  const paths = (Array.isArray(args.paths) ? args.paths : []).filter((item): item is string => typeof item === 'string');
  if (!paths.length) return { text: '"paths" must list at least one file or folder.', isError: true };
  return { text: await this.summaries.lookup(chat.mirror.cwd, paths.slice(0, 50)) };
}

/** The progress bar for a shell call that builds, installs or tests; ends the timer when the call finishes. */
export function toolProgressFor(this: ExtensionHost, id: string, kind: SidebarToolEvent['kind'], command: string | undefined, state: SidebarToolEvent['state'], cwd: string): SidebarToolEvent['progress'] {
  if (state !== 'running') { this.toolProgress.end(id, state === 'complete'); return undefined; }
  if (kind !== 'shell' || !command) return undefined;
  return this.toolProgress.start(id, command, cwd);
}

export function postToolpacks(this: ExtensionHost, error?: string): void {
  const storage = this.context.globalStorageUri.fsPath;
  let packs = this.toolpacks.list();
  try {
    // Hub packs whose files are here but that do not load show as needing an install instead of as installed.
    packs = listToolpacks({ dir: join(storage, 'toolpacks'), installed: packs, hub: installedHubPacks(requestPaths({ workspaceRoot: undefined })) });
  } catch (listError) {
    this.output.appendLine(`Could not check toolpack install state: ${listError instanceof Error ? listError.message : String(listError)}`);
  }
  this.sidebar.postMessage({ type: 'toolpacksState', packs, error });
}

export async function addToolpack(this: ExtensionHost): Promise<void> {
  const picked = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFolders: false, filters: { TypeScript: ['ts'] }, openLabel: 'Upload toolpack' });
  if (!picked?.[0]) return;
  try {
    await this.toolpacks.add(picked[0].fsPath);
    this.postToolpacks();
  } catch (error) {
    this.postToolpacks(`Could not add ${basename(picked[0].fsPath)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
