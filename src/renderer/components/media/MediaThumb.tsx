/**
 * A small print of an image: flat, hairline-edged, 4px corners. Height comes from the `size` (row 40px, strip 32px);
 * the width follows the image's shape up to a cap, cropped to cover.
 *
 * `hidden` keeps its box but hides the picture: the expanded copy or the viewer is standing in for it.
 */
import { Show, type JSX } from 'solid-js';
import { pressable } from '../../motion';
import { imageDragProps } from '../../shell/imageDrag';
import { Icon } from '../Icon';
import { isImage, thumbSource, type MediaItem } from './media';
import './media.css';

export interface MediaThumbProps {
  media: MediaItem;
  /** row 40px and strip 32px are framed, cropped prints; sent is a subagent's image shown like a chat bubble's, at half its size. */
  size?: 'row' | 'strip' | 'sent';
  /** This thumbnail's image is expanded somewhere else right now. */
  active?: boolean;
  hidden?: boolean;
  label?: string;
  onSelect: (element: HTMLButtonElement) => void;
  ref?: (element: HTMLButtonElement) => void;
}

export function MediaThumb(props: MediaThumbProps): JSX.Element {
  let button!: HTMLButtonElement;
  return (
    <button
      type="button"
      class={`media-print media-print-${props.size ?? 'row'}`}
      classList={{
        'media-print-active': !!props.active,
        'media-print-hidden': !!props.hidden,
      }}
      aria-label={props.label ?? props.media.name}
      aria-pressed={props.active ? 'true' : 'false'}
      title={props.media.name}
      // On the button, not the <img>: prints set `pointer-events: none` on their image, so it never starts a drag.
      {...imageDragProps(() => (isImage(props.media) ? props.media.file : undefined), () => props.media.name)}
      draggable={isImage(props.media)}
      ref={element => {
        button = element;
        pressable(element, 0.94);
        props.ref?.(element);
      }}
      onClick={event => {
        event.stopPropagation();
        props.onSelect(button);
      }}
    >
      <Show
        when={isImage(props.media)}
        fallback={
          <span class="media-print-file">
            <Icon name="file" size={12} />
          </span>
        }
      >
        <img src={thumbSource(props.media)} alt={props.media.name} draggable={false} />
      </Show>
    </button>
  );
}
