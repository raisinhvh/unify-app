/**
 * Setup wizard data: the CLI tools check and its fix actions, imports from an existing DSH install, the
 * setup-complete flag and the default project.
 *
 * Tool fixes reuse `runtime/dependencies.ts`, the same installer the sidebar protocol uses for provider CLIs.
 * Imports only touch packs from `~/.dsh/toolpacks` that Unify does not have yet; rules, skills and memory are
 * already shared with DSH because both read `~/.dsh`, so importing "knowledge" only counts what is visible.
 */
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { run, WindowsDependencies } from '../../runtime/dependencies';
import { parseRuleSections } from './knowledge';
import { RequestPaths, readJsonFile, writeJsonFile } from './state';
import {
  DshImportScan,
  ImportKind,
  SetupState,
  SetupSummary,
  ToolStatus,
} from './types';

interface SetupFile {
  complete: boolean;
  defaultProject?: { name: string; path: string };
  summary?: SetupSummary;
  completedAt?: number;
}

const BASE_TOOLS = [
  { id: 'git', description: 'Checkpoints, diffs and branches', required: true },
  { id: 'node', description: 'Runs toolpacks and MCP servers', required: true },
];

const PROVIDER_TOOLS = [
  { id: 'claude', provider: 'claude-cli', description: 'Claude Code CLI, the Anthropic agent runtime', required: true },
  { id: 'codex', provider: 'codex-cli', description: 'Codex CLI, the OpenAI agent runtime', required: true },
  { id: 'cursor-agent', provider: 'cursor-acp', description: 'Cursor agent CLI', required: true },
  { id: 'opencode', provider: 'opencode-go', description: 'OpenCode CLI, for OpenCode Go accounts', required: true },
];

const TOOL_TIMEOUT = 15_000;
const INSTALLABLE_PROVIDERS = new Set(['claude-cli', 'cursor-acp']);

function readSetup(paths: RequestPaths): SetupFile {
  const stored = readJsonFile<Partial<SetupFile>>(paths.setupFile, {});
  return {
    complete: stored.complete === true,
    ...(stored.defaultProject && typeof stored.defaultProject.path === 'string'
      ? { defaultProject: { name: String(stored.defaultProject.name || path.basename(stored.defaultProject.path)), path: stored.defaultProject.path } }
      : {}),
    ...(stored.summary ? { summary: stored.summary } : {}),
    ...(typeof stored.completedAt === 'number' ? { completedAt: stored.completedAt } : {}),
  };
}

function saveSetup(paths: RequestPaths, file: SetupFile): void {
  writeJsonFile(paths.setupFile, file);
}

function setupState(paths: RequestPaths): SetupState {
  const file = readSetup(paths);
  return {
    complete: file.complete,
    ...(file.defaultProject ? { defaultProject: file.defaultProject } : {}),
  };
}

export function getSetupState(paths: RequestPaths): { type: 'setupState' } & SetupState {
  return { type: 'setupState', ...setupState(paths) };
}

/** Records that the wizard finished, with the summary the Done step shows. */
export function markSetupComplete(paths: RequestPaths, summary?: SetupSummary): { type: 'setupState' } & SetupState {
  const file = readSetup(paths);
  file.complete = true;
  file.completedAt = Date.now();
  if (summary) file.summary = summary;
  const project = summary?.project;
  if (project && typeof project.path === 'string' && project.path.trim()) {
    file.defaultProject = { name: String(project.name || path.basename(project.path)), path: project.path };
  }
  saveSetup(paths, file);
  return getSetupState(paths);
}

/** Remembers the folder new chats start in. */
export function setDefaultProject(
  paths: RequestPaths,
  project: { name?: unknown; path?: unknown } | undefined,
): { type: 'setupState' } & SetupState {
  const target = typeof project?.path === 'string' ? project.path.trim() : '';
  if (!target) throw new Error('Choose a project folder first.');
  const file = readSetup(paths);
  file.defaultProject = { name: typeof project?.name === 'string' && project.name.trim() ? project.name.trim() : path.basename(target), path: target };
  saveSetup(paths, file);
  return getSetupState(paths);
}

/* ---------------------------------------------------------------------------------------------------------------
 * Tools
 */

/** Providers with at least one saved account (or a Cursor login) in the shim's state.json. */
export function accountProviders(paths: RequestPaths): Set<string> {
  const state = readJsonFile<Record<string, unknown>>(paths.stateFile, {});
  const providers = new Set<string>();
  for (const key of ['dsh.oauthCliAccounts.v1', 'dsh.accounts.v1']) {
    const list = state[key];
    if (!Array.isArray(list)) continue;
    for (const account of list) {
      if (account && typeof account === 'object' && typeof (account as { provider?: unknown }).provider === 'string') {
        providers.add((account as { provider: string }).provider);
      }
    }
  }
  const cursor = state['dsh.cursor.v1'];
  if (cursor && typeof cursor === 'object' && (cursor as { connected?: unknown }).connected === true) providers.add('cursor-acp');
  return providers;
}

function toolVersion(text: string): string | undefined {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined;
}

