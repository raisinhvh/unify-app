/** Smart Auto model picking: rankings, candidates and the decider. */
import type { Host as ExtensionHost } from '../extension';
import * as vscode from 'vscode';
import { ModelEntry } from '../accounts';
import { SidebarSmartAutoRank } from '../sidebar/view';
import { deciderPrompt, MAX_NOTE, MAX_RANKS, normalizeRanks, parseDecision, rankLabel, SMART_AUTO, SmartAutoRank } from '../runtime/smartAuto';
import type { Chat } from './types';
import { SELECTED_MODEL_KEY } from './constants';

export function smartAutoRanks(this: ExtensionHost): SmartAutoRank[] {
  return normalizeRanks(vscode.workspace.getConfiguration('unify').get<unknown>('smartAutoRanks'));
}

/** Ranked entries whose model is still configured, enabled and runnable on this PC, smartest first. */
export function smartAutoCandidates(this: ExtensionHost): (SmartAutoRank & { entry: ModelEntry })[] {
  return this.smartAutoRanks().flatMap(rank => {
    const entry = this.availableModel(rank.model);
    return entry && this.isUsable(entry) ? [{ ...rank, entry }] : [];
  });
}

export function smartAutoReady(this: ExtensionHost): boolean {
  const name = this.modelSetting('deciderModel').model;
  const decider = name ? this.availableModel(name) : undefined;
  return this.feature('smartAuto') && !!decider && this.isUsable(decider) && this.smartAutoCandidates().length > 0;
}

/** Leaves Smart Auto for a real model once it is turned off or can no longer pick one. */
export async function dropSmartAuto(this: ExtensionHost): Promise<void> {
  if (this.selectedModel !== SMART_AUTO || this.smartAutoReady()) return;
  const current = this.active && this.availableModel(this.active.modelName);
  this.selectedModel = current && this.isUsable(current) ? current.name : this.availableModels().find(model => this.isUsable(model))?.name || '';
  await this.context.workspaceState.update(SELECTED_MODEL_KEY, this.selectedModel);
  this.refreshModels(); await this.refreshAccount();
}

export async function saveSmartAutoRanks(this: ExtensionHost, value: SidebarSmartAutoRank[]): Promise<void> {
  if (!Array.isArray(value) || value.length > MAX_RANKS) throw new Error(`Smart Auto can rank up to ${MAX_RANKS} models.`);
  const ranks = value.map(item => {
    const model = this.availableModel(String(item?.model || '').trim());
    if (!model) throw new Error(`Model "${item?.model}" is not available.`);
    const effort = item.effort || undefined;
    if (effort && !model.effortOptions?.includes(effort)) throw new Error(`Effort "${effort}" is not offered by ${model.name}.`);
    const note = typeof item.note === 'string' && item.note.trim() ? item.note.trim() : undefined;
    if (note && note.length > MAX_NOTE) throw new Error(`Smart Auto notes can be up to ${MAX_NOTE} characters.`);
    return { model: model.name, effort, note };
  });
  await vscode.workspace.getConfiguration('unify').update('smartAutoRanks', ranks.length ? ranks : undefined, vscode.ConfigurationTarget.Global);
  this.refreshCustomize();
}

/**
 * Has the decider model pick this turn's model from the ranked list, switches the chat to it and notes the pick
 * in the chat. Throws when the decider fails or its reply names no listed model, so the message is not sent.
 */
export async function smartAutoPick(this: ExtensionHost, chat: Chat, prompt: string, turnEntryId: string): Promise<void> {
  const record = chat.record;
  const decider = this.modelSetting('deciderModel');
  const candidates = this.smartAutoCandidates();
  if (!this.feature('smartAuto') || !decider.model || !candidates.length) throw new Error('Smart Auto needs a decider model and at least one ranked model. Set them in Customize.');
  this.postRun(record.id, 'thinking', 'Smart Auto is choosing a model…');
  const history = (this.transcripts.get(record.id) || []).filter(item => !item.internal);
  let reply: string;
  try {
    reply = await this.runOneShot({ ...decider, model: decider.model }, chat.mirror.cwd, deciderPrompt(candidates, history, prompt), 120_000, stop => { chat.stopDecider = stop; });
  } catch (error) {
    if (chat.cancelRequested) return;
    throw new Error(`Smart Auto: the decider "${decider.model}" failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally { chat.stopDecider = undefined; }
  if (chat.cancelRequested) return;
  const decision = parseDecision(reply, candidates.length);
  if (!decision) throw new Error(`Smart Auto: the decider "${decider.model}" did not name a listed model. It replied: ${reply.trim().slice(0, 200) || '(nothing)'}`);
  const pick = candidates[decision.rank - 1];
  const effort = pick.effort || '';
  if (record.modelName !== pick.entry.name || record.backend !== pick.entry.backend || (record.effort || '') !== effort) await this.switchModel(chat, pick.entry, effort);
  record.smartAuto = true;
  this.sidebar.postMessage({ type: 'noteMessage', sessionId: record.id, entryId: `note:${turnEntryId}`, icon: 'auto_awesome',
    text: `Smart Auto picked ${rankLabel(pick)}${decision.reason ? ` because ${decision.reason}` : ''}` });
  this.postRun(record.id, 'thinking', 'Thinking…');
}
