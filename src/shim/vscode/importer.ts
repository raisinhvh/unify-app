/**
 * One-time import of DSH data that VS Code kept in its own extension stores.
 *
 * Global/workspace state is plain JSON in state.vscdb and imports cleanly.
 * SecretStorage values are encrypted with VS Code's key and cannot be read by
 * another app, so they are reported as needing a fresh sign-in instead.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonMemento, readJson, settingsSnapshot, ShimPaths, writeJson } from './state';
import { readVsCodeState } from './sqlite';

export const EXTENSION_ID = 'dsh-local.dsh-ide';

export interface MissingCredential {
  kind: 'secret';
  provider: string;
  accountId: string;
  label: string;
  reason: string;
}

export interface SetupStatus {
  needsSetup: boolean;
  firstRun: boolean;
  importedAccounts: number;
  importedOAuthAccounts: number;
  importedSettings: number;
  importedWorkspace: boolean;
  missing: MissingCredential[];
  notes: string[];
  dataRoot: string;
  sources: string[];
}

interface ImportRecord {
  globalState: boolean;
  settings: boolean;
  workspaceIds: string[];
  vsCodeUserDir?: string;
}

interface VsCodeAccount {
  id?: string;
  provider?: string;
  label?: string;
}

interface VsCodeGlobalState {
  'dsh.accounts.v1'?: VsCodeAccount[];
  'dsh.oauthCliAccounts.v1'?: unknown[];
}

function looksLikeVsCodeUserDir(path: string): boolean {
  return existsSync(join(path, 'globalStorage')) || existsSync(join(path, 'settings.json'));
}

function candidateUserDirs(): string[] {
  const appData = process.env.APPDATA;
  const home = process.env.HOME;
  const candidates: string[] = [];
  if (appData) {
    for (const product of ['Code', 'Code - Insiders', 'VSCodium', 'Cursor']) {
      candidates.push(join(appData, product, 'User'));
    }
  }
  if (home) {
    candidates.push(join(home, '.config', 'Code', 'User'));
    candidates.push(join(home, 'Library', 'Application Support', 'Code', 'User'));
  }
  return candidates;
}

/** The VS Code profile whose DSH data should carry over, if one exists. */
export function detectVsCodeUserDir(): string | undefined {
  return candidateUserDirs().find(looksLikeVsCodeUserDir);
}

