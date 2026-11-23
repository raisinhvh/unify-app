/**
 * Anchored menu (Figma 13 · Composer menus): raised, radius 8, caption group labels, a check on the selected
 * row, hints aligned right. Arrow keys move, Enter/Space picks, Escape closes (focus returns to the anchor).
 *
 *   <Menu anchor={button} open={open()} onClose={close} onSelect={id => …}
 *         items={[{ kind: 'group', label: 'Effort' }, { id: 'high', label: 'high', checked: true, hint: 'slowest' }]} />
 */
import { createEffect, createSignal, For, Match, Switch, type JSX } from 'solid-js';
import { Icon } from './Icon';
import type { IconName } from './icons';
import { Popover, type PopoverPlacement } from './Popover';
import './menu.css';

export type MenuEntry =
  | { kind: 'group'; label: string }
  | { kind: 'separator' }
  | {
      kind?: 'item';
      id: string;
      label: string;
      hint?: string;
      icon?: IconName;
      checked?: boolean;
      disabled?: boolean;
      danger?: boolean;
    };

type MenuItem = Extract<MenuEntry, { id: string }>;

export interface MenuProps {
  anchor: HTMLElement | undefined;
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  items: MenuEntry[];
  placement?: PopoverPlacement;
  class?: string;
  /** Leave a check column even when nothing is checked, so labels line up across menus. */
  checkColumn?: boolean;
}

const isItem = (entry: MenuEntry): entry is MenuItem => 'id' in entry;

export function Menu(props: MenuProps): JSX.Element {
  const [highlight, setHighlight] = createSignal(-1);
  let surface: HTMLDivElement | undefined;

  const selectable = () => props.items.filter(isItem).filter(item => !item.disabled);
  const hasChecks = () => props.checkColumn ?? props.items.some(entry => isItem(entry) && entry.checked !== undefined);

  createEffect(() => {
    if (!props.open) return;
    const checkedIndex = selectable().findIndex(item => item.checked);
    setHighlight(checkedIndex);
    queueMicrotask(() => surface?.focus({ preventScroll: true }));
  });

  const pick = (item: MenuItem) => {
    if (item.disabled) return;
    props.onSelect(item.id);
    props.onClose();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const list = selectable();
    if (!list.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHighlight(index => (index + step + list.length) % list.length);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const item = list[highlight()];
      if (item) pick(item);
    } else if (event.key === 'Tab') {
      props.onClose();
    }
  };

  return (
    <Popover
      anchor={props.anchor}
      open={props.open}
      onClose={props.onClose}
      placement={props.placement ?? 'bottom-start'}
      class={`menu${props.class ? ' ' + props.class : ''}`}
      ref={element => {
        surface = element;
        element.tabIndex = -1;
        element.setAttribute('role', 'menu');
        element.addEventListener('keydown', onKeyDown);
      }}
    >
      <For each={props.items}>
        {entry => (
          <Switch>
            <Match when={entry.kind === 'group' && entry}>
              {group => <div class="menu-group type-caption">{group().label}</div>}
            </Match>
            <Match when={entry.kind === 'separator'}>
              <div class="menu-separator" />
            </Match>
            <Match when={isItem(entry) && entry}>
              {item => (
                <button
                  type="button"
                  role={item().checked === undefined ? 'menuitem' : 'menuitemradio'}
                  aria-checked={item().checked === undefined ? undefined : item().checked}
                  class="menu-item"
                  classList={{
                    highlighted: selectable()[highlight()]?.id === item().id,
                    danger: !!item().danger,
                  }}
                  disabled={item().disabled}
                  onPointerEnter={() => setHighlight(selectable().findIndex(candidate => candidate.id === item().id))}
                  onClick={() => pick(item())}
                >
                  {hasChecks() && (
                    <span class="menu-check">{item().checked && <Icon name="check" size={14} />}</span>
                  )}
                  {item().icon && <Icon name={item().icon!} class="menu-icon" />}
                  <span class="menu-label">{item().label}</span>
                  {item().hint && <span class="menu-hint type-caption">{item().hint}</span>}
                </button>
              )}
            </Match>
          </Switch>
        )}
      </For>
    </Popover>
  );
}
