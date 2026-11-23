/**
 * Toolpack Hub data (registry: GitHub `raisinhvh/unify-hub`; the engine fetches it, never the renderer).
 *
 * The engine answers the Hub messages (src/engine/unify/requests/hub.ts, protocol-requests.md › Hub):
 *   - in the app (a host bridge exists) every request goes to the engine and only engine replies count;
 *   - in a plain-browser dev preview (vite dev, no host bridge) hubMock.ts answers instead (a fake catalogue
 *     and a fake download), so the screen can be built and screenshotted. Production builds drop the mock.
 * Nothing here contacts GitHub, and publishing is only ever a request to the engine.
 */
import { createSignal } from 'solid-js';
import { hasHostBridge, post } from '../../bridge';
import { readPersisted, writePersisted } from '../../persist';
import type { HubInstallMessage, HubInstallResultMessage, SidebarWebviewMessage } from '../../protocol';
import { onHostMessage } from '../../store';
import { feature } from '../../store/features';

export interface HubPack {
  id: string;
  name: string;
  author: string;
  /** HubCategory id. */
  category: string;
  description: string;
  /** Glyph name (screens/toolpacks/glyphs.ts); unknown names fall back to the toolpacks icon. */
  icon?: string;
  installs: number;
  tools: string[];
  version: string;
  /** Epoch ms of the latest version. */
  updatedAt: number;
  /** Epoch ms of the first version ("New" sort). */
  publishedAt: number;
  license: string;
}

export interface HubCategory {
  id: string;
  label: string;
}

export interface HubDevice {
  id: string;
  label: string;
  current: boolean;
}

export interface HubState {
  packs: HubPack[];
  categories: HubCategory[];
  /** Pack ids shown in Featured, in order. */
  featured: string[];
  authors: number;
  /** Signed-in devices "Your devices" installs to (sync). */
  devices: HubDevice[];
  fetchedAt: number;
  error?: string;
}

export type HubInstallTarget = 'this' | 'all';

export interface HubInstallProgress {
  id: string;
  /** 0-100. */
  percent: number;
  state: 'downloading' | 'installing' | 'done' | 'error';
  error?: string;
}

/** UI -> engine. */
export type HubRequest =
  | { type: 'hubBrowse'; refresh?: boolean }
  | HubInstallMessage
  | { type: 'hubPublish' };

/** Engine -> UI. `hubPublishResult` is the suggested dedicated reply (protocol-requests.md › Publish). */
export type HubReply =
  | { type: 'hubState'; hub: HubState }
  | ({ type: 'hubInstallProgress' } & HubInstallProgress)
  | HubInstallResultMessage
  | { type: 'hubPublishResult'; ok: boolean; message: string; url?: string };

/** A pack whose install script waits for the user's consent (the Hub's script dialog). */
export interface ScriptConsent {
  id: string;
  target: HubInstallTarget;
  scriptName: string;
  scriptText: string;
}

/** Whether the Hub shows at all (`toolpacks.hub`). Nav entries and the panel's Hub folder check this. */
export function hubEnabled(): boolean {
  return feature('toolpacks.hub');
}

const [hubState, setHubState] = createSignal<HubState | undefined>();
const [installs, setInstalls] = createSignal<Record<string, HubInstallProgress>>({});
const [requested, setRequested] = createSignal(false);
const [scriptConsent, setScriptConsent] = createSignal<ScriptConsent | undefined>();
export { hubState, installs, scriptConsent };

/**
 * Publishing is answered calmly next to the Upload button, never as a Hub error. Today the engine replies to
 * `hubPublish` with a `hubState` whose `error` explains publishing is unavailable (later: limited to approved
 * accounts); a hubState with an error that arrives while a publish is pending becomes this message instead.
 */
export interface PublishStatus {
  pending: boolean;
  message?: string;
  ok?: boolean;
  url?: string;
}
const [publishStatus, setPublishStatus] = createSignal<PublishStatus>({ pending: false });
export { publishStatus };
export function dismissPublishStatus(): void {
  setPublishStatus({ pending: false });
}

