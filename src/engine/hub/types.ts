/**
 * Toolpack Hub contracts, shared by the registry implementations, the install flow and the request handlers.
 *
 * These mirror `src/renderer/screens/hub/hubAdapter.ts`. Pack ids are Hub ids; installs map them to a valid
 * toolpack id (lowercase letters, digits and underscores) before writing a pack folder.
 */
import type { GithubAuth } from '../unify/github';

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

export interface HubState {
  packs: HubPack[];
  categories: HubCategory[];
  /** Pack ids shown in Featured, in order. */
  featured: string[];
  authors: number;
  fetchedAt: number;
  error?: string;
}

export interface HubPackDetail {
  pack: HubPack;
  readme?: string;
}

/**
 * UI → engine `hubInstall`. Two consents, in order: `allowScript` once the user agreed to the pack's install and
 * uninstall scripts, then `packages` once they agreed to its dependencies (the step ids of the optional ones they
 * ticked; required ones always install). Without `packages` a pack with dependencies answers `needsDependencyConsent`.
 */
export interface HubInstallRequest {
  id: string;
  /** Set once the user was shown the pack's install/uninstall scripts and agreed to run them. */
  allowScript?: boolean;
  /** Set once the user agreed to the dependencies: the optional ones they ticked (may be empty). */
  packages?: string[];
}

/** Step id of the Python that Unify adds by itself when a pip package needs it and none is installed. */
export const PYTHON_DEPENDENCY_ID = 'unify:python';

/** A program a pack's setup will install, shown on the Hub's dependency dialog. */
export interface HubInstallPackage {
  /** The setup step it comes from (`PYTHON_DEPENDENCY_ID` for the Python Unify adds). */
  stepId: string;
  title: string;
  /** Exactly what runs, e.g. `winget install --id ImageMagick.ImageMagick --exact`. */
  command: string;
  /** Not needed for the pack to work: shown unticked, installed only when ticked. */
  optional?: boolean;
  /** For the Python Unify adds: the pip steps that need it. It installs when any of them does. */
  neededBy?: string[];
}

export interface HubInstallProgress {
  id: string;
  /** 0-100. */
  percent: number;
  state: 'downloading' | 'installing' | 'done' | 'error';
  error?: string;
}

/* ---------------------------------------------------------------------------------------------------------------
 * Pack setup (companion apps): `setup.json` in a pack folder, read by `hub/setup.ts`.
 *
 * A pack's install script (install.js / install.ps1 / install.sh) does every step it can by itself, e.g. copying
 * a Roblox Studio plugin into the Plugins folder. `setup.json` lists every step, automatic or not, so Unify can
 * show a "Finish setup" checklist: automatic steps report whether they worked, manual steps tell the user exactly
 * what to do (with a path to copy or a link to open) and can be ticked off.
 *
 * Steps can also name a package (`install`) that Unify installs itself with winget, brew or pip.
 *
 * A pack whose install script puts anything outside the pack folder (a plugin in another app's folder, a
 * registry value, an app preference) ships an uninstall script (uninstall.js / uninstall.ps1 / uninstall.sh) that
 * undoes exactly that. Unify runs it when the pack is removed, after the pack stopped and before its folder
 * (`data/` included) is deleted. Programs installed through `install` stay: other apps may use them.
 *
 * Strings in `detail`, `copy`, `open` and `check.exists` expand `${PACK}` (the installed pack folder), `${HOME}`
 * and any environment variable (`${LOCALAPPDATA}`, `${APPDATA}`, ...). Paths use forward slashes in the file.
 */

/** One step in `setup.json`, as the pack author writes it. */
export interface PackSetupStepDefinition {
  /** Stable id, unique in the pack (lowercase, dashes). */
  id: string;
  /** Short imperative title: "Import the Figma plugin". */
  title: string;
  /** One or two sentences: what happens, or exactly what to click. */
  detail?: string;
  /** `auto`: the install script does it. `manual`: the user does it. */
  kind: 'auto' | 'manual';
  /** A path or text the user needs (shown with a Copy button). */
  copy?: string;
  /** A URL or folder to open (shown as an Open button). */
  open?: string;
  /**
   * Done when this path exists (`exists`) or this program is found (`command`, a bare name like "magick": PATH,
   * the system PATH saved in the registry on Windows, and WinGet's Links folder). Without a check, auto steps are
   * done when the script succeeded, manual steps when ticked.
   */
  check?: PackSetupCheck;
  /**
   * A package Unify installs by itself (see PackSetupInstall). Required steps install during the pack install,
   * after the user agreed to the listed commands; optional ones get an Install button on the checklist.
   */
  install?: PackSetupInstall;
  /** Not needed for the pack to work: never installed without a click, and never shown as failed. */
  optional?: boolean;
  /** Only on these platforms (`process.platform` values). All platforms when missing. */
  platforms?: string[];
}

export interface PackSetupCheck {
  /** A path, or several: done when any exists. */
  exists?: string | string[];
  command?: string;
}

/**
 * Package ids per installer. Unify uses the first one that fits the platform: Windows `winget`, macOS `brew`,
 * then `pip` anywhere (`python -m pip install --user`). Give a `check` so a package already installed is skipped.
 */
export interface PackSetupInstall {
  winget?: string;
  brew?: string;
  pip?: string;
}

export interface PackSetupDefinition {
  /** Extra files in the pack folder to download with it (e.g. a Studio plugin the install script copies). Plain names, no folders. */
  files?: string[];
  steps: PackSetupStepDefinition[];
}

export type PackSetupStepStatus = 'done' | 'todo' | 'failed';

/** One step as the UI sees it: tokens expanded, status worked out. */
export interface PackSetupStep {
  id: string;
  title: string;
  detail?: string;
  kind: 'auto' | 'manual';
  copy?: string;
  open?: string;
  status: PackSetupStepStatus;
  /** Why an automatic step failed (the script's last output line, or a missing path). */
  error?: string;
  /** The command Unify runs for this step's package on this platform (shown on its Install button). */
  install?: string;
  optional?: boolean;
}

/** The checklist for one installed pack. `pending` counts steps that are not done. */
export interface PackSetupState {
  /** Installed toolpack id (folder name). */
  id: string;
  name: string;
  steps: PackSetupStep[];
  pending: number;
  /** The pack has an install script that can be run again from the checklist. */
  canRerunScript: boolean;
}

/** What a publish attempt answered; the screen shows `message` next to Upload. */
export interface HubPublishResult {
  ok: boolean;
  message: string;
  url?: string;
}

/** One selectable item shown in a host picker (e.g. choosing an installed toolpack to publish). */
export interface HubPickItem {
  id: string;
  label: string;
  description?: string;
  detail?: string;
}

/** Host services needed to interactively pick, confirm and upload a toolpack to the Hub. */
export interface HubPublishOptions {
  toolpacksDir: string;
  pickOption?: (items: HubPickItem[], placeholder: string) => Promise<string | undefined>;
  confirm?: (message: string, detail: string) => Promise<boolean>;
  fetch?: typeof fetch;
}

/** What the request handlers need from a registry; each implementation owns its own source of packs. */
export interface HubRegistry {
  id: string;
  state(): Promise<HubState>;
  detail(id: string): Promise<HubPackDetail | undefined>;
  /** Writes the pack files (and optional install script) into `destination`. */
  download(id: string, destination: string): Promise<void>;
  /** Checks approval, picks and validates an installed pack, and opens a Hub pull request. */
  publish(auth: GithubAuth | undefined, options?: HubPublishOptions): Promise<HubPublishResult>;
}
