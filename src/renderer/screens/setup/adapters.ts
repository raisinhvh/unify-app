/**
 * Engine data the Setup wizard needs. What already exists is used directly (accounts, sign-in,
 * checkDependencies/installProvider for provider CLIs); the rest goes through typed requests that
 * settings/protocol-requests.md describes. Until the engine answers them:
 *   - git and node stay "Checking…" (provider CLIs still come from dependencyState),
 *   - imports report nothing found,
 *   - the setup-complete flag lives in renderer persistence only.
 */
import { createSignal } from 'solid-js';
import { post } from '../../bridge';
import { readPersisted, writePersisted } from '../../persist';
import type { SidebarDependency, SidebarProject } from '../../protocol';
import { onHostMessage, viewState } from '../../store';
import { onRequestReply, postRequest } from '../settings/adapters';

/* Command-line tools */

export type ToolState = 'checking' | 'found' | 'missing' | 'fixing' | 'error';

export interface ToolStatus {
  /** Executable name: git, node, claude, codex, cursor-agent, opencode. */
  id: string;
  description: string;
  state: ToolState;
  version?: string;
  /** Why the last fix failed (state 'error'). */
  error?: string;
  /** Required tools block Continue while missing. */
  required: boolean;
}

interface ToolsStateMessage {
  type: 'toolsState';
  tools: ToolStatus[];
}

/** Provider CLI executables and the provider ids DSH's dependencyState / installProvider use. */
const providerTools: { id: string; provider: string; description: string }[] = [
  { id: 'claude', provider: 'claude-cli', description: 'Claude Code CLI, the Anthropic agent runtime' },
  { id: 'codex', provider: 'codex-cli', description: 'Codex CLI, the OpenAI agent runtime' },
  { id: 'cursor-agent', provider: 'cursor-acp', description: 'Cursor agent CLI' },
  { id: 'opencode', provider: 'opencode-go', description: 'OpenCode CLI, for OpenCode Go accounts' },
];

const baseTools: { id: string; description: string }[] = [
  { id: 'git', description: 'Checkpoints, diffs and branches' },
  { id: 'node', description: 'Runs toolpacks and MCP servers' },
];

const [engineTools, setEngineTools] = createSignal<ToolStatus[] | undefined>();
const [dependencies, setDependencies] = createSignal<SidebarDependency[] | undefined>();
const [checking, setChecking] = createSignal(false);
/** Fixes started from here for tools the engine reports through dependencyState only. */
const [fixing, setFixing] = createSignal<string[]>([]);

let listening = false;

function listen(): void {
  if (listening) return;
  listening = true;
  onRequestReply<ToolsStateMessage>('toolsState', message => {
    setEngineTools(message.tools);
    setChecking(false);
  });
  onHostMessage(message => {
    if (message.type !== 'dependencyState') return;
    setDependencies(message.providers);
    setChecking(false);
    // A fix is over once its provider is no longer installing.
    setFixing(current => current.filter(id => {
      const provider = providerTools.find(tool => tool.id === id)?.provider;
      return !!message.providers.find(item => item.provider === provider)?.installing;
    }));
  });
}

/** A provider CLI matters only when an account for that provider exists (git and node always do). */
function providerInUse(provider: string): boolean {
  if (provider === 'cursor-acp' && viewState.cursor?.connected) return true;
  return (viewState.accounts ?? []).some(account => account.provider === provider);
}

/** The list the Tools step shows: the engine's when it sends one, otherwise built from dependencyState. */
export function tools(): ToolStatus[] {
  listen();
  // The engine decides `required` and which provider CLIs to list (see protocol-requests.md).
  const fromEngine = engineTools();
  if (fromEngine) return fromEngine;
  const list: ToolStatus[] = baseTools.map(tool => ({ ...tool, state: 'checking', required: true }));
  for (const tool of providerTools) {
    if (!providerInUse(tool.provider)) continue;
    const dependency = dependencies()?.find(item => item.provider === tool.provider);
    let state: ToolState = 'checking';
    if (dependency) {
      if (dependency.installing || fixing().includes(tool.id)) state = 'fixing';
      else if (dependency.error) state = 'error';
      else state = dependency.installed ? 'found' : 'missing';
    }
    if (checking() && state !== 'fixing') state = 'checking';
    list.push({ id: tool.id, description: tool.description, state, error: dependency?.error, required: true });
  }
  return list;
}

