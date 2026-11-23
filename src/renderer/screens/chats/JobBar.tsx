/**
 * The /job bar at the top of a chat (port of DSH media/sidebar.js renderJobBar).
 *
 *   <JobBar chatId={id} />      shows viewState.jobs[id]; nothing (and no gap) while the chat has no job
 *
 *   head      phase glyph, "Job round 2 of 10", the phase ("Reviewing"), "3/7 passing", chevron
 *   reason    why the job stopped or finished, under the head once it has
 *   criteria  expand: one row per acceptance criterion hanging off a guide line: status glyph, id, text,
 *             source tag, the check command, and the reviewer's evidence
 *
 * Stopping a job is the composer's stop button (cancel); the bar only shows state.
 *
 * Motion: the bar reveals and collapses with the Reveal spring (Collapse), the criteria open the same way and the
 * chevron turns on the Indicator spring. Status glyphs never swap: the loader morphs between action loaders and
 * the done check, and the pending box, fail cross and stop square crossfade and scale in their shared cell.
 * The round and passing counts roll (RollingNumber); the phase label retypes (RetypeText, fast).
 */
import { createMemo, createSignal, Show, type JSX } from 'solid-js';
import { Icon, Loader, actionLoader, type LoaderShape } from '../../components';
import { AnimatedList, Collapse, createSpring } from '../../motion';
import { RetypeText, RollingNumber } from '../../motion/organic';
import type { SidebarJob } from '../../protocol';
import { viewState } from '../../store';
import './job-bar.css';

type JobPhase = SidebarJob['phase'];
type JobCriterion = SidebarJob['criteria'][number];

/** Same words as DSH's jobPhaseLabel. */
const phaseLabel: Record<JobPhase, string> = {
  draft: 'Drafting',
  work: 'Working',
  verify: 'Reviewing',
  done: 'Done',
  stopped: 'Stopped',
};

/** A mark drawn in the glyph cell when no loader shape fits. */
type GlyphMark = 'pending' | 'fail' | 'stop';

interface GlyphState {
  loader?: LoaderShape;
  mark?: GlyphMark;
}

function phaseGlyph(phase: JobPhase): GlyphState {
  if (phase === 'draft') return { loader: actionLoader.planning };
  if (phase === 'work') return { loader: actionLoader.other };
  if (phase === 'verify') return { loader: actionLoader.testing };
  if (phase === 'done') return { loader: 'done' };
  return { mark: 'stop' };
}

/** While the reviewer runs, every criterion not yet passing shows the testing loader. */
function criterionGlyph(criterion: JobCriterion, phase: JobPhase): GlyphState {
  if (criterion.status === 'pass') return { loader: 'done' };
  if (phase === 'verify') return { loader: actionLoader.testing };
  if (criterion.status === 'fail') return { mark: 'fail' };
  return { mark: 'pending' };
}

/** 'answer:2' (decision 2) reads "answer 2"; 'spec' and 'checklist' stay as they are. */
function sourceLabel(source: string): string {
  const answer = /^answer:(\d+)$/.exec(source);
  return answer ? `answer ${answer[1]}` : source;
}

/** One mark layer: fades and scales in its cell when it becomes (or stops being) the shown mark. */
function GlyphMarkLayer(props: { shown: boolean; mark: GlyphMark }): JSX.Element {
  const opacity = createSpring(() => (props.shown ? 1 : 0), 'control', { fadeOnly: true });
  const scale = createSpring(() => (props.shown ? 1 : 0.6), 'reveal');
  return (
    <span
      class={`job-glyph-mark job-glyph-${props.mark}`}
      style={{ opacity: String(Math.max(0, Math.min(1, opacity()))), scale: String(scale()) }}
    >
      <Show when={props.mark === 'fail'}>
        <Icon name="close" size={12} />
      </Show>
      <Show when={props.mark === 'stop'}>
        <Icon name="stop" size={12} />
      </Show>
    </span>
  );
}

/** A 12px status cell: the loader (which morphs on its own) with the marks stacked over it. */
function JobGlyph(props: GlyphState): JSX.Element {
  return (
    <span class="job-glyph">
      <Loader id={props.loader} size={12} />
      <GlyphMarkLayer shown={props.mark === 'pending'} mark="pending" />
      <GlyphMarkLayer shown={props.mark === 'fail'} mark="fail" />
      <GlyphMarkLayer shown={props.mark === 'stop'} mark="stop" />
    </span>
  );
}

