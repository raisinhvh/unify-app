/**
 * <MediaExpand media={expanded()} origin={…}> shows one image expanded in place under its thumbnails.
 *
 * The image grows out of the thumbnail it sat in (shared-element FLIP on the Reveal spring) while the slot's height
 * springs open, so the layout below follows. Collapsing returns it into the same thumbnail. Picking another
 * thumbnail while one is open crossfades the old image out and grows the new one from its own thumbnail; the slot
 * height retargets from where it is. Everything is interruptible: reopening an image that is on its way back turns
 * the same spring around. Reduced motion: no travel, the image crossfades.
 *
 * Size: fits the slot's width, at most `maxHeight` (360) tall, keeping the image's shape.
 */
import { createEffect, createSignal, For, on, onCleanup, onMount, Show, untrack, type JSX } from 'solid-js';
import { driveSpring, prefersReducedMotion, Spring } from '../../motion';
import { aspectOf, mediaKey, thumbSource, type MediaItem } from './media';
import './media.css';

export interface MediaExpandProps {
  /** The image shown expanded, or undefined when closed. */
  media: MediaItem | undefined;
  /** The thumbnail element an image grows out of and returns into. */
  origin: (media: MediaItem) => HTMLElement | undefined;
  /** A click on the expanded image (collapse it, or open the full viewer). */
  onImageClick: (media: MediaItem, element: HTMLElement) => void;
  /** Keys whose thumbnail the expanded image is standing in for; hide those thumbnails. */
  onStandIn?: (keys: ReadonlySet<string>) => void;
  /** Hint for screen readers on the expanded image ("Collapse image", "Open full view"). */
  imageAction?: string;
  /** The image click opens the full viewer (zoom-in cursor) instead of collapsing it. */
  opensViewer?: boolean;
  maxHeight?: number;
}

type LeaveMode = 'shrink' | 'fade';

interface Layer {
  id: number;
  key: string;
  media: MediaItem;
}

/** Space between the thumbnails and the expanded image. */
const slotGap = 6;
const defaultMaxHeight = 360;

let nextLayerId = 1;

export function MediaExpand(props: MediaExpandProps): JSX.Element {
  let wrapper: HTMLDivElement | undefined;
  const height = new Spring(0, 'reveal', 100);
  const [layers, setLayers] = createSignal<Layer[]>([]);
  const [leaving, setLeaving] = createSignal<Record<number, LeaveMode>>({});
  const layerHeights = new Map<number, number>();
  const standIns = new Map<number, string>();

  height.onChange(value => {
    if (wrapper) {
      wrapper.style.height = `${Math.max(0, value)}px`;
    }
  });
  onCleanup(() => height.stop());

  const publishStandIns = () => {
    props.onStandIn?.(new Set(standIns.values()));
  };

  const retargetHeight = () => {
    const modes = untrack(leaving);
    const active = untrack(layers).filter(layer => !modes[layer.id]);
    const last = active[active.length - 1];
    const layerHeight = last ? layerHeights.get(last.id) : undefined;
    const target = last && layerHeight !== undefined ? layerHeight + slotGap : last ? height.target : 0;
    driveSpring(height, target, 'reveal');
  };

  createEffect(on(() => (props.media ? mediaKey(props.media) : undefined), key => {
    const current = untrack(layers);
    const modes = { ...untrack(leaving) };
    if (key === undefined) {
      for (const layer of current) {
        if (!modes[layer.id]) {
          modes[layer.id] = 'shrink';
        }
      }
      setLeaving(modes);
      retargetHeight();
      return;
    }
    const existing = current.find(layer => layer.key === key);
    for (const layer of current) {
      if (layer !== existing && !modes[layer.id]) {
        modes[layer.id] = 'fade';
      }
    }
    if (existing) {
      delete modes[existing.id];
      setLeaving(modes);
    } else {
      setLeaving(modes);
      setLayers([...current, { id: nextLayerId++, key, media: props.media! }]);
    }
    retargetHeight();
  }));

  const removeLayer = (id: number) => {
    layerHeights.delete(id);
    standIns.delete(id);
    publishStandIns();
    setLayers(untrack(layers).filter(layer => layer.id !== id));
    const modes = { ...untrack(leaving) };
    delete modes[id];
    setLeaving(modes);
  };

  return (
    <Show when={layers().length}>
      <div
        class="media-expand"
        ref={element => {
          wrapper = element;
          element.style.height = `${Math.max(0, height.value)}px`;
        }}
      >
        <For each={layers()}>
          {layer => (
            <ExpandLayer
              layer={layer}
              leaving={() => leaving()[layer.id]}
              wrapper={() => wrapper}
              origin={props.origin}
              maxHeight={props.maxHeight ?? defaultMaxHeight}
              imageAction={props.imageAction}
              opensViewer={!!props.opensViewer}
              onHeight={value => {
                layerHeights.set(layer.id, value);
                retargetHeight();
              }}
              onStandIn={standing => {
                if (standing) {
                  standIns.set(layer.id, layer.key);
                } else {
                  standIns.delete(layer.id);
                }
                publishStandIns();
              }}
              onGone={() => removeLayer(layer.id)}
              onClick={element => props.onImageClick(layer.media, element)}
            />
          )}
        </For>
      </div>
    </Show>
  );
}

interface ExpandLayerProps {
  layer: Layer;
  leaving: () => LeaveMode | undefined;
  wrapper: () => HTMLDivElement | undefined;
  origin: (media: MediaItem) => HTMLElement | undefined;
  maxHeight: number;
  imageAction?: string;
  opensViewer: boolean;
  onHeight: (height: number) => void;
  onStandIn: (standing: boolean) => void;
  onGone: () => void;
  onClick: (element: HTMLElement) => void;
}

