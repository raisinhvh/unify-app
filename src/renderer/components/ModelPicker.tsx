/**
 * The one model picker (spec "One reusable model picker"). Every place that chooses a model uses it.
 *
 *   <ModelPicker chatId={id} variant="compact" placement="top-start" />          bound to the chat's model
 *   <ModelPicker value={profile.model} onChange={model => …} smartAuto={false} />  bound to the caller's own field
 *
 * Closed: one flat line, provider glyph, model name and a chevron. Effort and speed live in EffortPicker.
 * It truncates with an ellipsis and never wraps.
 * Open: a Popover with a search field (focused; filters by name, provider, account and backend), an optional
 * "None" row, Smart Auto when ready, then every enabled model grouped by provider like a folder tree.
 * Keyboard: arrows move, Enter picks, Esc closes, typing on the closed line opens it and starts the search.
 *
 * Options come from screens/chats/models.ts, so the rules (enabled models only, Smart Auto first when ready,
 * Smart Auto naming) live in one place.
 */
import { createEffect, createMemo, createSignal, on, onMount, Show, type JSX } from 'solid-js';
import { AnimatedList, Collapse } from '../motion';
import { viewState } from '../store';
import { modelOptions, selectedModelValue, selectModel, smartAutoId } from '../screens/chats/models';
import { ProviderGlyph } from './ProviderGlyph';
import { Button } from './Button';
import { Icon } from './Icon';
import { Popover, type PopoverPlacement } from './Popover';
import './modelPicker.css';

export type ModelPickerVariant = 'compact' | 'regular';

export interface ModelPickerProps {
  /** The model id shown as picked. Read only when `onChange` is set; otherwise the active chat's model is used. */
  value?: string;
  /** Called with the picked model id ('' for the None row). Omit to post selectModel for `chatId`. */
  onChange?: (modelId: string) => void;
  /** The chat the default binding applies to. */
  chatId?: string;
  /** `compact` for tight spots (composer footer, pane header), `regular` for settings rows. Default compact. */
  variant?: ModelPickerVariant;
  /** Offer Smart Auto (only shown when it is ready). Default true. */
  smartAuto?: boolean;
  /** Adds a first row with this label that picks ''. */
  noneLabel?: string;
  /** Only offer these model ids (an account's own models). */
  modelIds?: readonly string[];
  /** Shown on the line when nothing is picked and there is no None row. */
  placeholder?: string;
  placement?: PopoverPlacement;
  disabled?: boolean;
  class?: string;
  title?: string;
}

interface GroupRow {
  kind: 'group';
  key: string;
  label: string;
  provider?: string;
}

interface ChoiceRow {
  kind: 'choice';
  key: string;
  value: string;
  label: string;
  hint?: string;
  /** Leading glyph: a provider id, the Smart Auto icon, or nothing. */
  provider?: string;
  smartAuto?: boolean;
  /** Hangs off its provider group's guide line. */
  nested?: boolean;
  /** Last row of a nested group (the guide line stops short). */
  last?: boolean;
}

type PickerRow = GroupRow | ChoiceRow;

interface Candidate {
  value: string;
  label: string;
  hint?: string;
  group?: string;
  provider?: string;
  smartAuto?: boolean;
  /** Lower-case text the search matches against. */
  haystack: string;
}

const noneValue = '';
let pickerCount = 0;
/** DEV: ?open= opens only one picker (the first visible one in a composer). */
let devOpened = false;

function accountLabel(accountId: string | undefined): string | undefined {
  if (!accountId) return undefined;
  return viewState.accounts.find(account => account.id === accountId)?.label;
}

