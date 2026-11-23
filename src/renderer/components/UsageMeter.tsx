/**
 * The slim usage meter in the rail (spec › Usage): a 20×4 stacked bar of every account's share (DSH's maths in
 * store/usage.ts) with the combined percent below. Clicking opens the usage popover with one row per account.
 */
import { createSignal, For, Index, Show, type JSX } from 'solid-js';
import { post } from '../bridge';
import { createSpring, pressable } from '../motion';
import { clampPercent, resetColor, resetIn, usageSummary } from '../store/usage';
import { providerNames } from '../store/providers';
import { IconButton } from './Button';
import { Popover } from './Popover';
import './usage.css';

function StackedBar(props: { class: string }): JSX.Element {
  return (
    <div class={`usage-bar ${props.class}`}>
      {/* Index keeps one spring per position, so a usage update glides instead of re-creating segments. */}
      <Index each={usageSummary().entries}>
        {entry => {
          const width = createSpring(() => entry().width, 'panel', { precision: 10 });
          return <span class="usage-segment" style={{ width: `${clampPercent(width())}%`, background: entry().color }} />;
        }}
      </Index>
    </div>
  );
}

export function UsageMeter(): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [anchor, setAnchor] = createSignal<HTMLButtonElement>();
  const summary = usageSummary;

  return (
    <>
      <button
        type="button"
        class="usage-meter"
        ref={element => {
          setAnchor(element);
          pressable(element);
        }}
        aria-label={`AI usage ${summary().combined}%`}
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <StackedBar class="usage-bar-slim" />
        <span class="usage-percent type-caption">{summary().entries.length ? `${summary().combined}%` : '–'}</span>
      </button>
      <Popover anchor={anchor()} open={open()} onClose={() => setOpen(false)} placement="right-end" offset={10} class="usage-popover">
        <div class="usage-header">
          <span class="type-heading">Usage</span>
          <span class="usage-combined">{summary().combined}%</span>
          <IconButton icon="refresh" label="Refresh usage" size="small" onClick={() => post({ type: 'refreshUsage' })} />
        </div>
        <StackedBar class="usage-bar-wide" />
        <Show
          when={summary().entries.length}
          fallback={<div class="usage-empty type-label">No account reports usage yet.</div>}
        >
          <div class="usage-rows">
            <For each={summary().entries}>
              {entry => (
                <div class="usage-row">
                  <span class="usage-swatch" style={{ background: entry.color }} />
                  <span class="usage-account">
                    <span class="usage-name">{entry.account.label}</span>
                    <span class="usage-detail type-caption">
                      {providerNames[entry.account.provider] || entry.account.provider} · {entry.binding.label}
                    </span>
                  </span>
                  <span class="usage-values">
                    <span class="usage-used">{Math.round(entry.used)}%</span>
                    <Show when={resetIn(entry.binding.resetsAt)}>
                      {text => (
                        <span class="usage-reset type-caption" style={{ color: resetColor(entry.binding.resetsAt!) }}>
                          resets in {text()}
                        </span>
                      )}
                    </Show>
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={summary().missing}>
          <div class="usage-missing type-caption">
            {summary().missing} account{summary().missing === 1 ? '' : 's'} without usage yet
          </div>
        </Show>
      </Popover>
    </>
  );
}
