/**
 * What a pane shows, by kind (shell/layout.ts PaneKind). PaneGrid draws the leaf frame and calls these:
 *
 *   PaneContent   chat → ChatPane; files, knowledge, terminal, image, git → a generic frame (grip · title · close)
 *   EmptySlot     a leaf without a pane: Files / Knowledge / Terminal / Source Control, or drop something here
 *
 * Files and Knowledge are the screens' panel and content halves side by side. Under 620px the body shows one half
 * at a time behind a small Tree | Editor (Tree | Document) toggle, which switches to the content half when the
 * selected file or item changes. Wider, a divider between the halves drags the tree's width (persisted per kind,
 * double-click resets); under 280px the tree keeps its full-size layout and scales down so its text still fits.
 * Styles: pane-content.css.
 */
import { createEffect, createSignal, For, on, onCleanup, Match, onMount, Show, Switch, type JSX } from 'solid-js';
import { Button, Icon, IconButton } from '../components';
import { readPersisted, writePersisted } from '../persist';
import { ChatPane } from '../screens/chats/ChatPane';
import { ProjectSwitch } from '../screens/chats/ProjectSwitch';
import { FilesEditor, FilesPanel } from '../screens/files/FilesScreen';
import { activePath } from '../screens/files/state';
import { KnowledgeContent, KnowledgePanel } from '../screens/knowledge/KnowledgeScreen';
import { selection } from '../screens/knowledge/state';
import { GitView } from '../screens/git/GitView';
import { TerminalView } from '../screens/terminal/TerminalView';
import { fillSlot, openPane, setPaneCwd, setPaneTitle, type PaneInstance } from './layout';
import type { EmptySlotContext, PaneContext } from './PaneGrid';
import './pane-content.css';

/** Below this body width the Files / Knowledge halves take turns. */
const narrowWidth = 620;
/** The tree half's full-size width; narrower than this it scales down instead of cutting text off. */
const sideDefaultWidth = 280;
const sideMinWidth = 140;
/** The tree never scales below this (≈10.5px text); narrower than that it stays this size and names truncate. */
const sideMinScale = 0.8;
/** The editor half never gets narrower than this while dragging the divider. */
const mainMinWidth = 260;

export function PaneContent(props: { context: PaneContext }): JSX.Element {
  const kind = () => props.context.pane()?.kind;
  return (
    <Switch>
      <Match when={kind() === 'chat'}>
        <ChatPane context={props.context} />
      </Match>
      <Match when={kind() === 'files'}>
        <SplitPane
          context={props.context}
          title="Files"
          treeLabel="Tree"
          mainLabel="Editor"
          wakeOn={activePath}
          panel={() => <FilesPanel />}
          main={() => <FilesEditor />}
        />
      </Match>
      <Match when={kind() === 'knowledge'}>
        <SplitPane
          context={props.context}
          title="Knowledge"
          treeLabel="Tree"
          mainLabel="Document"
          wakeOn={selection}
          panel={() => <KnowledgePanel />}
          main={() => <KnowledgeContent />}
        />
      </Match>
      <Match when={kind() === 'terminal'}>
        <TerminalPane context={props.context} />
      </Match>
      <Match when={kind() === 'git'}>
        <GitPane context={props.context} />
      </Match>
      <Match when={kind() === 'image'}>
        <ImagePane context={props.context} />
      </Match>
    </Switch>
  );
}

// ---------------------------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------------------------

interface PaneHeaderProps {
  context: PaneContext;
  title: string;
  /** Between the title and the actions (e.g. the narrow-width toggle). */
  middle?: JSX.Element;
  /** Before the close button. */
  actions?: JSX.Element;
}

