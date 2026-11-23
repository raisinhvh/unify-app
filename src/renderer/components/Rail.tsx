/**
 * The left rail (Figma Rail 306:785): logo, 40×40 nav buttons, the usage meter and Settings at the bottom.
 * The selection highlight is one surface that glides between buttons on the Indicator spring.
 *
 *   <Rail items={navItems} active={route()} onSelect={go} settingsActive={route() === 'settings'} onSettings={…} />
 */
import { For, Show, type JSX } from 'solid-js';
import { LogoMark } from '../backdrop/Backdrop';
import { createSpring } from '../motion';
import { IconButton } from './Button';
import type { IconName } from './icons';
import { UsageMeter } from './UsageMeter';
import './rail.css';

export interface RailItem {
  id: string;
  icon: IconName;
  label: string;
}

export interface RailProps {
  items: RailItem[];
  active: string;
  onSelect: (id: string) => void;
  settingsActive?: boolean;
  onSettings: () => void;
  /** Replaces the usage meter slot. */
  meter?: JSX.Element;
}

const buttonTop = 64;
const buttonStep = 44;

export function Rail(props: RailProps): JSX.Element {
  const activeIndex = () => props.items.findIndex(item => item.id === props.active);
  const highlightY = createSpring(() => buttonTop + Math.max(0, activeIndex()) * buttonStep, 'indicator', { precision: 100 });
  const highlightOpacity = createSpring(() => (activeIndex() >= 0 ? 1 : 0), 'indicator', { fadeOnly: true });

  return (
    <nav class="rail" aria-label="Main">
      <div class="rail-logo">
        <LogoMark />
      </div>
      <div class="rail-highlight" style={{ translate: `0 ${highlightY()}px`, opacity: highlightOpacity() }} />
      <div class="rail-items">
        <For each={props.items}>
          {item => (
            <IconButton
              icon={item.icon}
              label={item.label}
              size="large"
              class="rail-button"
              classList={{ current: item.id === props.active }}
              aria-current={item.id === props.active ? 'page' : undefined}
              tooltipPlacement="right-start"
              onClick={() => props.onSelect(item.id)}
            />
          )}
        </For>
      </div>
      <div class="rail-bottom">
        <Show when={props.meter} fallback={<UsageMeter />}>
          {props.meter}
        </Show>
        <IconButton
          icon="settings"
          label="Settings"
          size="large"
          class="rail-button"
          active={props.settingsActive}
          tooltipPlacement="right-end"
          onClick={props.onSettings}
        />
      </div>
    </nav>
  );
}
