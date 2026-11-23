/**
 * "Finish setup" for one installed pack (screens/toolpacks/setup.ts): shown in the Hub right after an install
 * and in the Toolpacks pack detail.
 *
 *   <SetupChecklist id={pack.id} />
 *
 *   header   "Finish setup" + "1 of 2 done"; once every step is done it becomes the single done line
 *            "Setup complete", and the steps fold away (Show steps opens them again)
 *   step     status glyph (manual steps: the glyph is the tick box), title, muted detail, the failure reason,
 *            Copy (clipboard, the label morphs to "Copied" for a moment) and Open (the engine opens it)
 *   footer   Check again (recheck), Run setup again (only when the pack's script can run again), last error
 *
 * Motion: the tick draws its check and fills on a Control spring, the header retypes, the step list folds on
 * the Panel spring (Collapse). Reduced motion: the springs settle at once, the fold fades.
 */
import { createSignal, Index, onCleanup, Show, type JSX } from 'solid-js';
import { Button } from '../../components';
import { Collapse, createSpring, pressable } from '../../motion';
import { RetypeText, RollingNumber } from '../../motion/organic';
import type { PackSetupStep } from '../../protocol';
import { runSetupAction, setupBusy, setupError, setupFor } from './setup';
import './setup.css';

/** How long "Copied" stays before the label turns back. */
const copiedMs = 1400;

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
    document.body.appendChild(field);
    field.select();
    document.execCommand('copy');
    field.remove();
  }
}

/** Square box like the notice glyphs: the check draws in and the box fills as `done` springs to 1. */
function StepGlyph(props: { status: PackSetupStep['status'] }): JSX.Element {
  const done = createSpring(() => (props.status === 'done' ? 1 : 0), 'control');
  const checkLength = 12;
  return (
    <svg class={`tp-setup-glyph status-${props.status}`} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect
        class="tp-setup-box"
        x="2.5"
        y="2.5"
        width="11"
        height="11"
        rx="2"
        style={{ 'fill-opacity': String(done() * 0.18) }}
      />
      <Show
        when={props.status !== 'failed'}
        fallback={
          <>
            <rect x="7.25" y="4.75" width="1.5" height="4" rx="0.5" class="tp-setup-mark" />
            <rect x="7.25" y="9.75" width="1.5" height="1.5" rx="0.5" class="tp-setup-mark" />
          </>
        }
      >
        <path
          class="tp-setup-check"
          d="M5 8.25 L7.1 10.25 L11 5.75"
          pathLength={checkLength}
          style={{ 'stroke-dasharray': String(checkLength), 'stroke-dashoffset': String((1 - done()) * checkLength), opacity: String(Math.min(1, done() * 3)) }}
        />
      </Show>
    </svg>
  );
}

function CopyButton(props: { text: string; title: string }): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  let timer = 0;
  onCleanup(() => window.clearTimeout(timer));
  return (
    <Button
      variant="text"
      class="tp-setup-action"
      title={props.text}
      aria-label={copied() ? 'Copied' : `Copy for ${props.title}`}
      onClick={() => {
        void copyText(props.text);
        setCopied(true);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => setCopied(false), copiedMs);
      }}
    >
      <span class="tp-setup-copy-label" classList={{ copied: copied() }}>
        <RetypeText value={copied() ? 'Copied' : 'Copy'} speed="fast" effect="rename" data-motion="setup-copy" />
      </span>
    </Button>
  );
}

