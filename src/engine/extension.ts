import { createHash } from 'node:crypto';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { AccountRegistry, ModelEntry, ModelRegistry } from './accounts';
import { AccountUsageService } from './accounts/usageService';
import { OAuthCliAccounts } from './accounts/oauthCli';
import { WindowsDependencies } from './runtime/dependencies';
import { ReviewController } from './review/controller';
import { DelegateHost } from './delegate/host';
import { unbindChatAgentOwner } from './delegate/messaging';
import { DiskMediaStore, createShownMediaTracker } from './unify/media';
import { ToolpackRegistry } from './toolpacks/registry';
import { ConfigSync } from './sync/controller';
import { SYNCED_SETTINGS } from './sync/configSync';
import type { AgentRuntimeOffer } from './update/plan';
import { parseApprovalMode } from './slash/registry';
import { ScheduledPrompts } from './schedule/store';
import { AcpRuntime } from './runtime/acp';
import { mirrorPathExcluded, WorkspaceMirror } from './runtime/shadow';
import { FileSummaries } from './summaries/store';
import { setAgentPriority } from './runtime/priority';
import type { InternalToolPlaces } from './unify/internalRows';
import { ProgressHistory, ToolProgressTracker } from './unify/toolProgress';
import { BackgroundProcessList } from './unify/backgroundProcesses';
import { UnifySidebarProvider, SidebarHostMessage } from './sidebar/provider';
import { Dictation } from './voice/dictation';
import { WhisperEngine } from './voice/whisperInstall';
import { ApprovalMode, CursorAccountState } from './sidebar/view';
import { onUnifyFeatureChange, unifyHome } from './unify/settings';
import { agentBus } from './unify/agentBusImpl';
import type { AgentInfo } from './unify/agentBus';
import { onGithubAuthChange } from './unify/github';
import { runPackUninstallScript } from './hub/setup';
import { createShutdownController, ShutdownController } from './unify/power';
import { SMART_AUTO } from './runtime/smartAuto';
import type { SessionRecord, SavedTimeline, ModelChoice, MediaItem, ChildRun, TranscriptItem, Chat } from './host/types';
import { SELECTED_MODEL_KEY, CURSOR_MODELS_KEY, MODEL_CHOICES_KEY, APPROVAL_KEY, TRANSCRIPTS_KEY, TIMELINES_KEY } from './host/constants';
import * as lifecycle from './host/lifecycle';
import * as runtimes from './host/runtimes';
import * as git from './host/git';
import * as agentBusMethods from './host/agentBus';
import * as sessions from './host/sessions';
import * as updates from './host/updates';
import * as models from './host/models';
import * as cursor from './host/cursor';
import * as approvals from './host/approvals';
import * as toolpacks from './host/toolpacks';
import * as chats from './host/chats';
import * as instructions from './host/instructions';
import * as media from './host/media';
import * as jobs from './host/jobs';
import * as prompt from './host/prompt';
import * as subagents from './host/subagents';
import * as settings from './host/settings';
import * as voice from './host/voice';
import * as smartAuto from './host/smartAuto';
import * as sidebarMessages from './host/sidebarMessages';

