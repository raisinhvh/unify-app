/**
 * The slim usage meter in the rail (spec › Usage): a 20×4 stacked bar of every account's share (DSH's maths in
 * store/usage.ts) with the combined percent below. Clicking opens the usage popover with one row per account.
 */
import { createSignal, For, Index, Show, type JSX } from 'solid-js';
import { post } from '../bridge';
import { createSpring, pressable } from '../motion';
import { RollingNumber } from '../motion/organic';
import { navigate } from '../router';
import { select as selectProvider } from '../screens/providers/selection';
import { clampPercent, resetColor, resetIn, usageSummary, type UsageEntry } from '../store/usage';
import { providerNames } from '../store/providers';
import { IconButton } from './Button';
import { Popover } from './Popover';
import { ProviderGlyph } from './ProviderGlyph';
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

/**
 * Providers › that account: its page holds the per-limit usage bars. Only the in-app view; the engine's
 * `openProviderUsage` would also open the provider's dashboard in the browser.
 */
function openAccountUsage(accountId: string): void {
  selectProvider({ kind: 'account', id: accountId });
  navigate('providers');
}

/** Time until the limit resets ("32m", "1d 23h"), "now" once it is due, nothing when unknown. */
function resetLabel(at: number | undefined): string {
  if (!at) return '';
  return resetIn(at) || 'now';
}

/**
 * One account: its provider logo in the account's bar colour (the legend for the stacked bar), the account name,
 * then the percent used and the time until it resets. The whole row opens the account in Providers.
 */
function UsageRow(props: { entry: UsageEntry; onOpen: () => void }): JSX.Element {
  const provider = () => providerNames[props.entry.account.provider] || props.entry.account.provider;
  const reset = () => resetLabel(props.entry.binding.resetsAt);
  return (
    <button
      type="button"
      class="usage-row"
      ref={element => pressable(element, 0.98)}
      aria-label={`${props.entry.account.label}, ${provider()} ${props.entry.binding.label}, ${Math.round(props.entry.used)}% used${reset() ? `, resets ${reset() === 'now' ? 'now' : `in ${reset()}`}` : ''}. Open in Providers`}
      onClick={() => props.onOpen()}
    >
      <span class="usage-glyph" style={{ color: props.entry.color }}>
        <ProviderGlyph provider={props.entry.account.provider} size={14} />
      </span>
      <span class="usage-name">{props.entry.account.label}</span>
      <span class="usage-used">
        <RollingNumber value={`${Math.round(props.entry.used)}%`} />
      </span>
      <span
        class="usage-reset type-caption"
        style={{ color: props.entry.binding.resetsAt ? resetColor(props.entry.binding.resetsAt) : undefined }}
      >
        {reset()}
      </span>
    </button>
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
        <span class="usage-percent type-caption">
          <RollingNumber value={summary().entries.length ? `${summary().combined}%` : '–'} data-motion="rail-usage" />
        </span>
      </button>
      <Popover anchor={anchor()} open={open()} onClose={() => setOpen(false)} placement="right-end" offset={10} class="usage-popover">
        <div class="usage-header">
          <span class="type-heading">Usage</span>
          <span class="usage-combined">
            <RollingNumber value={`${summary().combined}%`} />
          </span>
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
                <UsageRow
                  entry={entry}
                  onOpen={() => {
                    setOpen(false);
                    openAccountUsage(entry.account.id);
                  }}
                />
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
