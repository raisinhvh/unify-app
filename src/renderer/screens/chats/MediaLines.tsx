/**
 * Images inside chat rows (docs/briefs/ds-media-chat-ui.md):
 *
 *   <ToolMediaLine media={…}>    prints under a tool row (images the call gave the agent).
 *   <SubagentStrip media={…}>    "N images", up to 4 prints and "+K" under a subagent row. Prints that arrive
 *                                while it runs pop in one by one.
 *
 * Clicking a print opens the full viewer for the row's images, growing out of the print; "+K" opens it at the
 * first hidden image. Non-image files open with the OS (openMedia), as the media entry does.
 */
import { createSignal, For, onMount, Show, type JSX } from 'solid-js';
import { post } from '../../bridge';
import { isImage, mediaKey, MediaThumb, openMediaViewer, type MediaItem } from '../../components/media';
import { Presence } from '../../motion';

/** Opens a group's images in the full viewer from their prints; non-image files open with the OS. */
function useViewerOpen(media: () => MediaItem[], sender?: () => string | undefined) {
  const prints = new Map<string, HTMLElement>();
  const open = (target: MediaItem) => {
    if (!isImage(target)) {
      post({ type: 'openMedia', file: target.file });
      return;
    }
    const images = media().filter(isImage);
    openMediaViewer({
      items: images,
      index: Math.max(0, images.indexOf(target)),
      sender: sender?.(),
      origin: index => prints.get(mediaKey(images[index])),
    });
  };
  return {
    prints,
    open,
  };
}

export function ToolMediaLine(props: { media: MediaItem[] }): JSX.Element {
  const viewer = useViewerOpen(() => props.media);
  return (
    <div class="tool-media">
      <div class="media-prints">
        <For each={props.media}>
          {media => (
            <MediaThumb
              media={media}
              size="row"
              ref={element => viewer.prints.set(mediaKey(media), element)}
              onSelect={() => viewer.open(media)}
            />
          )}
        </For>
      </div>
    </div>
  );
}

/** Prints shown in the strip before "+K". */
const stripLimit = 4;

export function SubagentStrip(props: { media: MediaItem[]; sender: string }): JSX.Element {
  const viewer = useViewerOpen(
    () => props.media,
    () => props.sender,
  );
  const visible = () => props.media.slice(0, stripLimit);
  const more = () => Math.max(0, props.media.length - stripLimit);
  const imageCount = () => props.media.filter(isImage).length;
  // Images speak for themselves, like a user's bubble; a count only helps when files are mixed in.
  const label = () => {
    if (imageCount() === props.media.length) {
      return '';
    }
    return props.media.length === 1 ? '1 file' : `${props.media.length} files`;
  };

  // Prints already there when the strip first shows sit still; later ones pop in as they arrive.
  const settled = new Set<string>();
  const [ready, setReady] = createSignal(false);
  onMount(() => {
    for (const media of props.media) {
      settled.add(mediaKey(media));
    }
    setReady(true);
  });

  // "+K" opens at the first hidden image (or the first image, when only files are hidden).
  const openMore = () => {
    const hiddenImage = props.media.slice(stripLimit).find(isImage);
    const firstImage = props.media.find(isImage);
    const target = hiddenImage ?? firstImage;
    if (target) {
      viewer.open(target);
    }
  };

  return (
    <div
      class="subagent-strip"
      onClick={event => event.stopPropagation()}
    >
      <div class="subagent-strip-line">
        <Show when={label()}>
          <span class="subagent-strip-label">{label()}</span>
        </Show>
        <div class="media-prints">
          <For each={visible()}>
            {media => {
              const key = mediaKey(media);
              // The engine resends the whole list, so a print can remount: only a new key pops in.
              const [shown, setShown] = createSignal(!ready() || settled.has(key));
              onMount(() => {
                settled.add(key);
                setShown(true);
              });
              return (
                <Presence
                  when={shown()}
                  from={0.85}
                  origin="center"
                >
                  <MediaThumb
                    media={media}
                    size={isImage(media) ? 'sent' : 'strip'}
                    ref={element => viewer.prints.set(key, element)}
                    onSelect={() => viewer.open(media)}
                  />
                </Presence>
              );
            }}
          </For>
          <Show when={more()}>
            <button
              type="button"
              class="media-print-more"
              aria-label={`Show all ${props.media.length}`}
              onClick={openMore}
            >
              {`+${more()}`}
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}
