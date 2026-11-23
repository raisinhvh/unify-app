/**
 * Toolpack Hub contracts, shared by the registry implementations, the install flow and the request handlers.
 *
 * These mirror `src/renderer/screens/hub/hubAdapter.ts`. Pack ids are Hub ids; installs map them to a valid
 * toolpack id (lowercase letters, digits and underscores) before writing a pack folder.
 */
export interface HubPack {
  id: string;
  name: string;
  author: string;
  /** HubCategory id. */
  category: string;
  description: string;
  /** Glyph name, as in the toolpacks screen. */
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
  devices: HubDevice[];
  fetchedAt: number;
  error?: string;
}

export interface HubPackDetail {
  pack: HubPack;
  readme?: string;
}

export type HubInstallTarget = 'this' | 'all';

export interface HubInstallProgress {
  id: string;
  /** 0-100. */
  percent: number;
  state: 'downloading' | 'installing' | 'done' | 'error';
  error?: string;
}

/** What the request handlers need from a registry; each implementation owns its own source of packs. */
export interface HubRegistry {
  id: string;
  state(): Promise<HubState>;
  detail(id: string): Promise<HubPackDetail | undefined>;
  /** Writes the pack files (and optional install script) into `destination`. */
  download(id: string, destination: string): Promise<void>;
}