export function checkTools(): void {
  listen();
  setChecking(true);
  const current = engineTools();
  if (current) setEngineTools(current.map(tool => (tool.state === 'fixing' ? tool : { ...tool, state: 'checking' })));
  postRequest({ type: 'checkTools' });
  post({ type: 'checkDependencies' });
}

export function fixTool(id: string): void {
  listen();
  const providerTool = providerTools.find(tool => tool.id === id);
  const current = engineTools();
  if (current) setEngineTools(current.map(tool => (tool.id === id ? { ...tool, state: 'fixing', error: undefined } : tool)));
  if (providerTool && !current) {
    setFixing(list => [...list, id]);
    post({ type: 'installProvider', provider: providerTool.provider });
    return;
  }
  postRequest({ type: 'fixTool', id });
}

/* Imports from DSH (Extras) */

export interface DshImportScan {
  /** Toolpack folder names in ~/.dsh/toolpacks not yet installed in Unify. */
  toolpacks: string[];
  rules: number;
  skills: number;
  memoryNotes: number;
}

export type ImportKind = 'toolpacks' | 'knowledge';

interface DshImportStateMessage {
  type: 'dshImportState';
  scan: DshImportScan;
}

interface DshImportResultMessage {
  type: 'dshImportResult';
  what: ImportKind;
  ok: boolean;
  /** Toolpacks installed, or rules + skills + notes merged. */
  count: number;
  error?: string;
}

const [importScan, setImportScan] = createSignal<DshImportScan | undefined>();
const [importResults, setImportResults] = createSignal<Partial<Record<ImportKind, DshImportResultMessage>>>({});
export { importScan, importResults };

let importListening = false;

export function scanImports(): void {
  if (!importListening) {
    importListening = true;
    onRequestReply<DshImportStateMessage>('dshImportState', message => setImportScan(message.scan));
    onRequestReply<DshImportResultMessage>('dshImportResult', message => setImportResults(current => ({ ...current, [message.what]: message })));
  }
  postRequest({ type: 'scanDshImports' });
}

export function importFromDsh(what: ImportKind): void {
  setImportResults(current => {
    const next = { ...current };
    delete next[what];
    return next;
  });
  postRequest({ type: 'importFromDsh', what });
}

/* Setup flag and default project */

export interface SetupSummary {
  accounts: string[];
  project?: SidebarProject;
  tools: string[];
  theme: string;
  toolpacks: 'imported' | 'skipped';
  knowledge: 'imported' | 'skipped';
}

interface SetupStateMessage {
  type: 'setupState';
  complete: boolean;
  defaultProject?: SidebarProject;
}

/** Renderer copy of the flag, so a finished setup stays finished before the engine knows the message. */
const [setupComplete, setSetupCompleteSignal] = createSignal<boolean>(readPersisted('setupComplete', false));
const [engineSetupKnown, setEngineSetupKnown] = createSignal(false);
export { setupComplete, engineSetupKnown };

let setupRequested = false;

export function requestSetupState(onDefaultProject?: (project: SidebarProject) => void): void {
  if (setupRequested) return;
  setupRequested = true;
  onRequestReply<SetupStateMessage>('setupState', message => {
    setEngineSetupKnown(true);
    setSetupCompleteSignal(message.complete);
    writePersisted('setupComplete', message.complete);
    if (message.defaultProject) onDefaultProject?.(message.defaultProject);
  });
  postRequest({ type: 'getSetupState' });
}

export function markSetupComplete(summary: SetupSummary): void {
  setSetupCompleteSignal(true);
  writePersisted('setupComplete', true);
  postRequest({ type: 'setupComplete', summary });
}

export function setDefaultProject(project: SidebarProject): void {
  postRequest({ type: 'setDefaultProject', project });
}
