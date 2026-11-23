/**
 * An explorer run, shown as what it is: a lookup, not a subagent (spec: Decisions → "Explorer is not shown as a
 * subagent"). An inline tool-style row, "Exploring" with the Sift loader while it runs, "Explored" once done, the
 * question as its text. When it completes, the tokens it used show muted, and the ranges it found open underneath
 * as compact `file:start–end` chips (full path in the tooltip); a chip opens the file at that line.
 *
 * No chat tab, image strip, "who → who" label or roster badge. `agents.explorerRanges` only hides the chips.
 */
import { For, Match, Show, Switch, type JSX } from 'solid-js';
import { Icon, Loader, tooltip } from '../../components';
import { post } from '../../bridge';
import { Collapse, pressable } from '../../motion';
import type { SidebarExplorerRange, SidebarSubagent } from '../../protocol';
import { feature } from '../../store/features';

export function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return `${tokens} tokens`;
  }
  const thousands = tokens / 1000;
  const rounded = thousands >= 100 ? Math.round(thousands).toString() : thousands.toFixed(1).replace(/\.0$/, '');
  return `${rounded}k tokens`;
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function rangeLabel(range: SidebarExplorerRange): string {
  const lines = range.endLine > range.startLine ? `${range.startLine}–${range.endLine}` : `${range.startLine}`;
  return `${fileName(range.path)}:${lines}`;
}

function RangeChip(props: { range: SidebarExplorerRange }): JSX.Element {
  return (
    <button
      type="button"
      class="range-chip type-mono"
      ref={element => {
        pressable(element, 0.96);
        tooltip(
          element,
          () => (
            <span class="range-tip">
              <span class="type-mono">{props.range.path}</span>
              <Show when={props.range.why}>
                <span class="range-tip-why">{props.range.why}</span>
              </Show>
            </span>
          ),
          { placement: 'top-start', delay: 400 },
        );
      }}
      onClick={() => post({ type: 'openFile', path: props.range.path, line: props.range.startLine })}
    >
      {rangeLabel(props.range)}
    </button>
  );
}

export function ExplorerRow(props: { agent: SidebarSubagent }): JSX.Element {
  const running = () => props.agent.state === 'running';
  const complete = () => props.agent.state === 'complete';
  const question = () => (props.agent.prompt || props.agent.title).replace(/\s+/g, ' ');
  const ranges = () => props.agent.ranges ?? [];
  return (
    <div class="feed-entry explorer-entry">
      <div
        class="tool-row explorer-row"
        classList={{ [`tool-${props.agent.state}`]: true }}
      >
        <span class="tool-glyph">
          <Switch fallback={<Icon name="search" size={12} />}>
            <Match when={running()}>
              <Loader id="sift" size={12} />
            </Match>
            <Match when={props.agent.state === 'error'}>
              <Icon name="close" size={12} />
            </Match>
            <Match when={props.agent.state === 'cancelled'}>
              <Icon name="stop" size={12} />
            </Match>
          </Switch>
        </span>
        <span class="tool-row-title">{running() ? 'Exploring' : 'Explored'}</span>
        <span class="tool-row-detail">{question()}</span>
        <Show when={complete() && props.agent.tokens}>
          <span class="explorer-tokens">{formatTokens(props.agent.tokens!)}</span>
        </Show>
      </div>
      <Show when={feature('agents.explorerRanges')}>
        <Collapse open={complete() && ranges().length > 0}>
          <div class="explorer-ranges-slot">
            <div class="explorer-ranges">
              <For each={ranges()}>{range => <RangeChip range={range} />}</For>
            </div>
          </div>
        </Collapse>
      </Show>
    </div>
  );
}
