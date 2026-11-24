/**
 * "No questions" (feature agents.noQuestions, toggled with `/noquestions`) as a compact bar by the composer.
 *
 *   <NoQuestionsBar />     shown in every chat and on Home while it is on
 *
 * One row: label, then Turn off. While it is on, an agent that tries to ask a question gets its call denied
 * and is told to use its best judgement and list its assumptions (src/engine/extension.ts askQuestions).
 * Nothing (and no gap) while it is off. Reuses the shutdown bar's card styles.
 */
import { type JSX } from 'solid-js';
import { Button } from '../../components';
import { Collapse } from '../../motion';
import { feature, setFeature } from '../../store/features';
import './shutdown-bar.css';

export function NoQuestionsBar(): JSX.Element {
  return (
    <Collapse open={feature('agents.noQuestions')} class="shutdown-bar-slot">
      <div class="shutdown-bar-frame">
        <div class="shutdown-bar" role="status">
          <span class="shutdown-bar-label">No questions: agents decide and state their assumptions</span>
          <Button class="shutdown-bar-cancel" onClick={() => setFeature('agents.noQuestions', false)}>
            Turn off
          </Button>
        </div>
      </div>
    </Collapse>
  );
}