/** Same height and look as the chat pane header (chat-pane.css). */
function PaneHeader(props: PaneHeaderProps): JSX.Element {
  const startDrag = (event: PointerEvent) => props.context.startDrag(event);
  return (
    <header class="chat-pane-header pane-header">
      <span class="chat-pane-grip" data-drag-handle aria-label="Drag to rearrange" onPointerDown={startDrag}>
        <Icon name="grip" size={14} />
      </span>
      <h3 class="chat-pane-title type-heading" onPointerDown={startDrag}>
        {props.title}
      </h3>
      <span class="chat-pane-spacer" onPointerDown={startDrag} />
      {props.middle}
      <div class="chat-pane-actions">
        {props.actions}
        <IconButton icon="close" label="Close pane" size="small" onClick={() => props.context.close()} />
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------------------------
// Files and Knowledge: panel | main, one at a time when narrow
// ---------------------------------------------------------------------------------------------

interface SplitPaneProps {
  context: PaneContext;
  title: string;
  treeLabel: string;
  mainLabel: string;
  /** When this value changes to something truthy, a narrow pane shows the main half. */
  wakeOn: () => unknown;
  panel: () => JSX.Element;
  main: () => JSX.Element;
}

function SplitPane(props: SplitPaneProps): JSX.Element {
  const [narrow, setNarrow] = createSignal(false);
  const [half, setHalf] = createSignal<'panel' | 'main'>('panel');
  const [bodySize, setBodySize] = createSignal({ width: 0, height: 0 });
  const widthKey = `paneSideWidth:${props.title.toLowerCase()}`;
  const [sideWidth, setSideWidth] = createSignal(readPersisted(widthKey, sideDefaultWidth));
  const [dragging, setDragging] = createSignal(false);
  let body: HTMLDivElement | undefined;
  let observer: ResizeObserver | undefined;

  onMount(() => {
    if (!body) return;
    observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      const width = rect?.width ?? narrowWidth;
      setBodySize({ width, height: rect?.height ?? 0 });
      setNarrow(width < narrowWidth);
    });
    observer.observe(body);
  });
  onCleanup(() => observer?.disconnect());

  /** The tree's on-screen width: the dragged width, kept clear of the editor's minimum. */
  const clampSide = (width: number) => {
    const room = bodySize().width;
    const max = room > 0 ? room - mainMinWidth : width;
    return Math.round(Math.max(sideMinWidth, Math.min(width, max)));
  };
  const shownSide = () => clampSide(sideWidth());
  /** Under the default width the tree keeps its full-size layout and scales down (to sideMinScale at most). */
  const sideScale = () => (narrow() ? 1 : Math.max(sideMinScale, Math.min(1, shownSide() / sideDefaultWidth)));

  const startResize = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = shownSide();
    setDragging(true);
    const move = (moveEvent: PointerEvent) => setSideWidth(clampSide(startWidth + moveEvent.clientX - startX));
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      setDragging(false);
      writePersisted(widthKey, sideWidth());
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const resetWidth = () => {
    setSideWidth(sideDefaultWidth);
    writePersisted(widthKey, sideDefaultWidth);
  };

  createEffect(on(
    () => props.wakeOn(),
    value => {
      if (value && narrow()) setHalf('main');
    },
    { defer: true },
  ));

  const toggle = (
    <Show when={narrow()}>
      <div class="pane-segmented" role="group" aria-label="Show">
        <button type="button" aria-pressed={half() === 'panel'} onClick={() => setHalf('panel')}>
          {props.treeLabel}
        </button>
        <button type="button" aria-pressed={half() === 'main'} onClick={() => setHalf('main')}>
          {props.mainLabel}
        </button>
      </div>
    </Show>
  );

  return (
    <div class="chat-pane pane-frame">
      <PaneHeader context={props.context} title={props.title} middle={toggle} />
      <div class="pane-body" classList={{ narrow: narrow(), resizing: dragging() }} ref={element => (body = element)}>
        <Show when={!narrow() || half() === 'panel'}>
          <div class="pane-side" style={narrow() ? undefined : { width: `${shownSide()}px` }}>
            <div
              class="pane-side-scale"
              style={sideScale() < 1 ? {
                zoom: String(sideScale()),
                width: `${shownSide() / sideScale()}px`,
                height: `${bodySize().height / sideScale()}px`,
              } : undefined}
            >
              {props.panel()}
            </div>
          </div>
        </Show>
        <Show when={!narrow()}>
          <div
            class="pane-split-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize tree (double-click to reset)"
            onPointerDown={startResize}
            onDblClick={resetWidth}
          />
        </Show>
        <Show when={!narrow() || half() === 'main'}>
          <div class="pane-main">{props.main()}</div>
        </Show>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------------------------

function TerminalPane(props: { context: PaneContext }): JSX.Element {
  const pane = () => props.context.pane();
  // Where the shell actually started (the project folder or home when the pane has no folder of its own).
  const [startedIn, setStartedIn] = createSignal<string>();
  const folder = () => pane()?.cwd ?? startedIn();
  return (
    <div class="chat-pane pane-frame">
      <PaneHeader
        context={props.context}
        title={pane()?.title || 'Terminal'}
        middle={
          <ProjectSwitch
            class="pane-cwd"
            path={folder()}
            onSelect={project => setPaneCwd(props.context.paneId, project.path)}
          />
        }
        actions={
          <IconButton
            icon="plus"
            label="New terminal"
            size="small"
            onClick={() => openPane('terminal', { cwd: pane()?.cwd })}
          />
        }
      />
      <div class="pane-body pane-terminal">
        {/* A new folder remounts the view, which replaces the shell with one started there. */}
        <For each={[pane()?.cwd]}>
          {cwd => (
            <TerminalView
              paneId={props.context.paneId}
              cwd={cwd}
              focused={props.context.focused()}
              onTitle={title => setPaneTitle(props.context.paneId, title)}
              onStarted={setStartedIn}
            />
          )}
        </For>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Source Control: the git view (screens/git) in the generic frame
// ---------------------------------------------------------------------------------------------

function GitPane(props: { context: PaneContext }): JSX.Element {
  return (
    <div class="chat-pane pane-frame">
      <PaneHeader context={props.context} title="Source Control" />
      <div class="pane-body pane-git">
        <GitView />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Image: fit, wheel zoom around the pointer (0.25x–8x), drag to pan when zoomed, double-click resets
// ---------------------------------------------------------------------------------------------

const minZoom = 0.25;
const maxZoom = 8;

function ImagePane(props: { context: PaneContext }): JSX.Element {
  const pane = (): PaneInstance | undefined => props.context.pane();
  const [zoom, setZoom] = createSignal(1);
  const [offset, setOffset] = createSignal({ x: 0, y: 0 });
  const [panning, setPanning] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  let view: HTMLDivElement | undefined;
  let drag: { x: number; y: number; originX: number; originY: number } | undefined;

  /** Zooms to `next`, keeping the image point under (px, py) — relative to the view's centre — in place. */
  const zoomAt = (next: number, px: number, py: number) => {
    const current = zoom();
    const target = Math.max(minZoom, Math.min(maxZoom, next));
    const ratio = target / current;
    const start = offset();
    if (target <= 1) {
      setOffset({ x: 0, y: 0 });
    } else {
      setOffset({ x: px - (px - start.x) * ratio, y: py - (py - start.y) * ratio });
    }
    setZoom(target);
  };

  const reset = () => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  };

  const onWheel = (event: WheelEvent) => {
    if (!view) return;
    event.preventDefault();
    const rect = view.getBoundingClientRect();
    const px = event.clientX - rect.left - rect.width / 2;
    const py = event.clientY - rect.top - rect.height / 2;
    zoomAt(zoom() * Math.exp(-event.deltaY * 0.0015), px, py);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || zoom() <= 1 || !view) return;
    const start = offset();
    drag = { x: event.clientX, y: event.clientY, originX: start.x, originY: start.y };
    view.setPointerCapture(event.pointerId);
    setPanning(true);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!drag) return;
    setOffset({ x: drag.originX + event.clientX - drag.x, y: drag.originY + event.clientY - drag.y });
  };

  const endPan = () => {
    drag = undefined;
    setPanning(false);
  };

  return (
    <div class="chat-pane pane-frame">
      <PaneHeader context={props.context} title={pane()?.title || 'Image'} />
      <div
        class="pane-body pane-image"
        classList={{ zoomed: zoom() > 1, panning: panning() }}
        ref={element => {
          view = element;
          element.addEventListener('wheel', onWheel, { passive: false });
          onCleanup(() => element.removeEventListener('wheel', onWheel));
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onDblClick={reset}
      >
        <Show
          when={!failed() && pane()?.src}
          fallback={<p class="pane-image-missing type-caption">Image unavailable</p>}
        >
          <img
            class="pane-image-img"
            src={pane()?.src}
            alt={pane()?.title || 'Image'}
            draggable={false}
            onError={() => setFailed(true)}
            style={{ transform: `translate(${offset().x}px, ${offset().y}px) scale(${zoom()})` }}
          />
        </Show>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Empty slot
// ---------------------------------------------------------------------------------------------

/** A leaf with no pane: open a Files, Knowledge, Terminal or Source Control pane here. Chats and images arrive by drop. */
export function EmptySlot(props: { context: EmptySlotContext }): JSX.Element {
  const fill = (kind: 'files' | 'knowledge' | 'terminal' | 'git') => fillSlot(props.context.leafKey, kind);
  return (
    <div class="pane-empty">
      <section class="pane-empty-card" classList={{ focused: props.context.focused() }}>
        <button type="button" class="pane-empty-close" aria-label="Close empty slot" onClick={() => props.context.close()}>
          <Icon name="close" size={12} />
        </button>
        <h3 class="pane-empty-title type-heading">Empty slot</h3>
        <div class="pane-empty-actions">
          <Button variant="secondary" onClick={() => fill('files')}>Files</Button>
          <Button variant="secondary" onClick={() => fill('knowledge')}>Knowledge</Button>
          <Button variant="secondary" onClick={() => fill('terminal')}>Terminal</Button>
          <Button variant="secondary" onClick={() => fill('git')}>Source Control</Button>
        </div>
        <p class="pane-empty-hint type-caption">or drop a chat, pane or image here</p>
      </section>
    </div>
  );
}
