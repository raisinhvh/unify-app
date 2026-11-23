/**
 * Unify feature settings (engine side). Shared contract — owner: main agent.
 *
 * Values persist in ~/.unify/settings.json (UNIFY_HOME overrides the folder) as { features: Record<UnifyFeatureId, UnifyFeatureValue> }.
 * The renderer's list of features lives in src/renderer/store/features.ts; the engine only needs the
 * engine-scope ids below (any other id is stored and mirrored as-is so UI-only toggles persist too).
 *
 * Protocol (implemented by the sidebar/extension owner):
 *   UI → engine: { type: 'setUnifyFeature'; id: string; value: boolean | number | string; chatId?: string }
 *   engine → UI: viewState.unifyFeatures: Record<string, boolean | number | string>
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type UnifyFeatureValue = boolean | number | string;

export const ENGINE_FEATURE_DEFAULTS = {
  'agents.messaging': true,
  'agents.messaging.scope': 'everyone',
  'agents.blockNativeAgents': true,
  'agents.maxParallel': 4,
  'agents.imagesToParent': true,
  'agents.explorerRanges': true,
  'tools.rangeEdits': true,
  'chats.showYourWork': true,
  'chat.friendlyInternalRows': true,
  'knowledge.agentWrites': true,
  'knowledge.audiences': true,
  'notifications.desktop': true,
  'power.shutdownWhenIdle': false,
  'power.rememberArmed': false,
} as const satisfies Record<string, UnifyFeatureValue>;

export type EngineFeatureId = keyof typeof ENGINE_FEATURE_DEFAULTS;
export type AgentMessagingScope = 'everyone' | 'same-chat' | 'parent-child';

type Listener = (id: string, value: UnifyFeatureValue) => void;

/** Unify's data folder. `UNIFY_HOME` overrides it (tests point it at a temp folder). */
export function unifyHome(): string {
  return process.env.UNIFY_HOME || path.join(os.homedir(), '.unify');
}

function settingsFilePath(): string {
  return path.join(unifyHome(), 'settings.json');
}

let cachedValues: Record<string, UnifyFeatureValue> | undefined;
const listeners = new Set<Listener>();

function loadValues(): Record<string, UnifyFeatureValue> {
  if (cachedValues) return cachedValues;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFilePath(), 'utf8')) as { features?: Record<string, UnifyFeatureValue> };
    cachedValues = parsed.features && typeof parsed.features === 'object' ? { ...parsed.features } : {};
  } catch {
    cachedValues = {};
  }
  return cachedValues;
}

/** Tests only: forget cached values so the next read uses the current UNIFY_HOME. */
export function resetUnifySettingsCache(): void {
  cachedValues = undefined;
}

/** Current value of an engine-scope feature (stored value, else default). */
export function getUnifyFeature<K extends EngineFeatureId>(id: K): (typeof ENGINE_FEATURE_DEFAULTS)[K] extends boolean ? boolean : (typeof ENGINE_FEATURE_DEFAULTS)[K] extends number ? number : string {
  const stored = loadValues()[id];
  const fallback = ENGINE_FEATURE_DEFAULTS[id];
  const value = stored === undefined || typeof stored !== typeof fallback ? fallback : stored;
  return value as never;
}

/** Every stored value (all scopes), for mirroring into viewState.unifyFeatures. */
export function allUnifyFeatures(): Record<string, UnifyFeatureValue> {
  return { ...loadValues() };
}

/** Persist one value and notify listeners. */
export function setUnifyFeature(id: string, value: UnifyFeatureValue): void {
  const values = loadValues();
  values[id] = value;
  const settingsFile = settingsFilePath();
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const temporaryFile = `${settingsFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify({ features: values }, null, 2));
  fs.renameSync(temporaryFile, settingsFile);
  for (const listener of listeners) listener(id, value);
}

/** Subscribe to changes; returns an unsubscribe function. */
export function onUnifyFeatureChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
