/** JSON-persisted mementos, secrets and settings for the Electron shim. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from './events';

export interface ShimPaths {
  extensionPath: string;
  stateRoot: string;
  globalStoragePath: string;
  projectPath?: string;
  /** Folder the sidebar media is copied into (globalStorage/media). */
  mediaPath: string;
}

let paths: ShimPaths = {
  extensionPath: process.cwd(),
  stateRoot: join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.unify'),
  globalStoragePath: join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.unify', 'storage'),
  mediaPath: join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.unify', 'storage', 'media'),
};

export function configurePaths(next: ShimPaths): void {
  paths = next;
  mkdirSync(next.stateRoot, { recursive: true });
  mkdirSync(next.globalStoragePath, { recursive: true });
}

export function shimPaths(): ShimPaths {
  return paths;
}

function ensureFolder(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Writes a small JSON file atomically enough that a crash cannot truncate it. */
export function writeJson(path: string, value: unknown): void {
  ensureFolder(join(path, '..'));
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export class JsonMemento {
  private values: Record<string, unknown>;
  private writeTimer?: NodeJS.Timeout;
  private pending?: Promise<void>;

  public constructor(private readonly path: string) {
    this.values = readJson<Record<string, unknown>>(path, {});
  }

  public keys(): readonly string[] {
    return Object.keys(this.values);
  }

  public get<T>(key: string, defaultValue?: T): T {
    return key in this.values ? (this.values[key] as T) : (defaultValue as T);
  }

  public update(key: string, value: unknown): Promise<void> {
    if (value === undefined) delete this.values[key];
    else this.values[key] = value;
    return this.flushSoon();
  }

  /** Replaces all values, used by the one-time VS Code import. */
  public replaceAll(values: Record<string, unknown>): Promise<void> {
    this.values = { ...values };
    return this.flushSoon();
  }

  public snapshot(): Record<string, unknown> {
    return { ...this.values };
  }

  public flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    if (!this.pending) {
      this.pending = Promise.resolve().then(() => {
        this.pending = undefined;
        writeJson(this.path, this.values);
      });
    }
    return this.pending;
  }

  private flushSoon(): Promise<void> {
    if (!this.writeTimer) {
      this.writeTimer = setTimeout(() => {
        this.writeTimer = undefined;
        void this.flush();
      }, 80);
    }
    return this.flush();
  }
}

export interface SecretStorageLike {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  onDidChange?: EventEmitter<{ key: string }>['event'];
}

class MemorySecrets implements SecretStorageLike {
  private readonly values = new Map<string, string>();
  public async get(key: string): Promise<string | undefined> { return this.values.get(key); }
  public async store(key: string, value: string): Promise<void> { this.values.set(key, value); }
  public async delete(key: string): Promise<void> { this.values.delete(key); }
}

let secretStorage: SecretStorageLike = new MemorySecrets();

export function configureSecrets(storage: SecretStorageLike): void {
  secretStorage = storage;
}

export function secrets(): SecretStorageLike {
  return secretStorage;
}

export interface SettingProperty {
  type?: string | string[];
  default?: unknown;
  enum?: unknown[];
  description?: string;
  items?: unknown;
  properties?: Record<string, SettingProperty>;
}

export interface ConfigurationChangeEvent {
  affectsConfiguration(section: string): boolean;
}

const configurationChanged = new EventEmitter<ConfigurationChangeEvent>();
export const onDidChangeSettings = configurationChanged.event;

let defaults: Record<string, SettingProperty> = {};
let settingsPath = '';
let notifyUpdate: ((key: string) => void) | undefined;

/** Lets workspace.ts surface writes to the engine's onDidChangeConfiguration. */
export function onConfigurationUpdated(listener: (key: string) => void): void {
  notifyUpdate = listener;
}

export function configureSettings(path: string, packageDefaults: Record<string, SettingProperty>): void {
  settingsPath = path;
  defaults = packageDefaults;
}

function readSettings(): Record<string, unknown> {
  return readJson<Record<string, unknown>>(settingsPath, {});
}

function lookup(record: Record<string, unknown>, dotted: string): unknown {
  let current: unknown = record;
  for (const part of dotted.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export class WorkspaceConfiguration {
  public constructor(public readonly section?: string) {}

  public get<T>(key: string, defaultValue?: T): T {
    const dotted = this.section ? `${this.section}.${key}` : key;
    const settings = readSettings();
    const value = dotted in settings ? settings[dotted] : lookup(settings, dotted);
    if (value !== undefined) return value as T;
    const property = defaults[dotted];
    if (property && property.default !== undefined) return property.default as T;
    return defaultValue as T;
  }

  public has(key: string): boolean {
    const dotted = this.section ? `${this.section}.${key}` : key;
    return dotted in readSettings() || dotted in defaults;
  }

  public inspect<T>(key: string): { key: string; defaultValue?: T; globalValue?: T; workspaceValue?: T } {
    const dotted = this.section ? `${this.section}.${key}` : key;
    return { key: dotted, defaultValue: defaults[dotted]?.default as T, globalValue: this.get<T>(key) };
  }

  public async update(key: string, value: unknown, _target?: unknown): Promise<void> {
    const dotted = this.section ? `${this.section}.${key}` : key;
    const settings = readSettings();
    if (value === undefined) delete settings[dotted];
    else settings[dotted] = value;
    ensureFolder(join(settingsPath, '..'));
    writeJson(settingsPath, settings);
    configurationChanged.fire({
      affectsConfiguration: (section: string) => dotted === section || dotted.startsWith(`${section}.`) || section.startsWith(`${dotted}.`),
    });
    notifyUpdate?.(dotted);
  }
}

export function settingsSnapshot(): Record<string, unknown> {
  return readSettings();
}

/** Folder name used for a project's workspaceState JSON. */
export function workspaceStatePath(projectPath: string | undefined): string {
  const key = projectPath ? projectPath.replace(/\\/g, '/').toLowerCase() : 'no-workspace';
  const hash = createHash('sha1').update(key).digest('hex').slice(0, 16);
  const folder = join(paths.stateRoot, 'workspaces');
  ensureFolder(folder);
  return join(folder, `${hash}.json`);
}
