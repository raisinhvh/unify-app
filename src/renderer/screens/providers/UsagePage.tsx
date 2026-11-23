/**
 * Providers › Usage (Figma "24c · Providers · Usage").
 *
 * Combined usage is DSH's own maths from store/usage.ts: each account's segment is weighted by its plan's
 * monthly price, so a $100 Max plan counts ten times a $10 Go plan. Bars animate on springs; the percents are
 * organic RollingNumbers (odometer roll, motion.organic.counters).
 */
import { For, Index, Show, type JSX } from 'solid-js';
import { Button, Icon, IconButton, ProviderGlyph } from '../../components';
import { createSpring, pressable } from '../../motion';
import { RollingNumber } from '../../motion/organic';
import type { UsageEntry } from '../../store/usage';
import { clampPercent, resetColor, resetIn, usageSummary } from '../../store/usage';
import { viewState } from '../../store';
import {
  accountName,
  accountsWithoutUsage,
  allAccounts,
  openProviderUsage,
  providerTitle,
  refreshUsage,
  signedInWith,
  usageUpdatedAgo,
} from './adapter';
import { select, setAddProviderOpen } from './selection';

function latestUpdate(): number | undefined {
  const times = Object.values(viewState.usage)
    .map(usage => usage.fetchedAt)
    .filter((time): time is number => typeof time === 'number' && time > 0);
  return times.length ? Math.max(...times) : undefined;
}

function StackedBar(): JSX.Element {
  return (
    <div class="pv-stack" role="img" aria-label={`Combined usage ${usageSummary().combined}%`}>
      {/* Index keeps one spring per position, so updated numbers glide rather than restart. */}
      <Index each={usageSummary().entries}>
        {entry => {
          const width = createSpring(() => entry().width, 'panel', { precision: 10 });
          return (
            <span
              class="pv-stack-segment"
              style={{
                width: `max(0px, calc(${clampPercent(width())}% - 2px))`,
                background: entry().color,
              }}
            />
          );
        }}
      </Index>
    </div>
  );
}

/** The first account still without numbers: "Mistral" then a muted "API key". */
function MissingAccount(): JSX.Element {
  const first = () => accountsWithoutUsage()[0];
  return (
    <Show when={first()}>
      {account => (
        <>
          <span class="pv-usage-missing-provider">{providerTitle(account().provider)}</span>
          <span class="pv-usage-missing-account">{signedInWith(account())}</span>
        </>
      )}
    </Show>
  );
}

function UsageRow(props: { entry: UsageEntry }): JSX.Element {
  const entry = () => props.entry;
  const width = createSpring(() => clampPercent(entry().used), 'panel', { precision: 10 });
  const reset = () => entry().binding.resetsAt;
  const name = () => accountName(entry().account);
  const planPrice = () => {
    const plan = entry().plan;
    if (!plan) return '';
    return plan.monthlyUsd ? `$${plan.monthlyUsd}/mo` : 'Free';
  };
  return (
    <div class="pv-usage-row">
      <button
        type="button"
        class="pv-usage-account"
        ref={element => pressable(element, 0.99)}
        onClick={() => select({ kind: 'account', id: entry().account.id })}
      >
        <ProviderGlyph provider={entry().account.provider} size={16} class="pv-usage-glyph" />
        <span class="pv-usage-name" title={`${name().provider} ${name().label}`}>
          {name().provider}
          <span class="pv-usage-muted">{name().label}</span>
        </span>
      </button>
      <span class="pv-usage-plan" title={entry().plan ? `${entry().plan!.name} ${planPrice()}` : undefined}>
        <Show when={entry().plan} fallback="—">
          {plan => (
            <>
              {plan().name}
              <span class="pv-usage-muted">{planPrice()}</span>
            </>
          )}
        </Show>
      </span>
      <span class="pv-usage-share type-mono">
        <RollingNumber value={`${Math.round(entry().share)}%`} data-motion="usage-share" />
      </span>
      <span class="pv-usage-limit">{entry().binding.label}</span>
      <span class="pv-usage-bar" aria-hidden="true">
        <span class="pv-usage-fill" style={{ width: `${clampPercent(width())}%`, background: entry().color }} />
      </span>
      <span class="pv-usage-used type-mono">
        <RollingNumber value={`${Math.round(entry().used)}%`} data-motion="usage-used" />
      </span>
      <span class="pv-usage-reset" style={{ color: reset() ? resetColor(reset()!) : undefined }}>
        {reset() ? resetIn(reset()) || 'now' : '—'}
      </span>
    </div>
  );
}