function CriterionRow(props: { criterion: JobCriterion; phase: JobPhase }): JSX.Element {
  const glyph = () => criterionGlyph(props.criterion, props.phase);
  return (
    <div class={`job-criterion job-criterion-${props.criterion.status}`}>
      <JobGlyph loader={glyph().loader} mark={glyph().mark} />
      <div class="job-criterion-main">
        <div class="job-criterion-line">
          <span class="job-criterion-id">{props.criterion.id}</span>
          <span class="job-criterion-text">{props.criterion.text}</span>
          <span class="job-criterion-source type-caption">{sourceLabel(props.criterion.source)}</span>
        </div>
        <Show when={props.criterion.check}>
          {check => <code class="job-criterion-check" title={check()}>{check()}</code>}
        </Show>
        <Collapse open={!!props.criterion.evidence}>
          <div class="job-criterion-evidence" title={props.criterion.evidence}>
            {props.criterion.evidence}
          </div>
        </Collapse>
      </div>
    </div>
  );
}

export function JobBar(props: { chatId: string }): JSX.Element {
  const live = () => viewState.jobs[props.chatId];
  // Keeps the last job while the bar collapses away after the engine clears it.
  const job = createMemo<SidebarJob | undefined>(previous => live() ?? previous);
  const [expanded, setExpanded] = createSignal(false);
  const chevron = createSpring(() => (expanded() ? 90 : 0), 'indicator', { precision: 100 });

  const passing = () => job()?.criteria.filter(criterion => criterion.status === 'pass').length ?? 0;
  const total = () => job()?.criteria.length ?? 0;
  const finished = () => job()?.phase === 'done' || job()?.phase === 'stopped';
  const stopReason = () => (finished() ? job()?.stopReason : undefined);

  return (
    <Collapse open={!!live()} class="job-bar-slot">
      <Show when={job()}>
        {current => (
          <div class="job-bar-frame">
            <div class="job-bar" classList={{ [`job-bar-${current().phase}`]: true }}>
              <button
                type="button"
                class="job-bar-head"
                aria-expanded={expanded()}
                aria-label={expanded() ? 'Collapse job details' : 'Expand job details'}
                onClick={() => setExpanded(!expanded())}
              >
                <JobGlyph loader={phaseGlyph(current().phase).loader} mark={phaseGlyph(current().phase).mark} />
                <span class="job-bar-title">
                  <span>Job</span>
                  <Show when={current().round > 0}>
                    <span class="job-bar-round">
                      <span>round</span>
                      <RollingNumber value={current().round} />
                      <span class="job-bar-of">of {current().maxRounds}</span>
                    </span>
                  </Show>
                </span>
                <span class="job-bar-phase">
                  <RetypeText value={phaseLabel[current().phase] ?? current().phase} speed="fast" />
                </span>
                <span class="job-bar-spacer" />
                <Show when={total() > 0}>
                  <span class="job-bar-counts">
                    <RollingNumber value={`${passing()}/${total()}`} />
                    <span class="job-bar-counts-word">passing</span>
                  </span>
                </Show>
                <Icon name="chevronRight" size={12} class="job-bar-chevron" style={{ rotate: `${chevron()}deg` }} />
              </button>
              <Collapse open={!!stopReason()}>
                <div class="job-bar-reason" classList={{ [`job-bar-reason-${current().phase}`]: true }}>
                  {stopReason()}
                </div>
              </Collapse>
              <Collapse open={expanded()}>
                <div class="job-criteria">
                  <Show
                    when={total() > 0}
                    fallback={<div class="job-criteria-empty type-caption">No criteria yet. The checklist appears once drafting ends.</div>}
                  >
                    <AnimatedList each={current().criteria} key={criterion => criterion.id} itemClass="job-criterion-slot">
                      {criterion => <CriterionRow criterion={criterion()} phase={current().phase} />}
                    </AnimatedList>
                  </Show>
                </div>
              </Collapse>
            </div>
          </div>
        )}
      </Show>
    </Collapse>
  );
}
