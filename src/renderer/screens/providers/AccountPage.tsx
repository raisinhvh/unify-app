/**
 * Providers › one account (Figma "24 · Providers", right content).
 *
 * Breadcrumb, account header (provider glyph, label, status), then Account (plan, signed in with, usage, label).
 * Models belong to the provider, so they live on the Provider page; this page only links there. Label is an edit
 * the engine does not own yet (protocol-requests.md); the adapter applies it optimistically until the next
 * accountsState.
 */
import { createEffect, createSignal, For, on, onMount, Show, type JSX } from 'solid-js';
import { Button, Icon, IconButton, Menu, ProviderGlyph, type MenuEntry } from '../../components';
import { createSpring } from '../../motion';
import { viewState } from '../../store';
import { clampPercent, resetColor, resetIn } from '../../store/usage';
import type { SidebarUsageMetric } from '../../protocol';
import type { AccountView } from './adapter';
import {
  accountStateLabel,
  accountName,
  brandedPlan,
  findAccount,
  openProviderUsage,
  providerTitle,
  refreshUsage,
  removeAccount,
  renameAccount,
  signOut,
  signedInWith,
} from './adapter';
import { LocalServerPanel, LocalStatus } from './local/LocalServerPanel';
import { loadLocalInference, localProvider, localServerByAccount } from './local/localStore';
import { select, selection } from './selection';

function Crumb(props: { account: AccountView }): JSX.Element {
  return (
    <nav class="pv-crumbs type-caption" aria-label="Breadcrumb">
      <button type="button" class="pv-crumb-link" onClick={() => select({ kind: 'usage' })}>
        Providers
      </button>
      <span class="pv-crumb-sep">/</span>
      <button type="button" class="pv-crumb-link" onClick={() => select({ kind: 'provider', provider: props.account.provider })}>
        {accountName(props.account).provider}
      </button>
      <span class="pv-crumb-sep">/</span>
      <span class="pv-crumb-current">{props.account.label}</span>
    </nav>
  );
}

/** Shortest and longest label column, in characters (the UI font is monospaced, so `ch` is exact). */
const minimumLabelChars = 8;
const maximumLabelChars = 26;

/**
 * The label column's width: the longest usage label across every account, so the bars start at the same x on
 * every account page. Labels longer than the cap are cut with an ellipsis and keep the full text as a tooltip.
 */
function metricLabelChars(): number {
  let longest = minimumLabelChars;
  for (const usage of Object.values(viewState.usage)) {
    for (const metric of usage?.metrics ?? []) {
      longest = Math.max(longest, metric.label.length);
    }
  }
  return Math.min(longest, maximumLabelChars);
}

function MetricRow(props:{ metric: SidebarUsageMetric; first: boolean; account: AccountView }): JSX.Element {
  const used = () => (typeof props.metric.usedPercent === 'number' ? clampPercent(props.metric.usedPercent) : 0);
  const width = createSpring(used, 'panel', { precision: 10 });
  const usedLabel = () => (typeof props.metric.usedPercent === 'number' ? `${Math.round(used())}%` : props.metric.value);
  const reset = () => props.metric.resetsAt;
  return (
    <div class="pv-metric-row">
      <span class="pv-metric-label" title={props.metric.label}>{props.metric.label}</span>
      <span class="pv-metric-bar" aria-hidden="true">
        <span class="pv-metric-fill" style={{ width: `${width()}%`, background: props.account.color }} />
      </span>
      <span class="pv-metric-used type-mono">{usedLabel()}</span>
      <span
        class="pv-metric-reset"
        style={{ color: reset() ? resetColor(reset()!) : undefined }}
        title={reset() ? (resetIn(reset()) ? `Resets in ${resetIn(reset())}` : 'Resets now') : undefined}
      >
        {reset() ? resetIn(reset()) || 'now' : ''}
      </span>
      <Show when={props.first}>
        <button type="button" class="pv-view-usage" onClick={() => openProviderUsage(props.account)}>
          View usage
          <Icon name="pop" size={16} />
        </button>
      </Show>
    </div>
  );
}

