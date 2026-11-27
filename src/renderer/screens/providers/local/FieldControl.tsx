/**
 * Generic controls for local server settings (engine/local/types.ts LocalFieldSpec), plus the small pieces the
 * local screens share: a path that truncates in the middle and a text that cross-fades when it changes.
 *
 *   <FieldRow spec={spec} value={values()[spec.id]} onChange={value => setValue(spec.id, value)} />
 *
 * Rows follow the Providers setting rows: a 168px muted label, the control in the value column, and the field's
 * help as a caption under it.
 */
import { createEffect, createSignal, createUniqueId, For, on, Show, type JSX } from 'solid-js';
import { Button, Select, Toggle } from '../../../components';
import { prefersReducedMotion, useSpring } from '../../../motion';
import type { LocalFieldSpec, LocalValue } from '../../../../engine/local/types';
import { browseLocalPath } from './localStore';

export interface FieldControlProps {
  spec: LocalFieldSpec;
  value: LocalValue | undefined;
  onChange: (value: LocalValue) => void;
  id?: string;
}

const asText = (value: LocalValue | undefined): string => (value === undefined || value === null ? '' : String(value));

/** The control alone (no label). */
export function FieldControl(props: FieldControlProps): JSX.Element {
  const spec = () => props.spec;
  const text = () => asText(props.value ?? spec().default);

  const browse = async () => {
    const kind = spec().type === 'folder' ? 'folder' : 'file';
    const path = await browseLocalPath({
      kind,
      title: spec().label,
      filters: spec().filters,
      defaultPath: text() || undefined,
    });
    if (path) props.onChange(path);
  };

  switch (spec().type) {
    case 'toggle':
      return (
        <Toggle
          checked={props.value === undefined ? spec().default === true : props.value === true}
          label={spec().label}
          onChange={checked => props.onChange(checked)}
        />
      );
    case 'select':
      return (
        <Select
          class="pv-local-select"
          value={text()}
          options={(spec().options ?? []).map(option => ({ value: option.value, label: option.label }))}
          onChange={value => props.onChange(value)}
          placement="bottom-start"
        />
      );
    case 'number':
      return (
        <input
          id={props.id}
          class="pv-text-input pv-local-number"
          type="number"
          inputmode="numeric"
          min={spec().min}
          max={spec().max}
          step={spec().step}
          placeholder={spec().placeholder}
          value={text()}
          onInput={event => {
            const raw = event.currentTarget.value;
            if (raw.trim() === '') props.onChange('');
            else if (Number.isFinite(Number(raw))) props.onChange(Number(raw));
          }}
        />
      );
    case 'file':
    case 'folder':
      return (
        <span class="pv-local-path-control">
          <input
            id={props.id}
            class="pv-text-input pv-local-wide"
            placeholder={spec().placeholder ?? (spec().type === 'folder' ? 'Choose a folder' : 'Choose a file')}
            value={text()}
            title={text() || undefined}
            spellcheck={false}
            autocomplete="off"
            onInput={event => props.onChange(event.currentTarget.value)}
          />
          <Button variant="secondary" class="pv-local-browse" onClick={() => void browse()}>
            Browse…
          </Button>
        </span>
      );
    case 'args':
      return (
        <input
          id={props.id}
          class="pv-text-input pv-local-wide pv-local-mono"
          placeholder={spec().placeholder ?? '--flag value'}
          value={text()}
          spellcheck={false}
          autocomplete="off"
          onInput={event => props.onChange(event.currentTarget.value)}
        />
      );
    case 'env':
      return (
        <textarea
          id={props.id}
          class="pv-text-input pv-local-wide pv-local-mono pv-local-env"
          placeholder={spec().placeholder ?? 'NAME=value'}
          value={text()}
          rows={3}
          spellcheck={false}
          onInput={event => props.onChange(event.currentTarget.value)}
        />
      );
    default:
      return (
        <input
          id={props.id}
          class="pv-text-input pv-local-wide"
          placeholder={spec().placeholder}
          value={text()}
          spellcheck={false}
          autocomplete="off"
          onInput={event => props.onChange(event.currentTarget.value)}
        />
      );
  }
}

