/** Shared types of the extension host: chat records, subagent runs and transcript items. */
import type { ModelEntry, ResolvedModel } from '../accounts';
import type { OAuthCliAccount } from '../accounts/oauthCli';
import type { ReviewController } from '../review/controller';
import type { DelegateResult } from '../delegate/host';
import type { JobState } from '../goal/types';
import type { AfterTurn } from '../runtime/delegation';
import type { AcpRuntime } from '../runtime/acp';
import type { OAuthCliRuntime } from '../runtime/oauthCli';
import type { CodexCliRuntime } from '../runtime/codexCli';
import type { WorkspaceMirror } from '../runtime/shadow';
import type { Checkpoint } from '../runtime/checkpoint';
import type { LiveEdits } from '../unify/liveEdits';
import type { CompactWatch } from '../runtime/midTurnCompact';
import type { ChatMessage } from '../runtime/handoff';
import type { TranscriptPart } from '../runtime/transcriptParts';
import type { SidebarMedia, SidebarProject, SidebarTimelineItem, SidebarSubagent } from '../sidebar/view';

export interface SessionRecord {
  id: string;
  mirrorId: string;
  name: string;
  /** The chat agent's exclusive name in agent messaging ("Kernel"); kept while free, see unify/agentNames.ts. */
  agentName?: string;
  /** The user renamed this chat, so automatic titles must not replace the name. */
  renamed?: boolean;
  /** Material Symbols icon the activity rail shows, picked by the name model. */
  icon?: string;
  /** Workspace folder the chat was created in; chats are grouped by it in the rail. */
  project?: SidebarProject;
  modelName: string;
  provider: string;
  backend: string;
  accountId: string;
  job?: JobState;
  cliSessionId?: string;
  /** Frozen when the chat is created. Missing on older chats means the previous agent-runtime route. */
  codexRuntime?: boolean;
  previousCliSessionId?: string;
  checkpoint?: Checkpoint;
  contextTokens?: number;
  /** Context of a fresh session before any conversation: system prompt, tools and the first message. Auto compaction counts from here. */
  baseTokens?: number;
  /** With auto compaction: earlier messages archived as parts under .unify/transcripts, in order. */
  parts?: TranscriptPart[];
  explorerTokens?: number;
  sessionInstructions?: string;
  lastInstructions?: string;
  initTools?: string[];
  prefixHash?: string;
  lastTurnAt?: number;
  lastPingAt?: number;
  pingsSent?: number;
  resumeNotice?: 'checkpoint' | 'idle' | 'compact';
  idleHandoff?: boolean;
  shortCache?: boolean;
  nudgedAt?: number;
  runtimeId?: string;
  pendingMirror?: boolean;
  /**
   * The folder the chat's working copy was made from, fixed when it was first prepared. Chats from before this
   * was recorded were all made from the workspace folder.
   */
  rootPath?: string;
  /** The agent edits the real workspace instead of a private copy (unify.runtime.mirror off when the chat was created). */
  direct?: boolean;
  /** Started with no project folder: the agent works in its own empty scratch folder (see scratchRoot). */
  noFolder?: boolean;
  effort?: string;
  /** Smart Auto picks this chat's model for each message the user sends. */
  smartAuto?: boolean;
  /** Toolpacks turned on in this chat, by a /pack command or an agent's load_toolpack call. */
  toolpacks?: string[];
  updatedAt: number;
}

export type SavedTimeline = { timeline: SidebarTimelineItem[]; subagents: Record<string, SidebarSubagent> };

export type ModelChoice = { speed?: string; effort?: string };

export type ModelSettingKey = 'nameModel' | 'reviewModel' | 'summaryModel' | 'deciderModel' | 'explorerModel';

export type ResolvedRoute = ResolvedModel | { model: ModelEntry } | { model: ModelEntry; oauthAccount: OAuthCliAccount };

export interface SubagentProfile { name: string; description?: string; model: string; effort?: string; speed?: string; mode: 'read-only' | 'edit'; tools?: boolean; enabled?: boolean }

export interface Actor { owner: string; label: string; readOnly: boolean }

export interface ToolInfo { tool: string; input: Record<string, unknown>; autoAllowEdits?: boolean }