function StepRow(props: { packId: string; step: PackSetupStep }): JSX.Element {
  const manual = () => props.step.kind === 'manual';
  const done = () => props.step.status === 'done';
  const toggle = () => runSetupAction(props.packId, done() ? 'markTodo' : 'markDone', props.step.id);
  return (
    <div class="tp-setup-step" classList={{ done: done(), failed: props.step.status === 'failed' }}>
      <Show
        when={manual()}
        fallback={
          <span class="tp-setup-tick static" title={done() ? 'Done by the install script' : props.step.status === 'failed' ? 'Failed' : 'Not done yet'}>
            <StepGlyph status={props.step.status} />
          </span>
        }
      >
        <button
          type="button"
          class="tp-setup-tick"
          role="checkbox"
          aria-checked={done()}
          aria-label={`${props.step.title}: ${done() ? 'done' : 'not done'}`}
          ref={element => pressable(element, 0.9)}
          onClick={toggle}
        >
          <StepGlyph status={props.step.status} />
        </button>
      </Show>
      <div class="tp-setup-text">
        <span class="tp-setup-title">{props.step.title}</span>
        <Show when={props.step.detail}>
          <span class="tp-setup-detail">{props.step.detail}</span>
        </Show>
        <Show when={props.step.status === 'failed' && props.step.error}>
          <span class="tp-setup-error">{props.step.error}</span>
        </Show>
        <Show when={props.step.copy}>
          <code class="tp-setup-path type-mono" title={props.step.copy}>{props.step.copy}</code>
        </Show>
      </div>
      <div class="tp-setup-actions">
        <Show when={props.step.copy}>
          {text => <CopyButton text={text()} title={props.step.title} />}
        </Show>
        <Show when={props.step.open}>
          <Button
            variant="text"
            class="tp-setup-action"
            title={props.step.open}
            onClick={() => runSetupAction(props.packId, 'open', props.step.id)}
          >
            Open
          </Button>
        </Show>
      </div>
    </div>
  );
}

export function SetupChecklist(props: { id: string }): JSX.Element {
  const setup = () => setupFor(props.id);
  const [showSteps, setShowSteps] = createSignal(false);
  const complete = () => (setup()?.pending ?? 0) === 0;
  const doneCount = () => (setup()?.steps.filter(step => step.status === 'done').length ?? 0);
  const busy = () => setupBusy(props.id);
  return (
    <Show when={setup()?.steps.length}>
      <section class="tp-setup" classList={{ complete: complete() }} aria-label={`${setup()!.name} setup`}>
        <header class="tp-setup-header">
          <span class="tp-setup-header-glyph" aria-hidden="true">
            <StepGlyph status={complete() ? 'done' : 'todo'} />
          </span>
          <h2 class="tp-setup-heading">
            <RetypeText value={complete() ? 'Setup complete' : 'Finish setup'} speed="fast" data-motion="setup-heading" />
          </h2>
          <span class="tp-setup-count type-caption">
            <RollingNumber value={doneCount()} /> of <RollingNumber value={setup()!.steps.length} /> done
          </span>
          <span class="tp-setup-spacer" />
          <Show when={complete()}>
            <Button variant="text" class="tp-setup-action" aria-expanded={showSteps()} onClick={() => setShowSteps(!showSteps())}>
              <RetypeText value={showSteps() ? 'Hide steps' : 'Show steps'} speed="fast" data-motion="setup-toggle" />
            </Button>
          </Show>
        </header>
        <Collapse open={!complete() || showSteps()}>
          <div class="tp-setup-body">
            <div class="tp-setup-steps">
              <Index each={setup()!.steps}>{step => <StepRow packId={props.id} step={step()} />}</Index>
            </div>
            <footer class="tp-setup-footer">
              <span class="tp-setup-footer-error" role={setupError(props.id) ? 'alert' : undefined}>
                {setupError(props.id) ?? ''}
              </span>
              <Button
                variant="text"
                icon="refresh"
                class="tp-setup-action"
                disabled={!!busy()}
                onClick={() => runSetupAction(props.id, 'recheck')}
              >
                <RetypeText value={busy() === 'recheck' ? 'Checking…' : 'Check again'} speed="fast" data-motion="setup-recheck" />
              </Button>
              <Show when={setup()!.canRerunScript}>
                <Button
                  variant="text"
                  class="tp-setup-action"
                  disabled={!!busy()}
                  onClick={() => runSetupAction(props.id, 'rerunScript')}
                >
                  <RetypeText value={busy() === 'rerunScript' ? 'Running setup…' : 'Run setup again'} speed="fast" data-motion="setup-rerun" />
                </Button>
              </Show>
            </footer>
          </div>
        </Collapse>
      </section>
    </Show>
  );
}
