/**
 * Tooltips. One global host (mount <TooltipHost /> once, App does) and a ref helper:
 *
 *   <div ref={el => tooltip(el, () => <ChatTip … />, { placement: 'right-start' })}>…</div>
 *   <button ref={el => tooltip(el, 'Pop out')}>…</button>
 *
 * Shows after a short hover delay; moving straight to another tooltip target swaps content without waiting
 * (the surface glides to the new anchor instead of closing and reopening). Pops in, quick exit.
 */
import { createSignal, onCleanup, type JSX } from 'solid-js';
import { Popover, type PopoverPlacement } from './Popover';
import './tooltip.css';

type TooltipContent = string | (() => JSX.Element);

interface TooltipRequest {
  anchor: HTMLElement;
  content: TooltipContent;
  placement: PopoverPlacement;
  rich: boolean;
}

const [request, setRequest] = createSignal<TooltipRequest | undefined>();
const [visible, setVisible] = createSignal(false);
let showTimer = 0;
let hideTimer = 0;

const showDelay = 450;
const hideDelay = 80;

export interface TooltipOptions {
  placement?: PopoverPlacement;
  /** Delay before the first tooltip shows, ms. */
  delay?: number;
}

export function tooltip(element: HTMLElement, content: TooltipContent, options: TooltipOptions = {}): void {
  const show = () => {
    window.clearTimeout(hideTimer);
    window.clearTimeout(showTimer);
    const next: TooltipRequest = {
      anchor: element,
      content,
      placement: options.placement ?? 'bottom-start',
      rich: typeof content !== 'string',
    };
    if (visible()) {
      setRequest(next);
      return;
    }
    showTimer = window.setTimeout(() => {
      setRequest(next);
      setVisible(true);
    }, options.delay ?? showDelay);
  };
  const hide = () => {
    window.clearTimeout(showTimer);
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => setVisible(false), hideDelay);
  };
  element.addEventListener('pointerenter', show);
  element.addEventListener('pointerleave', hide);
  element.addEventListener('pointerdown', hide);
  onCleanup(() => {
    element.removeEventListener('pointerenter', show);
    element.removeEventListener('pointerleave', hide);
    element.removeEventListener('pointerdown', hide);
    if (request()?.anchor === element) {
      window.clearTimeout(showTimer);
      setVisible(false);
    }
  });
}

export function TooltipHost(): JSX.Element {
  return (
    <Popover
      anchor={request()?.anchor}
      open={visible()}
      onClose={() => setVisible(false)}
      placement={request()?.placement}
      class={request()?.rich ? 'tooltip tooltip-rich' : 'tooltip'}
    >
      {(() => {
        const current = request();
        if (!current) return null;
        return typeof current.content === 'string' ? <span>{current.content}</span> : current.content();
      })()}
    </Popover>
  );
}