class ExtensionHost implements vscode.Disposable {
  readonly dependencies: WindowsDependencies;
  nodeReady?: Promise<string>;
  updateCheck?: Promise<{ agentRuntime?: AgentRuntimeOffer; failures: string[] }>;
  updateInstall?: Promise<unknown>;
  readonly providerInstalls = new Set<string>();
  readonly providerErrors = new Map<string, string>();
  readonly output = vscode.window.createOutputChannel('DeepSeek Harness');
  readonly accounts: AccountRegistry;
  readonly oauthAccounts: OAuthCliAccounts;
  readonly usage = new AccountUsageService(usage => this.sidebar.postMessage({ type: 'usageState', usage }));
  readonly models: ModelRegistry;
  readonly sidebar: UnifySidebarProvider;
  /** Unify power: runs the countdown and shuts the PC down when every task has finished. */
  readonly shutdown: ShutdownController;
  readonly runtimes = new Map<string, AcpRuntime>();
  dictation?: Dictation;
  whisperInstall?: Promise<WhisperEngine>;
  /** Bumped by every voice start and stop, so a start that finishes downloading late knows it was cancelled. */
  voiceSession = 0;
  readonly chats = new Map<string, Chat>();
  readonly chatLoads = new Map<string, Promise<Chat>>();
  readonly promptStarts = new Map<string, Promise<void>>();
  /** Turns started by other agents' messages since the chat's last user message, per chat id. */
  readonly messageWakes = new Map<string, number>();
  readonly deletedSessions = new Set<string>();
  readonly childRuns = new Set<ChildRun>();
  /** Root sets for friendly internal rows, built once per chat instead of per runtime event. */
  readonly placesByChat = new Map<string, InternalToolPlaces>();
  /** Text listeners for tool-less ACP runs such as chat naming, keyed by `${runtimeKey}\n${sessionId}`. */
  readonly oneShots = new Map<string, (update: Record<string, unknown>) => void>();
  readonly delegateHost = new DelegateHost();
  readonly toolpacks: ToolpackRegistry;
  readonly sync: ConfigSync;
  active?: SessionRecord;
  selectedModel: string;
  modelChoices: Record<string, ModelChoice>;
  approvalMode: ApprovalMode;
  /** Chats the main window shows in panes or pop-outs (renderer `openChats` message); exempt from pruning. */
  openChatIds = new Set<string>();
  readonly transcripts = new Map<string, TranscriptItem[]>();
  /** ACP sessions created in this window that have not had a prompt yet, so their first context report measures the baseline. */
  readonly freshSessions = new Set<string>();
  readonly timelines: Record<string, SavedTimeline>;
  timelineTimer?: NodeJS.Timeout;
  cursorModels: ModelEntry[];
  cursorAccount: CursorAccountState = { connected: false, label: 'Not connected' };
  fileSummaries?: FileSummaries;
  /** Roster of agents taking part in messaging, keyed by agent id; refreshed from agentBus roster events. */
  readonly agentRoster = new Map<string, AgentInfo>();
  /** Whether the VS Code window has focus; desktop notifications are shown only while it does not. */
  windowFocused = true;
  /** Unify's media store: files under ~/.unify/media, deduplicated by sha256 (docs/contracts/media.md). */
  readonly media = new DiskMediaStore(join(unifyHome(), 'media'));
  /** Progress bars for builds, installs and tests, timed from past runs of the same command. */
  readonly toolProgress = new ToolProgressTracker({ history: new ProgressHistory(join(unifyHome(), 'tool-durations.json')) });
  /** Shell commands, subagents and provider tasks that keep running after the agent's turn, shown above the composer. */
  readonly backgroundProcesses = new BackgroundProcessList({
    onChange: (sessionId, processes) => this.sidebar.postMessage({ type: 'backgroundProcesses', sessionId, processes }),
  });
  /** Images already shown per chat, whatever chats.showYourWork says (TODO 2e). */
  readonly shownMedia = createShownMediaTracker();
  /** `/schedule` prompts, global so they survive project switches and restarts. */
  readonly scheduled: ScheduledPrompts;
  /** Images a background subagent sent its parent; they ride the parent's next tool result. */
  readonly pendingParentMedia = new Map<string, { item: MediaItem; shownBy: string; run?: ChildRun }[]>();
  readonly disposables: vscode.Disposable[] = [];
  readonly pendingApprovals = new Map<string, { sessionId: string; background: boolean; resolve: (allow: boolean) => void; timer: NodeJS.Timeout; /** Allow rule this request would store with "Always allow". */ project?: string; prefix?: string }>();
  readonly pendingQuestions = new Map<string, { sessionId: string; resolve: (answers: string[] | null) => void; timer: NodeJS.Timeout }>();
  knowledgeTimer: ReturnType<typeof setTimeout> | undefined;
  /** When each account last reported a usage limit, so later runs try it last. */
  readonly limitedAt = new Map<string, number>();

