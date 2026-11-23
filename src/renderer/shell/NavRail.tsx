/**
 * The Shell's left rail (Figma Rail 306:785): logo, entries that can hide, the usage meter and Settings.
 *
 *   <NavRail items={entries} active={route()} onSelect={go} settingsActive={…} onSettings={…} showMeter={…} />
 *
 * Every entry has a `visible` accessor (a feature toggle). A hidden entry fades and shrinks out while the entries
 * below glide up into its place on the Panel spring, so nothing jumps; showing it again reverses the same springs
 * from wherever they are. The selection highlight glides to the active entry's settled place on the Indicator
 * spring. The usage meter above Settings pops in and out with `showMeter` (feature usage.railMeter).
 * Reduced motion: positions snap and only opacity fades (createSpring / Presence handle it).
 */
import { createMemo, For, mapArray, type Accessor, type JSX } from 'solid-js';
import { LogoMark } from '../backdrop/Backdrop';
import { IconButton } from '../components/Button';
import type { IconName } from '../components/icons';
import { UsageMeter } from '../components/UsageMeter';
import { createSpring, Presence } from '../motion';
import './navRail.css';

export interface NavRailItem {
  id: string;
  icon: IconName;
  label: string;
  visible: () => boolean;
}

export interface NavRailProps {
  items: NavRailItem[];
  active: string;
  onSelect: (id: string) => void;
  settingsActive?: boolean;
  onSettings: () => void;
  showMeter: boolean;
  /** True while something covers the whole app (setup); the rail takes no focus or clicks. */
  inert?: boolean;
  style?: JSX.CSSProperties;
}

interface RailEntry {
  item: NavRailItem;
  /** 0 hidden … 1 shown. Drives the places of the entries below; snaps under reduced motion. */
  place: Accessor<number>;
  /** Opacity on its own fade-only spring, so reduced motion still crossfades. */
  opacity: Accessor<number>;
}

const buttonTop = 64;
const buttonStep = 44;

export function NavRail(props: NavRailProps): JSX.Element {
  const entries = createMemo(mapArray(
    () => props.items,
    (item): RailEntry => ({
      item,
      place: createSpring(() => (item.visible() ? 1 : 0), 'panel'),
      opacity: createSpring(() => (item.visible() ? 1 : 0), 'panel', { fadeOnly: true }),
    }),
  ));

  /** Animated offset of an entry: how many shown entries sit above it right now. */
  const animatedSlot = (index: number): number => {
    let slot = 0;
    const list = entries();
    for (let above = 0; above < index; above += 1) slot += list[above].place();
    return slot;
  };

  /** Where an entry will settle, from the targets (the highlight springs there itself). */
  const settledSlot = (index: number): number => {
    let slot = 0;
    for (let above = 0; above < index; above += 1) {
      if (props.items[above].visible()) slot += 1;
    }
    return slot;
  };

  const activeIndex = () => props.items.findIndex(item => item.id === props.active && item.visible());
  const highlightY = createSpring(() => buttonTop + settledSlot(Math.max(0, activeIndex())) * buttonStep, 'indicator', { precision: 100 });
  const highlightOpacity = createSpring(() => (activeIndex() >= 0 ? 1 : 0), 'indicator', { fadeOnly: true });

  return (
    <nav class="rail nav-rail" aria-label="Main" inert={props.inert} style={props.style}>
      <div class="rail-logo">
        <LogoMark />
      </div>
      <div class="rail-highlight" style={{ translate: `0 ${highlightY()}px`, opacity: highlightOpacity() }} />
      <div class="rail-items nav-rail-items">
        <For each={entries()}>
          {(entry, index) => {
            const shownScale = () => 0.85 + 0.15 * Math.max(0, Math.min(1, entry.place()));
            return (
              <div
                class="nav-rail-entry"
                data-rail-entry={entry.item.id}
                inert={!entry.item.visible()}
                aria-hidden={entry.item.visible() ? undefined : 'true'}
                style={{
                  translate: `0 ${animatedSlot(index()) * buttonStep}px`,
                  scale: String(shownScale()),
                  opacity: Math.max(0, Math.min(1, entry.opacity())),
                }}
              >
                <IconButton
                  icon={entry.item.icon}
                  label={entry.item.label}
                  size="large"
                  class="rail-button"
                  classList={{ current: entry.item.id === props.active }}
                  aria-current={entry.item.id === props.active ? 'page' : undefined}
                  tooltipPlacement="right-start"
                  onClick={() => props.onSelect(entry.item.id)}
                />
              </div>
            );
          }}
        </For>
      </div>
      <div class="rail-bottom">
        <Presence when={props.showMeter} from={0.85} origin="center bottom" exit="control">
          <div class="nav-rail-meter" data-rail-meter>
            <UsageMeter />
          </div>
        </Presence>
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
