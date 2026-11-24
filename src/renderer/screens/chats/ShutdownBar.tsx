/**
 * "Shut down when all tasks finish", armed with `/shutdown`, as a compact bar by the composer.
 *
 *   <ShutdownBar />     shown in every chat and on Home while the shutdown is armed
 *
 * One row: power glyph, "Shutting down on finish" (or the live countdown once every task is idle), then Cancel.
 * Cancel posts `cancelShutdown`, which disarms whether it is still waiting or already counting down.
 * Nothing (and no gap) while it is not armed.
 *
 * Motion: the bar opens and closes with Collapse (Reveal spring), like ScheduleBar.
 */
import { type JSX } from 'solid-js';
import { Button } from '../../components';
import { PowerGlyph } from '../../components/TitleBar';
import { Collapse } from '../../motion';
import { post } from '../../bridge';
import { viewState } from '../../store';
import './shutdown-bar.css';

function label(): string {
  const shutdown = viewState.shutdown;
  if (shutdown?.phase === 'countdown') return `Shutting down in ${shutdown.secondsLeft ?? 0}s`;
  if (shutdown?.phase === 'shuttingDown') return 'Shutting down…';
  return 'Shutting down on finish';
}

export function ShutdownBar(): JSX.Element {
  const armed = () => viewState.shutdown?.armed === true;
  const counting = () => viewState.shutdown?.phase === 'countdown';

  return (
    <Collapse open={armed()} class="shutdown-bar-slot">
      <div class="shutdown-bar-frame">
        <div class="shutdown-bar" classList={{ counting: counting() }} role="status">
          <span class="shutdown-bar-glyph">
            <PowerGlyph size={12} />
          </span>
          <span class="shutdown-bar-label">{label()}</span>
          <Button class="shutdown-bar-cancel" onClick={() => post({ type: 'cancelShutdown' })}>
            Cancel
          </Button>
        </div>
      </div>
    </Collapse>
  );
}
