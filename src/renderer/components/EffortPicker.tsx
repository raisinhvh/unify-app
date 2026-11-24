/**
 * The composer's effort button, the sibling of ModelPicker's compact line.
 *
 *   <EffortPicker chatId={id} placement="top-start" />
 *
 * Closed: a compact pill that reads the chat's effort ("High"), or "Effort" while on Default, and a chevron.
 * Open: a Popover (same anchor, placement and Presence motion as the model menu) with a vertical list:
 * "Default" plus each effort level, then, when the model has speeds, a "Speed" caption and its rows below a
 * hairline. The selected effort and speed carry a check.
 * Hidden when Smart Auto is picked or the model offers neither effort nor speed.
 * Keyboard: arrows move, Enter picks, Esc closes (the Popover).
 *
 * Options come from screens/chats/models.ts, so the rules live in one place.
 */
import { createSignal, For, onMount, Show, type JSX } from 'solid-js';
import { viewState } from '../store';
import {
  effortOptions,
  selectedModelValue,
  selectEffort,
  selectSpeed,
  smartAutoId,
  speedOptions,
} from '../screens/chats/models';
import { Button } from './Button';
import { Icon } from './Icon';
import { Popover, type PopoverPlacement } from './Popover';
import './modelPicker.css';
import './effortPicker.css';

export interface EffortPickerProps {
  /** The chat whose effort and speed this sets. */
  chatId?: string;
  placement?: PopoverPlacement;
  disabled?: boolean;
  class?: string;
}

interface EffortChoice {
  key: string;
  kind: 'effort' | 'speed';
  value: string;
  label: string;
}

let effortPickerCount = 0;
/** DEV: ?open= opens only one picker (the first visible one in a composer). */
let devOpened = false;

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