  public constructor(readonly context: vscode.ExtensionContext) {
    this.dependencies = new WindowsDependencies(context.globalStorageUri.fsPath,
      () => vscode.workspace.getConfiguration('unify').get<string>('runtime.nodePath'),
      provider => vscode.workspace.getConfiguration('unify').get<string>(provider === 'claude-cli' ? 'runtime.claudePath' : 'runtime.cursorAgentPath'));
    this.accounts = new AccountRegistry(context);
    this.oauthAccounts = new OAuthCliAccounts(context);
    this.models = new ModelRegistry(context, this.accounts);
    this.cursorModels = context.workspaceState.get<ModelEntry[]>(CURSOR_MODELS_KEY, []);
    for (const [id, items] of Object.entries(context.workspaceState.get<Record<string, TranscriptItem[]>>(TRANSCRIPTS_KEY, {}))) this.transcripts.set(id, items);
    const savedModel = context.workspaceState.get<string>(SELECTED_MODEL_KEY);
    // A saved pick that was since renamed, removed or turned off falls back to the first enabled model.
    this.selectedModel = savedModel && (savedModel === SMART_AUTO || this.models.list(true).some(model => model.name === savedModel))
      ? savedModel : this.models.list(true)[0]?.name || '';
    this.modelChoices = context.workspaceState.get<Record<string, ModelChoice>>(MODEL_CHOICES_KEY, {});
    const savedApproval = context.workspaceState.get<ApprovalMode>(APPROVAL_KEY);
    this.approvalMode = parseApprovalMode(savedApproval ?? '') ?? 'ask';
    this.timelines = context.workspaceState.get<Record<string, SavedTimeline>>(TIMELINES_KEY, {});
    for (const saved of Object.values(this.timelines)) for (const item of saved.timeline) if (item.kind === 'question' && item.status === 'pending') item.status = 'skipped';
    this.toolpacks = new ToolpackRegistry({
      dir: join(context.globalStorageUri.fsPath, 'toolpacks'),
      workerPath: join(context.extensionPath, 'dist', 'toolpack-worker.js'),
      nodePath: () => vscode.workspace.getConfiguration('unify').get<string>('runtime.nodePath') || undefined,
      compile: async source => (await (await import('esbuild')).transform(source, { loader: 'ts', format: 'cjs', target: 'node20' })).code,
      // Undo what the pack's install script put outside its folder (plugins, add-ons, registry values).
      beforeRemove: async (_id, folder) => {
        await runPackUninstallScript(folder, { unifyHome: unifyHome() })
          .catch(error => this.output.appendLine(`Uninstall script for ${folder} failed: ${error instanceof Error ? error.message : String(error)}`));
      },
    });
    this.sidebar = new UnifySidebarProvider(context.extensionUri, message => this.onSidebarMessage(message), (id, timeline, subagents) => {
      if (this.deletedSessions.has(id)) return;
      this.timelines[id] = { timeline, subagents };
      if (!this.timelineTimer) this.timelineTimer = setTimeout(() => {
        this.timelineTimer = undefined;
        void this.context.workspaceState.update(TIMELINES_KEY, this.timelines);
      }, 1500); // Streaming changes the timeline constantly; dispose and shutdown flush the rest.
    }, vscode.Uri.joinPath(context.globalStorageUri, 'media'));
    this.sync = new ConfigSync(context, {
      roots: () => ({ ...this.instructionRoots(), memory: this.memorySettings().global }),
      git: () => this.gitPath(),
      accounts: () => [...this.oauthAccounts.list(), ...this.accounts.list()].map(({ id, provider, label }) => ({ id, provider, label })),
      log: line => this.output.appendLine(line),
      post: sync => this.sidebar.postMessage({ type: 'syncState', sync }),
      applied: async () => { this.refreshModels(); this.refreshSubagents(); this.refreshCustomize(); await this.refreshInstructions(); },
    });
    this.shutdown = createShutdownController({
      getActivity: () => this.shutdownActivity(),
      onActivityChange: listener => {
        const timer = setInterval(listener, 1000);
        return () => clearInterval(timer);
      },
      saveState: () => this.saveAllState(),
      notify: (title, body) => this.notifyDesktop(title, body),
      post: message => { this.sidebar.postMessage(message as SidebarHostMessage); this.sidebar.setShutdown(this.shutdown.getStatus()); },
    });
    this.disposables.push({ dispose: () => this.shutdown.dispose() });
    this.scheduled = new ScheduledPrompts(context, {
      project: () => this.currentProject()?.path,
      fire: (prompt, images) => { void this.guarded(() => this.deliverScheduledPrompt(prompt, images)); },
      changed: () => this.postScheduledPrompts(),
    });
    this.disposables.push({ dispose: () => this.scheduled.dispose() });
    this.sidebar.setShutdown(this.shutdown.getStatus());
    this.disposables.push({ dispose: onGithubAuthChange(auth => this.setGithub(auth)) });
    void this.refreshGithub();
    const keepAliveTimer = setInterval(() => { void this.keepAliveChats(); }, 60_000);
    setAgentPriority(vscode.workspace.getConfiguration('unify').get('runtime.processPriority'));
    this.applyShellSettings();
    this.disposables.push(
      this.output, this.sidebar, this.sync,
      { dispose: () => clearInterval(keepAliveTimer) },
      { dispose: () => { for (const runtime of this.runtimes.values()) runtime.dispose(); this.runtimes.clear(); this.delegateHost.dispose(); void this.toolpacks.dispose(); this.fileSummaries?.dispose(); this.dictation?.stop(); } },
      this.toolpacks.onChange(() => this.postToolpacks()),
      vscode.window.registerWebviewViewProvider(UnifySidebarProvider.viewType, this.sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('unify.models')) this.refreshModels();
        if (event.affectsConfiguration('unify.subagents')) this.refreshSubagents();
        if (event.affectsConfiguration('unify.memory')) this.refreshMemory();
        if (event.affectsConfiguration('unify.runtime.processPriority')) setAgentPriority(vscode.workspace.getConfiguration('unify').get('runtime.processPriority'));
        if (event.affectsConfiguration('unify.runtime.powershellSpeedups') || event.affectsConfiguration('unify.runtime.rustTools')) this.applyShellSettings();
        if (['unify.features', 'unify.experimental', 'unify.runtime', 'unify.nameModel', 'unify.reviewModel', 'unify.summaryModel', 'unify.deciderModel', 'unify.explorerModel', 'unify.smartAutoRanks', 'unify.updates.check', 'unify.accessibility'].some(key => event.affectsConfiguration(key))) this.refreshCustomize();
        if (['unify.models', 'unify.features.smartAuto', 'unify.deciderModel', 'unify.smartAutoRanks'].some(key => event.affectsConfiguration(key))) void this.guarded(() => this.dropSmartAuto());
        if (SYNCED_SETTINGS.some(key => event.affectsConfiguration(`unify.${key}`))) this.sync.schedule();
      }),
      vscode.window.onDidChangeWindowState(state => { this.windowFocused = state.focused; if (state.focused) this.sync.check(true); }),
      { dispose: agentBus.onEvent(event => this.onAgentBusEvent(event)) },
      { dispose: onUnifyFeatureChange(() => { this.postUnifyFeatures(); this.refreshCustomize(); }) },
      { dispose: onUnifyFeatureChange((id, value) => { if (id === 'toolpacks.autoUpdate' && value === true) this.checkToolpackUpdates(); }) },
      ...this.watchGlobalInstructions(),
      ...this.watchKnowledge(),
      { dispose: () => { if (this.knowledgeTimer) clearTimeout(this.knowledgeTimer); } },
      // Before the write, so a watcher scan cannot see the save first; after it, for format-on-save output.
      vscode.workspace.onWillSaveTextDocument(event => this.adoptSave(event.document)),
      vscode.workspace.onDidSaveTextDocument(document => this.adoptSave(document)),
    );
    this.registerCommands();
    this.delegateHost.start({
      describe: () => this.subagentInfos(),
      tools: owner => this.bridgeTools(owner),
      call: (owner, tool, args) => this.handleDelegateCall(owner, tool, args),
      batching: owner => this.feature('batching') && [...this.chats.values()].some(chat => chat.ownerId === owner),
    }).catch(error => this.output.appendLine(`Subagent bridge failed to start: ${String(error)}`));
    const updateTimer = setTimeout(() => { void this.checkUpdates(); }, 5000);
    this.disposables.push({ dispose: () => clearTimeout(updateTimer) });
    // Toolpack updates: once shortly after startup, then every 6 hours (auto-update installs them when it is on).
    const toolpackUpdateTimer = setTimeout(() => this.checkToolpackUpdates(), 30_000);
    const toolpackUpdateInterval = setInterval(() => this.checkToolpackUpdates(), 6 * 60 * 60 * 1000);
    this.disposables.push({ dispose: () => { clearTimeout(toolpackUpdateTimer); clearInterval(toolpackUpdateInterval); } });
    // Models saved before they moved to settings must be in settings to sync.
    void this.models.migrate().catch(error => this.output.appendLine(`Could not move saved models to settings: ${String(error)}`));
    // One-time: an OAuth account signed in twice (same email) keeps one record.
    void this.oauthAccounts.collapseDuplicates()
      .then(count => { if (count) { this.output.appendLine(`Merged ${count} duplicate sign-in${count === 1 ? '' : 's'}.`); void this.refreshAccounts(false); } })
      .catch(error => this.output.appendLine(`Could not merge duplicate accounts: ${String(error)}`));
    this.ensureNode().then(async () => { await this.refreshDependencies(); await this.toolpacks.start(); this.sync.start(); void this.offerSync(); }).catch(error => {
      this.output.appendLine(`Dependency setup failed: ${String(error)}`);
      void vscode.window.showErrorMessage(`Unify setup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.sidebar.postMessage({ type: 'approvalState', mode: this.approvalMode });
    this.refreshCustomize();
    this.postUnifyFeatures();
    this.refreshModels();
    this.refreshSessions();
    this.resumeLastChat();
    void this.refreshAccount();
    void this.refreshAccounts();
    // Startup sweep: files whose chats were deleted while the app was closed leave the index for good.
    void this.media.sweep().then(count => {
      if (count) this.output.appendLine(`Media sweep removed ${count} unreferenced file${count === 1 ? '' : 's'}.`);
    }).catch(error => this.output.appendLine(`Media sweep failed: ${String(error)}`));
  }

  get chat(): Chat | undefined { return this.active ? this.chats.get(this.active.id) : undefined; }

  get mirror(): WorkspaceMirror | undefined { return this.chat?.mirror; }

  get review(): ReviewController | undefined { return this.chat?.review; }

  get running(): boolean { return !!this.chat?.running; }

  public dispose(): Thenable<void> {
    if (this.timelineTimer) clearTimeout(this.timelineTimer);
    const saved = this.context.workspaceState.update(TIMELINES_KEY, this.timelines);
    for (const chat of this.chats.values()) { if (chat.ping) chat.cli.cancel(); chat.review.dispose(); chat.mirror.dispose(); agentBus.unregister(chat.record.id); unbindChatAgentOwner(chat.ownerId); }
    for (const disposable of this.disposables) disposable.dispose();
    return saved;
  }

  /** This workspace's file summaries, kept in extension storage. Undefined without a local workspace folder. */
  get summaries(): FileSummaries | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') return undefined;
    return this.fileSummaries ??= new FileSummaries({
      file: join(this.context.globalStorageUri.fsPath, 'summaries', `${createHash('sha256').update(folder.uri.fsPath).digest('hex').slice(0, 16)}.json`),
      generate: (cwd, prompt) => {
        const choice = this.modelSetting('summaryModel');
        if (!choice.model) throw new Error('No summary model is set.');
        return this.runOneShot({ ...choice, model: choice.model }, cwd, prompt, 300_000);
      },
      enabled: () => this.summariesOn(),
      canGenerate: () => !!this.modelSetting('summaryModel').model,
      log: line => this.output.appendLine(line),
      excluded: path => mirrorPathExcluded(path),
    });
  }
}

/**
 * The host's methods live in host/*.ts, one module per area, as functions with an explicit `this: ExtensionHost`.
 * They are attached to the prototype here, so `this.foo()` call sites are unchanged.
 */
type HostParts = typeof lifecycle & typeof runtimes & typeof git & typeof agentBusMethods & typeof sessions & typeof updates & typeof models & typeof cursor & typeof approvals & typeof toolpacks & typeof chats & typeof instructions & typeof media & typeof jobs & typeof prompt & typeof subagents & typeof settings & typeof voice & typeof smartAuto & typeof sidebarMessages;
// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface ExtensionHost extends HostParts {}
/** The host's type for the modules in host/ (the class itself stays unexported: the tests append their own export). */
export type { ExtensionHost as Host };
Object.assign(ExtensionHost.prototype, lifecycle, runtimes, git, agentBusMethods, sessions, updates, models, cursor, approvals, toolpacks, chats, instructions, media, jobs, prompt, subagents, settings, voice, smartAuto, sidebarMessages);

let host: ExtensionHost | undefined;

export function activate(context: vscode.ExtensionContext): void {
  host = new ExtensionHost(context);
  context.subscriptions.push(host);
}

export function deactivate(): Thenable<void> | undefined { const saved = host?.dispose(); host = undefined; return saved; }
