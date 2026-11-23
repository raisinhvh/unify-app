/**
 * Internal tool rows: a generic file tool the engine says was really app work (spec: Non-negotiables →
 * "A generic file tool used on app data says what it's really doing"). The engine decides through
 * `internal`; this file only maps each kind to how it looks.
 *
 *   history.refresh   rewinding the chat's history    refresh arrow turned back   Trace loader
 *   memory.read       looking a note up                lens                        Sift loader
 *   memory.write      saving a note                    into-the-tray arrow         Shelve loader
 */
import type { JSX } from 'solid-js';
import { Icon, type LoaderId } from '../../components';
import type { SidebarInternalToolKind } from '../../protocol';

export const internalLoader: Record<SidebarInternalToolKind, LoaderId> = {
  'history.refresh': 'trace',
  'memory.read': 'sift',
  'memory.write': 'shelve',
};

/** Same 16px grid and stroke as components/icons.ts: the upload tray with the arrow coming down into it. */
const saveIconPath =
  'M14 10V12.6667C14 13.0203 13.8595 13.3594 13.6095 13.6095C13.3594 13.8595 13.0203 14 12.6667 14H3.33333C2.97971 14 2.64057 13.8595 2.39052 13.6095C2.14048 13.3594 2 13.0203 2 12.6667V10M4.66667 6.66667L8 10L11.3333 6.66667M8 10V2';

export function InternalIcon(props: { kind: SidebarInternalToolKind; size?: number }): JSX.Element {
  const size = () => props.size ?? 12;
  if (props.kind === 'history.refresh') {
    return (
      <Icon
        name="refresh"
        size={size()}
        style={{ transform: 'scaleX(-1)' }}
      />
    );
  }
  if (props.kind === 'memory.read') {
    return (
      <Icon
        name="search"
        size={size()}
      />
    );
  }
  return (
    <svg
      class="icon"
      width={size()}
      height={size()}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d={saveIconPath}
        stroke-width="1.33333"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke="currentColor"
      />
    </svg>
  );
}