interface Offset {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

const restingOffset: Offset = { x: 0, y: 0, scaleX: 1, scaleY: 1 };

function ExpandLayer(props: ExpandLayerProps): JSX.Element {
  let element!: HTMLButtonElement;
  const progress = new Spring(0, 'reveal', 1);
  const opacity = new Spring(1, 'reveal', 1);
  let size = { width: 0, height: 0 };
  let from: Offset = restingOffset;
  let gone = false;

  const originImage = () => props.origin(props.layer.media)?.querySelector('img') ?? null;

  const measureSize = () => {
    const available = props.wrapper()?.clientWidth || 320;
    const aspect = aspectOf(props.layer.media, originImage());
    const fittedHeight = Math.min(props.maxHeight, available / aspect);
    size = { width: Math.round(fittedHeight * aspect), height: Math.round(fittedHeight) };
    element.style.width = `${size.width}px`;
    element.style.height = `${size.height}px`;
  };

  /** Where the thumbnail is, relative to this image's resting place, or undefined when it is gone. */
  const measureOrigin = (): Offset | undefined => {
    const origin = props.origin(props.layer.media);
    const wrapper = props.wrapper();
    if (!origin || !wrapper || !origin.isConnected || !size.width || !size.height) {
      return undefined;
    }
    const originRect = origin.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    return {
      x: originRect.left - wrapperRect.left,
      y: originRect.top - (wrapperRect.top + slotGap),
      scaleX: originRect.width / size.width,
      scaleY: originRect.height / size.height,
    };
  };

  const paint = () => {
    const amount = progress.value;
    const rest = 1 - amount;
    const scaleX = from.scaleX + (1 - from.scaleX) * amount;
    const scaleY = from.scaleY + (1 - from.scaleY) * amount;
    const moved = Math.abs(rest) > 0.0005;
    element.style.transform = moved ? `translate(${from.x * rest}px, ${from.y * rest}px) scale(${scaleX}, ${scaleY})` : '';
    // Keep the 4px corners round while scaled.
    element.style.borderRadius = moved ? `${4 / Math.max(0.05, scaleX)}px / ${4 / Math.max(0.05, scaleY)}px` : '';
    element.style.opacity = String(Math.max(0, Math.min(1, opacity.value)));
  };

  const finish = () => {
    if (gone) {
      return;
    }
    gone = true;
    props.onStandIn(false);
    props.onGone();
  };

  progress.onChange(paint);
  opacity.onChange(paint);
  progress.onRest(value => {
    if (value === 0 && props.leaving() === 'shrink') {
      finish();
    }
  });
  opacity.onRest(value => {
    if (value === 0 && props.leaving()) {
      finish();
    }
  });
  onCleanup(() => {
    progress.stop();
    opacity.stop();
  });

  const grow = () => {
    const reduced = prefersReducedMotion();
    const origin = reduced ? undefined : measureOrigin();
    if (!origin) {
      from = restingOffset;
      progress.jump(1);
      opacity.set(1, 'control');
      return;
    }
    // A layer turning around mid-collapse keeps its current value and velocity.
    if (!progress.moving && progress.value === 0) {
      from = origin;
    }
    props.onStandIn(true);
    opacity.set(1, 'control');
    progress.set(1, 'reveal');
  };

  onMount(() => {
    opacity.jump(0);
    paint();
    queueMicrotask(() => {
      measureSize();
      props.onHeight(size.height);
      const origin = prefersReducedMotion() ? undefined : measureOrigin();
      if (origin) {
        from = origin;
        progress.jump(0);
        opacity.jump(1);
        props.onStandIn(true);
        progress.set(1, 'reveal');
      } else {
        progress.jump(1);
        opacity.set(1, 'control');
      }
    });

    let lastWidth = props.wrapper()?.clientWidth ?? 0;
    const observer = new ResizeObserver(() => {
      const width = props.wrapper()?.clientWidth ?? 0;
      if (width === lastWidth || props.leaving() || progress.moving) {
        return;
      }
      lastWidth = width;
      measureSize();
      props.onHeight(size.height);
    });
    const wrapper = props.wrapper();
    if (wrapper) {
      observer.observe(wrapper);
    }
    onCleanup(() => observer.disconnect());
  });

  createEffect(on(props.leaving, mode => {
    if (mode === 'fade') {
      props.onStandIn(false);
      opacity.set(0, prefersReducedMotion() ? 'control' : 'exit');
      return;
    }
    if (mode === 'shrink') {
      const origin = prefersReducedMotion() ? undefined : measureOrigin();
      if (!origin) {
        props.onStandIn(false);
        opacity.set(0, 'control');
        return;
      }
      // Aim at where the thumbnail is now (it may have moved while the image was open).
      from = origin;
      progress.set(0, 'reveal');
      return;
    }
    grow();
    props.onHeight(size.height);
  }, { defer: true }));

  return (
    <button
      type="button"
      class="media-expand-layer"
      data-action={props.opensViewer ? 'open' : 'collapse'}
      aria-label={props.imageAction ? `${props.imageAction}: ${props.layer.media.name}` : props.layer.media.name}
      ref={element}
      onClick={event => {
        event.stopPropagation();
        props.onClick(element);
      }}
    >
      <img
        class="media-expand-thumb"
        src={thumbSource(props.layer.media)}
        alt=""
        draggable={false}
      />
      <img
        class="media-expand-image"
        src={props.layer.media.file}
        alt={props.layer.media.name}
        draggable={false}
      />
    </button>
  );
}
