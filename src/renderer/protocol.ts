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
import type { HubInstallPackage, PackSetupState } from '@engine/hub/types';

export type { AgentInfo, AgentMessage } from '@engine/unify/agentBus';

export type {
  ApprovalMode,
  CursorAccountState,
  SidebarAccount,
  SidebarBackgroundProcess,
  SidebarDependency,
  SidebarDiff,
  SidebarEditLine,
  SidebarEditPreview,
  SidebarExplorerRange,
  SidebarFeatures,
  SidebarInternalTool,
  SidebarInternalToolKind,
  SidebarImage,
  SidebarJob,
  SidebarMedia,
  SidebarPage,
  SidebarQuestion,
  SidebarScheduledPrompt,
  SidebarSubagent,
  SidebarSubagentTool,
  SidebarTimelineItem,
  SidebarToolEvent,
  SidebarToolProgress,
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
 * `project` and `noFolder` are only read on `newSession`: Home starts the chat in the folder picked under its
 * composer, or with no folder (its own empty scratch folder).
 */
export type SidebarWebviewMessage = EngineWebviewMessage & { chatId?: string; project?: SidebarProject; noFolder?: boolean };

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
 * Toolpack Hub install (src/engine/unify/requests/hub.ts). Two consents, in order: a pack that ships an install
 * script answers with `needsScriptConsent` and the script; the UI resends with `allowScript: true` once the user
 * agrees. A pack with dependencies then answers `needsDependencyConsent` with `packages`; the UI resends with
 * `packages` (the optional step ids the user ticked) once they agree.
 */
export interface HubInstallMessage {
  type: 'hubInstall';
  id: string;
  allowScript?: boolean;
  packages?: string[];
  requestId?: string;
}

export interface HubInstallResultMessage {
  type: 'hubInstallResult';
  ok: boolean;
  id: string;
  needsScriptConsent?: boolean;
  scriptName?: string;
  scriptText?: string;
  /** The script that runs when the pack is removed (undoes what the install script put outside the pack). */
  uninstallScriptName?: string;
  uninstallScriptText?: string;
  /** The pack's dependencies wait for the user's consent (the Hub's dependency dialog); see `packages`. */
  needsDependencyConsent?: boolean;
  /** With `needsDependencyConsent`: the programs the pack's setup installs (winget/brew/pip). */
  packages?: HubInstallPackage[];
  error?: string;
  requestId?: string;
  /** On success: the pack's setup checklist when it ships a `setup.json` (see engine/hub/types.ts). */
  setup?: PackSetupState | null;
}

export type {
  HubCheckUpdatesRequest,
  HubInstallPackage,
  PackSetupState,
  PackSetupStep,
  PackSetupStepStatus,
  ToolpackAutoUpdated,
  ToolpackUpdate,
  ToolpackUpdatesMessage,
} from '@engine/hub/types';