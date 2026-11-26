/** Routing of messages from the sidebar webview to the host. */
import type { Host as ExtensionHost } from '../extension';
import { mkdir } from 'node:fs/promises';
import * as vscode from 'vscode';
import { locateInstruction, readInstruction } from '../instructions/store';
import { SELF_HOSTED, normalizeBaseURL } from '../runtime/selfHosted';
import { parseApprovalMode, parseNoQuestionsArg, parseSlash, SLASH_COMMANDS } from '../slash/registry';
import { parseScheduleArgs } from '../schedule/parse';
import { globalMemoryFolder } from '../runtime/memory';
import { SidebarHostMessage, SidebarWebviewMessage } from '../sidebar/provider';
import { normalizeVoiceCommands } from '../voice/dictation';
import { normalizeCompactTokens, normalizeProcessPriority } from '../sidebar/view';
import { getUnifyFeature, setUnifyFeature } from '../unify/settings';
import { agentBus } from '../unify/agentBusImpl';
import { handleUnifyRequest } from '../unify/requests';
import { searchWorkspaceFiles } from '../unify/requests/workspace';
import { getGithubAuth, clearGithubToken, setGithubToken } from '../unify/github';
import { CURSOR_ACCOUNT_ID, APPROVAL_KEY, PROVIDER_USAGE_URLS } from './constants';
import { isOAuthProvider } from './helpers';

