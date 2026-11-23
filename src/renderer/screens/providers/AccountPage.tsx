/**
 * Providers › one account (Figma "24 · Providers", right content).
 *
 * Breadcrumb, account header (provider glyph, label, status, models on), then Account / Usage / Models
 * sections. Labels and the default model are edits the engine does not own yet (protocol-requests.md); the
 * adapter applies them optimistically until the next accountsState.
 */
import { createEffect, createSignal, For, on, Show, type JSX } from 'solid-js';
import { Button, Icon, IconButton, Menu, Select, Toggle, type MenuEntry } from '../../components';
import { createSpring, pressable } from '../../motion';
import { clampPercent, resetColor, resetIn } from '../../store/usage';
import type { SidebarUsageMetric } from '../../protocol';
import type { AccountView, ModelView } from './adapter';
import {
  accountModels,
  accountStateLabel,
  accountTitle,
  brandedPlan,
  findAccount,
  formatContext,
  openProviderUsage,
  refreshUsage,
  removeAccount,
  renameAccount,
  setAccountDefaultModel,
  setModelEnabled,
  signIn,
  signOut,
  signedInWith,
} from './adapter';
import { ProviderGlyph } from './glyphs';
import { select, selection } from './selection';

function Crumb(props: { account: AccountView }): JSX.Element {
  return (
    <nav class="pv-crumbs type-caption" aria-label="Breadcrumb">
      <button type="button" class="pv-crumb-link" onClick={() => select({ kind: 'usage' })}>
        Providers
      </button>
      <span class="pv-crumb-sep">/</span>
      <button type="button" class="pv-crumb-link" onClick={() => select({ kind: 'usage' })}>
        {accountTitle(props.account).split(' · ')[0]}
      </button>
      <span class="pv-crumb-sep">/</span>
      <span class="pv-crumb-current">{props.account.label}</span>
    </nav>
  );
}

