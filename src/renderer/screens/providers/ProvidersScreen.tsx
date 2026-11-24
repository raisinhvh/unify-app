/**
 * Providers route (Figma "24 · Providers", "24b · Add provider", "24c · Usage").
 *
 * Exports the two halves separately, like Files: `ProvidersPanel` for the Shell's side-panel slot and
 * `ProvidersContent` for the content card. `ProvidersScreen` is the composite used when the screen owns both.
 */
import { Match, Switch, type JSX } from 'solid-js';
import { AddProviderDialog } from './AddProviderDialog';
import { AccountPage } from './AccountPage';
import { providerAccounts, findAccount } from './adapter';
import { ProviderPage } from './ProviderPage';
import { ProvidersPanel } from './ProvidersPanel';
import { UsagePage } from './UsagePage';
import { selection, type ProviderSelection } from './selection';
import './providers.css';

export { ProvidersPanel } from './ProvidersPanel';

/**
 * The selection to show. An account that is gone (signed out and removed by the engine) falls back to its provider
 * page while the provider still has accounts, otherwise to the Usage overview.
 */
function shownSelection(current: ProviderSelection): ProviderSelection {
  if (current.kind !== 'account') return current;
  if (findAccount(current.id)) return current;
  if (current.provider && providerAccounts(current.provider).length) return { kind: 'provider', provider: current.provider };
  return { kind: 'usage' };
}

/** The right-hand column, including the card inset and scroll: one account, one provider, or the usage overview. */
export function ProvidersContent(): JSX.Element {
  const shown = () => shownSelection(selection());
  return (
    <main class="providers-main">
      <div class="providers-column">
        <Switch fallback={<UsagePage />}>
          <Match when={shown().kind === 'account'}>
            <AccountPage />
          </Match>
          <Match when={shown().kind === 'provider'}>
            <ProviderPage provider={(shown() as { provider: string }).provider} />
          </Match>
        </Switch>
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