const [installTarget, setInstallTargetSignal] = createSignal<HubInstallTarget>(readPersisted<HubInstallTarget>('hubInstallTarget', 'all'));
export { installTarget };
export function setInstallTarget(target: HubInstallTarget): void {
  setInstallTargetSignal(target);
  writePersisted('hubInstallTarget', target);
}

/** The target each pending install was sent with, so consenting to its script resends the same one. */
const pendingTargets = new Map<string, HubInstallTarget>();

function setInstall(id: string, progress: HubInstallProgress | undefined): void {
  setInstalls(current => {
    const next = { ...current };
    if (progress) next[id] = progress;
    else delete next[id];
    return next;
  });
}

function applyInstallResult(result: HubInstallResultMessage): void {
  const target = pendingTargets.get(result.id) ?? installTarget();
  pendingTargets.delete(result.id);
  if (result.needsScriptConsent) {
    setInstall(result.id, undefined);
    setScriptConsent({ id: result.id, target, scriptName: result.scriptName ?? 'Install script', scriptText: result.scriptText ?? '' });
    return;
  }
  if (result.ok) setInstall(result.id, undefined);
  else setInstall(result.id, { id: result.id, percent: 100, state: 'error', error: result.error ?? 'The install failed.' });
}

function applyReply(reply: HubReply): void {
  if (reply.type === 'hubInstallResult') {
    applyInstallResult(reply);
    return;
  }
  if (reply.type === 'hubPublishResult') {
    setPublishStatus({ pending: false, ok: reply.ok, message: reply.message, url: reply.url });
    return;
  }
  if (reply.type === 'hubState') {
    if (publishStatus().pending && reply.hub.error) {
      const { error, ...hub } = reply.hub;
      setPublishStatus({ pending: false, ok: false, message: error });
      setHubState(hub);
      return;
    }
    setHubState(reply.hub);
    return;
  }
  const { type: _type, ...progress } = reply;
  // A finished install is shown by the pack list (toolpacksState); only failures stay.
  setInstall(progress.id, progress.state === 'done' ? undefined : progress);
}

const hubReplyTypes = new Set<string>(['hubState', 'hubInstallProgress', 'hubInstallResult', 'hubPublishResult']);

onHostMessage(message => {
  const reply = message as unknown as HubReply;
  if (hubReplyTypes.has(reply.type)) applyReply(reply);
});

function send(request: HubRequest): void {
  post(request as unknown as SidebarWebviewMessage);
  if (import.meta.env.DEV && !hasHostBridge()) {
    void import('./hubMock').then(mock => mock.answer(request, applyReply));
  }
}

/** Loads the catalogue once (pass refresh to fetch again). */
export function browseHub(refresh = false): void {
  if (requested() && !refresh) return;
  setRequested(true);
  send({ type: 'hubBrowse', refresh });
}

function requestInstall(id: string, target: HubInstallTarget, allowScript?: boolean): void {
  pendingTargets.set(id, target);
  setInstall(id, { id, percent: 0, state: 'downloading' });
  send({ type: 'hubInstall', id, target, ...(allowScript ? { allowScript } : {}) });
}

export function installFromHub(id: string): void {
  requestInstall(id, installTarget());
}

/** The user agreed to the pack's install script: install again, letting it run. */
export function runScriptAndInstall(): void {
  const consent = scriptConsent();
  if (!consent) return;
  setScriptConsent(undefined);
  requestInstall(consent.id, consent.target, true);
}

export function cancelScriptConsent(): void {
  setScriptConsent(undefined);
}

/** Asks the engine to publish a toolpack folder (it shows the picker and the confirmation). */
export function publishToHub(): void {
  setPublishStatus({ pending: true });
  send({ type: 'hubPublish' });
}

/** "5.2k", "12.4k", "860". */
export function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(value);
}

/** "4 days ago", "today". */
export function formatAge(at: number): string {
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}
