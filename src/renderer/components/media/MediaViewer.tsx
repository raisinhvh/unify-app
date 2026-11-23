/**
 * openMediaViewer({ items, index, origin }) shows one image of a group full size over the whole app.
 *
 * One shared overlay, mounted lazily on the body (theme variables live on the root element, so it is themed).
 * The image scales up out of its thumbnail (shared-element FLIP on the Sheet spring) while a dark scrim fades in;
 * closing (Esc, a click anywhere) returns it into the thumbnail it came from, which stays hidden while the image
 * is lifted out of it. Left / Right step through the group by crossfade. Interruptible: every motion is a spring
 * retargeted from where it is. Reduced motion: the image and scrim crossfade, nothing travels.
 *
 * Images without a thumbnail on screen (the "+K" ones of a strip) open and close with a soft scale and fade.
 */
import { createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { prefersReducedMotion, Spring } from '../../motion';
import { aspectOf, thumbSource, type MediaItem } from './media';
import './media.css';

export interface MediaViewerRequest {
  items: MediaItem[];
  index: number;
  /** Who sent the images, shown muted after the name ("Researcher"). */
  sender?: string | ((media: MediaItem) => string | undefined);
  /** The element showing image `index` now (a thumbnail or an expanded image), if any. */
  origin: (index: number) => HTMLElement | undefined;
}

const [request, setRequest] = createSignal<MediaViewerRequest>();
let hostMounted = false;

export function openMediaViewer(next: MediaViewerRequest): void {
  if (!next.items.length) {
    return;
  }
  if (!hostMounted) {
    hostMounted = true;
    const host = document.createElement('div');
    host.className = 'media-viewer-host';
    document.body.appendChild(host);
    render(() => <ViewerHost />, host);
  }
  setRequest({
    ...next,
    index: Math.max(0, Math.min(next.items.length - 1, next.index)),
  });
}

export function isMediaViewerOpen(): boolean {
  return request() !== undefined;
}

function ViewerHost(): JSX.Element {
  return (
    <Show
      when={request()}
      keyed
    >
      {current => (
        <Viewer
          request={current}
          onGone={() => {
            if (request() === current) {
              setRequest(undefined);
            }
          }}
        />
      )}
    </Show>
  );
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Offset {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

interface ViewerLayer {
  id: number;
  index: number;
}

interface LayerState {
  element: HTMLDivElement;
  fade: Spring;
  fit: Rect;
  /** Where its thumbnail is, relative to the fitted rect; undefined = no travel (scale and fade instead). */
  from: Offset | undefined;
}

/** Room kept free around the image: sides, top, and the caption underneath. */
const sideMargin = 48;
const topMargin = 40;
const bottomMargin = 64;

let nextLayerId = 1;

function Viewer(props: { request: MediaViewerRequest; onGone: () => void }): JSX.Element {
  let overlay!: HTMLDivElement;
  let scrim!: HTMLDivElement;
  let caption!: HTMLDivElement;
  const items = props.request.items;
  const [index, setIndex] = createSignal(props.request.index);
  const [closing, setClosing] = createSignal(false);
  const [layers, setLayers] = createSignal<ViewerLayer[]>([{ id: nextLayerId++, index: props.request.index }]);
  const progress = new Spring(0, 'sheet', 1);
  const states = new Map<number, LayerState>();
  let activeLayerId = layers()[0].id;
  let hiddenOrigin: HTMLElement | undefined;
  const previousFocus = document.activeElement as HTMLElement | null;

  const senderOf = (media: MediaItem) => {
    const sender = props.request.sender;
    return typeof sender === 'function' ? sender(media) : sender;
  };

  const originImage = (origin: HTMLElement | undefined) => {
    if (!origin) {
      return null;
    }
    return origin instanceof HTMLImageElement ? origin : origin.querySelector('img');
  };

  const fitFor = (itemIndex: number, image?: HTMLImageElement | null): Rect => {
    const media = items[itemIndex];
    const aspect = aspectOf(media, image ?? originImage(props.request.origin(itemIndex)));
    const maxWidth = Math.max(80, window.innerWidth - sideMargin * 2);
    const maxHeight = Math.max(80, window.innerHeight - topMargin - bottomMargin);
    let width = maxWidth;
    let height = width / aspect;
    if (height > maxHeight) {
      height = maxHeight;
      width = height * aspect;
    }
    // Never blow a small original up past its real size.
    if (media.width && media.height && width > media.width) {
      width = media.width;
      height = media.height;
    }
    return {
      left: Math.round((window.innerWidth - width) / 2),
      top: Math.round(topMargin + (window.innerHeight - topMargin - bottomMargin - height) / 2),
      width: Math.round(width),
      height: Math.round(height),
    };
  };

  const measureFrom = (itemIndex: number, fit: Rect): Offset | undefined => {
    if (prefersReducedMotion()) {
      return undefined;
    }
    const origin = props.request.origin(itemIndex);
    if (!origin || !origin.isConnected) {
      return undefined;
    }
    const rect = origin.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return undefined;
    }
    return {
      x: rect.left - fit.left,
      y: rect.top - fit.top,
      scaleX: rect.width / fit.width,
      scaleY: rect.height / fit.height,
    };
  };

  const hideOrigin = (itemIndex: number) => {
    restoreOrigin();
    const origin = props.request.origin(itemIndex);
    if (origin) {
      origin.style.visibility = 'hidden';
      hiddenOrigin = origin;
    }
  };

  const restoreOrigin = () => {
    if (hiddenOrigin) {
      hiddenOrigin.style.visibility = '';
      hiddenOrigin = undefined;
    }
  };

  const placeLayer = (state: LayerState) => {
    state.element.style.left = `${state.fit.left}px`;
    state.element.style.top = `${state.fit.top}px`;
    state.element.style.width = `${state.fit.width}px`;
    state.element.style.height = `${state.fit.height}px`;
  };

  const paintLayer = (state: LayerState) => {
    const amount = progress.value;
    const rest = 1 - amount;
    const fade = Math.max(0, Math.min(1, state.fade.value));
    const element = state.element;
    if (state.from) {
      const from = state.from;
      const scaleX = from.scaleX + (1 - from.scaleX) * amount;
      const scaleY = from.scaleY + (1 - from.scaleY) * amount;
      const moved = Math.abs(rest) > 0.0005;
      element.style.transformOrigin = 'top left';
      element.style.transform = moved ? `translate(${from.x * rest}px, ${from.y * rest}px) scale(${scaleX}, ${scaleY})` : '';
      element.style.borderRadius = moved ? `${4 / Math.max(0.02, scaleX)}px / ${4 / Math.max(0.02, scaleY)}px` : '';
      element.style.opacity = String(fade);
      return;
    }
    const reduced = prefersReducedMotion();
    const scale = reduced ? 1 : 0.96 + 0.04 * amount;
    element.style.transformOrigin = 'center';
    element.style.transform = scale === 1 ? '' : `scale(${scale})`;
    element.style.borderRadius = '';
    element.style.opacity = String(fade * Math.max(0, Math.min(1, amount)));
  };

  const paint = () => {
    const amount = Math.max(0, Math.min(1, progress.value));
    scrim.style.opacity = String(amount);
    caption.style.opacity = String(amount * amount);
    for (const state of states.values()) {
      paintLayer(state);
    }
  };

  const removeLayer = (id: number) => {
    const state = states.get(id);
    state?.fade.stop();
    states.delete(id);
    setLayers(layers().filter(layer => layer.id !== id));
  };

  const step = (delta: number) => {
    if (closing()) {
      return;
    }
    const next = Math.max(0, Math.min(items.length - 1, index() + delta));
    if (next === index()) {
      return;
    }
    const previous = states.get(activeLayerId);
    previous?.fade.set(0, 'exit');
    const id = nextLayerId++;
    activeLayerId = id;
    hideOrigin(next);
    setIndex(next);
    setLayers([...layers(), { id, index: next }]);
  };

  const close = () => {
    if (closing()) {
      return;
    }
    setClosing(true);
    overlay.style.pointerEvents = 'none';
    const state = states.get(activeLayerId);
    if (state) {
      // At rest (amount 1) the offset has no effect, so re-aiming at the current thumbnail never jumps.
      const from = measureFrom(index(), state.fit);
      if (from || progress.value >= 0.999) {
        state.from = from;
      }
    }
    for (const [id, other] of states) {
      if (id !== activeLayerId) {
        other.fade.set(0, 'exit');
      }
    }
    progress.set(0, prefersReducedMotion() ? 'control' : 'sheet');
  };

  progress.onChange(paint);
  progress.onRest(value => {
    if (value === 0 && closing()) {
      restoreOrigin();
      previousFocus?.focus?.({ preventScroll: true });
      props.onGone();
    }
  });

  const onKey = (event: KeyboardEvent) => {
    if (closing()) {
      return;
    }
    if (event.key === 'Escape') {
      close();
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      step(1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      step(-1);
    } else {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onResize = () => {
    for (const [id, state] of states) {
      const layer = layers().find(entry => entry.id === id);
      if (!layer) {
        continue;
      }
      state.fit = fitFor(layer.index, state.element.querySelector<HTMLImageElement>('.media-viewer-full'));
      placeLayer(state);
    }
    paint();
  };

  onMount(() => {
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    hideOrigin(props.request.index);
    overlay.focus({ preventScroll: true });
    progress.set(1, prefersReducedMotion() ? 'control' : 'sheet');
  });

  onCleanup(() => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    progress.stop();
    for (const state of states.values()) {
      state.fade.stop();
    }
    restoreOrigin();
  });

  const registerLayer = (layer: ViewerLayer, element: HTMLDivElement) => {
    const first = layer.id === layers()[0].id && states.size === 0;
    const fit = fitFor(layer.index);
    const fade = new Spring(first ? 1 : 0, 'control', 1);
    const state: LayerState = {
      element,
      fade,
      fit,
      from: first ? measureFrom(layer.index, fit) : undefined,
    };
    states.set(layer.id, state);
    fade.onChange(() => paintLayer(state));
    fade.onRest(value => {
      if (value === 0 && layer.id !== activeLayerId) {
        removeLayer(layer.id);
      }
    });
    placeLayer(state);
    paintLayer(state);
    if (!first) {
      fade.set(1, 'control');
    }
  };

  const current = () => items[index()];

  return (
    <div
      class="media-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={current().name}
      tabindex="-1"
      ref={overlay}
      onClick={close}
    >
      <div
        class="media-viewer-scrim"
        ref={scrim}
      />
      <For each={layers()}>
        {layer => {
          const media = items[layer.index];
          return (
            <div
              class="media-viewer-image"
              ref={element => registerLayer(layer, element)}
            >
              <img
                src={thumbSource(media)}
                alt=""
                draggable={false}
              />
              <img
                class="media-viewer-full"
                src={media.file}
                alt={media.name}
                draggable={false}
                onLoad={event => {
                  const state = states.get(layer.id);
                  if (!state || closing()) {
                    return;
                  }
                  const fit = fitFor(layer.index, event.currentTarget);
                  if (fit.width !== state.fit.width || fit.height !== state.fit.height) {
                    state.fit = fit;
                    placeLayer(state);
                    paintLayer(state);
                  }
                }}
              />
            </div>
          );
        }}
      </For>
      <div
        class="media-viewer-caption"
        ref={caption}
      >
        <span class="media-viewer-name">{current().name}</span>
        <Show when={senderOf(current())}>
          {sender => <span class="media-viewer-sender">{sender()}</span>}
        </Show>
        <Show when={items.length > 1}>
          <span class="media-viewer-count">{`${index() + 1} of ${items.length}`}</span>
        </Show>
      </div>
    </div>
  );
}