async function probe(executable: string): Promise<{ state: ToolStatus['state']; version?: string; error?: string }> {
  try {
    const result = await run(executable, ['--version'], TOOL_TIMEOUT);
    if (result.code !== 0) return { state: 'missing' };
    return { state: 'found', version: toolVersion(`${result.stdout}\n${result.stderr}`) };
  } catch (error) {
    return { state: 'missing', ...(error instanceof Error && error.message.includes('timed out') ? { state: 'error', error: error.message } : {}) };
  }
}

function providerExecutable(tool: string): string {
  return tool === 'cursor-agent' ? 'cursor-agent' : tool;
}

/** The Tools step: git and node always, provider CLIs only when an account for that provider exists. */
export async function checkTools(paths: RequestPaths): Promise<ToolStatus[]> {
  const accounts = accountProviders(paths);
  const dependencies = new WindowsDependencies(paths.storageRoot);
  const tools: ToolStatus[] = [];
  for (const tool of BASE_TOOLS) {
    const result = await probe(tool.id === 'node' ? process.execPath : tool.id);
    tools.push({ ...tool, ...result });
  }
  for (const tool of PROVIDER_TOOLS) {
    if (!accounts.has(tool.provider)) continue;
    let executable: string | undefined;
    if (INSTALLABLE_PROVIDERS.has(tool.provider)) {
      executable = await dependencies.providerCommand(tool.provider).catch(() => undefined);
    }
    const result = executable
      ? await probe(executable)
      : await probe(providerExecutable(tool.id));
    tools.push({
      id: tool.id,
      description: tool.description,
      required: tool.required,
      ...result,
    });
  }
  return tools;
}

/** Installs a missing provider CLI, or explains why the tool cannot be fixed from here. */
export async function fixTool(paths: RequestPaths, id: string): Promise<ToolStatus[]> {
  const provider = PROVIDER_TOOLS.find(tool => tool.id === id)?.provider;
  if (!provider) throw new Error(`${id} is not installed by Unify. Install it from its own website and run the check again.`);
  if (!INSTALLABLE_PROVIDERS.has(provider)) {
    throw new Error(`${id} has no automatic installer here. Install it with its package manager and run the check again.`);
  }
  await new WindowsDependencies(paths.storageRoot).installProvider(provider);
  return checkTools(paths);
}

/* ---------------------------------------------------------------------------------------------------------------
 * Imports from an existing DSH install
 */

async function countSkillFolders(root: string): Promise<number> {
  let count = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    let entries;
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        count += 1;
      }
    }
  };
  await walk(root, 0);
  return count;
}

async function countMemoryNotes(root: string): Promise<number> {
  let count = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    let entries;
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        count += 1;
      }
    }
  };
  await walk(root, 0);
  return count;
}

async function installedNames(paths: RequestPaths): Promise<Set<string>> {
  try {
    const entries = await fsp.readdir(paths.toolpacksDir, { withFileTypes: true });
    return new Set(entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name));
  } catch {
    return new Set();
  }
}

/** Toolpacks in `~/.dsh/toolpacks` Unify does not have, plus counts of shared knowledge. */
export async function scanDshImports(paths: RequestPaths): Promise<DshImportScan> {
  const installed = await installedNames(paths);
  const available: string[] = [];
  try {
    const entries = await fsp.readdir(path.join(paths.dshHome, 'toolpacks'), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || installed.has(entry.name)) continue;
      available.push(entry.name);
    }
  } catch {
    // No toolpacks folder: nothing to import.
  }
  let rules = 0;
  try {
    const text = await fsp.readFile(path.join(paths.dshHome, 'AGENTS.md'), 'utf8');
    const parsed = parseRuleSections(text);
    rules = parsed.sections.length || (parsed.preamble.trim() ? 1 : 0);
  } catch {
    // No global rules.
  }
  const skills = (await countSkillFolders(path.join(paths.dshHome, 'skills')))
    + (await countSkillFolders(path.join(paths.agentsHome, 'skills')));
  const memoryNotes = await countMemoryNotes(path.join(paths.dshHome, 'memory'));
  return { toolpacks: available.sort(), rules, skills, memoryNotes };
}

export interface ImportResult {
  type: 'dshImportResult';
  what: ImportKind;
  ok: boolean;
  count: number;
  error?: string;
}

/** Copies DSH toolpacks; knowledge is already shared through `~/.dsh`, so it only counts it. */
export async function importFromDsh(paths: RequestPaths, what: ImportKind): Promise<ImportResult> {
  const scan = await scanDshImports(paths);
  if (what === 'toolpacks') {
    let count = 0;
    await fsp.mkdir(paths.toolpacksDir, { recursive: true });
    for (const name of scan.toolpacks) {
      const source = path.join(paths.dshHome, 'toolpacks', name);
      const destination = path.join(paths.toolpacksDir, name);
      if (fs.existsSync(destination)) continue;
      await fsp.cp(source, destination, { recursive: true, force: false, errorOnExist: false });
      count += 1;
    }
    return { type: 'dshImportResult', what, ok: true, count };
  }
  if (what === 'knowledge') {
    return { type: 'dshImportResult', what, ok: true, count: scan.rules + scan.skills + scan.memoryNotes };
  }
  return { type: 'dshImportResult', what, ok: false, count: 0, error: 'Unknown import.' };
}
