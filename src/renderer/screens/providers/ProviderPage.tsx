/**
 * Providers › one provider (Figma "24 · Providers", provider level).
 *
 * Breadcrumb, provider header (glyph, company, "N of M models on"), then Defaults (the default model), Accounts
 * (the provider's accounts: the first is used first, the rest are fallbacks) and Models. Every account of a
 * provider serves the same models, so the model list lives here rather than on an account.
 */
import { createEffect, createSignal, For, on, Show, type JSX } from 'solid-js';
import { Button, Icon, IconButton, ModelPicker, ProviderGlyph, Toggle } from '../../components';
import {
  defaultAccount,
  formatContext,
  providerAccounts,
  providerDefault,
  providerModels,
  providerTitle,
  removeModel,
  setModelEnabled,
  setProviderDefaultModel,
  signedInWith,
} from './adapter';
import { AddModelForm } from './AddModelForm';
import { LocalEnginesSection } from './local/LocalEnginesPanel';
import { loadLocalInference, localProvider } from './local/localStore';
import { select } from './selection';
import './local/local.css';

/** Local models come from their servers, one each, so the page has no manual Add model. */
const localModelHint = 'Each local server adds its model automatically.';

function Crumb(props: { provider: string }): JSX.Element {
  return (
    <nav class="pv-crumbs type-caption" aria-label="Breadcrumb">
      <button type="button" class="pv-crumb-link" onClick={() => select({ kind: 'usage' })}>
        Providers
      </button>
      <span class="pv-crumb-sep">/</span>
      <span class="pv-crumb-current">{providerTitle(props.provider)}</span>
    </nav>
  );
}

function ProviderBody(props: { provider: string }): JSX.Element {
  const models = () => providerModels(props.provider);
  const accounts = () => providerAccounts(props.provider);
  const enabledCount = () => models().filter(model => model.enabled).length;
  const defaultModelId = () => providerDefault(props.provider) ?? models().find(model => model.enabled)?.id;
  const [addingModel, setAddingModel] = createSignal(false);
  const [editingModel, setEditingModel] = createSignal<string>();
  const isLocal = () => props.provider === localProvider;

  createEffect(() => {
    if (isLocal()) loadLocalInference();
  });

  createEffect(
    on(
      () => props.provider,
      () => {
        setAddingModel(false);
        setEditingModel(undefined);
      },
      { defer: true },
    ),
  );

  return (
    <>
      <Crumb provider={props.provider} />
      <header class="pv-account-header">
        <ProviderGlyph provider={props.provider} size={24} class="pv-account-glyph" />
        <div class="pv-account-titles">
          <h1 class="pv-title pv-account-title">{providerTitle(props.provider)}</h1>
          <p class="pv-account-status">
            <span class="pv-account-models">{enabledCount()} of {models().length} models on</span>
          </p>
        </div>
      </header>

      <div class="pv-account-divider" />

      <div class="pv-account-body">
        <section class="pv-section">
          <h2 class="pv-section-heading">Defaults</h2>
          <div class="pv-rows">
            <div class="pv-setting-row">
              <span class="pv-setting-label">Default model</span>
              <span class="pv-setting-value">
                <ModelPicker
                  class="pv-default-model"
                  variant="regular"
                  value={defaultModelId() ?? ''}
                  onChange={id => setProviderDefaultModel(props.provider, id)}
                  smartAuto={false}
                  noneLabel="None"
                  modelIds={models().map(model => model.id)}
                  disabled={!models().length}
                  placement="bottom-start"
                />
              </span>
            </div>
          </div>
        </section>

        <div class="pv-section-divider" />

        <Show when={isLocal()}>
          <LocalEnginesSection />
          <div class="pv-section-divider" />
        </Show>

        <section class="pv-section">
          <h2 class="pv-section-heading">{isLocal() ? 'Servers' : 'Accounts'}</h2>
          <div class="pv-rows">
            <For each={accounts()}>
              {account => (
                <button
                  type="button"
                  class="pv-setting-row pv-provider-account"
                  onClick={() => select({ kind: 'account', id: account.id, provider: props.provider })}
                >
                  <span class="pv-setting-label" title={account.label}>{account.label}</span>
                  <span class="pv-setting-value">{account.email ?? signedInWith(account)}</span>
                  <span class="pv-account-caption">
                    {defaultAccount(props.provider)?.id === account.id ? 'Used first' : 'Fallback'}
                  </span>
                  <Icon name="chevron" size={12} class="pv-provider-account-chevron" style={{ rotate: '-90deg' }} />
                </button>
              )}
            </For>
            <Show when={!accounts().length}>
              <p class="pv-section-note type-body">
                {isLocal() ? 'No local servers yet. Add one with Add provider, Local model.' : 'No accounts for this provider yet.'}
              </p>
            </Show>
          </div>
        </section>

        <div class="pv-section-divider" />

        <section class="pv-section">
          <div class="pv-section-heading-row">
            <h2 class="pv-section-heading">Models</h2>
            <Show when={!isLocal() && (models().length > 0 || addingModel())}>
              <Button
                variant="text"
                icon="plus"
                class="pv-add-model-trigger"
                aria-expanded={addingModel()}
                onClick={() => { setEditingModel(undefined); setAddingModel(open => !open); }}
              >
                Add model
              </Button>
            </Show>
          </div>
          <AddModelForm
            provider={props.provider}
            open={addingModel()}
            model={models().find(model => model.name === editingModel())}
            onClose={() => { setAddingModel(false); setEditingModel(undefined); }}
          />
          <Show
            when={models().length}
            fallback={
              <Show when={!addingModel()}>
                <Show
                  when={!isLocal()}
                  fallback={<p class="pv-section-note type-body">{localModelHint}</p>}
                >
                <div class="pv-models-empty">
                  <p class="pv-models-empty-text type-body">
                    {props.provider === 'cursor-acp' ? 'No models yet. Pick from the models your Cursor account can use.' : 'No models yet. Add one by its model ID.'}
                  </p>
                  <Button
                    variant="secondary"
                    icon="plus"
                    class="pv-models-empty-action"
                    onClick={() => setAddingModel(true)}
                  >
                    Add model
                  </Button>
                </div>
                </Show>
              </Show>
            }
          >
            <div class="pv-models">
              <For each={models()}>
                {model => (
                  <div class="pv-model-row">
                    <span class="pv-model-name" classList={{ off: !model.enabled }} title={model.name}>
                      {model.name}
                    </span>
                    <span class="pv-model-context">{formatContext(model.contextWindow)}</span>
                    <div class="pv-model-actions">
                      <button
                        type="button"
                        class="pv-model-edit"
                        aria-label={`Configure ${model.name}`}
                        title={`Configure ${model.name}`}
                        onClick={() => { setAddingModel(false); setEditingModel(model.name); setAddingModel(true); }}
                      >Configure</button>
                      <IconButton
                        icon="close"
                        size="small"
                        label={`Remove ${model.name}`}
                        class="pv-model-remove"
                        onClick={() => removeModel(model.name)}
                      />
                      <Toggle
                        checked={model.enabled}
                        label={`Use ${model.name}`}
                        onChange={enabled => setModelEnabled(model.id, enabled)}
                      />
                    </div>
                  </div>
                )}
              </For>
            </div>
            <Show when={isLocal()}>
              <p class="pv-section-note type-body">{localModelHint}</p>
            </Show>
          </Show>
        </section>
      </div>
    </>
  );
}

export function ProviderPage(props: { provider: string }): JSX.Element {
  return (
    <section class="pv-page pv-account-page" aria-label="Provider">
      <ProviderBody provider={props.provider} />
    </section>
  );
}
