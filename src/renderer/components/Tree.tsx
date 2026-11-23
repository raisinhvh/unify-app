/**
 * File-system style tree (Figma Tree/Folder 306:6184, Tree/Item 306:6199).
 *
 *   <TreeFolder label="Unify" icon="folder" trailing="Programs/Unify" open={open()} onToggle={setOpen}>
 *     <TreeItem leading={<ChatLoader … />} label="Fix ACP init timeout" trailing="0:42" selected />
 *   </TreeFolder>
 *
 * Folders have a chevron that rotates on the Indicator spring and reveal their children with <Collapse>, so
 * rows below slide down instead of jumping. Children hang off a guide line under the chevron.
 */
import { Show, splitProps, type JSX } from 'solid-js';
import { Collapse, createSpring, pressable } from '../motion';
import { Icon } from './Icon';
import type { IconName } from './icons';
import './tree.css';

export interface TreeFolderProps {
  label: JSX.Element;
  icon?: IconName;
  /** Right-aligned caption (a path, a count). */
  trailing?: JSX.Element;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: JSX.Element;
  class?: string;
}

export function TreeFolder(props: TreeFolderProps): JSX.Element {
  const rotation = createSpring(() => (props.open ? 0 : -90), 'indicator', { precision: 100 });
  return (
    <div class={props.class ? `tree-folder ${props.class}` : 'tree-folder'}>
      <button
        type="button"
        class="tree-row tree-folder-row"
        aria-expanded={props.open}
        ref={element => pressable(element, 0.98)}
        onClick={() => props.onToggle(!props.open)}
      >
        <Icon name="chevron" size={12} class="tree-chevron" style={{ rotate: `${rotation()}deg` }} />
        <Show when={props.icon}>
          <Icon name={props.icon!} class="tree-folder-icon" />
        </Show>
        <span class="tree-label">{props.label}</span>
        <Show when={props.trailing !== undefined}>
          <span class="tree-trailing">{props.trailing}</span>
        </Show>
      </button>
      <Collapse open={props.open} class="tree-children">
        {props.children}
      </Collapse>
    </div>
  );
}

export interface TreeItemProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  leading?: JSX.Element;
  label: JSX.Element;
  trailing?: JSX.Element;
  selected?: boolean;
  /** Colours the label (Active rows that need you use 'warn'). */
  tone?: 'warn' | 'muted';
  /** Extra classes for the trailing caption ('warn' for "needs approval"). */
  trailingTone?: 'warn';
}

export function TreeItem(props: TreeItemProps): JSX.Element {
  const [local, rest] = splitProps(props, ['leading', 'label', 'trailing', 'selected', 'tone', 'trailingTone', 'class', 'ref']);
  return (
    <button
      type="button"
      {...rest}
      ref={element => {
        pressable(element, 0.98);
        if (typeof local.ref === 'function') (local.ref as (element: HTMLButtonElement) => void)(element);
      }}
      class={local.class ? `tree-row tree-item ${local.class}` : 'tree-row tree-item'}
      classList={{ selected: !!local.selected, [`tone-${local.tone}`]: !!local.tone }}
      aria-current={local.selected ? 'true' : undefined}
    >
      <span class="tree-leading">{local.leading}</span>
      <span class="tree-label">{local.label}</span>
      <Show when={local.trailing !== undefined}>
        <span class="tree-trailing" classList={{ warn: local.trailingTone === 'warn' }}>{local.trailing}</span>
      </Show>
    </button>
  );
}