function MetricRow(props: { metric: SidebarUsageMetric; first: boolean; account: AccountView }): JSX.Element {
  const used = () => (typeof props.metric.usedPercent === 'number' ? clampPercent(props.metric.usedPercent) : 0);
  const width = createSpring(used, 'panel', { precision: 10 });
  const usedLabel = () => (typeof props.metric.usedPercent === 'number' ? `${Math.round(used())}%` : props.metric.value);
  const reset = () => props.metric.resetsAt;
  return (
    <div class="pv-metric-row">
      <span class="pv-metric-label">{props.metric.label}</span>
      <span class="pv-metric-bar" aria-hidden="true">
        <span class="pv-metric-fill" style={{ width: `${width()}%`, background: props.account.color }} />
      </span>
      <span class="pv-metric-used type-mono">{usedLabel()}</span>
      <span class="pv-metric-reset" style={{ color: reset() ? resetColor(reset()!) : undefined }}>
        {reset() ? `resets in ${resetIn(reset()) || 'now'}` : ''}
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
  const models = () => accountModels(account());
  const enabledCount = () => models().filter(model => model.enabled).length;
  const defaultModel = () => account().defaultModel || models().find(model => model.enabled)?.id;
  const defaultModelName = () => models().find(model => model.id === defaultModel())?.name ?? 'None';

  createEffect(
    on(
      () => account().id,
      () => setLabel(account().label),
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

  const menuItems = (): MenuEntry[] => {
    const items: MenuEntry[] = [
      { kind: 'group', label: 'Account' },
      { id: 'refresh', label: 'Refresh usage', icon: 'refresh' },
      { id: 'usage', label: 'View usage', icon: 'usage' },
      { kind: 'separator' },
    ];
    if (account().status === 'signedOut') items.push({ id: 'signin', label: 'Sign in' });
    else if (account().authType === 'oauth') items.push({ id: 'signout', label: 'Sign out', danger: true });
    else items.push({ id: 'remove', label: 'Remove account', danger: true });
    return items;
  };

  const onMenu = (id: string) => {
    if (id === 'refresh') refreshUsage(account().id);
    else if (id === 'usage') openProviderUsage(account());
    else if (id === 'signin') signIn(account());
    else if (id === 'signout') signOut(account());
    else if (id === 'remove') {
      removeAccount(account());
      select({ kind: 'usage' });
    }
  };

  return (
    <>
      <Crumb account={account()} />
      <header class="pv-account-header">
        <ProviderGlyph provider={account().provider} size={24} class="pv-account-glyph" />
        <div class="pv-account-titles">
          <h1 class="pv-title pv-account-title">{accountTitle(account())}</h1>
          <p class="pv-account-status">
            <Show when={account().status === 'connected'} fallback={<span class="pv-account-caption warn">{accountStateLabel(account())}</span>}>
              <Icon name="check" size={12} class="pv-account-check" />
              <span class="pv-account-connected">Connected</span>
            </Show>
            <span class="pv-sep">·</span>
            <span class="pv-account-models">{enabledCount()} of {models().length} models on</span>
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

      <Show when={account().status === 'signedOut'}>
        <div class="pv-notice">
          <span class="pv-status-dot warn" />
          <span class="pv-notice-text">
            This account is signed out. Sign in again to use its models and see usage.
          </span>
          <Button variant="primary" class="pv-notice-action" onClick={() => signIn(account())}>
            Sign in
          </Button>
        </div>
      </Show>

      <div class="pv-account-divider" />

      <div class="pv-account-body">
        <section class="pv-section">
          <h2 class="pv-section-heading">Account</h2>
          <div class="pv-rows">
            <div class="pv-setting-row">
              <span class="pv-setting-label">Plan</span>
              <span class="pv-setting-value">{brandedPlan(account())}</span>
            </div>
            <div class="pv-setting-row">
              <span class="pv-setting-label">Signed in with</span>
              <span class="pv-setting-value">{signedInWith(account())}</span>
              <button
                type="button"
                class="pv-row-action"
                onClick={() => {
                  if (account().authType === 'oauth') signOut(account());
                  else {
                    removeAccount(account());
                    select({ kind: 'usage' });
                  }
                }}
              >
                {account().authType === 'oauth' ? 'Sign out' : 'Remove'}
              </button>
            </div>
            <Show
              when={account().usage?.metrics.length}
              fallback={
                <div class="pv-setting-row">
                  <span class="pv-setting-label">Usage</span>
                  <p class="pv-section-note type-body">
                    {account().status === 'signedOut' ? 'Sign in to see usage for this account.' : 'This account has not reported usage yet.'}
                  </p>
                </div>
              }
            >
              <div class="pv-setting-row pv-account-usage">
                <span class="pv-setting-label">Usage</span>
                <div class="pv-inline-usage">
                  <For each={account().usage?.metrics}>
                    {(metric, index) => <MetricRow metric={metric} first={index() === 0} account={account()} />}
                  </For>
                </div>
              </div>
            </Show>
          </div>
        </section>

        <div class="pv-section-divider" />

        <section class="pv-section">
          <h2 class="pv-section-heading">Defaults</h2>
          <div class="pv-rows">
            <div class="pv-setting-row">
              <span class="pv-setting-label">Default model</span>
              <span class="pv-setting-value">
                <Select
                  class="pv-default-model"
                  value={defaultModel()}
                  placeholder="None"
                  display={defaultModelName()}
                  options={models().map((model: ModelView) => ({ value: model.id, label: model.name }))}
                  disabled={!models().length}
                  onChange={modelId => setAccountDefaultModel(account().id, modelId)}
                  placement="bottom-start"
                />
              </span>
            </div>
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

        <section class="pv-section">
          <h2 class="pv-section-heading">Models</h2>
          <Show
            when={models().length}
            fallback={<p class="pv-section-note type-body">No models are served through this account.</p>}
          >
            <div class="pv-models">
              <For each={models()}>
                {model => (
                  <div class="pv-model-row">
                    <span class="pv-model-name" classList={{ off: !model.enabled }}>
                      {model.name}
                    </span>
                    <span class="pv-model-context">{formatContext(model.contextWindow)}</span>
                    <Toggle
                      checked={model.enabled}
                      label={`Use ${model.name}`}
                      onChange={enabled => setModelEnabled(model.id, enabled)}
                    />
                  </div>
                )}
              </For>
            </div>
          </Show>
        </section>
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
