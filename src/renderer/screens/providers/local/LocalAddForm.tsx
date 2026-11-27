/**
 * Add provider › Local model. Pick a preset (grouped by engine), check the engine is there (Install / Browse /
 * Detect), fill the engine's required fields and a name, then Create: the engine makes the server and its
 * account, and the dialog closes onto that account's page.
 */
import { createEffect, createMemo, createSignal, on, Show, type JSX } from 'solid-js';
import { Button, Select, type SelectOption } from '../../../components';
import type { LocalEngineKind, LocalPreset, LocalValue, LocalValues } from '../../../../engine/local/types';
import { FieldGroups } from './FieldControl';
import { EngineStatusLine } from './LocalEnginesPanel';
import { createServer, localEngine, localLoaded, localState } from './localStore';
import './local.css';

const engineOrder: LocalEngineKind[] = ['polystrata', 'llama-cpp', 'koboldcpp', 'ollama', 'custom'];

const isEmpty = (value: LocalValue | undefined): boolean => value === undefined || (typeof value === 'string' && !value.trim());

export function LocalAddForm(props: { onCreated: (accountId: string) => void }): JSX.Element {
  const presets = createMemo<LocalPreset[]>(() => {
    const rank = (kind: LocalEngineKind) => {
      const index = engineOrder.indexOf(kind);
      return index < 0 ? engineOrder.length : index;
    };
    return [...localState.presets].sort((first, second) => rank(first.engine) - rank(second.engine));
  });
  const [presetId, setPresetId] = createSignal<string>();
  const preset = () => presets().find(item => item.id === presetId()) ?? presets()[0];
  const engine = () => localEngine(preset()?.engine);
  const [values, setValues] = createSignal<LocalValues>({});
  const [name, setName] = createSignal('');
  const [nameEdited, setNameEdited] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const [error, setError] = createSignal<string>();

  createEffect(
    on(
      () => preset()?.id,
      () => {
        const current = preset();
        setValues({ ...(current?.values ?? {}) });
        if (!nameEdited()) setName(current?.label ?? '');
        setError(undefined);
      },
    ),
  );

  const options = (): SelectOption[] => {
    let previous: LocalEngineKind | undefined;
    return presets().map(item => {
      const group = item.engine !== previous ? localEngine(item.engine)?.label ?? item.engine : undefined;
      previous = item.engine;
      return { value: item.id, label: item.label, hint: item.builtin ? undefined : 'Saved', group };
    });
  };

  const required = () => (engine()?.fields ?? []).filter(spec => spec.required);
  const missing = () => required().filter(spec => isEmpty(values()[spec.id] ?? spec.default));
  const canCreate = () => !!preset() && !!name().trim() && !missing().length && !creating();

  const submit = async (event?: Event) => {
    event?.preventDefault();
    const current = preset();
    if (!current || !canCreate()) return;
    setCreating(true);
    setError(undefined);
    const result = await createServer({ presetId: current.id, label: name().trim(), values: values() });
    setCreating(false);
    if (result.error) setError(result.error);
    else if (result.accountId) props.onCreated(result.accountId);
  };

  return (
    <form class="pv-add-form pv-local-add" onSubmit={event => void submit(event)}>
      <Show when={localLoaded()} fallback={<p class="pv-add-caption type-caption pv-local-loading">Loading local engines…</p>}>
        <div class="pv-field">
          <span class="pv-field-label">Preset</span>
          <Select
            class="pv-local-preset"
            value={preset()?.id}
            options={options()}
            onChange={setPresetId}
            placement="bottom-start"
          />
        </div>
        <Show when={preset()?.description || preset()?.note}>
          <p class="pv-local-preset-note">
            <Show when={preset()?.description}>
              <span>{preset()!.description}</span>
            </Show>
            <Show when={preset()?.note}>
              <span class="pv-local-muted">{preset()!.note}</span>
            </Show>
          </p>
        </Show>
        <Show when={engine()}>{current => <EngineStatusLine engine={current()} />}</Show>
        <FieldGroups
          specs={required()}
          values={values()}
          onChange={(id, value) => setValues(current => ({ ...current, [id]: value }))}
          compact
        />
        <div class="pv-field">
          <label class="pv-field-label" for="pv-local-name">Name</label>
          <input
            id="pv-local-name"
            class="pv-text-input pv-field-input"
            value={name()}
            onInput={event => {
              setNameEdited(true);
              setName(event.currentTarget.value);
            }}
            spellcheck={false}
            autocomplete="off"
          />
        </div>
        <Show when={error()}>
          <p class="pv-local-error-text" role="alert">{error()}</p>
        </Show>
        <div class="pv-add-actions">
          <span class="pv-add-caption type-caption">Starts on first use. Everything stays editable.</span>
          <Button variant="primary" type="submit" class="pv-connect" disabled={!canCreate()}>
            <Show when={creating()}>
              <span class="pv-spinner" aria-hidden="true" />
            </Show>
            Create
          </Button>
        </div>
      </Show>
    </form>
  );
}