/** Text keys are dsh.*; drop comments tolerantly so VS Code's settings.json parses. */
function readSettingsFile(path: string): Record<string, unknown> {
  try {
    const text = readFileSync(path, 'utf8');
    const withoutComments = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    return JSON.parse(withoutComments) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function projectKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

function workspaceStorageDir(userDir: string, projectPath: string | undefined): string | undefined {
  if (!projectPath) return undefined;
  const root = join(userDir, 'workspaceStorage');
  if (!existsSync(root)) return undefined;
  const wanted = projectKey(projectPath);
  for (const name of readdirSync(root)) {
    const metaPath = join(root, name, 'workspace.json');
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { folder?: string; workspace?: string };
      const urls = [meta.folder, meta.workspace].filter((value): value is string => typeof value === 'string');
      for (const url of urls) {
        if (!url.startsWith('file:')) continue;
        const path = decodeURIComponent(new URL(url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
        if (projectKey(path) === wanted) return join(root, name);
      }
    } catch {
      // A half-written workspace folder is not this project.
    }
  }
  return undefined;
}

/** Collects the accounts whose VS Code secret cannot be decrypted. */
function missingCredentials(globalState: VsCodeGlobalState, secretKeys: string[]): MissingCredential[] {
  const missing: MissingCredential[] = [];
  const secretIds = new Set<string>();
  for (const key of secretKeys) {
    const payload = key.includes('"key":"') ? key.slice(key.indexOf('"key":"') + 7).replace(/"\}$/, '') : '';
    if (payload) secretIds.add(payload);
  }
  for (const account of globalState['dsh.accounts.v1'] || []) {
    if (!account?.id) continue;
    const secretId = `dsh.account.secret.v1.${encodeURIComponent(account.id)}`;
    // VS Code's rows are present but encrypted; either way the key is unusable here.
    missing.push({
      kind: 'secret',
      provider: String(account.provider || 'unknown'),
      accountId: String(account.id),
      label: String(account.label || account.id),
      reason: secretIds.has(secretId) || secretIds.size > 0
        ? 'Stored by VS Code SecretStorage (encrypted); enter the key again in Unify.'
        : 'No usable secret was found; enter the key again in Unify.',
    });
  }
  return missing;
}

function secretKeyNames(secretRows: string[]): string[] {
  const names: string[] = [];
  for (const key of secretRows) {
    const match = /"key":"([^"]+)"/.exec(key);
    if (match) names.push(match[1]);
  }
  return names;
}

export interface ImportOptions {
  paths: ShimPaths;
  globalMemento: JsonMemento;
  workspaceMemento: JsonMemento;
  projectPath?: string;
}

export interface ImportResult {
  setup: SetupStatus;
  record: ImportRecord;
}

function importRecordPath(paths: ShimPaths): string { return join(paths.stateRoot, 'import.json'); }

export function loadImportRecord(paths: ShimPaths): ImportRecord {
  return readJson<ImportRecord>(importRecordPath(paths), { globalState: false, settings: false, workspaceIds: [] });
}

export function saveImportRecord(paths: ShimPaths, record: ImportRecord): void {
  writeJson(importRecordPath(paths), record);
}

/**
 * Imports settings and the VS Code global state once, then this project's
 * workspace state the first time that project is opened. Returns what was
 * imported and which secrets need re-entering.
 */
export function importVsCodeData(options: ImportOptions): ImportResult {
  const { paths, globalMemento, workspaceMemento, projectPath } = options;
  const record = loadImportRecord(paths);
  const notes: string[] = [];
  const sources: string[] = [];
  let importedAccounts = 0;
  let importedOAuthAccounts = 0;
  let importedSettings = 0;
  let importedWorkspace = false;
  let missing: MissingCredential[] = [];

  const userDirs = candidateUserDirs().filter(looksLikeVsCodeUserDir);
  const preferred = record.vsCodeUserDir && existsSync(record.vsCodeUserDir) ? record.vsCodeUserDir : userDirs[0];
  if (preferred) record.vsCodeUserDir = preferred;

  if (preferred && !record.settings) {
    const vsSettings = readSettingsFile(join(preferred, 'settings.json'));
    const dshSettings = Object.fromEntries(Object.entries(vsSettings).filter(([key]) => key.startsWith('dsh.')));
    importedSettings = Object.keys(dshSettings).length;
    if (importedSettings > 0 && Object.keys(settingsSnapshot()).length === 0) {
      const settingsPath = join(paths.stateRoot, 'settings.json');
      writeJson(settingsPath, { ...readJson<Record<string, unknown>>(settingsPath, {}), ...dshSettings });
      sources.push('VS Code settings');
    }
    record.settings = true;
  }

  if (preferred && !record.globalState) {
    const dbPath = join(preferred, 'globalStorage', 'state.vscdb');
    if (existsSync(dbPath)) {
      try {
        const state = readVsCodeState(dbPath, EXTENSION_ID);
        const globalState = (state.globalState || {}) as VsCodeGlobalState;
        if (state.globalState && typeof state.globalState === 'object') {
          const entries = { ...(state.globalState as Record<string, unknown>) };
          globalMemento.replaceAll(entries);
          importedAccounts = (entries['dsh.accounts.v1'] as unknown[] | undefined)?.length || 0;
          importedOAuthAccounts = (entries['dsh.oauthCliAccounts.v1'] as unknown[] | undefined)?.length || 0;
          sources.push('VS Code globalState');
        }
        const secretKeys = secretKeyNames(state.secretKeys);
        missing = missingCredentials(globalState, secretKeys);
        record.globalState = true;
      } catch (error) {
        notes.push(`Could not read VS Code global state: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else if (!preferred) {
    notes.push('VS Code profile not found; Unify starts with its own data folder.');
  }

  if (preferred && projectPath && !record.workspaceIds.includes(projectKey(projectPath))) {
    const folder = workspaceStorageDir(preferred, projectPath);
    if (folder) {
      const dbPath = join(folder, 'state.vscdb');
      if (existsSync(dbPath)) {
        try {
          const state = readVsCodeState(dbPath, EXTENSION_ID);
          if (state.globalState && typeof state.globalState === 'object') {
            workspaceMemento.replaceAll(state.globalState as Record<string, unknown>);
            importedWorkspace = true;
            sources.push('VS Code workspaceState');
          }
        } catch (error) {
          notes.push(`Could not read this project's VS Code state: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    record.workspaceIds.push(projectKey(projectPath));
  }

  saveImportRecord(paths, record);

  if (!record.globalState && !preferred) {
    // Nothing to carry over; the setup wizard can add accounts from scratch.
  }

  const setup: SetupStatus = {
    needsSetup: missing.length > 0,
    firstRun: !record.globalState,
    importedAccounts,
    importedOAuthAccounts,
    importedSettings,
    importedWorkspace,
    missing,
    notes,
    dataRoot: paths.stateRoot,
    sources,
  };
  return { setup, record };
}

/** Writes a marker so the setup wizard is not shown again after accounts are entered. */
export function markSetupComplete(paths: ShimPaths): void {
  writeFileSync(join(paths.stateRoot, 'setup-complete'), new Date().toISOString(), 'utf8');
}
