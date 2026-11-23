/**
 * "Shut down when done" switch for the usage popover (spec › Shut down when done). Same switch as
 * Settings › Power: it arms `power.shutdownWhenIdle` and shows the engine's live armed state.
 *
 *   <ShutdownArmRow />      a flat row under a hairline: label and status on the left, the switch on the right
 *
 * The switch knob rides its own spring (Toggle); the status line under the label is plain text.
 */
import { type JSX } from 'solid-js';
import { Toggle } from '../components';
import { setShutdownArmed, shutdownArmed, viewState } from '../store';
import './shell.css';

function statusText(): string {
  const shutdown = viewState.shutdown;
  if (shutdown?.phase === 'countdown') return `Shutting down in ${shutdown.secondsLeft ?? 0} s`;
  if (shutdownArmed()) return 'Armed, waiting for every task';
  return 'After every agent finishes';
}

export function ShutdownArmRow(): JSX.Element {
  const countingDown = () => viewState.shutdown?.phase === 'countdown';
  // A click anywhere on the row flips the switch, as on Settings rows.
  const onRowClick = (event: MouseEvent) => {
    if ((event.target as Element).closest('button')) return;
    setShutdownArmed(!shutdownArmed());
  };
  return (
    <div class="shutdown-arm-row" data-shutdown-arm onClick={onRowClick}>
      <div class="shutdown-arm-text">
        <span class="shutdown-arm-label">Shut down when done</span>
        <span class="shutdown-arm-status type-caption" classList={{ warn: countingDown() }}>{statusText()}</span>
      </div>
      <Toggle checked={shutdownArmed()} label="Shut down when all tasks finish" onChange={setShutdownArmed} />
    </div>
  );
}