/** One settings row: label, control, help caption. */
export function FieldRow(props: FieldControlProps & { compact?: boolean }): JSX.Element {
  const id = createUniqueId();
  const labelled = () => props.spec.type !== 'toggle' && props.spec.type !== 'select';
  return (
    <div class="pv-local-field" classList={{ compact: !!props.compact, tall: props.spec.type === 'env' }}>
      <Show
        when={labelled()}
        fallback={<span class="pv-local-field-label" title={props.spec.label}>{props.spec.label}</span>}
      >
        <label class="pv-local-field-label" for={id} title={props.spec.label}>
          {props.spec.label}
          <Show when={props.spec.required}>
            <span class="pv-local-required" aria-label="required"> *</span>
          </Show>
        </label>
      </Show>
      <div class="pv-local-field-value">
        <FieldControl {...props} id={id} />
        <Show when={props.spec.help}>
          <span class="pv-local-help">{props.spec.help}</span>
        </Show>
      </div>
    </div>
  );
}

/** Rows for a list of specs, grouped under small headings by `group` (array order kept inside a group). */
export function FieldGroups(props: {
  specs: LocalFieldSpec[];
  values: Record<string, LocalValue>;
  onChange: (id: string, value: LocalValue) => void;
  compact?: boolean;
  /** Heading for fields without a group. */
  fallbackGroup?: string;
}): JSX.Element {
  const groups = () => {
    const order: string[] = [];
    const byGroup = new Map<string, LocalFieldSpec[]>();
    for (const spec of props.specs) {
      const name = spec.group ?? props.fallbackGroup ?? '';
      if (!byGroup.has(name)) {
        byGroup.set(name, []);
        order.push(name);
      }
      byGroup.get(name)!.push(spec);
    }
    return order.map(name => ({ name, specs: byGroup.get(name)! }));
  };
  return (
    <For each={groups()}>
      {group => (
        <div class="pv-local-group">
          <Show when={group.name}>
            <h3 class="pv-local-group-heading">{group.name}</h3>
          </Show>
          <For each={group.specs}>
            {spec => (
              <FieldRow
                spec={spec}
                value={props.values[spec.id]}
                onChange={value => props.onChange(spec.id, value)}
                compact={props.compact}
              />
            )}
          </For>
        </div>
      )}
    </For>
  );
}

/** A long path that keeps its start and its file name, cutting the middle with an ellipsis. */
export function MiddlePath(props: { path: string; class?: string }): JSX.Element {
  const split = () => {
    const path = props.path;
    const separator = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
    const nameLength = path.length - separator;
    const tailLength = Math.min(path.length, Math.max(12, Math.min(nameLength, 32)));
    const cut = path.length - tailLength;
    return { head: path.slice(0, cut), tail: path.slice(cut) };
  };
  return (
    <span class={`pv-local-middle${props.class ? ` ${props.class}` : ''}`} title={props.path}>
      <span class="pv-local-middle-head">{split().head}</span>
      <span class="pv-local-middle-tail">{split().tail}</span>
    </span>
  );
}

/** Text that cross-fades (Control token) when it changes; the old words fade out, the new ones in. */
export function FadeText(props: { text: string; class?: string; children?: JSX.Element }): JSX.Element {
  const [shown, setShown] = createSignal(props.text);
  const [opacity, setOpacity] = createSignal(1);
  const fade = useSpring(1, 'control', 1);
  fade.onChange(value => setOpacity(Math.max(0, Math.min(1, value))));
  let pending: string | undefined;
  fade.onRest(value => {
    if (value <= 0.01 && pending !== undefined) {
      setShown(pending);
      pending = undefined;
      fade.set(1, 'control');
    }
  });
  createEffect(
    on(
      () => props.text,
      next => {
        if (next === shown() && pending === undefined) return;
        if (prefersReducedMotion()) {
          setShown(next);
          return;
        }
        pending = next;
        fade.set(0, 'exit');
      },
      { defer: true },
    ),
  );
  return (
    <span class={props.class} style={{ opacity: String(opacity()) }}>
      {props.children}
      {shown()}
    </span>
  );
}
