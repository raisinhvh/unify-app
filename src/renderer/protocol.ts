/**
 * Engine <-> renderer protocol.
 *
 * The message shapes are owned by the engine (`src/engine/sidebar/view.ts`, copied from DSH unchanged).
 * This file only re-exports them as types, so the renderer bundle never pulls engine code in, and adds the
 * renderer-side extensions that ARCHITECTURE.md allows:
 *   - an optional `chatId` on outgoing messages, so several chats on screen can each address their own runtime;
 *   - `plan` on account usage (DSH's usage maths reads `usage.plan.monthlyUsd`);
 *   - an optional `project` on sessions, so the Chats tree can group chats by project folder;
 *   - `contextWindow` on models, and the `githubState` push, until view.ts lists them.
 * Everything here is `import type`, so Vite strips it at build time.
 */
import type {
  SidebarAccountUsage as EngineAccountUsage,
  SidebarHostMessage as EngineHostMessage,
  SidebarModel as EngineModel,
  SidebarSession as EngineSession,
  SidebarViewState as EngineViewState,
  SidebarWebviewMessage as EngineWebviewMessage,
} from '@engine/sidebar/view';
import type { PackSetupState } from '@engine/hub/types';

export type { AgentInfo, AgentMessage } from '@engine/unify/agentBus';

export type {
  ApprovalMode,
  CursorAccountState,
  SidebarAccount,
  SidebarDependency,
  SidebarDiff,
  SidebarExplorerRange,
  SidebarFeatures,
  SidebarInternalTool,
  SidebarInternalToolKind,
  SidebarImage,
  SidebarJob,
  SidebarMedia,
  SidebarPage,
  SidebarQuestion,
  SidebarSubagent,
  SidebarSubagentTool,
  SidebarTimelineItem,
  SidebarToolEvent,
  SidebarUsageMetric,
} from '@engine/sidebar/view';

/** The plan an account is on; the usage summary weights each account by what its plan costs. */
export interface SidebarPlan {
  name: string;
  monthlyUsd: number;
}

export type SidebarAccountUsage = EngineAccountUsage & { plan?: SidebarPlan };

/** Project folder a chat belongs to. Optional until the backend sends it; chats without one group under "Chats". */
export interface SidebarProject {
  name: string;
  path: string;
}

export type SidebarSession = EngineSession & { project?: SidebarProject };

/**
 * Every UI -> engine message may name the chat it is for when several chats are on screen.
 * `project` is only read on `newSession`: Home starts the chat in the folder picked under its composer.
 */
export type SidebarWebviewMessage = EngineWebviewMessage & { chatId?: string; project?: SidebarProject };

/** A model the engine offers; `contextWindow` is its context size in tokens, when the provider reports it. */
export type SidebarModel = EngineModel & { contextWindow?: number };

/** GitHub sign-in, as in `viewState.github`. */
export type SidebarGithub = NonNullable<EngineViewState['github']>;

/** Sent whenever GitHub auth changes; carries the same shape as `viewState.github`. */
export interface GithubStateMessage {
  type: 'githubState';
  github: SidebarGithub;
}

type WithSessionExtensions<Message> = Message extends { type: 'sessionState'; sessions: EngineSession[] }
  ? Omit<Message, 'sessions'> & { sessions: SidebarSession[] }
  : Message extends { type: 'usageState' }
    ? Omit<Message, 'usage'> & { usage: Record<string, SidebarAccountUsage> }
    : Message extends { type: 'modelState' }
      ? Omit<Message, 'models'> & { models: SidebarModel[] }
      : Message;

export type SidebarHostMessage = (WithSessionExtensions<EngineHostMessage> | GithubStateMessage) & { chatId?: string };

export type SidebarViewState = Omit<EngineViewState, 'sessions' | 'usage' | 'models'> & {
  sessions: SidebarSession[];
  usage: Record<string, SidebarAccountUsage>;
  models: SidebarModel[];
  /** Kept from DSH's webview state: Cursor backends offered by modelState. */
  cursorBackends?: { value: string; name: string }[];
};

export type RunState = SidebarViewState['runStates'][string];

/**
 * Toolpack Hub install (src/engine/unify/requests/hub.ts). A pack that ships an install script answers with
 * `needsScriptConsent` and the script; the UI resends with `allowScript: true` once the user agrees.
 */
export interface HubInstallMessage {
  type: 'hubInstall';
  id: string;
  target: 'this' | 'all';
  allowScript?: boolean;
  requestId?: string;
}

export interface HubInstallResultMessage {
  type: 'hubInstallResult';
  ok: boolean;
  id: string;
  needsScriptConsent?: boolean;
  scriptName?: string;
  scriptText?: string;
  error?: string;
  requestId?: string;
  /** On success: the pack's setup checklist when it ships a `setup.json` (see engine/hub/types.ts). */
  setup?: PackSetupState | null;
}

export type { PackSetupState, PackSetupStep, PackSetupStepStatus } from '@engine/hub/types';
