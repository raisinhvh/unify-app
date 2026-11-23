/**
 * Toolpack Hub data (registry: GitHub `raisinhvh/unify-hub`; the engine fetches it, never the renderer).
 *
 * The engine does not speak the Hub messages yet (protocol-requests.md › Hub). Until it does:
 *   - in vite dev the adapter answers itself from hubMock.ts (a fake catalogue and a fake download), so the
 *     screen can be built and screenshotted;
 *   - in the app it posts the requests and shows "Hub unavailable" until a `hubState` arrives.
 * Nothing here contacts GitHub, and publishing is only ever a request to the engine.
 */
import { createSignal } from 'solid-js';
import { post } from '../../bridge';
import { readPersisted, writePersisted } from '../../persist';
import type { SidebarWebviewMessage } from '../../protocol';
import { onHostMessage } from '../../store';

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
  | { type: 'hubInstall'; id: string; target: HubInstallTarget }
  | { type: 'hubPublish' };

/** Engine -> UI. */
export type HubReply =
  | { type: 'hubState'; hub: HubState }
  | ({ type: 'hubInstallProgress' } & HubInstallProgress);

const [hubState, setHubState] = createSignal<HubState | undefined>();
const [installs, setInstalls] = createSignal<Record<string, HubInstallProgress>>({});
const [requested, setRequested] = createSignal(false);
export { hubState, installs };

const [installTarget, setInstallTargetSignal] = createSignal<HubInstallTarget>(readPersisted<HubInstallTarget>('hubInstallTarget', 'all'));
export { installTarget };
export function setInstallTarget(target: HubInstallTarget): void {
  setInstallTargetSignal(target);
  writePersisted('hubInstallTarget', target);
}

/** Whether a reply came from a real engine (then the dev mock stays out of the way). */
let engineSpeaksHub = false;

function applyReply(reply: HubReply): void {
  if (reply.type === 'hubState') {
    setHubState(reply.hub);
    return;
  }
  const { type: _type, ...progress } = reply;
  setInstalls(current => {
    const next = { ...current };
    // A finished install is shown by the pack list (toolpacksState); only failures stay.
    if (progress.state === 'done') delete next[progress.id];
    else next[progress.id] = progress;
    return next;
  });
}

onHostMessage(message => {
  const reply = message as unknown as HubReply;
  if (reply.type === 'hubState' || reply.type === 'hubInstallProgress') {
    engineSpeaksHub = true;
    applyReply(reply);
  }
});

function send(request: HubRequest): void {
  post(request as unknown as SidebarWebviewMessage);
  if (import.meta.env.DEV && !engineSpeaksHub) {
    void import('./hubMock').then(mock => mock.answer(request, applyReply));
  }
}

/** Loads the catalogue once (pass refresh to fetch again). */
export function browseHub(refresh = false): void {
  if (requested() && !refresh) return;
  setRequested(true);
  send({ type: 'hubBrowse', refresh });
}

export function installFromHub(id: string): void {
  setInstalls(current => ({ ...current, [id]: { id, percent: 0, state: 'downloading' } }));
  send({ type: 'hubInstall', id, target: installTarget() });
}

/** Asks the engine to publish a toolpack folder (it shows the picker and the confirmation). */
export function publishToHub(): void {
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