function AccountBody(props: { account: AccountView }): JSX.Element {
  const account = () => props.account;
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [anchor, setAnchor] = createSignal<HTMLButtonElement>();
  const [label, setLabel] = createSignal(account().label);

  createEffect(
    on(
      () => account().id,
      () => {
        setLabel(account().label);
      },
    ),
  );

  const commitLabel = () => {
    const next = label().trim();
    if (!next) {
      setLabel(account().label);
      return;
    }
    if (next !== account().label) renameAccount(account().id, next);
  };

  const leaveAccount = () => select({ kind: 'provider', provider: account().provider });
  const isLocal = () => account().provider === localProvider;
  const localServerView = () => (isLocal() ? localServerByAccount(account().id) : undefined);

  onMount(() => {
    if (isLocal()) loadLocalInference();
  });

  const menuItems = (): MenuEntry[] => {
    if (isLocal()) return [{ id: 'remove', label: 'Delete server', danger: true }];
    const items: MenuEntry[] = [
      { kind: 'group', label: 'Account' },
      { id: 'refresh', label: 'Refresh usage', icon: 'refresh' },
      { id: 'usage', label: 'View usage', icon: 'usage' },
      { kind: 'separator' },
    ];
    if (account().authType === 'oauth') items.push({ id: 'signout', label: 'Sign out', danger: true });
    else items.push({ id: 'remove', label: 'Remove account', danger: true });
    return items;
  };

  const onMenu = (id: string) => {
    if (id === 'refresh') refreshUsage(account().id);
    else if (id === 'usage') openProviderUsage(account());
    else if (id === 'signout') signOut(account());
    else if (id === 'remove') {
      removeAccount(account());
      leaveAccount();
    }
  };

  return (
    <>
      <Crumb account={account()} />
      <header class="pv-account-header">
        <ProviderGlyph provider={account().provider} size={24} class="pv-account-glyph" />
        <div class="pv-account-titles">
          <h1 class="pv-title pv-account-title">
            {accountName(account()).provider}
            <span class="pv-title-muted">{accountName(account()).label}</span>
          </h1>
          <p class="pv-account-status">
            <Show when={localServerView()}>
              {server => <LocalStatus server={server()} />}
            </Show>
            <Show when={!localServerView() && account().status === 'connected'} fallback={<Show when={!localServerView()}><span class="pv-account-caption warn">{accountStateLabel(account())}</span></Show>}>
              <Icon name="check" size={12} class="pv-account-check" />
              <span class="pv-account-connected">Connected</span>
            </Show>
          </p>
        </div>
        <IconButton
          ref={setAnchor}
          icon="more"
          label="Account actions"
          class="pv-icon-28"
          aria-expanded={menuOpen()}
          onClick={() => setMenuOpen(!menuOpen())}
        />
        <Menu
          anchor={anchor()}
          open={menuOpen()}
          onClose={() => setMenuOpen(false)}
          onSelect={onMenu}
          items={menuItems()}
          placement="bottom-end"
        />
      </header>

      <div class="pv-account-divider" />

      <div class="pv-account-body">
        <section class="pv-section">
          <h2 class="pv-section-heading">Account</h2>
          <div class="pv-rows">
            <Show when={!isLocal()}>
              <div class="pv-setting-row">
                <span class="pv-setting-label">Plan</span>
                <span class="pv-setting-value">{brandedPlan(account())}</span>
              </div>
            </Show>
            <div class="pv-setting-row">
              <span class="pv-setting-label">{isLocal() ? 'Serves' : 'Signed in with'}</span>
              <span class="pv-setting-value">{signedInWith(account())}</span>
              <button
                type="button"
                class="pv-row-action"
                onClick={() => {
                  if (account().authType === 'oauth') signOut(account());
                  else {
                    removeAccount(account());
                    leaveAccount();
                  }
                }}
              >
                {account().authType === 'oauth' ? 'Sign out' : isLocal() ? 'Delete server' : 'Remove'}
              </button>
            </div>
            <Show
              when={!isLocal() && account().usage?.metrics.length}
              fallback={!isLocal() && (
                <div class="pv-setting-row">
                  <span class="pv-setting-label">Usage</span>
                  <p class="pv-section-note type-body">This account has not reported usage yet.</p>
                </div>
              )}
            >
              <div class="pv-setting-row pv-account-usage">
                <span class="pv-setting-label">Usage</span>
                <div class="pv-inline-usage" style={{ '--pv-metric-label-chars': String(metricLabelChars()) }}>
                  <For each={account().usage?.metrics}>
                    {(metric, index) => <MetricRow metric={metric} first={index() === 0} account={account()} />}
                  </For>
                </div>
              </div>
            </Show>
            <div class="pv-setting-row">
              <label class="pv-setting-label" for="pv-account-label">Label</label>
              <span class="pv-setting-value">
                <input
                  id="pv-account-label"
                  class="pv-text-input"
                  value={label()}
                  spellcheck={false}
                  onInput={event => setLabel(event.currentTarget.value)}
                  onBlur={commitLabel}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitLabel();
                      event.currentTarget.blur();
                    } else if (event.key === 'Escape') {
                      setLabel(account().label);
                      event.currentTarget.blur();
                    }
                  }}
                />
              </span>
            </div>
          </div>
        </section>

        <div class="pv-section-divider" />

        <Show
          when={isLocal()}
          fallback={
            <p class="pv-shared-models type-body">
              Models are shared by every {providerTitle(account().provider)} account.{' '}
              <button type="button" class="pv-shared-models-link" onClick={leaveAccount}>Manage models</button>
            </p>
          }
        >
          <Show
            when={localServerByAccount(account().id)}
            fallback={<p class="pv-section-note type-body">Loading the local server…</p>}
          >
            {server => <LocalServerPanel server={server()} />}
          </Show>
        </Show>
      </div>
    </>
  );
}

export function AccountPage(): JSX.Element {
  const account = () => {
    const current = selection();
    return current.kind === 'account' ? findAccount(current.id) : undefined;
  };
  return (
    <section class="pv-page pv-account-page" aria-label="Account">
      <Show
        when={account()}
        fallback={
          <div class="pv-empty">
            <p class="type-body">This account is no longer connected.</p>
            <Button onClick={() => select({ kind: 'usage' })}>Back to usage</Button>
          </div>
        }
      >
        {current => <AccountBody account={current()} />}
      </Show>
    </section>
  );
}
