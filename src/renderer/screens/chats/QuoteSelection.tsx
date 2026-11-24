/**
 * Quote a part of the agent's reply: selecting text inside an assistant message pops a small "Quote" button above
 * the selection; clicking it hands the text to `onQuote` (ChatPane puts it in the composer as a "> " block).
 *
 *   <QuoteSelection root={paneElement} onQuote={text => composer.quote(text)} />
 *
 * Only selections that start and end inside this pane's assistant messages count (not user bubbles, tools or other
 * panes). The button appears once the selection is finished (pointer up, or a keyboard selection), hides when the
 * selection collapses, the feed scrolls, or the pointer goes down elsewhere, and glides to a new selection while
 * shown (Popover motion).
 */
import { createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { Button, Popover } from '../../components';
import './quote-selection.css';

export interface QuoteSelectionProps {
  /** The pane the selection must be inside. */
  root: HTMLElement | undefined;
  onQuote: (text: string) => void;
}

const assistantSelector = '.feed-entry.assistant';

function assistantEntry(node: Node | null, root: HTMLElement): Element | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const entry = element?.closest(assistantSelector) ?? null;
  return entry && root.contains(entry) ? entry : null;
}

export function QuoteSelection(props: QuoteSelectionProps): JSX.Element {
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  const [open, setOpen] = createSignal(false);
  const [selectedText, setSelectedText] = createSignal('');
  let surface: HTMLDivElement | undefined;

  /** A fresh invisible box over the selection's first line each time, so a shown button glides to it. */
  function placeAnchor(rect: DOMRect): void {
    const element = document.createElement('div');
    element.className = 'quote-selection-anchor';
    element.style.left = `${rect.left}px`;
    element.style.top = `${rect.top}px`;
    element.style.width = `${Math.max(1, rect.width)}px`;
    element.style.height = `${Math.max(1, rect.height)}px`;
    document.body.appendChild(element);
    const previous = anchor();
    setAnchor(element);
    // The old box stays until the popover has measured the new one.
    if (previous) queueMicrotask(() => previous.remove());
  }

  function readSelection(): void {
    const root = props.root;
    const selection = window.getSelection();
    if (!root || !selection || selection.isCollapsed || !selection.rangeCount) {
      setOpen(false);
      return;
    }
    const text = selection.toString().trim();
    if (!text || !assistantEntry(selection.anchorNode, root) || !assistantEntry(selection.focusNode, root)) {
      setOpen(false);
      return;
    }
    const range = selection.getRangeAt(0);
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
    const first = rects[0] ?? range.getBoundingClientRect();
    setSelectedText(text);
    placeAnchor(first);
    setOpen(true);
  }

  function close(): void {
    setOpen(false);
  }

  function quote(): void {
    const text = selectedText();
    setOpen(false);
    window.getSelection()?.removeAllRanges();
    if (text) props.onQuote(text);
  }

  onMount(() => {
    const onPointerUp = (event: PointerEvent) => {
      if (surface?.contains(event.target as Node)) return;
      // After the browser settles the selection (a click inside the old one collapses it on this same event).
      requestAnimationFrame(readSelection);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.shiftKey || event.key === 'Shift' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a')) {
        readSelection();
      }
    };
    const onSelectionChange = () => {
      if (open() && window.getSelection()?.isCollapsed) setOpen(false);
    };
    const onScroll = (event: Event) => {
      if (open() && props.root?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('scroll', onScroll, true);
    onCleanup(() => {
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('scroll', onScroll, true);
      anchor()?.remove();
    });
  });

  return (
    <Popover
      anchor={anchor()}
      open={open()}
      onClose={close}
      placement="top-start"
      offset={6}
      class="quote-selection"
      ref={element => {
        surface = element;
      }}
    >
      <Button
        variant="text"
        icon="quote"
        class="quote-selection-button"
        // Keep the selection (and the focus) where they are until the click lands.
        onPointerDown={event => event.preventDefault()}
        onMouseDown={event => event.preventDefault()}
        onClick={quote}
      >
        Quote
      </Button>
    </Popover>
  );
}
