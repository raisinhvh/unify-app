/**
 * What the Providers side panel has selected (the Usage overview or one account), the closed provider
 * folders, and whether the Add provider dialog is open. Shared by the panel and the screen.
 */
import { createSignal } from 'solid-js';
import { readPersisted, writePersisted } from '../../persist';

export type ProviderSelection = { kind: 'usage' } | { kind: 'account'; id: string };

const [selection, setSelectionSignal] = createSignal<ProviderSelection>(
  readPersisted<ProviderSelection>('providerSelection', { kind: 'usage' }),
);
export { selection };

export function select(next: ProviderSelection): void {
  setSelectionSignal(next);
  writePersisted('providerSelection', next);
}

const [closedProviders, setClosedProviders] = createSignal<string[]>(readPersisted<string[]>('providerTreeClosed', []));
export const providerOpen = (provider: string): boolean => !closedProviders().includes(provider);

export function setProviderOpen(provider: string, open: boolean): void {
  const next = closedProviders().filter(item => item !== provider);
  if (!open) next.push(provider);
  setClosedProviders(next);
  writePersisted('providerTreeClosed', next);
}

export const [addProviderOpen, setAddProviderOpen] = createSignal(false);
