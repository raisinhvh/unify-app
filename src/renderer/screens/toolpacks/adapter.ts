/**
 * Toolpacks as the screen sees them: the engine's SidebarToolpack plus the fields Unify needs that the engine
 * does not send yet (screens/hub/protocol-requests.md › Toolpacks). Every missing field has a fallback, so the
 * screen works against today's engine: display name from the id, glyph guessed from the id, tool kind guessed
 * from the tool name, every tool on, every group "Ask first" except Read.
 *
 * Changes are optimistic: the screen shows them at once and the engine's next `toolpacksState` replaces them.
 */
import { createMemo, createRoot, createSignal } from 'solid-js';
import { post } from '../../bridge';
import type { SidebarWebviewMessage } from '../../protocol';
import { onHostMessage, viewState } from '../../store';
import { packGlyph, type GlyphName } from './glyphs';

export type ToolKind = 'read' | 'write' | 'run';
export type ToolPolicy = 'always' | 'ask' | 'off';

export const toolKinds: ToolKind[] = ['read', 'write', 'run'];

/** Optional fields the engine is asked to add to SidebarToolpack (protocol-requests.md). */
export interface ToolpackExtension {
  name?: string;
  icon?: string;
  version?: string;
  source?: 'hub' | 'local';
  permissions?: Partial<Record<ToolKind, ToolPolicy>>;
  tools: { name: string; description: string; kind?: ToolKind; enabled?: boolean }[];
}

export interface PackTool {
  name: string;
  description: string;
  kind: ToolKind;
  enabled: boolean;
}

export interface InstalledPack {
  id: string;
  name: string;
  description: string;
  glyph: GlyphName | undefined;
  enabled: boolean;
  state: 'starting' | 'running' | 'stopped' | 'error';
  status: string;
  error?: string;
  /** Configured locally but not installed and working on this PC: offers Install / Reinstall. */
  needsInstall: boolean;
  /** Why the last install attempt failed, when one did. */
  installError?: string;
  /** An install was requested and the engine has not answered with a new toolpacksState yet. */
  installing: boolean;
  version?: string;
  source?: 'hub' | 'local';
  tools: PackTool[];
  policies: Record<ToolKind, ToolPolicy>;
  logs: string[];
}

/** Messages the engine does not handle yet; see protocol-requests.md. */
export type ToolpackRequest =
  | { type: 'toolpackToolEnabled'; id: string; tool: string; enabled: boolean }
  | { type: 'toolpackPermission'; id: string; group: ToolKind; policy: ToolPolicy };

export function postToolpackRequest(message: ToolpackRequest): void {
  post(message as unknown as SidebarWebviewMessage);
}

const readWords = /(^|_)(get|read|list|find|search|tree|inspect|selection|output|screenshot|capture|pages|properties|attributes|camera|status|log|diff|query|show|view|info|describe|fetch)(_|$)/;
const runWords = /(^|_)(execute|exec|run|play|eval|start|stop|build|render|test|call|invoke|export)(_|$)/;
const writeWords = /(^|_)(set|create|delete|remove|move|insert|write|edit|update|rename|add|apply|select|save)(_|$)/;

/** Guess for tools without a `kind`: names like studio_tree read, figma_execute runs, studio_set_x writes. */
export function guessToolKind(name: string): ToolKind {
  const lower = name.toLowerCase();
  if (runWords.test(lower)) return 'run';
  if (writeWords.test(lower)) return 'write';
  if (readWords.test(lower)) return 'read';
  return 'write';
}

/** "roblox-studio" -> "Roblox Studio". */
export function packTitle(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

const defaultPolicies: Record<ToolKind, ToolPolicy> = { read: 'always', write: 'ask', run: 'ask' };

interface Overrides {
  packs: Record<string, boolean>;
  tools: Record<string, boolean>;
  policies: Record<string, ToolPolicy>;
  /** Pack ids with a reinstall requested; cleared by the next toolpacksState. */
  installing: Record<string, boolean>;
}

const emptyOverrides = (): Overrides => ({ packs: {}, tools: {}, policies: {}, installing: {} });

const [overrides, setOverrides] = createSignal<Overrides>(emptyOverrides());

// The engine's next pack list is the truth again.
onHostMessage(message => {
  if (message.type === 'toolpacksState') setOverrides(emptyOverrides());
});

export const installedPacks = createRoot(() =>
  createMemo<InstalledPack[]>(() => {
    const local = overrides();
    return viewState.toolpacks.map(raw => {
      const pack = raw as typeof raw & Partial<ToolpackExtension>;
      const policies = { ...defaultPolicies, ...pack.permissions };
      for (const kind of toolKinds) {
        const key = `${pack.id}\u0000${kind}`;
        if (key in local.policies) policies[kind] = local.policies[key];
      }
      const tools = (pack.tools as ToolpackExtension['tools']).map(tool => {
        const key = `${pack.id}\u0000${tool.name}`;
        return {
          name: tool.name,
          description: tool.description,
          kind: tool.kind ?? guessToolKind(tool.name),
          enabled: key in local.tools ? local.tools[key] : tool.enabled ?? true,
        };
      });
      return {
        id: pack.id,
        name: pack.name || packTitle(pack.id),
        description: pack.description,
        glyph: packGlyph(pack.id, pack.icon),
        enabled: pack.id in local.packs ? local.packs[pack.id] : pack.enabled,
        state: pack.state,
        status: pack.status,
        error: pack.error,
        needsInstall: pack.needsInstall === true,
        installError: pack.installError,
        installing: local.installing[pack.id] === true,
        version: pack.version,
        source: pack.source,
        tools,
        policies,
        logs: pack.logs || [],
      };
    });
  }),
);

export const findPack = (id: string | undefined): InstalledPack | undefined =>
  id ? installedPacks().find(pack => pack.id === id) : undefined;

/** Tools that can actually run: the tool is on and its group is not off. */
export const toolIsOn = (pack: InstalledPack, tool: PackTool): boolean => tool.enabled && pack.policies[tool.kind] !== 'off';

export function setPackEnabled(id: string, enabled: boolean): void {
  setOverrides(current => ({ ...current, packs: { ...current.packs, [id]: enabled } }));
  post({ type: 'toolpackAction', id, action: enabled ? 'enable' : 'disable' });
}

export function setToolEnabled(id: string, tool: string, enabled: boolean): void {
  setOverrides(current => ({ ...current, tools: { ...current.tools, [`${id}\u0000${tool}`]: enabled } }));
  postToolpackRequest({ type: 'toolpackToolEnabled', id, tool, enabled });
}

export function setGroupPolicy(id: string, group: ToolKind, policy: ToolPolicy): void {
  setOverrides(current => ({ ...current, policies: { ...current.policies, [`${id}\u0000${group}`]: policy } }));
  postToolpackRequest({ type: 'toolpackPermission', id, group, policy });
}

export function packAction(id: string, action: 'reload' | 'remove'): void {
  post({ type: 'toolpackAction', id, action });
}

/** Install / Reinstall a pack that needs installing on this PC. Busy until the next toolpacksState. */
export function reinstallPack(id: string): void {
  setOverrides(current => ({ ...current, installing: { ...current.installing, [id]: true } }));
  post({ type: 'reinstallToolpack', id });
}

/** Adds a toolpack from a folder on disk (the engine opens the picker). */
export function addLocalPack(): void {
  post({ type: 'pickToolpack' });
}
