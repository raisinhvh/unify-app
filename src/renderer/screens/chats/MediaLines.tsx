/**
 * Images inside chat rows (docs/briefs/ds-media-chat-ui.md):
 *
 *   <ToolMediaLine media={…}>    prints under a tool row (images the call gave the agent). A click expands one in
 *                                place under the row; clicking it again, clicking the expanded image or Esc
 *                                collapses it back into its print.
 *   <SubagentStrip media={…}>    "N images", up to 4 prints and "+K" under a subagent row. Prints that arrive
 *                                while it runs pop in one by one. A print expands in place; the expanded image's
 *                                own click (and "+K") opens the full viewer for the whole group.
 *
 * Non-image files open with the OS (openMedia), as the media entry does.
 */
import { createSignal, For, onMount, Show, type JSX } from 'solid-js';
import { post } from '../../bridge';
import {
  isImage,
  MediaExpand,
  mediaKey,
  MediaThumb,
  onEscape,
  openMediaViewer,
  type MediaItem,
} from '../../components/media';
import { Presence } from '../../motion';

/** Which image of a group is expanded in place, and the prints it grows out of. */
function useInPlaceExpand() {
  const [expanded, setExpanded] = createSignal<MediaItem>();
  const [standIns, setStandIns] = createSignal<ReadonlySet<string>>(new Set());
  const prints = new Map<string, HTMLElement>();
  const expandedKey = () => {
    const media = expanded();
    return media ? mediaKey(media) : undefined;
  };
  const toggle = (media: MediaItem) => {
    if (!isImage(media)) {
      post({ type: 'openMedia', file: media.file });
      return;
    }
    setExpanded(expandedKey() === mediaKey(media) ? undefined : media);
  };
  onEscape(() => expanded() !== undefined, () => setExpanded(undefined));
  return {
    expanded,
    setExpanded,
    expandedKey,
    standIns,
    setStandIns,
    prints,
    toggle,
  };
}

export function ToolMediaLine(props: { media: MediaItem[] }): JSX.Element {
  const expand = useInPlaceExpand();
  return (
    <div class="tool-media">
      <div class="media-prints">
        <For each={props.media}>
          {media => (
            <MediaThumb
              media={media}
              size="row"
              active={expand.expandedKey() === mediaKey(media)}
              hidden={expand.standIns().has(mediaKey(media))}
              ref={element => expand.prints.set(mediaKey(media), element)}
              onSelect={() => expand.toggle(media)}
            />
          )}
        </For>
      </div>
      <MediaExpand
        media={expand.expanded()}
        origin={media => expand.prints.get(mediaKey(media))}
        imageAction="Collapse image"
        onStandIn={expand.setStandIns}
        onImageClick={() => expand.setExpanded(undefined)}
      />
    </div>
  );
}

/** Prints shown in the strip before "+K". */
const stripLimit = 4;

export function SubagentStrip(props: { media: MediaItem[]; sender: string }): JSX.Element {
  const expand = useInPlaceExpand();
  let expandedElement: HTMLElement | undefined;
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

  const openViewer = (index: number) => {
    const images = props.media.filter(isImage);
    const target = props.media[index];
    const imageIndex = Math.max(0, images.indexOf(target));
    openMediaViewer({
      items: images,
      index: imageIndex,
      sender: props.sender,
      origin: itemIndex => {
        const key = mediaKey(images[itemIndex]);
        if (key === expand.expandedKey() && expandedElement?.isConnected) {
          return expandedElement;
        }
        return expand.prints.get(key);
      },
    });
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
                    active={expand.expandedKey() === key}
                    hidden={expand.standIns().has(key)}
                    ref={element => expand.prints.set(key, element)}
                    onSelect={() => expand.toggle(media)}
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
              onClick={() => openViewer(stripLimit)}
            >
              {`+${more()}`}
            </button>
          </Show>
        </div>
      </div>
      <MediaExpand
        media={expand.expanded()}
        origin={media => expand.prints.get(mediaKey(media))}
        imageAction="Open full view"
        opensViewer
        onStandIn={expand.setStandIns}
        onImageClick={(media, element) => {
          expandedElement = element;
          openViewer(props.media.indexOf(media));
        }}
      />
    </div>
  );
}