function UsageEmpty(): JSX.Element {
  return (
    <div class="pv-empty">
      <Icon name="usage" size={24} />
      <h2 class="pv-empty-title type-heading">No usage yet</h2>
      <p class="pv-empty-copy type-body">Add a provider to see what you have used across accounts.</p>
      <Button variant="primary" icon="plus" onClick={() => setAddProviderOpen(true)}>
        Add provider
      </Button>
    </div>
  );
}

export function UsagePage(): JSX.Element {
  const summary = usageSummary;
  const accounts = allAccounts;
  const updated = () => {
    const at = latestUpdate();
    return at ? usageUpdatedAgo(at) : '';
  };

  return (
    <section class="pv-page pv-usage-page" aria-label="Usage">
      <nav class="pv-crumbs type-caption" aria-label="Breadcrumb">
        <button type="button" class="pv-crumb-link" onClick={() => select({ kind: 'usage' })}>
          Providers
        </button>
        <span class="pv-crumb-sep">/</span>
        <span class="pv-crumb-current">Usage</span>
      </nav>
      <header class="pv-page-header">
        <div class="pv-page-heading">
          <h1 class="pv-title">Usage</h1>
          <p class="pv-page-status">
            Weighted by plan price
            <Show when={updated()}>{text => <span>, updated {text()}</span>}</Show>
          </p>
        </div>
        <IconButton icon="refresh" label="Refresh usage" class="pv-icon-28" onClick={() => refreshUsage()} />
      </header>

      <Show when={accounts().length} fallback={<UsageEmpty />}>
        <div class="pv-combined">
          <span class="pv-combined-value">
            <RollingNumber value={`${Math.round(summary().combined)}%`} data-motion="usage-combined" />
          </span>
          <span class="pv-combined-caption">
            combined usage across <RollingNumber value={summary().entries.length} /> account
            {summary().entries.length === 1 ? '' : 's'}
          </span>
        </div>
        <StackedBar />
        <div class="pv-usage-accounts">
          <h2 class="pv-section-heading">Accounts</h2>
          <Show
            when={summary().entries.length}
            fallback={<p class="pv-usage-none type-body">No account reports usage yet.</p>}
          >
            <div class="pv-usage-table">
              <div class="pv-usage-columns type-caption" aria-hidden="true">
                <span>Account</span>
                <span>Plan</span>
                <span>Share</span>
                <span>Binding limit</span>
                <span />
                <span />
                <span>Resets</span>
              </div>
              {/* Keyed by account: every usage update builds new entries, and a remounted row cannot roll its numbers. */}
              <For each={summary().entries.map(entry => entry.account.id)}>
                {id => <Show when={summary().entries.find(entry => entry.account.id === id)}>{entry => <UsageRow entry={entry()} />}</Show>}
              </For>
            </div>
          </Show>
          <Show when={accountsWithoutUsage().length}>
            <footer class="pv-usage-footer">
              <span class="pv-usage-missing type-caption">
                {accountsWithoutUsage().length} account{accountsWithoutUsage().length === 1 ? '' : 's'} without usage
                data
                <MissingAccount />
              </span>
              <button
                type="button"
                class="pv-link"
                onClick={() => {
                  const first = accounts()[0];
                  if (first) select({ kind: 'account', id: first.id });
                  else openProviderUsage();
                }}
              >
                Manage accounts
              </button>
            </footer>
          </Show>
        </div>
      </Show>
    </section>
  );
}
