/**
 * What the Toolpacks side panel and screens have selected. Module signals so the panel (drawn by the Shell)
 * and the content screen share them; the pack and open folders survive a reload.
 */
import { createSignal } from 'solid-js';
import { readPersisted, writePersisted } from '../../persist';
import { findPack, installedPacks, type InstalledPack } from './adapter';

const [selectedPackId, setSelectedPackSignal] = createSignal<string | undefined>(readPersisted<string | undefined>('toolpackSelected', undefined));
export { selectedPackId };

export function selectPack(id: string | undefined): void {
  setSelectedPackSignal(id);
  writePersisted('toolpackSelected', id);
}

/** Folders in the Toolpacks tree: 'hub', 'installed', and one key per pack whose tool list is expanded. */
const [openKeys, setOpenKeys] = createSignal<string[]>(readPersisted<string[]>('toolpackTreeOpen', ['installed']));
export const isOpen = (key: string): boolean => openKeys().includes(key);

export function setOpen(key: string, open: boolean): void {
  const next = openKeys().filter(item => item !== key);
  if (open) next.push(key);
  setOpenKeys(next);
  writePersisted('toolpackTreeOpen', next);
}

/** The pack the Toolpacks screen shows: the selected one, or the first installed one. */
export const currentPack = (): InstalledPack | undefined => findPack(selectedPackId()) ?? installedPacks()[0];

/** Hub category shown in the Hub screen ('all' or a category id). */
export const [hubCategory, setHubCategory] = createSignal('all');