/** The contract's SidebarMedia, plus the hash and size the renderer reads (view.ts predates them). */
export type MediaItem = SidebarMedia & { hash: string; width?: number; height?: number };

/** An image block as ACP reports it on a finished tool call. */
export interface IncomingImage { data: string; mimeType: string }

export interface ChildRun {
  parent: Chat;
  owner: string;
  label: string;
  /** The agent's exclusive messaging name (e.g. "Arp"), set once it is registered with the agent bus. */
  name?: string;
  /** The id the UI knows this subagent by, for its own feed and sentToParent updates. */
  agentId: string;
  readOnly: boolean;
  changed: Set<string>;
  outOfScope: Set<string>;
  files: string[];
  /** Images sent to the parent while it runs, in order; the parent's own chat id is the store ref. */
  sentToParent: MediaItem[];
  /** Images to hand the parent as content blocks when this run's result is returned. */
  queuedForParent: { item: MediaItem; shownBy: string }[];
  /** Started with background: true, so it outlives an interrupted parent turn. */
  background?: boolean;
  runtimeKey?: string;
  sessionId?: string;
  onUpdate?(update: Record<string, unknown>): void;
  cancel(): void;
  /**
   * Puts a message from the user into the running turn (Claude CLI: mid-turn input; ACP: interrupt, then the
   * message is the session's next prompt). False when the runtime has no such channel or no turn is running;
   * the message then waits in the subagent's inbox for its next Unify tool result.
   */
  say?(text: string): boolean;
}

/** A subagent started with background: true, kept until the parent agent collects its result. */
export interface BackgroundTask { id: string; label: string; afterTurn: AfterTurn; done: boolean; result?: DelegateResult; finished: Promise<void>; run?: ChildRun }

export interface TurnOptions {
  shown?: string;
  job?: boolean;
  /** Sent by Unify, not typed by the user (job steps, background subagent results): no user message is shown for it. */
  internal?: boolean;
  /** Chat this prompt belongs to in a multi-pane UI; omitted means the active chat. */
  chatId?: string;
  onFinish?(reply: string, cancelled: boolean): void;
}

/** A transcript entry; `internal` marks prompts Unify sent on its own, which are never shown as the user's messages. */
export type TranscriptItem = ChatMessage & { internal?: boolean; displayText?: string; media?: MediaItem[] };

export interface Chat {
  record: SessionRecord;
  mirror: WorkspaceMirror;
  review: ReviewController;
  cli: OAuthCliRuntime;
  codexCli: CodexCliRuntime;
  running: boolean;
  cancelRequested: boolean;
  jobActive: boolean;
  jobCancelled: boolean;
  /** Messages sent while a job runs, waiting for the job to log them as decisions. */
  jobNotes: { prompt: string; images: { path: string; mimeType: string; data: string; name: string }[] }[];
  /** Set when a sent message ended the job's current turn or review early. */
  jobInterrupted: boolean;
  queue: { prompt: string; images: { path: string; mimeType: string; data: string; name: string }[] }[];
  turnEntryId: string;
  segment: number;
  startedTools: Set<string>;
  /** Live edit preview of this turn's edit calls (spec "Live edit preview in chat"); reset when a turn starts. */
  liveEdits?: LiveEdits;
  subagentIds: Set<string>;
  delegationToolIds: Set<string>;
  subagentText: Map<string, string>;
  turnReply: string;
  /** Tool lines of the running turn, saved with its reply so read_chat_history can return and search them. */
  turnTools: string[];
  /** Set while the first context report of a fresh session is awaited: the estimated size of the prompt that started it. */
  measureBase?: number;
  handoffPending: boolean;
  pendingCheckpoint?: Checkpoint;
  /** Mid-turn compaction of the running turn: set when it may ask the agent to checkpoint. */
  compactWatch?: CompactWatch;
  ping?: Promise<void>;
  /** Instructions and editor context last sent into this agent session, so unchanged text is not repeated. */
  sent?: { session: string; instructions: string; context: string };
  ownerId: string;
  runtime?: AcpRuntime;
  runtimeKey?: string;
  locks: Map<string, { owner: string; label: string }>;
  children: Set<ChildRun>;
  background: Map<string, BackgroundTask>;
  /** Stops the Smart Auto decider while it is choosing this turn's model. */
  stopDecider?: () => void;
}