export async function onSidebarMessage(this: ExtensionHost, message: SidebarWebviewMessage): Promise<void> {
  await this.guarded(async () => {
    switch (message.type) {
      case 'checkDependencies': await this.refreshDependencies(); break;
      case 'installProvider': await this.installProvider(message.provider); break;
      case 'pageChanged': this.sidebar.setPage(message.page); if (message.page === 'accounts') this.refreshUsage(); if (message.page === 'instructions') await this.refreshInstructions(); break;
      case 'ready': this.sidebar.setShutdown(this.shutdown.getStatus()); this.sidebar.postMessage({ type: 'usageState', usage: this.usage.snapshot() }); this.refreshUsage(); if (this.active) { this.restoreJob(this.active); this.postJob(this.active); } for (const id of this.chats.keys()) { this.postChatDiffs(id); this.sidebar.postMessage({ type: 'backgroundProcesses', sessionId: id, processes: this.backgroundProcesses.list(id) }); } await this.refreshInstructions(); this.postToolpacks(); this.sidebar.postMessage({ type: 'approvalState', mode: this.approvalMode }); this.sidebar.postMessage({ type: 'slashCommandsState', commands: SLASH_COMMANDS }); this.scheduled.refresh(); this.postScheduledPrompts(); this.refreshCustomize(); this.postUnifyFeatures(); if (this.agentRoster.size) this.sidebar.postMessage({ type: 'agentRoster', agents: [...this.agentRoster.values()] }); this.refreshMemory(); this.sync.post(); this.refreshSubagents(); this.refreshModels(); this.refreshSessions(); await this.refreshAccount(); await this.refreshAccounts(); break;
      case 'sendPrompt': {
        if (message.subagentId) {
          this.messageSubagent(message.chatId, message.subagentId, message.prompt, message.images);
          break;
        }
        const slash = parseSlash(message.prompt);
        if (slash?.name === 'job') await this.startJob(slash.args, message.images, message.chatId);
        else if (slash?.name === 'schedule') {
          const parsed = parseScheduleArgs(slash.args, new Date());
          if ('error' in parsed) this.sidebar.postMessage({ type: 'error', message: parsed.error });
          else this.scheduled.add({ prompt: parsed.prompt, dueAt: parsed.dueAt, chatId: message.chatId, images: message.images });
        } else if (slash?.name === 'permissions') {
          const mode = slash.args ? parseApprovalMode(slash.args) : undefined;
          if (mode) {
            this.approvalMode = mode;
            await this.context.workspaceState.update(APPROVAL_KEY, mode);
          }
          // With no or an unknown mode the UI opens its own picker.
          this.sidebar.postMessage({ type: 'approvalState', mode: this.approvalMode });
        } else if (slash?.name === 'noquestions') {
          // Only flips the setting; agents learn about it when they try to ask (see askQuestions), no turn is started.
          setUnifyFeature('agents.noQuestions', parseNoQuestionsArg(slash.args, getUnifyFeature('agents.noQuestions')));
          this.postUnifyFeatures();
        } else if (slash?.name === 'shutdown') {
          // Arms the one-shot shutdown; the controller answers with shutdownArmed and the chat shows its bar.
          setUnifyFeature('power.shutdownWhenIdle', true);
          this.postUnifyFeatures();
        } else if (slash?.name === 'clearcontext') {
          await this.clearContext(message.chatId);
          // "/clearcontext <prompt>" starts the fresh session with that prompt.
          if (slash.args || message.images?.length) await this.sendPrompt(slash.args, message.images, undefined, undefined, 'interrupt', { chatId: message.chatId });
        } else {
          await this.sendPrompt(message.prompt, message.images, undefined, undefined, message.mode === 'queue' ? 'queue' : 'interrupt', { chatId: message.chatId });
        }
        break;
      }
      case 'unqueue': { const target = this.chats.get(message.sessionId); if (target && Number.isInteger(message.index)) { target.queue.splice(message.index, 1); this.postQueue(target); } break; }
      case 'cancelProgress': (vscode.window as unknown as { __unifyCancelProgress?: (id: string) => boolean }).__unifyCancelProgress?.(message.id); break;
      case 'cancelScheduledPrompt': this.scheduled.cancel(message.id); break;
      case 'loadChat': {
        // A pane or pop-out window asks for its chat's history (on app start, or when it opens); the active chat stays as it is.
        if (!this.sidebar.resendChat(message.sessionId)) {
          this.replayTranscript(message.sessionId);
          const record = this.sessions().find(item => item.id === message.sessionId);
          if (record?.job) this.postJob(record);
        }
        this.postChatDiffs(message.sessionId);
        // Always answer, so the pane's loading state ends even for a chat with no history.
        this.sidebar.postMessage({ type: 'chatLoaded', sessionId: message.sessionId });
        break;
      }
      case 'sendScheduledPromptNow': {
        const item = this.scheduled.take(message.id);
        if (item) await this.deliverScheduledPrompt(item.prompt, item.images);
        break;
      }
      case 'searchWorkspaceFiles': {
        const folder = vscode.workspace.workspaceFolders?.[0];
        let results: ReturnType<typeof searchWorkspaceFiles> = [];
        if (folder?.uri.scheme === 'file') {
          try { results = searchWorkspaceFiles(folder.uri.fsPath, message.query, message.limit); }
          catch (error) { this.output.appendLine(`Workspace file search failed: ${String(error)}`); }
        }
        this.sidebar.postMessage({ type: 'workspaceFileResults', requestId: message.requestId, query: message.query, results });
        break;
      }
      case 'editMessage': await this.editMessage(message.sessionId, message.entryId, message.text); break;
      case 'readInstruction': this.sidebar.postMessage({ type: 'instructionContent', id: message.id, content: await readInstruction(this.instructionRoots(), message.id) }); break;
      case 'openInstruction': await vscode.window.showTextDocument(vscode.Uri.file(await locateInstruction(this.instructionRoots(), message.id))); break;
      case 'saveInstruction': await this.saveInstructionRequest(message); break;
      case 'removeInstruction': await this.removeInstructionRequest(message.id); break;
      case 'approvalResponse': this.settleApproval(message.id, message.allow === true, message.always === true); break;
      case 'questionResponse': this.settleQuestion(message.id, Array.isArray(message.answers) ? message.answers.map(item => String(item)) : null); break;
      case 'pickToolpack': await this.addToolpack(); break;
      case 'setFeature': await this.setFeature(message.key, message.enabled); break;
      case 'setUnifyFeature':
        if (typeof message.id === 'string' && message.id && ['boolean', 'number', 'string'].includes(typeof message.value)) {
          setUnifyFeature(message.id, message.value);
          this.postUnifyFeatures();
        }
        break;
      case 'saveReviewModel': await this.saveModelSetting('reviewModel', message.reviewModel); break;
      case 'saveNameModel': await this.saveModelSetting('nameModel', message.nameModel); break;
      case 'saveSummaryModel': await this.saveModelSetting('summaryModel', message.summaryModel); break;
      case 'saveDeciderModel': await this.saveModelSetting('deciderModel', message.deciderModel); break;
      case 'saveExplorerModel': await this.saveModelSetting('explorerModel', message.explorerModel); break;
      case 'saveSmartAutoRanks': await this.saveSmartAutoRanks(message.ranks); break;
      case 'setMemory': await this.setMemory(message.enabled === true); break;
      case 'openMemoryFolder': {
        const folder = globalMemoryFolder(this.instructionRoots().unifyHome);
        await mkdir(folder, { recursive: true });
        await vscode.env.openExternal(vscode.Uri.file(folder));
        break;
      }
      case 'saveAutoCompactTokens':
        await vscode.workspace.getConfiguration('unify').update('experimental.autoCompactTokens', normalizeCompactTokens(message.tokens), vscode.ConfigurationTarget.Global);
        this.refreshCustomize();
        break;
      case 'saveProcessPriority':
        await vscode.workspace.getConfiguration('unify').update('runtime.processPriority', normalizeProcessPriority(message.priority), vscode.ConfigurationTarget.Global);
        this.refreshCustomize();
        break;
      case 'saveAccessibility': await this.saveAccessibility(message.accessibility); break;
      case 'voiceStart': void this.startVoice(); break;
      case 'voiceStop': this.stopVoice(); break;
      case 'saveVoiceCommands':
        await vscode.workspace.getConfiguration('unify').update('voice.commands', normalizeVoiceCommands(message.commands), vscode.ConfigurationTarget.Global);
        this.refreshCustomize();
        break;
      case 'deleteAllSessions': await this.deleteAllSessions(); break;
      case 'syncAction': await this.syncAction(message.action); break;
      case 'setSyncAuto': await this.sync.setAuto(message.enabled === true); break;
      case 'cancelShutdown': this.shutdown?.cancelShutdown(); break;
      case 'githubRefresh': await this.refreshGithub(); break;
      case 'githubSetToken':
        try {
          this.setGithub(await setGithubToken(message.token));
        } catch (error) {
          this.setGithub(undefined, error instanceof Error ? error.message : String(error));
        }
        break;
      case 'githubSignOut': await clearGithubToken(); this.setGithub(await getGithubAuth()); break;
      case 'toolpackAction':
        if (message.action === 'remove') await this.toolpacks.remove(message.id);
        else if (message.action === 'reload') await this.toolpacks.reload(message.id);
        else await this.toolpacks.setEnabled(message.id, message.action === 'enable');
        this.postToolpacks();
        break;
      case 'setApproval':
        this.approvalMode = parseApprovalMode(message.mode ?? '') ?? 'ask';
        await this.context.workspaceState.update(APPROVAL_KEY, this.approvalMode);
        this.sidebar.postMessage({ type: 'approvalState', mode: this.approvalMode });
        break;
      case 'applyAll': await this.chatForMessage(message.chatId)?.review.applyAll(); break;
      case 'rejectAll': await this.chatForMessage(message.chatId)?.review.rejectAll(); break;
      case 'cancel': this.cancel(true, message.chatId); break;
      case 'newSession': await this.newChat(message.project, !!message.noFolder); break;
      case 'selectSession': await this.continueChat(message.sessionId); break;
      case 'deleteSession': await this.deleteSession(message.sessionId); break;
      case 'deleteSessions': await this.deleteSessions(message.sessionIds); break;
      case 'openChats': this.openChatIds = new Set(message.chatIds); break;
      case 'stopBackgroundProcess': this.backgroundProcesses.stop(message.sessionId, message.id); break;
      case 'renameSession': {
        // Prefer the loaded chat's record so a later turn save does not restore the old name.
        const record = this.chats.get(message.sessionId)?.record ?? this.sessions().find(item => item.id === message.sessionId);
        if (record) {
          const name = message.name.trim() || await vscode.window.showInputBox({ prompt: 'Session name', value: record.name });
          if (name?.trim()) { record.name = name.trim().slice(0, 100); record.renamed = true; await this.saveSession(record, false); agentBus.update(record.id, { task: record.name }); }
        }
        break;
      }
      case 'selectModel': await this.selectModel(message.modelId); break;
      case 'selectSpeed': await this.selectChoice('speed', message.value); break;
      case 'selectEffort': await this.selectChoice('effort', message.value); break;
      case 'saveSubagent': await this.saveSubagent(message); break;
      case 'removeSubagent': await this.writeSubagents(this.subagentProfiles().filter(item => item.name !== message.name)); break;
      case 'saveModel': await this.saveModel(message); break;
      case 'removeModel': await this.removeModel(message.name); break;
      case 'manageAccounts': await this.manageAccounts(); break;
      case 'refreshAccounts': await this.refreshAccounts(); break;
      case 'refreshUsage': this.refreshUsage(true, message.accountId); break;
      case 'reauthAccount': {
        if (!this.oauthAccounts.get(message.accountId)) throw new Error('Account not found.');
        await this.ensureNode();
        await this.refreshDependencies();
        await this.oauthAccounts.reauth(message.accountId);
        await this.refreshAccounts(false);
        this.sidebar.postMessage({ type: 'accountSaved' });
        this.refreshUsage(true, message.accountId);
        break;
      }
      case 'replaceAccountKey': {
        const account = this.accounts.get(message.accountId);
        if (!account) throw new Error('Account not found.');
        if (!['deepseek-official', 'openrouter', 'opencode-go', 'mistral', SELF_HOSTED].includes(account.provider)) throw new Error('Choose a supported API provider.');
        await this.accounts.replaceSecret(message.accountId, message.secret);
        await this.refreshAccounts(false);
        this.sidebar.postMessage({ type: 'accountSaved' });
        this.refreshUsage(true, message.accountId);
        break;
      }
      case 'listProviderModels':
      if (message.accountId === CURSOR_ACCOUNT_ID) await this.listCursorModels(message.accountId);
      else await this.listProviderModels(message.accountId);
      break;
      case 'openCliSetting':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'unify.runtime.claudePath');
        break;
      case 'viewProviderUsage': {
        const url = PROVIDER_USAGE_URLS.get(message.provider);
        if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }
      case 'addAccount': {
        if (!['deepseek-official', 'openrouter', 'opencode-go', 'mistral', SELF_HOSTED].includes(message.provider)) throw new Error('Choose a supported API provider.');
        const baseURL = message.provider === SELF_HOSTED ? normalizeBaseURL(message.baseURL ?? '') : undefined;
        await this.accounts.add({ provider: message.provider, label: message.label, email: message.email, secret: message.secret,
          ...(baseURL ? { metadata: { baseURL } } : {}) });
        await this.refreshAccounts(false);
        this.sidebar.postMessage({ type: 'accountSaved' });
        break;
      }
      case 'addOAuthAccount':
        await this.ensureNode();
        await this.refreshDependencies();
        await this.oauthAccounts.add(message.provider, message.label, message.email);
        await this.refreshAccounts(false);
        this.sidebar.postMessage({ type: 'accountSaved' });
        break;
      case 'setDefaultAccount':
        if (isOAuthProvider(message.provider)) await this.oauthAccounts.setDefault(message.provider, message.accountId);
        else await this.accounts.setDefault(message.provider, message.accountId);
        await this.refreshAccounts(false);
        break;
      case 'removeAccount': await this.removeAccount(message.accountId); break;
      case 'cursorLogin': await this.cursorLogin(); break;
      case 'cursorLogout': await this.cursorLogout(); break;
      case 'openAuthUrl': if (this.safeCursorAuthUrl(message.url) && message.url === this.cursorAccount.authUrl) await vscode.env.openExternal(vscode.Uri.parse(message.url)); break;
      case 'openFile': {
        const target = this.chatForMessage(message.chatId);
        const item = target?.review.pending().find(diff => diff.path === message.path);
        if (item) await target?.review.open(item.id);
        else if (target?.mirror) {
          const editor = await vscode.window.showTextDocument(target.mirror.uri(message.path));
          if (message.line && Number.isInteger(message.line) && message.line > 0) {
            const position = new vscode.Position(message.line - 1, Math.max(0, (message.column || 1) - 1));
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
          }
        }
        break;
      }
      case 'openMedia': await this.openMedia(String(message.file || '')); break;
      case 'applyDiff': await this.chatForMessage(message.chatId)?.review.apply(message.diffId); break;
      case 'openDiff': await this.chatForMessage(message.chatId)?.review.open(message.diffId); break;
      case 'rejectDiff': await this.chatForMessage(message.chatId)?.review.reject(message.diffId); break;
      case 'reviewAll': await this.chatForMessage(message.chatId)?.review.openAll(); break;
      case 'openTerminal': await this.openWorkingCopyTerminal(); break;
      default: await this.handleUnhandledSidebarMessage(message); break;
    }
  });
}

