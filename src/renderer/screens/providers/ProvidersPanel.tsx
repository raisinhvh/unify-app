/**
 * The Providers side panel (Figma "24 · Providers", left 280px).
 *
 *   header       "Providers" + add
 *   Usage        combined weight meter; opens the usage overview
 *   providers    one TreeFolder per provider (logo, name, account count), accounts inside as tree rows:
 *                a status mark, the account label, and what it reports (mini bar, "Connected", "Sign in")
 *
 * Rows only select; every action lives on the account page, except "Sign in" on a signed-out row.
 */
import { For, Show, type JSX } from 'solid-js';
import { Icon, IconButton, ProviderGlyph, TreeFolder, TreeItem } from '../../components';
import { createSpring, pressable } from '../../motion';
import { RollingNumber } from '../../motion/organic';
import { clampPercent, usageSummary } from '../../store/usage';
import type { AccountView, ProviderGroup } from './adapter';
import { accountStateLabel, providerGroups, providerTitle, signIn } from './adapter';
import { providerOpen, select, selection, setAddProviderOpen, setProviderOpen } from './selection';

function UsageRow(): JSX.Element {
  const summary = usageSummary;
  return (
    <TreeItem
      class="pv-panel-usage"
      leading={<Icon name="usage" size={16} />}
      label="Usage"
      trailing={<RollingNumber value={summary().entries.length ? `${summary().combined}%` : '–'} data-motion="providers-usage" />}
      selected={selection().kind === 'usage'}
      onClick={() => select({ kind: 'usage' })}
    />
  );
}

function StatusMark(props: { account: AccountView }): JSX.Element {
  return (
    <Show
      when={props.account.status === 'signedOut' || props.account.status === 'error' || props.account.status === 'loading'}
      fallback={<Icon name="check" size={12} class="pv-account-check" />}
    >
      <span class="pv-status-dot" classList={{ warn: props.account.status !== 'loading' }} />
    </Show>
  );
}

function MiniMeter(props: { used: number; color: string }): JSX.Element {
  const width = createSpring(() => clampPercent(props.used), 'panel', { precision: 10 });
  return (
    <span class="pv-mini-meter" aria-hidden="true">
      <span class="pv-mini-fill" style={{ width: `${width()}%`, background: props.color }} />
    </span>
  );
}

function AccountRow(props: { account: AccountView }): JSX.Element {
  const account = () => props.account;
  const selected = () => {
    const current = selection();
    return current.kind === 'account' && current.id === account().id;
  };
  const choose = () => select({ kind: 'account', id: account().id });
  return (
    <div
      class="tree-row tree-item pv-account-row"
      classList={{ selected: selected(), signedOut: account().status === 'signedOut' }}
      role="button"
      tabIndex={0}
      aria-current={selected() ? 'true' : undefined}
      ref={element => pressable(element, 0.99)}
      onClick={choose}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          choose();
        }
      }}
    >
      <span class="pv-panel-status">
        <StatusMark account={account()} />
      </span>
      <span class="pv-account-label">{account().label}</span>
      <Show
        when={account().status === 'signedOut'}
        fallback={
          <Show
            when={account().binding}
            fallback={<span class="pv-account-caption">{accountStateLabel(account())}</span>}
          >
            {binding => <MiniMeter used={binding().usedPercent} color={account().color} />}
          </Show>
        }
      >
        <span class="pv-account-caption warn">Signed out</span>
        <button
          type="button"
          class="pv-signin"
          onClick={event => {
            event.stopPropagation();
            signIn(account());
          }}
        >
          Sign in
        </button>
      </Show>
    </div>
  );
}

function ProviderFolder(props: { group: ProviderGroup }): JSX.Element {
  const group = () => props.group;
  // Keyed by id: usage updates hand over new account objects, which must not remount the rows.
  const accountIds = () => group().accounts.map(account => account.id);
  // A folder like any other in the app; the provider's logo stands in for the folder glyph (as the Hub's does).
  return (
    <TreeFolder
      class="pv-provider"
      label={
        <span class="pv-provider-label">
          <ProviderGlyph provider={group().provider} size={16} class="pv-provider-glyph" />
          <span class="pv-row-label">{providerTitle(group().provider)}</span>
        </span>
      }
      trailing={String(group().accounts.length)}
      open={providerOpen(group().provider)}
      onToggle={open => setProviderOpen(group().provider, open)}
    >
      <For each={accountIds()}>
        {id => <Show when={group().accounts.find(account => account.id === id)}>{account => <AccountRow account={account()} />}</Show>}
      </For>
    </TreeFolder>
  );
}

export function ProvidersPanel(): JSX.Element {
  const providers = () => providerGroups().map(group => group.provider);
  return (
    <aside class="side-panel providers-panel" aria-label="Providers">
      <header class="providers-panel-header">
        <h2 class="type-heading">Providers</h2>
        <IconButton icon="plus" label="Add provider" onClick={() => setAddProviderOpen(true)} />
      </header>
      <div class="providers-panel-list">
        <UsageRow />
        <For each={providers()}>
          {provider => <Show when={providerGroups().find(group => group.provider === provider)}>{group => <ProviderFolder group={group()} />}</Show>}
        </For>
        <Show when={!providerGroups().length}>
          <p class="pv-panel-empty type-caption">No providers connected yet.</p>
        </Show>
      </div>
    </aside>
  );
}
