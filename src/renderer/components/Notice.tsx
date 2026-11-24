/**
 * The notice row at the top of the content column (engine errors, and any one-line app notice).
 *
 *   <Notice notice={{ message, tone: 'error', action: { label, run } }} onDismiss={…} onProgress={…} />
 *   <EngineNotice onProgress={…} />   the engine's last error (store engineError), dismiss clears it
 *
 * One line: a tone glyph (the only coloured part), the message, an optional text action (e.g. a progress task's
 * Cancel, which can be disabled while it takes effect) and a dismiss button,
 * on the raised surface with the app's control radius. It enters and leaves on the Panel spring: the row's
 * height opens (onProgress reports 0..1 so the Shell moves the content below with it, no jump) while the bar
 * slides down a few px and fades in. A new notice replaces the old one in place: the old line slides up and
 * fades out while the new one slides in, in the same bar. Reduced motion: no slide, height snaps, fades only.
 *
 * A notice with the same `key` as the line on screen updates that line in place instead (a progress task
 * moving on): the loader morphs (e.g. 'pull' → 'done'), the text retypes, and the thin determinate bar under
 * the text springs to the new percent. The bar fills to the end and fades once percent reaches 100 or goes away.
 *
 *   <EngineNotice onProgress={…} />   the engine's last error first, else the newest progress task (ProgressNotice)
 */
import { createEffect, createSignal, For, on, onCleanup, Show, type Accessor, type JSX } from 'solid-js';
import { prefersReducedMotion, Spring } from '../motion';
import { RetypeText } from '../motion/organic';
import { engineError, setEngineError } from '../store';
import { Button, IconButton } from './Button';
import { Loader, type LoaderShape } from './loaders';
import { useProgressNotice } from './ProgressNotice';
import { useToolpackUpdateNotice } from './ToolpackUpdateNotice';
import './notice.css';

export type NoticeTone = 'error' | 'warning' | 'info';

export interface NoticeData {
  message: string;
  tone?: NoticeTone;
  /** A text action at the end of the line; `disabled` greys it out (e.g. 'Cancelling…' while a cancel is pending). */
  action?: { label: string; run: () => void; disabled?: boolean };
  /** A second text action, before `action` (e.g. Review before Update). */
  secondaryAction?: { label: string; run: () => void; disabled?: boolean };
  /** Same key as the line on screen: update it in place rather than sliding a new line in. */
  key?: string;
  /** Muted text after the message. */
  detail?: string;
  /** A loader or status glyph in place of the tone glyph; it morphs when it changes. */
  loader?: LoaderShape;
  /** 0-100: a thin determinate bar under the text. */
  percent?: number;
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
  notice: Accessor<NoticeData>;
  setNotice: (notice: NoticeData) => void;
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
  const notice = () => props.layer.notice();
  const tone = () => notice().tone ?? 'error';
  const fullText = () => (notice().detail ? `${notice().message} · ${notice().detail}` : notice().message);
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
      <Show when={notice().loader} fallback={<ToneGlyph tone={tone()} />}>
        <Loader id={notice().loader} size={14} class="notice-glyph notice-loader" />
      </Show>
      <span class="notice-text" title={fullText()}>
        <span class="notice-message">
          <RetypeText value={notice().message} speed="fast" data-motion="notice-message" />
        </span>
        <Show when={notice().detail}>
          {detail => (
            <span class="notice-detail">
              <RetypeText value={detail()} speed="fast" data-motion="notice-detail" />
            </span>
          )}
        </Show>
      </span>
      <Show when={notice().secondaryAction}>
        {action => (
          <Button
            variant="text"
            class="notice-action notice-action-secondary"
            tabIndex={props.layer.leaving() ? -1 : undefined}
            disabled={action().disabled}
            onClick={() => action().run()}
          >
            {action().label}
          </Button>
        )}
      </Show>
      <Show when={notice().action}>
        {action => (
          <Button
            variant="text"
            class="notice-action"
            tabIndex={props.layer.leaving() ? -1 : undefined}
            disabled={action().disabled}
            onClick={() => action().run()}
          >
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
    // Same key as the line on screen: the line itself moves on (loader morph, retyped text).
    const current = layers().filter(item => !item.leaving()).at(-1);
    if (notice.key && current && current.notice().key === notice.key) {
      current.setNotice(notice);
      current.presence.set(1, token);
      return;
    }
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
    const [layerNotice, setLayerNotice] = createSignal(notice);
    const layer: Layer = {
      id: nextLayerId,
      notice: layerNotice,
      setNotice: setLayerNotice,
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

  // The determinate bar: width and opacity on their own springs. It appears at the task's percent (from empty
  // when it was hidden), follows each update, and once full (or when percent goes away) fades out.
  let meter: HTMLDivElement | undefined;
  let meterFill: HTMLDivElement | undefined;
  const meterWidth = new Spring(0, 'panel', 0.01);
  const meterOpacity = new Spring(0, 'control', 0.01);
  const applyMeterWidth = (value: number) => {
    if (meterFill) meterFill.style.transform = `scaleX(${Math.max(0, Math.min(1, value))})`;
  };
  const applyMeterOpacity = (value: number) => {
    if (meter) meter.style.opacity = String(Math.max(0, Math.min(1, value)));
  };
  meterWidth.onChange(applyMeterWidth);
  meterOpacity.onChange(applyMeterOpacity);
  meterWidth.onRest(value => {
    if (value >= 0.999) meterOpacity.set(0, 'exit');
  });
  createEffect(on(() => props.notice?.percent, percent => {
    if (percent === undefined) {
      meterOpacity.set(0, 'exit');
      return;
    }
    const target = Math.max(0, Math.min(100, percent)) / 100;
    if (meterOpacity.value < 0.05) meterWidth.jump(0);
    if (target < 0.999) meterOpacity.set(1, 'control');
    if (prefersReducedMotion()) {
      meterWidth.jump(target);
      if (target >= 0.999) meterOpacity.set(0, 'control');
    } else {
      meterWidth.set(target, 'panel');
    }
  }));

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
    meterWidth.stop();
    meterOpacity.stop();
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
          <div
            ref={element => {
              meter = element;
              applyMeterOpacity(meterOpacity.value);
            }}
            class="notice-meter"
            aria-hidden="true"
          >
            <div
              ref={element => {
                meterFill = element;
                applyMeterWidth(meterWidth.value);
              }}
              class="notice-meter-fill"
            />
          </div>
          <IconButton icon="close" label="Dismiss" size="small" class="notice-dismiss" onClick={() => props.onDismiss()} />
        </div>
      </Show>
    </div>
  );
}

/**
 * The engine's last error as a notice, else the newest progress task, else toolpack updates (ToolpackUpdateNotice);
 * dismissing clears whichever is shown.
 */
export function EngineNotice(props: { onProgress?: (progress: number) => void }): JSX.Element {
  const progressNotice = useProgressNotice();
  const updateNotice = useToolpackUpdateNotice();
  const notice = (): NoticeData | undefined => {
    const message = engineError();
    if (message) return { message, tone: 'error', key: `engine-error:${message}` };
    return progressNotice.notice() ?? updateNotice.notice();
  };
  const dismiss = () => {
    if (engineError()) setEngineError(undefined);
    else if (progressNotice.notice()) progressNotice.dismiss();
    else updateNotice.dismiss();
  };
  return <Notice notice={notice()} onDismiss={dismiss} onProgress={props.onProgress} />;
}