/**
 * Routes messages this host has no case for through the Unify request handlers (screen data and
 * actions owned by other modules). An unhandled one is logged instead of silently disappearing.
 */
export async function handleUnhandledSidebarMessage(this: ExtensionHost, message: SidebarWebviewMessage): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const handled = await handleUnifyRequest(
    message as unknown as { type: string; [key: string]: unknown },
    reply => this.sidebar.postMessage(reply as SidebarHostMessage),
    { workspaceRoot: folder?.uri.fsPath,
      workspaceRoots: vscode.workspace.workspaceFolders?.map(item => item.uri.fsPath),
      refreshModelState: () => this.refreshModels(),
      refreshUsageState: (id?: string) => this.refreshUsage(true, id),
      removeAccount: id => this.removeAccount(id),
      refreshToolpacks: () => this.postToolpacks(),
      installToolpack: async sourcePath => { await this.toolpacks.add(sourcePath); },
      openExternal: url => vscode.env.openExternal(vscode.Uri.parse(url)),
      getGithubAuth,
      pickOption: async (items, placeHolder) => {
        const picked = await vscode.window.showQuickPick(
          items.map(item => ({
            label: item.label,
            description: item.description,
            detail: item.detail,
            id: item.id,
          })),
          { placeHolder },
        );
        return picked?.id;
      },
      confirm: async (message, detail) => {
        const choice = await vscode.window.showInformationMessage(message, { modal: true, detail }, 'Publish');
        return choice === 'Publish';
      } },
  );
  if (!handled) {
    const type = (message as { type?: unknown }).type;
    this.output.appendLine(`Unhandled sidebar message: ${typeof type === 'string' ? type : '(no type)'}`);
  }
}
