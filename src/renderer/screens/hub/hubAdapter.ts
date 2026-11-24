/**
 * Toolpack Hub data (registry: GitHub `raisinhvh/unify-hub`; the engine fetches it, never the renderer).
 *
 * The engine answers the Hub messages (src/engine/unify/requests/hub.ts, protocol-requests.md › Hub); only
 * engine replies count. There is no stand-in catalogue: without an engine the Hub stays empty.
 * Nothing here contacts GitHub, and publishing is only ever a request to the engine.
 */
import { createSignal } from 'solid-js';
import { post } from '../../bridge';
import type { HubInstallMessage, HubInstallPackage, HubInstallResultMessage, SidebarWebviewMessage } from '../../protocol';
import { onHostMessage } from '../../store';
import { feature } from '../../store/features';
import { applySetup } from '../toolpacks/setup';

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

export interface HubState {
  packs: HubPack[];
  categories: HubCategory[];
  /** Pack ids shown in Featured, in order. */
  featured: string[];
  authors: number;
  fetchedAt: number;
  error?: string;
}

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

/** A pack whose install script waits for the user's consent (the Hub's script dialog, shown first). */
export interface ScriptConsent {
  id: string;
  /** Empty when the pack only has an uninstall script. */
  scriptName: string;
  scriptText: string;
  /** Empty when the pack has nothing to undo on removal. */
  uninstallScriptName: string;
  uninstallScriptText: string;
}

/**
 * A pack whose dependencies wait for the user's consent (the Hub's dependency dialog, shown after the script one).
 * Required packages always install; optional ones only when ticked. The Python Unify adds (`neededBy`) installs
 * when any package it is needed by does, so the dialog ticks it by itself and never lets the user untick it.
 */
export interface DependencyConsent {
  id: string;
  packages: HubInstallPackage[];
}

/** Whether the Hub shows at all (`toolpacks.hub`). Nav entries and the panel's Hub folder check this. */
export function hubEnabled(): boolean {
  return feature('toolpacks.hub');
}

const [hubState, setHubState] = createSignal<HubState | undefined>();
const [installs, setInstalls] = createSignal<Record<string, HubInstallProgress>>({});
const [requested, setRequested] = createSignal(false);
const [scriptConsent, setScriptConsent] = createSignal<ScriptConsent | undefined>();
const [dependencyConsent, setDependencyConsent] = createSignal<DependencyConsent | undefined>();
export { dependencyConsent, hubState, installs, scriptConsent };

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

function setInstall(id: string, progress: HubInstallProgress | undefined): void {
  setInstalls(current => {
    const next = { ...current };
    if (progress) next[id] = progress;
    else delete next[id];
    return next;
  });
}

function applyInstallResult(result: HubInstallResultMessage): void {
  if (result.needsScriptConsent) {
    setInstall(result.id, undefined);
    setScriptConsent({
      id: result.id,
      scriptName: result.scriptName ?? '',
      scriptText: result.scriptText ?? '',
      uninstallScriptName: result.uninstallScriptName ?? '',
      uninstallScriptText: result.uninstallScriptText ?? '',
    });
    return;
  }
  if (result.needsDependencyConsent) {
    setInstall(result.id, undefined);
    setDependencyConsent({ id: result.id, packages: result.packages ?? [] });
    return;
  }
  if (result.ok) {
    setInstall(result.id, undefined);
    // The pack's "Finish setup" checklist (Hub detail and Toolpacks), when it ships one.
    if (result.setup) applySetup(result.setup);
  } else setInstall(result.id, { id: result.id, percent: 100, state: 'error', error: result.error ?? 'The install failed.' });
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
}

/** Loads the catalogue once (pass refresh to fetch again). */
export function browseHub(refresh = false): void {
  if (requested() && !refresh) return;
  setRequested(true);
  send({ type: 'hubBrowse', refresh });
}

function requestInstall(id: string, allowScript?: boolean, packages?: string[]): void {
  setInstall(id, { id, percent: 0, state: 'downloading' });
  send({ type: 'hubInstall', id, ...(allowScript ? { allowScript } : {}), ...(packages ? { packages } : {}) });
}

export function installFromHub(id: string): void {
  requestInstall(id);
}

/** The user agreed to the pack's install script: install again, letting it run (dependencies are asked next). */
export function runScriptAndInstall(): void {
  const consent = scriptConsent();
  if (!consent) return;
  setScriptConsent(undefined);
  requestInstall(consent.id, true);
}

export function cancelScriptConsent(): void {
  setScriptConsent(undefined);
}

/** The user agreed to the dependencies: install with the optional step ids they ticked (required ones always install). */
export function installDependencies(selectedOptional: string[]): void {
  const consent = dependencyConsent();
  if (!consent) return;
  setDependencyConsent(undefined);
  requestInstall(consent.id, true, selectedOptional);
}

/** Skip cancels the whole install (the user's choice): nothing was written yet. */
export function cancelDependencyConsent(): void {
  setDependencyConsent(undefined);
}

/** Asks the engine to publish a toolpack folder (it shows the picker and the confirmation). */
export function publishToHub(): void {
  setPublishStatus({ pending: true });
  send({ type: 'hubPublish' });
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
