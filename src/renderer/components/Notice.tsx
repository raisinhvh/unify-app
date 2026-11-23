/**
 * The notice row at the top of the content column (engine errors, and any one-line app notice).
 *
 *   <Notice notice={{ message, tone: 'error', action: { label, run } }} onDismiss={…} onProgress={…} />
 *   <EngineNotice onProgress={…} />   the engine's last error (store engineError), dismiss clears it
 *
 * One line: a tone glyph (the only coloured part), the message, an optional text action and a dismiss button,
 * on the raised surface with the app's control radius. It enters and leaves on the Panel spring: the row's
 * height opens (onProgress reports 0..1 so the Shell moves the content below with it, no jump) while the bar
 * slides down a few px and fades in. A new notice replaces the old one in place: the old line slides up and
 * fades out while the new one slides in, in the same bar. Reduced motion: no slide, height snaps, fades only.
 */
import { createEffect, createSignal, For, on, onCleanup, Show, type Accessor, type JSX } from 'solid-js';
import { prefersReducedMotion, Spring } from '../motion';
import { engineError, setEngineError } from '../store';
import { Button, IconButton } from './Button';
import './notice.css';

export type NoticeTone = 'error' | 'warning' | 'info';

export interface NoticeData {
  message: string;
  tone?: NoticeTone;
  action?: { label: string; run: () => void };
}

export interface NoticeProps {
  notice: NoticeData | undefined;
  onDismiss: () => void;
  /** 0 (closed) to 1 (open), every frame while the row opens or closes. */
  onProgress?: (progress: number) => void;
}

/** How far a line or the bar travels while it fades, in px. */
const slideDistance = 6;

interface Layer {
  id: number;
  notice: NoticeData;
  /** 0 = gone, 1 = settled. */
  presence: Spring;
  /** True once a newer notice replaced this line: it slides up instead of down. */
  leaving: Accessor<boolean>;
  setLeaving: (leaving: boolean) => void;
  /** Presence and travel when it started leaving, so the turn from entering to leaving never jumps. */
  leaveFrom: { presence: number; travel: number };
}

/** Vertical travel of a line: enters from below, leaves upward, continuous when it turns around mid-way. */
function lineTravel(layer: Layer, presence: number): number {
  if (prefersReducedMotion()) return 0;
  if (!layer.leaving()) return (1 - presence) * slideDistance;
  const { presence: startPresence, travel: startTravel } = layer.leaveFrom;
  if (startPresence <= 0) return -slideDistance;
  const amount = Math.max(0, Math.min(1, presence / startPresence));
  return -slideDistance + (startTravel + slideDistance) * amount;
}

function ToneGlyph(props: { tone: NoticeTone }): JSX.Element {
  // Drawn like the loaders: a square frame with a bar and a dot (16 units).
  return (
    <svg class={`notice-glyph notice-glyph-${props.tone}`} width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.333" />
      <Show
        when={props.tone !== 'info'}
        fallback={
          <>
            <rect x="7.25" y="4.5" width="1.5" height="1.5" rx="0.5" fill="currentColor" />
            <rect x="7.25" y="7" width="1.5" height="4.5" rx="0.5" fill="currentColor" />
          </>
        }
      >
        <rect x="7.25" y="4.5" width="1.5" height="4.5" rx="0.5" fill="currentColor" />
        <rect x="7.25" y="10" width="1.5" height="1.5" rx="0.5" fill="currentColor" />
      </Show>
    </svg>
  );
}

function NoticeLine(props: { layer: Layer }): JSX.Element {
  let element!: HTMLDivElement;
  const apply = (value: number) => {
    if (!element) return;
    const clamped = Math.max(0, Math.min(1, value));
    const travel = lineTravel(props.layer, clamped);
    element.style.opacity = String(clamped);
    element.style.transform = `translateY(${travel}px)`;
  };
  const stopListening = props.layer.presence.onChange(apply);
  onCleanup(stopListening);
  const tone = () => props.layer.notice.tone ?? 'error';
  return (
    <div
      ref={line => {
        element = line;
        apply(props.layer.presence.value);
      }}
      class="notice-line"
      classList={{ leaving: props.layer.leaving() }}
      aria-hidden={props.layer.leaving() ? 'true' : undefined}
    >
      <ToneGlyph tone={tone()} />
      <span class="notice-message" title={props.layer.notice.message}>
        {props.layer.notice.message}
      </span>
      <Show when={props.layer.notice.action}>
        {action => (
          <Button variant="text" class="notice-action" tabIndex={props.layer.leaving() ? -1 : undefined} onClick={() => action().run()}>
            {action().label}
          </Button>
        )}
      </Show>
    </div>
  );
}

