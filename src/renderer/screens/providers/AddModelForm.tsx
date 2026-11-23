/**
 * Inline form for adding a model to an account (Providers › Account › Models).
 *
 * Reveals under the Models heading with a critically-damped height + opacity spring (no bounce)
 * so the rows below slide down smoothly instead of jumping. Mirrors the engine's saveModel rules
 * and surfaces validation or engine errors inline until modelSaved closes the form.
 */
import { createEffect, createSignal, createUniqueId, For, on, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { Button } from '../../components';
import { createSpring, prefersReducedMotion, useSpring } from '../../motion';
import { onHostMessage } from '../../store';
import type { AccountView, ModelView } from './adapter';
import {
  loadServerModels,
  modelIdPlaceholder,
  modelSuggestions,
  saveModel,
  serverModels,
  validateModelInput,
} from './adapter';

export interface AddModelFormProps {
  account: AccountView;
  open: boolean;
  model?: ModelView;
  onClose: () => void;
}

const openSpring = { period: 0.22, damping: 1 } as const;
const closeSpring = { period: 0.18, damping: 1 } as const;
const opacitySpring = { period: 0.16, damping: 1 } as const;
const movingMask = 'linear-gradient(to bottom, #000 calc(100% - 12px), transparent)';

export function AddModelForm(props: AddModelFormProps): JSX.Element {
  let outer!: HTMLDivElement;
  let inner!: HTMLDivElement;
  let backendInput: HTMLInputElement | undefined;

  const backendId = createUniqueId();
  const nameId = createUniqueId();
  const effortId = createUniqueId();
  const suggestionsId = createUniqueId();

  const [mounted, setMounted] = createSignal(props.open);
  const [backend, setBackend] = createSignal('');
  const [displayName, setDisplayName] = createSignal('');
  const [effortText, setEffortText] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>();

  const height = useSpring(0, openSpring, 100);
  const opacity = createSpring(() => (props.open ? 1 : 0), opacitySpring, { fadeOnly: true });

  const isSelfHosted = () => props.account.provider === 'self-hosted';
  const suggestions = () => modelSuggestions(props.account);
  const serverState = () => serverModels()[props.account.id];
  const canSave = () => !saving() && backend().trim().length > 0;

  const contentHeight = () => inner?.offsetHeight ?? 0;

  const releaseHeight = () => {
    if (props.open && !height.moving) {
      outer.style.height = '';
      outer.style.overflow = '';
    }
  };

  height.onChange(value => {
    outer.style.height = `${Math.max(0, value)}px`;
    outer.style.overflow = 'hidden';
    outer.style.maskImage = height.moving ? movingMask : '';
  });

  height.onRest(value => {
    outer.style.maskImage = '';
    if (props.open) {
      releaseHeight();
    } else if (value === 0) {
      setMounted(false);
    }
  });

  const resetForm = () => {
    setBackend(props.model?.backend || '');
    setDisplayName(props.model?.name || '');
    setEffortText(props.model?.effortOptions?.join(', ') || '');
    setSaving(false);
    setError(undefined);
  };

  const animateOpen = () => {
    resetForm();
    setMounted(true);
    queueMicrotask(() => {
      if (!props.open) return;
      const from = outer.getBoundingClientRect().height;
      const to = contentHeight();
      if (prefersReducedMotion()) {
        height.jump(to);
        releaseHeight();
      } else {
        if (!height.moving) height.jump(from);
        height.set(to, openSpring);
      }
      backendInput?.focus();
    });
  };

  const animateClose = () => {
    const from = outer.getBoundingClientRect().height;
    if (!height.moving) height.jump(from);
    if (prefersReducedMotion()) height.jump(0);
    else height.set(0, closeSpring);
  };

  onMount(() => {
    if (!props.open) {
      outer.style.height = '0px';
      outer.style.overflow = 'hidden';
    } else {
      backendInput?.focus();
    }
    const observer = new ResizeObserver(() => {
      if (props.open && height.moving) height.set(contentHeight());
    });
    if (inner) observer.observe(inner);
    onCleanup(() => observer.disconnect());
  });

  createEffect(
    on(
      () => props.open,
      (open, previous) => {
        if (open === previous) return;
        if (open) animateOpen();
        else animateClose();
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => `${props.account.id}:${props.model?.name || ''}`,
      () => {
        resetForm();
      },
      { defer: true },
    ),
  );

  onCleanup(
    onHostMessage(message => {
      if (!saving()) return;
      if (message.type === 'modelSaved') {
        setSaving(false);
        setError(undefined);
        props.onClose();
      } else if (message.type === 'error') {
        setSaving(false);
        setError(message.message || 'Could not save model.');
      }
    }),
  );

  const cancel = () => {
    if (saving()) return;
    setError(undefined);
    props.onClose();
  };

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (saving()) return;
    const input = {
      account: props.account,
      backend: backend(),
      name: displayName(),
      originalName: props.model?.name,
      speedOptions: props.model?.speedOptions,
      effortOptions: effortText().split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
    };
    const issue = validateModelInput(input);
    if (issue) {
      setError(issue);
      return;
    }
    setError(undefined);
    setSaving(true);
    saveModel(input);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };

  const serverFeedback = () => {
    const state = serverState();
    if (!state || state.loading) return undefined;
    if (state.error) return { text: state.error, error: true };
    if (state.loaded) {
      const count = state.models.length;
      return {
        text: count ? `${count} model${count === 1 ? '' : 's'} loaded from server.` : 'Server returned no models.',
        error: false,
      };
    }
    return undefined;
  };

  return (
    <div ref={outer} class="pv-model-form-shell" data-open={props.open ? 'true' : 'false'}>
      <div ref={inner} style={{ opacity: String(Math.max(0, Math.min(1, opacity()))) }}>
        <Show when={mounted()}>
          <form class="pv-model-form" onSubmit={submit} onKeyDown={onKeyDown} novalidate>
            <div class="pv-setting-row">
              <label class="pv-setting-label" for={backendId}>Model ID</label>
              <span class="pv-setting-value">
                <input
                  ref={element => {
                    backendInput = element;
                  }}
                  id={backendId}
                  class="pv-text-input pv-model-input"
                  list={suggestions().length ? suggestionsId : undefined}
                  maxlength={120}
                  spellcheck={false}
                  autocomplete="off"
                  disabled={saving()}
                  placeholder={modelIdPlaceholder(props.account.provider)}
                  value={backend()}
                  onInput={event => {
                    setBackend(event.currentTarget.value);
                    if (error()) setError(undefined);
                  }}
                />
                <Show when={suggestions().length}>
                  <datalist id={suggestionsId}>
                    <For each={suggestions()}>
                      {item => <option value={item.value}>{item.label ?? item.value}</option>}
                    </For>
                  </datalist>
                </Show>
                <Show when={isSelfHosted()}>
                  <Button
                    variant="text"
                    class="pv-load-models"
                    disabled={saving() || !!serverState()?.loading}
                    onClick={() => loadServerModels(props.account.id)}
                  >
                    <Show when={serverState()?.loading}>
                      <span class="pv-spinner" aria-hidden="true" />
                    </Show>
                    {serverState()?.loading ? 'Loading…' : 'Load from server'}
                  </Button>
                </Show>
              </span>
            </div>

            <Show when={isSelfHosted() && serverFeedback()}>
              {feedback => (
                <p
                  class="pv-model-form-feedback"
                  classList={{ error: feedback().error }}
                  role={feedback().error ? 'alert' : 'status'}
                >
                  {feedback().text}
                </p>
              )}
            </Show>

            <div class="pv-setting-row">
              <label class="pv-setting-label" for={nameId}>Display name</label>
              <span class="pv-setting-value">
                <input
                  id={nameId}
                  class="pv-text-input pv-model-input"
                  maxlength={80}
                  spellcheck={false}
                  autocomplete="off"
                  disabled={saving()}
                  placeholder={backend().trim() || 'Defaults to model ID'}
                  value={displayName()}
                  onInput={event => {
                    setDisplayName(event.currentTarget.value);
                    if (error()) setError(undefined);
                  }}
                />
              </span>
            </div>

            <div class="pv-setting-row">
              <label class="pv-setting-label" for={effortId}>Effort levels</label>
              <span class="pv-setting-value">
                <input
                  id={effortId}
                  class="pv-text-input pv-model-input"
                  spellcheck={false}
                  autocomplete="off"
                  disabled={saving()}
                  placeholder="low, medium, high, xhigh"
                  value={effortText()}
                  onInput={event => {
                    setEffortText(event.currentTarget.value);
                    if (error()) setError(undefined);
                  }}
                  aria-describedby={`${effortId}-help`}
                />
              </span>
            </div>
            <p id={`${effortId}-help`} class="pv-model-form-feedback">Comma-separated effort levels supported by this model. Leave blank for provider defaults.</p>

            <Show when={error()}>
              {message => (
                <p class="pv-model-form-feedback error" role="alert">
                  {message()}
                </p>
              )}
            </Show>

            <div class="pv-model-form-actions">
              <Button variant="text" type="button" disabled={saving()} onClick={cancel}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" class="pv-model-save" disabled={!canSave()}>
                <Show when={saving()}>
                  <span class="pv-spinner" aria-hidden="true" />
                </Show>
                {saving() ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </form>
        </Show>
      </div>
    </div>
  );
}