export function EffortPicker(props: EffortPickerProps): JSX.Element {
  effortPickerCount += 1;
  const listId = `effort-picker-list-${effortPickerCount}`;
  const [open, setOpen] = createSignal(false);
  const [highlightKey, setHighlightKey] = createSignal<string>();
  const [anchor, setAnchor] = createSignal<HTMLButtonElement>();

  const smartAutoPicked = () => selectedModelValue() === smartAutoId;
  const efforts = () => (smartAutoPicked() ? [] : effortOptions());
  const speeds = () => (smartAutoPicked() ? [] : speedOptions());
  const visible = () => efforts().length > 0 || speeds().length > 0;

  const effortValue = () => {
    const effort = viewState.selectedEffort || '';
    return efforts().some(option => option.value === effort) ? effort : '';
  };

  const speedValue = () => {
    const speed = viewState.selectedSpeed;
    return speeds().some(option => option.value === speed) ? speed! : speeds()[0]?.value ?? '';
  };

  const effortChoices = (): EffortChoice[] =>
    efforts().map(option => ({
      key: `effort:${option.value}`,
      kind: 'effort',
      value: option.value,
      label: capitalize(option.label),
    }));

  const speedChoices = (): EffortChoice[] =>
    speeds().map(option => ({
      key: `speed:${option.value}`,
      kind: 'speed',
      value: option.value,
      label: capitalize(option.label),
    }));

  const choices = () => [...effortChoices(), ...speedChoices()];

  const isCurrent = (choice: EffortChoice) =>
    choice.kind === 'effort' ? choice.value === effortValue() : choice.value === speedValue();

  const lineLabel = () => {
    const effort = effortValue();
    if (effort) return capitalize(effort);
    if (!efforts().length && speeds().length) return capitalize(speedValue());
    return 'Effort';
  };

  const lineTitle = () => {
    const parts = [effortValue() ? capitalize(effortValue()) : 'Default effort'];
    if (speeds().length) parts.push(capitalize(speedValue()));
    return `Effort: ${parts.join(', ')}`;
  };

  function openPicker(): void {
    if (props.disabled) return;
    const current = choices().find(choice => choice.kind === 'effort' && isCurrent(choice)) ?? choices()[0];
    setHighlightKey(current?.key);
    setOpen(true);
  }

  function closePicker(focusTrigger: boolean): void {
    setOpen(false);
    if (focusTrigger) anchor()?.focus();
  }

  function pick(choice: EffortChoice): void {
    if (choice.kind === 'effort') selectEffort(choice.value, props.chatId);
    else selectSpeed(choice.value, props.chatId);
    closePicker(true);
  }

  function moveHighlight(step: number): void {
    const list = choices();
    if (!list.length) return;
    const at = list.findIndex(choice => choice.key === highlightKey());
    const next = at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length;
    setHighlightKey(list[next].key);
  }

  const onListKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveHighlight(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setHighlightKey(choices()[0]?.key);
    } else if (event.key === 'End') {
      event.preventDefault();
      setHighlightKey(choices()[choices().length - 1]?.key);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const choice = choices().find(candidate => candidate.key === highlightKey());
      if (choice) pick(choice);
    } else if (event.key === 'Tab') {
      closePicker(false);
    }
  };

  const onTriggerKeyDown = (event: KeyboardEvent) => {
    if (open() || props.disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openPicker();
    }
  };

  // DEV: `?open=effort` opens the picker so tools/shot.mjs can capture the popover.
  onMount(() => {
    if (!import.meta.env.DEV) return;
    if (new URLSearchParams(window.location.search).get('open') !== 'effort') return;
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

  const renderChoice = (choice: EffortChoice): JSX.Element => (
    <div
      id={`${listId}-${choice.key}`}
      role="option"
      aria-selected={isCurrent(choice)}
      class="model-picker-row effort-picker-row"
      classList={{
        highlighted: highlightKey() === choice.key,
        current: isCurrent(choice),
      }}
      onPointerMove={() => {
        if (highlightKey() !== choice.key) setHighlightKey(choice.key);
      }}
      onPointerDown={event => event.preventDefault()}
      onClick={() => pick(choice)}
    >
      <span class="model-picker-row-label">{choice.label}</span>
      <span class="model-picker-row-check">
        <Show when={isCurrent(choice)}>
          <Icon name="check" size={14} />
        </Show>
      </span>
    </div>
  );

  return (
    <Show when={visible()}>
      <Button
        ref={setAnchor}
        variant="text"
        trailingIcon="chevron"
        class={`model-picker model-picker-compact effort-picker${open() ? ' open' : ''}${props.class ? ' ' + props.class : ''}`}
        disabled={props.disabled}
        title={lineTitle()}
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => (open() ? closePicker(false) : openPicker())}
        onKeyDown={onTriggerKeyDown}
      >
        <span class="model-picker-name" classList={{ placeholder: !effortValue() && efforts().length > 0 }}>
          {lineLabel()}
        </span>
      </Button>
      <Popover
        anchor={anchor()}
        open={open()}
        onClose={() => setOpen(false)}
        placement={props.placement ?? 'bottom-start'}
        class="model-picker-popover effort-picker-popover"
      >
        <div
          ref={element => queueMicrotask(() => element.focus({ preventScroll: true }))}
          id={listId}
          class="effort-picker-list"
          role="listbox"
          aria-label="Reasoning effort and speed"
          aria-activedescendant={highlightKey() ? `${listId}-${highlightKey()}` : undefined}
          tabindex="-1"
          onKeyDown={onListKeyDown}
        >
          <For each={effortChoices()}>{choice => renderChoice(choice)}</For>
          <Show when={speedChoices().length > 0}>
            <Show when={effortChoices().length > 0}>
              <div class="effort-picker-divider" role="separator" />
            </Show>
            <div class="model-picker-group type-caption" role="presentation">
              <span class="model-picker-group-label">Speed</span>
            </div>
            <For each={speedChoices()}>{choice => renderChoice(choice)}</For>
          </Show>
        </div>
      </Popover>
    </Show>
  );
}