export function Notice(props: NoticeProps): JSX.Element {
  let slot!: HTMLDivElement;
  let bar!: HTMLDivElement;
  const [layers, setLayers] = createSignal<Layer[]>([]);
  const [open, setOpen] = createSignal(false);
  const progress = new Spring(0, 'panel', 1);
  const fade = new Spring(0, 'panel', 1);
  let nextLayerId = 1;

  const applyProgress = (value: number) => {
    const clamped = Math.max(0, Math.min(1, value));
    if (slot) slot.style.setProperty('--notice-progress', String(clamped));
    props.onProgress?.(clamped);
  };
  const applyFade = (value: number) => {
    if (!bar) return;
    const clamped = Math.max(0, Math.min(1, value));
    const travel = prefersReducedMotion() ? 0 : (clamped - 1) * slideDistance;
    bar.style.opacity = String(clamped);
    bar.style.transform = `translateY(${travel}px)`;
  };
  progress.onChange(applyProgress);
  fade.onChange(applyFade);
  fade.onRest(value => {
    if (value === 0 && !props.notice) {
      for (const layer of layers()) layer.presence.stop();
      setLayers([]);
      setOpen(false);
    }
  });

  const addLayer = (notice: NoticeData, animate: boolean) => {
    const token = prefersReducedMotion() ? 'control' : 'panel';
    // The line on screen slides up and out from wherever it is; lines already leaving keep going.
    for (const item of layers()) {
      if (!item.leaving()) {
        const presence = Math.max(0, Math.min(1, item.presence.value));
        item.leaveFrom = { presence, travel: lineTravel(item, presence) };
        item.setLeaving(true);
      }
      item.presence.set(0, token);
    }
    const [leaving, setLeaving] = createSignal(false);
    const layer: Layer = {
      id: nextLayerId,
      notice,
      presence: new Spring(animate ? 0 : 1, 'panel', 1),
      leaving,
      setLeaving,
      leaveFrom: { presence: 1, travel: 0 },
    };
    nextLayerId += 1;
    layer.presence.onRest(value => {
      if (value === 0 && layer.leaving()) setLayers(current => current.filter(item => item !== layer));
    });
    setLayers(current => [...current, layer]);
    if (animate) layer.presence.set(1, token);
  };

  createEffect(on(() => props.notice, notice => {
    const reduced = prefersReducedMotion();
    if (notice) {
      // Replacing a line already on screen (or still fading out) morphs it; a fresh row brings its line with it.
      const replacing = layers().length > 0;
      setOpen(true);
      addLayer(notice, replacing);
      if (reduced) progress.jump(1);
      else progress.set(1, 'panel');
      fade.set(1, reduced ? 'control' : 'panel');
      return;
    }
    if (reduced) progress.jump(0);
    else progress.set(0, 'panel');
    fade.set(0, reduced ? 'control' : 'exit');
  }));

  onCleanup(() => {
    progress.stop();
    fade.stop();
    for (const layer of layers()) layer.presence.stop();
  });

  return (
    <div
      ref={element => {
        slot = element;
        applyProgress(progress.value);
      }}
      class="notice-slot"
      inert={!props.notice}
    >
      <Show when={open()}>
        <div
          ref={element => {
            bar = element;
            applyFade(fade.value);
          }}
          class="notice"
          role={props.notice?.tone === 'info' ? 'status' : 'alert'}
        >
          <div class="notice-lines">
            <For each={layers()}>{layer => <NoticeLine layer={layer} />}</For>
          </div>
          <IconButton icon="close" label="Dismiss" size="small" class="notice-dismiss" onClick={() => props.onDismiss()} />
        </div>
      </Show>
    </div>
  );
}

/** The engine's last error as a notice; dismissing clears it. */
export function EngineNotice(props: { onProgress?: (progress: number) => void }): JSX.Element {
  const notice = (): NoticeData | undefined => {
    const message = engineError();
    return message ? { message, tone: 'error' } : undefined;
  };
  return <Notice notice={notice()} onDismiss={() => setEngineError(undefined)} onProgress={props.onProgress} />;
}