export function ModelPicker(props: ModelPickerProps): JSX.Element {
  pickerCount += 1;
  const listId = `model-picker-list-${pickerCount}`;
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [highlightKey, setHighlightKey] = createSignal<string>();
  const [anchor, setAnchor] = createSignal<HTMLButtonElement>();
  const rowElements = new Map<string, HTMLElement>();
  let searchInput: HTMLInputElement | undefined;

  const boundToChat = () => !props.onChange;
  const offersSmartAuto = () => props.smartAuto ?? true;

  const value = (): string | undefined => (boundToChat() ? selectedModelValue() : props.value);

  /** Every pickable model as a search candidate, in modelOptions order. */
  const candidates = createMemo<Candidate[]>(() => {
    const allowed = props.modelIds ? new Set(props.modelIds) : undefined;
    const list: Candidate[] = [];
    for (const option of modelOptions()) {
      if (option.value === smartAutoId) {
        if (!offersSmartAuto()) continue;
        list.push({
          value: option.value,
          label: option.label,
          hint: option.hint,
          smartAuto: true,
          haystack: `${option.label} ${option.hint ?? ''}`.toLowerCase(),
        });
        continue;
      }
      if (allowed && !allowed.has(option.value)) continue;
      const model = viewState.models.find(item => item.id === option.value);
      const account = accountLabel(model?.account);
      list.push({
        value: option.value,
        label: option.label,
        group: option.group,
        provider: model?.provider,
        hint: account,
        haystack: [option.label, option.group, model?.provider, model?.backend, account].filter(Boolean).join(' ').toLowerCase(),
      });
    }
    return list;
  });

  const rows = createMemo<PickerRow[]>(() => {
    const search = query().trim().toLowerCase();
    const matches = (candidate: Candidate) => !search || candidate.haystack.includes(search);
    const list: PickerRow[] = [];

    if (props.noneLabel !== undefined && (!search || props.noneLabel.toLowerCase().includes(search))) {
      list.push({ kind: 'choice', key: 'none', value: noneValue, label: props.noneLabel });
    }

    const smart = candidates().find(candidate => candidate.smartAuto);
    if (smart && matches(smart)) {
      list.push({ kind: 'choice', key: 'smart-auto', value: smart.value, label: smart.label, hint: smart.hint, smartAuto: true });
    }

    const models = candidates().filter(candidate => !candidate.smartAuto);

    const groups = new Map<string, Candidate[]>();
    for (const candidate of models) {
      if (!matches(candidate)) continue;
      const group = candidate.group ?? 'Other';
      const members = groups.get(group) ?? [];
      members.push(candidate);
      groups.set(group, members);
    }
    for (const [group, members] of groups) {
      const provider = members[0].provider;
      list.push({ kind: 'group', key: `group:${group}`, label: group, provider: provider ?? 'unknown' });
      // Account labels only help when one provider lists models from more than one account.
      const accounts = new Set(members.map(member => member.hint ?? ''));
      members.forEach((candidate, index) => {
        list.push({
          kind: 'choice',
          key: `model:${candidate.value}`,
          value: candidate.value,
          label: candidate.label,
          hint: accounts.size > 1 ? candidate.hint : undefined,
          nested: true,
          last: index === members.length - 1,
        });
      });
    }
    return list;
  });

  const choices = createMemo(() => rows().filter((row): row is ChoiceRow => row.kind === 'choice'));

  /**
   * The row to highlight when the list changes. While searching, the first match (what Enter should pick);
   * otherwise the picked model in its provider group, else the first row.
   */
  function defaultHighlight(): string | undefined {
    const list = choices();
    if (query().trim()) return list[0]?.key;
    const picked = value() ?? noneValue;
    const current = list.find(row => row.value === picked);
    return (current ?? list[0])?.key;
  }

  createEffect(on(query, () => {
    if (open()) setHighlightKey(defaultHighlight());
  }, { defer: true }));

  const scrollToHighlight = () => {
    const key = highlightKey();
    if (!key) return;
    rowElements.get(key)?.scrollIntoView({ block: 'nearest' });
  };

  function openPicker(initialQuery = ''): void {
    if (props.disabled) return;
    setQuery(initialQuery);
    setHighlightKey(defaultHighlight());
    setOpen(true);
    queueMicrotask(scrollToHighlight);
  }

  function closePicker(focusTrigger: boolean): void {
    setOpen(false);
    if (focusTrigger) anchor()?.focus();
  }

  // DEV: `?open=model` opens the composer's picker so tools/shot.mjs can capture the popover.
  onMount(() => {
    if (!import.meta.env.DEV || !boundToChat()) return;
    if (new URLSearchParams(window.location.search).get('open') !== 'model') return;
    window.setTimeout(() => {
      const trigger = anchor();
      if (devOpened || !trigger?.closest('.composer-bar')) return;
      // Only the composer on screen: a hidden one still has layout, so hit-test the trigger's centre.
      const box = trigger.getBoundingClientRect();
      if (!trigger.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))) return;
      devOpened = true;
      openPicker();
    }, 400);
  });

  function pick(row: ChoiceRow): void {
    if (props.onChange) props.onChange(row.value);
    else selectModel(row.value, props.chatId);
    closePicker(true);
  }

  function moveHighlight(step: number): void {
    const list = choices();
    if (!list.length) return;
    const at = list.findIndex(row => row.key === highlightKey());
    const next = at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length;
    setHighlightKey(list[next].key);
    queueMicrotask(scrollToHighlight);
  }

  const onSearchKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' && event.ctrlKey) {
      event.preventDefault();
      setHighlightKey(choices()[0]?.key);
      queueMicrotask(scrollToHighlight);
    } else if (event.key === 'End' && event.ctrlKey) {
      event.preventDefault();
      setHighlightKey(choices()[choices().length - 1]?.key);
      queueMicrotask(scrollToHighlight);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = choices().find(candidate => candidate.key === highlightKey());
      if (row) pick(row);
    } else if (event.key === 'Tab') {
      closePicker(false);
    }
  };

  const onTriggerKeyDown = (event: KeyboardEvent) => {
    if (open() || props.disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openPicker();
      return;
    }
    // Type-to-search: a printable key on the closed line opens the picker with that text.
    if (event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      openPicker(event.key);
    }
  };

  /* The line */

  const currentModel = () => viewState.models.find(model => model.id === value());

  const lineLabel = () => {
    const current = value();
    if (current === smartAutoId) return smartAutoId;
    if (current) return currentModel()?.name ?? current;
    return props.noneLabel ?? props.placeholder ?? 'Choose model';
  };

  const lineTitle = () => {
    return props.title ? `${props.title}: ${lineLabel()}` : lineLabel();
  };

  const lineGlyph = (): JSX.Element => {
    const current = value();
    if (current === smartAutoId) return <Icon name="bot" size={14} class="model-picker-glyph" />;
    if (!current) return null;
    return <ProviderGlyph provider={currentModel()?.provider ?? 'unknown'} size={14} class="model-picker-glyph" />;
  };

  /* Rows */

  const rowLeading = (row: ChoiceRow): JSX.Element => {
    if (row.nested) return null;
    if (row.smartAuto) return <Icon name="bot" size={14} />;
    if (row.provider) return <ProviderGlyph provider={row.provider} size={14} />;
    return null;
  };

  const renderRow = (row: () => PickerRow): JSX.Element => {
    const entry = row();
    if (entry.kind === 'group') {
      return (
        <div class="model-picker-group type-caption" role="presentation">
          <Show when={entry.provider}>
            {provider => <ProviderGlyph provider={provider()} size={12} class="model-picker-group-glyph" />}
          </Show>
          <span class="model-picker-group-label">{entry.label}</span>
        </div>
      );
    }
    const choice = () => row() as ChoiceRow;
    const isCurrent = () => choice().value === (value() ?? noneValue);
    return (
      <div
        ref={element => rowElements.set(entry.key, element)}
        id={`${listId}-${entry.key}`}
        role="option"
        aria-selected={isCurrent()}
        class="model-picker-row"
        classList={{
          highlighted: highlightKey() === entry.key,
          nested: !!choice().nested,
          last: !!choice().last,
          current: isCurrent(),
        }}
        onPointerMove={() => {
          if (highlightKey() !== entry.key) setHighlightKey(entry.key);
        }}
        onPointerDown={event => event.preventDefault()}
        onClick={() => pick(choice())}
      >
        <Show when={!choice().nested}>
          <span class="model-picker-row-leading">{rowLeading(choice())}</span>
        </Show>
        <span class="model-picker-row-label">{choice().label}</span>
        <Show when={choice().hint}>
          <span class="model-picker-row-hint type-caption">{choice().hint}</span>
        </Show>
        <span class="model-picker-row-check">
          <Show when={isCurrent()}>
            <Icon name="check" size={14} />
          </Show>
        </span>
      </div>
    );
  };

  return (
    <>
      <Button
        ref={setAnchor}
        variant="text"
        trailingIcon="chevron"
        class={`model-picker model-picker-${props.variant ?? 'compact'}${open() ? ' open' : ''}${props.class ? ' ' + props.class : ''}`}
        disabled={props.disabled}
        title={lineTitle()}
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => (open() ? closePicker(false) : openPicker())}
        onKeyDown={onTriggerKeyDown}
      >
        {lineGlyph()}
        <span
          class="model-picker-name"
          classList={{ placeholder: !value() && props.noneLabel === undefined }}
        >
          {lineLabel()}
        </span>
      </Button>
      <Popover
        anchor={anchor()}
        open={open()}
        onClose={() => setOpen(false)}
        placement={props.placement ?? 'bottom-start'}
        class="model-picker-popover"
      >
        <div class="model-picker-search">
          <Icon name="search" size={14} class="model-picker-search-icon" />
          <input
            ref={element => {
              searchInput = element;
              queueMicrotask(() => {
                searchInput?.focus({ preventScroll: true });
                const end = searchInput?.value.length ?? 0;
                searchInput?.setSelectionRange(end, end);
              });
            }}
            class="model-picker-search-input"
            type="text"
            role="combobox"
            aria-label="Search models"
            aria-controls={listId}
            aria-expanded="true"
            aria-activedescendant={highlightKey() ? `${listId}-${highlightKey()}` : undefined}
            placeholder="Search models"
            spellcheck={false}
            autocomplete="off"
            value={query()}
            onInput={event => setQuery(event.currentTarget.value)}
            onKeyDown={onSearchKeyDown}
          />
        </div>
        <div id={listId} class="model-picker-list" role="listbox" aria-label="Models">
          <AnimatedList each={rows()} key={row => row.key}>
            {row => renderRow(row)}
          </AnimatedList>
          {/* Reveals in step with the rows collapsing away, so the popover's height never jumps. */}
          <Collapse open={choices().length === 0}>
            <p class="model-picker-empty type-caption">
              {candidates().length ? 'No models match.' : 'No models yet. Add a provider account first.'}
            </p>
          </Collapse>
        </div>
      </Popover>
    </>
  );
}
