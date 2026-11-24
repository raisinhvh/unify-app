import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { createEffect, on, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { bridge, type UnifyTerminalApi } from '../../bridge';
import './terminal.css';

export interface TerminalViewProps {
  /** Pane id; also the main-process session id. */
  paneId: string;
  /** Working directory for a new shell (falls back to the project folder). */
  cwd?: string;
  /** When true, the xterm takes keyboard focus. */
  focused: boolean;
  /** Called when the shell sets its title (OSC 0/2). */
  onTitle?: (title: string) => void;
  /** Called with the folder the shell actually started in. */
  onStarted?: (cwd: string) => void;
}

const FALLBACK_BG = '#0D0B09';
const FALLBACK_TEXT = '#EFEAE4';

function terminalApi(): UnifyTerminalApi | undefined {
  try {
    return bridge().terminal;
  } catch {
    return undefined;
  }
}

/** Reads a theme token from the document root, falling back when the token is not set. */
function token(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

/** xterm needs concrete values, so a `var(...)` token is resolved through a probe element. */
function resolvedFontFamily(): string {
  const probe = document.createElement('span');
  probe.style.fontFamily = 'var(--font-mono)';
  document.body.appendChild(probe);
  const family = getComputedStyle(probe).fontFamily;
  probe.remove();
  return family || 'ui-monospace, monospace';
}

function readTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const background = token(style, '--bg', FALLBACK_BG);
  return {
    background,
    foreground: token(style, '--text', FALLBACK_TEXT),
    cursor: token(style, '--accent', FALLBACK_TEXT),
    cursorAccent: background,
    selectionBackground: token(style, '--accent-tint', 'rgba(201, 164, 101, 0.10)'),
  };
}

export function TerminalView(props: TerminalViewProps): JSX.Element {
  const api = terminalApi();
  let host!: HTMLDivElement;
  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let observer: ResizeObserver | undefined;
  let frame = 0;
  let disposed = false;
  let exited = false;
  let starting = false;
  let unsubscribeData: (() => void) | undefined;
  let unsubscribeExit: (() => void) | undefined;

  const fitNow = () => {
    if (disposed || !term || !fit || !host) return;
    if (host.clientWidth === 0 || host.clientHeight === 0) return;
    try {
      fit.fit();
    } catch {
      // The element was detached mid-frame.
    }
  };

  const scheduleFit = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      fitNow();
    });
  };

  const start = async (): Promise<void> => {
    if (disposed || !term || !api || starting) return;
    starting = true;
    try {
      const result = await api.create(props.paneId, { cols: term.cols, rows: term.rows, cwd: props.cwd });
      if (disposed) {
        api.kill(props.paneId);
        return;
      }
      if (!result.ok) {
        exited = true;
        term.write(`\r\n\x1b[31m${result.error ?? 'Could not start the terminal.'}\x1b[0m\r\n\x1b[2mpress Enter to retry\x1b[0m\r\n`);
        return;
      }
      exited = false;
      if (result.cwd) props.onStarted?.(result.cwd);
    } finally {
      starting = false;
    }
  };

  onMount(() => {
    if (!api) return;
    term = new Terminal({
      fontSize: 13,
      fontFamily: resolvedFontFamily(),
      cursorBlink: true,
      scrollback: 5000,
      theme: readTheme(),
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fitNow();
    if (props.focused) term.focus();

    const current = term;
    current.onData(data => {
      if (exited) {
        // A dead shell: Enter starts a fresh one.
        if (data.includes('\r')) void start();
        return;
      }
      api.write(props.paneId, data);
    });
    current.onResize(({ cols, rows }) => api.resize(props.paneId, cols, rows));
    current.onTitleChange(title => props.onTitle?.(title));

    unsubscribeData = api.onData((id, data) => {
      if (id === props.paneId) current.write(data);
    });
    unsubscribeExit = api.onExit((id, code) => {
      if (id !== props.paneId) return;
      exited = true;
      current.write(`\r\n\x1b[2m[process exited with code ${code}] — press Enter to restart\x1b[0m\r\n`);
    });

    observer = new ResizeObserver(() => scheduleFit());
    observer.observe(host);

    void start();
  });

  createEffect(
    on(
      () => props.focused,
      focused => {
        if (focused) term?.focus();
      },
      { defer: true },
    ),
  );

  onCleanup(() => {
    disposed = true;
    observer?.disconnect();
    observer = undefined;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    unsubscribeData?.();
    unsubscribeExit?.();
    unsubscribeData = undefined;
    unsubscribeExit = undefined;
    if (api) api.kill(props.paneId);
    term?.dispose();
    term = undefined;
    fit = undefined;
  });

  return (
    <Show
      when={api !== undefined}
      fallback={<div class="terminal-unavailable">Terminals need the desktop app</div>}
    >
      <div class="terminal-view">
        <div class="terminal-host" ref={host} />
      </div>
    </Show>
  );
}
