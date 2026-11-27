/**
 * Providers › Add provider (Figma "24b · Providers · Add provider").
 *
 * A centered 480px dialog over a 72% scrim. OAuth rows start the provider's own flow and close; API-key and
 * self-hosted rows expand an inline form under the row (Figma draws the self-hosted one open). The Local model row
 * expands LocalAddForm, which creates a Unify-managed server and closes onto its account page.
 *
 * Dev: `?open=addLocal` opens the dialog with the Local model row expanded (screenshots).
 */
import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Button, Icon, IconButton, ProviderGlyph } from '../../components';
import { Presence } from '../../motion';
import type { AddProviderOption } from './adapter';
import { addProviderOptions, connectOAuth, connectSelfHosted, connectWithKey } from './adapter';
import { LocalAddForm } from './local/LocalAddForm';
import { loadLocalInference } from './local/localStore';
import { addProviderOpen, select, setAddProviderOpen } from './selection';

function AddForm(props: { option: AddProviderOption }): JSX.Element {
  const [name, setName] = createSignal(props.option.method === 'self-hosted' ? 'homelab' : props.option.title);
  const [secret, setSecret] = createSignal('');
  const [baseURL, setBaseURL] = createSignal('');
  const keyRequired = () => props.option.method === 'api-key';
  const canConnect = () => !!name().trim() && (!keyRequired() || !!secret().trim()) && (props.option.method !== 'self-hosted' || !!baseURL().trim());

  const submit = (event?: Event) => {
    event?.preventDefault();
    if (!canConnect()) return;
    if (props.option.method === 'self-hosted') connectSelfHosted(props.option, { label: name(), secret: secret(), baseURL: baseURL() });
    else connectWithKey(props.option, { label: name(), secret: secret() });
    setAddProviderOpen(false);
  };

  return (
    <form class="pv-add-form" onSubmit={submit}>
      <Show when={props.option.method === 'self-hosted'}>
        <div class="pv-field">
          <label class="pv-field-label" for="pv-server-url">Server URL</label>
          <input
            id="pv-server-url"
            class="pv-text-input pv-field-input"
            type="url"
            placeholder="https://api.example.com/v1"
            value={baseURL()}
            onInput={event => setBaseURL(event.currentTarget.value)}
            spellcheck={false}
            autocomplete="off"
          />
        </div>
      </Show>
      <div class="pv-field">
        <label class="pv-field-label" for="pv-api-key">API key</label>
        <input
          id="pv-api-key"
          class="pv-text-input pv-field-input"
          type="password"
          placeholder={props.option.method === 'self-hosted' ? 'Optional' : 'sk-…'}
          value={secret()}
          onInput={event => setSecret(event.currentTarget.value)}
          autocomplete="off"
        />
      </div>
      <div class="pv-field">
        <label class="pv-field-label" for="pv-account-name">Name</label>
        <input
          id="pv-account-name"
          class="pv-text-input pv-field-input"
          value={name()}
          onInput={event => setName(event.currentTarget.value)}
          spellcheck={false}
          autocomplete="off"
        />
      </div>
      <div class="pv-add-actions">
        <span class="pv-add-caption type-caption">Models are listed after connecting.</span>
        <Button variant="primary" type="submit" class="pv-connect" disabled={!canConnect()}>
          Connect
        </Button>
      </div>
    </form>
  );
}

export function AddProviderDialog(): JSX.Element {
  const [expanded, setExpanded] = createSignal<string | undefined>();

  createEffect(() => {
    if (addProviderOpen()) return;
    setExpanded(undefined);
  });

  onMount(() => {
    if (!import.meta.env.DEV || new URLSearchParams(window.location.search).get('open') !== 'addLocal') return;
    setAddProviderOpen(true);
    queueMicrotask(() => setExpanded('local'));
  });

  createEffect(() => {
    if (expanded() === 'local') loadLocalInference();
  });

  createEffect(() => {
    if (!addProviderOpen()) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setAddProviderOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    onCleanup(() => window.removeEventListener('keydown', onKey, true));
  });

  const choose = (option: AddProviderOption) => {
    if (option.method === 'oauth') {
      connectOAuth(option);
      setAddProviderOpen(false);
      return;
    }
    setExpanded(current => (current === option.id ? undefined : option.id));
  };

  return (
    <Portal>
      <Presence when={addProviderOpen()} from={0.96} origin="center">
        <div
          class="pv-scrim"
          onClick={event => {
            if (event.target === event.currentTarget) setAddProviderOpen(false);
          }}
        >
          <div class="pv-dialog" role="dialog" aria-modal="true" aria-labelledby="pv-add-title">
            <header class="pv-dialog-header">
              <h2 id="pv-add-title" class="pv-dialog-title type-heading">
                Add provider
              </h2>
              <IconButton icon="close" label="Close" class="pv-icon-28" onClick={() => setAddProviderOpen(false)} />
            </header>
            <div class="pv-add-list">
              <For each={addProviderOptions}>
                {option => (
                  <>
                    <button
                      type="button"
                      class="pv-add-row"
                      classList={{ expanded: expanded() === option.id }}
                      aria-expanded={option.method === 'oauth' ? undefined : expanded() === option.id}
                      onClick={() => choose(option)}
                    >
                      <ProviderGlyph provider={option.provider} size={16} class="pv-add-glyph" />
                      <span class="pv-add-title">{option.title}</span>
                      <span class="pv-add-hint type-caption">{option.hint}</span>
                      <Icon name="chevronRight" size={16} class="pv-add-chevron" />
                    </button>
                    <Show when={expanded() === option.id}>
                      <Show
                        when={option.method === 'local'}
                        fallback={<AddForm option={option} />}
                      >
                        <LocalAddForm
                          onCreated={accountId => {
                            setAddProviderOpen(false);
                            select({ kind: 'account', id: accountId, provider: 'local' });
                          }}
                        />
                      </Show>
                    </Show>
                  </>
                )}
              </For>
            </div>
            <footer class="pv-dialog-footer">
              <span class="type-caption">Keys are stored in the system keychain and never synced.</span>
            </footer>
          </div>
        </div>
      </Presence>
    </Portal>
  );
}
