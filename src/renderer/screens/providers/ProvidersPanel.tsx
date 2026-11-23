/**
 * The Providers side panel (Figma "24 · Providers", left 280px).
 *
 *   header       "Providers" + add
 *   Usage        combined weight meter; opens the usage overview
 *   providers    one collapsible folder per provider (glyph, name), accounts inside:
 *                a status mark, the account label, and what it reports (mini bar, "Connected", "Sign in")
 *
 * Rows only select; every action lives on the account page, except "Sign in" on a signed-out row.
 */
import { For, Show, type JSX } from 'solid-js';
import { Icon, IconButton } from '../../components';
import { Collapse, createSpring, pressable } from '../../motion';
import { clampPercent, usageSummary } from '../../store/usage';
import type { AccountView, ProviderGroup } from './adapter';
import { accountStateLabel, providerGroups, providerTitle, signIn } from './adapter';
import { ProviderGlyph } from './glyphs';
import { providerOpen, select, selection, setAddProviderOpen, setProviderOpen } from './selection';

function UsageRow(): JSX.Element {
  const summary = usageSummary;
  const selected = () => selection().kind === 'usage';
  return (
    <button
      type="button"
      class="pv-panel-row pv-panel-usage"
      classList={{ selected: selected() }}
      aria-current={selected() ? 'true' : undefined}
      ref={element => pressable(element, 0.98)}
      onClick={() => select({ kind: 'usage' })}
    >
      <span class="pv-row-chevron-slot" />
      <Icon name="usage" size={16} class="pv-row-icon" />
      <span class="pv-row-label">Usage</span>
      <span class="pv-row-meta">{summary().entries.length ? `${summary().combined}%` : '–'}</span>
    </button>
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

function AccountRow(props: { account: AccountView }): JSX.Element {
  const account = () => props.account;
  const selected = () => {
    const current = selection();
    return current.kind === 'account' && current.id === account().id;
  };
  const choose = () => select({ kind: 'account', id: account().id });
  return (
    <div
      class="pv-account-row"
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
            {binding => (
              <span class="pv-mini-meter" aria-hidden="true">
                <span
                  class="pv-mini-fill"
                  style={{ width: `${clampPercent(binding().usedPercent)}%`, background: account().color }}
                />
              </span>
            )}
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
  const open = () => providerOpen(group().provider);
  const rotation = createSpring(() => (open() ? 0 : -90), 'indicator', { precision: 100 });
  return (
    <div class="pv-provider">
      <button
        type="button"
        class="pv-panel-row pv-provider-row"
        aria-expanded={open()}
        ref={element => pressable(element, 0.98)}
        onClick={() => setProviderOpen(group().provider, !open())}
      >
        <Icon name="chevron" size={12} class="pv-provider-chevron" style={{ rotate: `${rotation()}deg` }} />
        <ProviderGlyph provider={group().provider} size={16} class="pv-provider-glyph" />
        <span class="pv-row-label">{providerTitle(group().provider)}</span>
      </button>
      <Collapse open={open()} class="pv-account-children">
        <div class="pv-account-list">
          <For each={group().accounts}>{account => <AccountRow account={account} />}</For>
        </div>
      </Collapse>
    </div>
  );
}

export function ProvidersPanel(): JSX.Element {
  return (
    <aside class="side-panel providers-panel" aria-label="Providers">
      <header class="providers-panel-header">
        <h2 class="type-heading">Providers</h2>
        <IconButton icon="plus" label="Add provider" onClick={() => setAddProviderOpen(true)} />
      </header>
      <div class="providers-panel-list">
        <UsageRow />
        <For each={providerGroups()}>{group => <ProviderFolder group={group} />}</For>
        <Show when={!providerGroups().length}>
          <p class="pv-panel-empty type-caption">No providers connected yet.</p>
        </Show>
      </div>
    </aside>
  );
}
