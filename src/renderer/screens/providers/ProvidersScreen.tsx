/**
 * Providers route (Figma "24 · Providers", "24b · Add provider", "24c · Usage").
 *
 * Exports the two halves separately, like Files: `ProvidersPanel` for the Shell's side-panel slot and
 * `ProvidersContent` for the content card. `ProvidersScreen` is the composite used when the screen owns both.
 */
import { Show, type JSX } from 'solid-js';
import { AddProviderDialog } from './AddProviderDialog';
import { AccountPage } from './AccountPage';
import { ProvidersPanel } from './ProvidersPanel';
import { UsagePage } from './UsagePage';
import { selection } from './selection';
import './providers.css';

export { ProvidersPanel } from './ProvidersPanel';

/** The right-hand column, including the card inset and scroll: one account, or the usage overview. */
export function ProvidersContent(): JSX.Element {
  return (
    <main class="providers-main">
      <div class="providers-column">
        <Show when={selection().kind === 'account'} fallback={<UsagePage />}>
          <AccountPage />
        </Show>
      </div>
    </main>
  );
}

export function ProvidersScreen(): JSX.Element {
  return (
    <div class="providers-screen">
      <div class="providers-screen-panel">
        <ProvidersPanel />
      </div>
      <ProvidersContent />
      <AddProviderDialog />
    </div>
  );
}
