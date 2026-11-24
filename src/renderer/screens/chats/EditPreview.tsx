/**
 * Live edit preview (spec: "Live edit preview in chat"). An edit call is its own row in the timeline:
 *
 *   ◌ Editing  Timeline.tsx  +24 −6                                   0:12
 *   │  41    const rows = …                         context (muted)
 *   │  42 −  const old = …                          removed (red tint)
 *   │  42 +  const next = …|                        added (green tint, caret on the growing line)
 *
 *   - while the call's input streams in, the diff grows under the row and the last ~8 lines stay in view
 *     (the window glides to follow the tail); new lines wipe in, lines that turn into something else sweep out
 *     (EditedLines, motion.organic.codeEdits)
 *   - when the edit lands the label retypes to "Edited" and the window settles to ~4 lines around the first
 *     change, with "Show N more lines" to spring it open; the file name opens the file in the Files editor
 *   - a failed edit reads "Edit failed" with the error in red and the diff dimmed
 *   - an edit without a preview (the provider sent no input) is the same row with just the file name
 *   - hunks are joined in `lines`; a jump in line numbers draws a muted ⋯ row between them
 *
 * Elapsed time is tracked here (the event has no start time): from when the row is first seen running until it
 * leaves 'running', kept per call id so it survives the row remounting.
 *
 * LiveEditDetail is the one-line version in a subagent's row in the parent chat: the row's detail text fades
 * into an inline code chip of the last line the subagent's current edit wrote (green added, red removed).
 */
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, untrack, type JSX } from 'solid-js';
import { Icon, Loader, actionLabel, actionLoader, toolAction, tooltip } from '../../components';
import { post } from '../../bridge';
import { Collapse, driveSpring, useSpring } from '../../motion';
import { Caret, EditedLines, RetypeText, RollingNumber } from '../../motion/organic';
import type { SidebarEditLine, SidebarEditPreview, SidebarToolEvent } from '../../protocol';
import './edit-preview.css';

/** What an edit row needs: a main-agent tool event or a subagent's tool message. */
export interface EditTool {
  title: string;
  detail?: string;
  full?: string;
  kind: SidebarToolEvent['kind'];
  state: SidebarToolEvent['state'];
  edit?: SidebarEditPreview;
}

/** Height of one diff line (px); matches .edit-line in edit-preview.css. */
const lineHeight = 17;
/** Lines in view while the edit streams in (the tail follows). */
const streamingRows = 8;
/** Lines in view once the edit has landed, around its first change. */
const settledRows = 4;
/** A finished diff this short shows whole, without a "Show more" button. */
const wholeDiffRows = 6;

type DiffRowKind = SidebarEditLine['kind'] | 'gap';

interface DiffRow {
  key: string;
  kind: DiffRowKind;
  text: string;
  number?: number;
  /** The first removed or added line: the settled window opens around it. */
  firstChange: boolean;
  /** The last line while streaming: carries the typing caret. */
  tail: boolean;
}

/* Elapsed time */

interface EditTiming {
  start: number;
  end?: number;
}

const editTimings = new Map<string, EditTiming>();

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toString().padStart(2, '0')}`;
}

/** Seconds since the call was first seen running, frozen once it stops. Undefined for calls never seen running. */
function createElapsed(id: () => string, state: () => SidebarToolEvent['state']): () => string | undefined {
  const [now, setNow] = createSignal(Date.now());
  const [timing, setTiming] = createSignal<EditTiming | undefined>(untrack(() => editTimings.get(id())));
  let ticker: number | undefined;

  const stopTicker = () => {
    window.clearInterval(ticker);
    ticker = undefined;
  };

  createEffect(() => {
    const running = state() === 'running';
    const key = id();
    let current = editTimings.get(key);
    if (running && !current) {
      current = { start: Date.now() };
      editTimings.set(key, current);
    }
    if (!running && current && current.end === undefined) {
      current.end = Date.now();
    }
    setTiming(current ? { ...current } : undefined);
    if (running && ticker === undefined) {
      setNow(Date.now());
      ticker = window.setInterval(() => setNow(Date.now()), 1000);
    } else if (!running) {
      stopTicker();
    }
  });

  onCleanup(stopTicker);

  return () => {
    const current = timing();
    if (!current) {
      return undefined;
    }
    return formatElapsed((current.end ?? now()) - current.start);
  };
}

/* Diff rows */

function lineNumber(line: SidebarEditLine): number | undefined {
  return line.kind === 'removed' ? line.oldLine : line.newLine ?? line.oldLine;
}

/**
 * Display rows with stable keys (kind + line numbers, so a context line that turns into a removed line leaves and
 * the removed one joins) and a ⋯ gap row wherever the line numbers jump.
 */
function diffRows(edit: SidebarEditPreview): DiffRow[] {
  const rows: DiffRow[] = [];
  const seen = new Map<string, number>();
  let lastOld: number | undefined;
  let lastNew: number | undefined;
  let firstChangeFound = false;
  for (const line of edit.lines) {
    const jumpedOld = line.oldLine !== undefined && lastOld !== undefined && line.oldLine !== lastOld + 1;
    const jumpedNew = line.newLine !== undefined && lastNew !== undefined && line.newLine !== lastNew + 1;
    const baseKey = `${line.kind}:${line.oldLine ?? ''}:${line.newLine ?? ''}`;
    const occurrence = seen.get(baseKey) ?? 0;
    seen.set(baseKey, occurrence + 1);
    const key = occurrence ? `${baseKey}#${occurrence}` : baseKey;
    if (rows.length && (jumpedOld || jumpedNew)) {
      rows.push({ key: `gap:${key}`, kind: 'gap', text: '', firstChange: false, tail: false });
    }
    const change = line.kind !== 'context';
    rows.push({
      key,
      kind: line.kind,
      text: line.text,
      number: lineNumber(line),
      firstChange: change && !firstChangeFound,
      tail: false,
    });
    if (change) {
      firstChangeFound = true;
    }
    if (line.oldLine !== undefined) {
      lastOld = line.oldLine;
    }
    if (line.newLine !== undefined) {
      lastNew = line.newLine;
    }
  }
  if (edit.streaming && rows.length) {
    rows[rows.length - 1].tail = true;
  }
  return rows;
}

function gutterWidth(rows: DiffRow[]): number {
  let largest = 0;
  for (const row of rows) {
    if (row.number !== undefined && row.number > largest) {
      largest = row.number;
    }
  }
  return Math.max(2, String(largest).length);
}

function marker(kind: DiffRowKind): string {
  if (kind === 'removed') return '−';
  if (kind === 'added') return '+';
  return ' ';
}

export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function firstChangedLine(edit: SidebarEditPreview): number | undefined {
  const change = edit.lines.find(line => line.kind !== 'context');
  return change?.newLine ?? change?.oldLine ?? edit.lines[0]?.newLine;
}

function openEditedFile(edit: SidebarEditPreview): void {
  post({ type: 'openFile', path: edit.path, line: firstChangedLine(edit) });
}

/* The row */

function editLabel(tool: EditTool): string {
  const action = toolAction(tool);
  if (tool.state === 'running') return actionLabel[action];
  if (tool.state === 'error') return 'Edit failed';
  if (tool.state === 'cancelled') return 'Cancelled';
  return action === 'writing' ? 'Wrote' : 'Edited';
}

function EditGlyph(props: { tool: EditTool }): JSX.Element {
  return (
    <span class="tool-glyph">
      <Show
        when={props.tool.state === 'running'}
        fallback={<Icon name={props.tool.state === 'error' ? 'close' : props.tool.state === 'cancelled' ? 'stop' : 'check'} size={12} />}
      >
        <Loader id={actionLoader[toolAction(props.tool)]} size={12} />
      </Show>
    </span>
  );
}

function EditFile(props: { tool: EditTool }): JSX.Element {
  const label = () => {
    const edit = props.tool.edit;
    if (edit && edit.files > 1) return 'Multiple files';
    if (edit) return fileName(edit.path);
    return fileName((props.tool.detail || '').trim());
  };
  return (
    <Show
      when={props.tool.edit}
      fallback={
        <Show when={label()}>
          <span class="edit-file">{label()}</span>
        </Show>
      }
    >
      {edit => (
        <button
          type="button"
          class="edit-file edit-file-button"
          aria-label={`Open ${edit().path}`}
          ref={element => tooltip(element, () => <span class="type-mono tool-tip">{edit().path}</span>, { placement: 'top-start', delay: 500 })}
          onClick={() => openEditedFile(edit())}
        >
          {label()}
        </button>
      )}
    </Show>
  );
}

/** An edit call: the head row, and the diff under it on a guide line. */
export function EditRow(props: { id: string; tool: EditTool }): JSX.Element {
  const elapsed = createElapsed(() => props.id, () => props.tool.state);
  const edit = () => props.tool.edit;
  const rows = createMemo(() => (edit() ? diffRows(edit()!) : []));
  const failed = () => props.tool.state === 'error';
  const error = () => edit()?.error || (failed() ? props.tool.detail : undefined);
  // Rows first seen running reveal their diff; rows from history show it in place.
  const live = untrack(() => props.tool.state === 'running');
  return (
    <div class="feed-entry edit-entry" classList={{ [`tool-${props.tool.state}`]: true }}>
      <div class="tool-row edit-head">
        <EditGlyph tool={props.tool} />
        <span class="tool-row-title edit-label">
          <RetypeText value={editLabel(props.tool)} speed="fast" />
        </span>
        <EditFile tool={props.tool} />
        <Show when={edit() && !failed()}>
          <span class="edit-counts">
            <RollingNumber class="edit-additions" value={`+${edit()!.additions}`} />
            <Show when={edit()!.deletions > 0 || rows().some(row => row.kind === 'removed')}>
              <RollingNumber class="edit-deletions" value={`−${edit()!.deletions}`} />
            </Show>
          </span>
        </Show>
        <Show when={failed() && error()}>
          {text => (
            <span
              class="edit-error"
              ref={element => tooltip(element, () => <span class="edit-error-tip">{text()}</span>, { placement: 'top-start', delay: 300 })}
            >
              {text().replace(/\s+/g, ' ')}
            </span>
          )}
        </Show>
        <span class="edit-spacer" />
        <Show when={elapsed()}>
          {time => <RollingNumber class="edit-elapsed" value={time()} />}
        </Show>
      </div>
      <Collapse open={rows().length > 0} appear={live}>
        <div class="edit-body-slot">
          <EditDiff
            rows={rows()}
            streaming={!!edit()?.streaming && props.tool.state === 'running'}
            failed={failed()}
            truncated={!!edit()?.truncated}
          />
        </div>
      </Collapse>
    </div>
  );
}

/**
 * The diff window. Its height and the content's offset are springs: streaming keeps the tail in view, a landed
 * edit settles around its first change, and "Show N more lines" springs it open to every line.
 */
function EditDiff(props: { rows: DiffRow[]; streaming: boolean; failed: boolean; truncated: boolean }): JSX.Element {
  let viewport!: HTMLDivElement;
  let content!: HTMLDivElement;
  const [expanded, setExpanded] = createSignal(false);
  const height = useSpring(0, 'reveal', 100);
  const offset = useSpring(0, 'panel', 100);
  let contentHeight = 0;
  let placed = false;

  const paintFades = () => {
    const top = offset.value > 1;
    // While streaming the newest line is at the bottom edge; never fade it.
    const bottom = !props.streaming && contentHeight - offset.value - height.value > 1;
    viewport.classList.toggle('edit-fade-top', top);
    viewport.classList.toggle('edit-fade-bottom', bottom);
  };

  height.onChange(value => {
    viewport.style.height = `${Math.max(0, value)}px`;
    paintFades();
  });
  offset.onChange(value => {
    content.style.transform = value ? `translateY(${-value}px)` : '';
    paintFades();
  });

  const settledLimit = () => (props.rows.length <= wholeDiffRows ? props.rows.length : settledRows);
  const collapsible = () => !props.streaming && props.rows.length > wholeDiffRows;
  const hiddenCount = () => props.rows.filter(row => row.kind !== 'gap').length - settledRows;

  /** Top of the settled window: one line above the first change. */
  const settledOffset = (): number => {
    const first = content.querySelector<HTMLElement>('[data-first-change]');
    if (!first) return 0;
    const top = first.getBoundingClientRect().top - content.getBoundingClientRect().top;
    return Math.max(0, top - lineHeight);
  };

  const layout = () => {
    if (!viewport || !content) return;
    contentHeight = content.offsetHeight;
    let targetHeight: number;
    let targetOffset: number;
    if (expanded() && !props.streaming) {
      targetHeight = contentHeight;
      targetOffset = 0;
    } else if (props.streaming) {
      targetHeight = Math.min(contentHeight, streamingRows * lineHeight);
      targetOffset = contentHeight - targetHeight;
    } else {
      targetHeight = Math.min(contentHeight, settledLimit() * lineHeight);
      targetOffset = Math.min(settledOffset(), contentHeight - targetHeight);
    }
    targetOffset = Math.max(0, targetOffset);
    if (!placed) {
      placed = true;
      height.jump(targetHeight);
      offset.jump(targetOffset);
      return;
    }
    driveSpring(height, targetHeight, 'reveal');
    driveSpring(offset, targetOffset, 'panel');
  };

  createEffect(on(() => [props.rows, props.streaming, expanded()], () => queueMicrotask(layout)));

  onMount(() => {
    layout();
    // Lines reveal (and sweep out) on their own springs; follow the content's height as it moves.
    const observer = new ResizeObserver(() => layout());
    observer.observe(content);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div class="edit-body" classList={{ 'edit-body-failed': props.failed }}>
      <div ref={viewport} class="edit-viewport type-mono">
        <div ref={content} class="edit-lines-content" style={{ '--edit-gutter': `${gutterWidth(props.rows)}ch` }}>
          <EditedLines
            each={props.rows}
            key={row => row.key}
            class="edit-lines"
            lineClass="edit-line"
            caretColor={props.streaming ? 'transparent' : undefined}
          >
            {row => (
              <span
                class={`edit-line-inner edit-line-${row().kind}`}
                data-first-change={row().firstChange ? '' : undefined}
              >
                <Show
                  when={row().kind !== 'gap'}
                  fallback={<span class="edit-gap">⋯</span>}
                >
                  <span class="edit-number">{row().number ?? ''}</span>
                  <span class="edit-marker">{marker(row().kind)}</span>
                  <span class="edit-code">
                    {row().text}
                    <Show when={row().tail}>
                      <Caret phase="typing" />
                    </Show>
                  </span>
                </Show>
              </span>
            )}
          </EditedLines>
        </div>
      </div>
      <Show when={collapsible() && hiddenCount() > 0}>
        <button
          type="button"
          class="edit-more"
          aria-expanded={expanded()}
          onClick={() => setExpanded(!expanded())}
        >
          {expanded() ? 'Show fewer lines' : `Show ${hiddenCount()} more ${hiddenCount() === 1 ? 'line' : 'lines'}`}
        </button>
      </Show>
      <Show when={props.truncated && (expanded() || props.streaming)}>
        <span class="edit-truncated">More lines than the preview shows</span>
      </Show>
    </div>
  );
}

/* Subagent row */

/** The line a subagent's live edit wrote last: its latest added or removed line. */
function liveLine(edit: SidebarEditPreview): SidebarEditLine | undefined {
  for (let index = edit.lines.length - 1; index >= 0; index -= 1) {
    if (edit.lines[index].kind !== 'context') return edit.lines[index];
  }
  return undefined;
}

/** A new key is a new line (the chip crossfades); the same key growing types in place. */
function liveLineKey(line: SidebarEditLine): string {
  return `${line.kind}:${line.newLine ?? line.oldLine ?? ''}`;
}

interface LiveChip {
  key: string;
  line: SidebarEditLine;
  file: string;
}

function LiveEditChip(props: { chip: LiveChip; streaming: boolean; opacity: number; shift: number }): JSX.Element {
  return (
    <code
      class={`edit-live-chip edit-live-${props.chip.line.kind}`}
      aria-hidden={props.opacity < 0.5}
      style={{
        opacity: props.opacity,
        transform: `translateY(${props.shift}px)`,
      }}
    >
      <span class="edit-live-marker">{marker(props.chip.line.kind)}</span>
      <span class="edit-live-code">
        {props.chip.line.text.trim()}
        <Show when={props.streaming}>
          <Caret phase="typing" />
        </Show>
      </span>
    </code>
  );
}

/**
 * A subagent row's detail text. While the subagent edits, the text fades into an inline code chip of the last
 * line it wrote (green tint for added, red for removed), each new line crossfading over the one before, and
 * fades back to the text when the edit ends.
 */
export function LiveEditDetail(props: { edit?: SidebarEditPreview; text: string }): JSX.Element {
  const chip = createMemo<LiveChip | undefined>(() => {
    const edit = props.edit;
    const line = edit && liveLine(edit);
    if (!edit || !line) return undefined;
    return {
      key: liveLineKey(line),
      line,
      file: edit.files > 1 ? 'Multiple files' : fileName(edit.path),
    };
  });

  // The last chip stays while it fades out; the one before it fades out under a new line.
  const [current, setCurrent] = createSignal<LiveChip | undefined>(untrack(chip));
  const [previous, setPrevious] = createSignal<LiveChip | undefined>();
  const streaming = () => !!chip() && !!props.edit?.streaming;

  const presence = useSpring(untrack(chip) ? 1 : 0, 'panel');
  const swap = useSpring(1, 'panel');
  const [presenceValue, setPresenceValue] = createSignal(presence.value);
  const [swapValue, setSwapValue] = createSignal(swap.value);
  onCleanup(presence.onChange(setPresenceValue));
  onCleanup(swap.onChange(setSwapValue));

  createEffect(
    on(chip, next => {
      if (!next) {
        driveSpring(presence, 0);
        return;
      }
      const shown = untrack(current);
      if (shown && shown.key !== next.key && untrack(presenceValue) > 0.01) {
        setPrevious(shown);
        swap.jump(0);
        driveSpring(swap, 1);
      }
      setCurrent(next);
      driveSpring(presence, 1);
    }),
  );

  // The file name and chips fade in and out together; only the chips crossfade between lines.
  const codeOpacity = () => presenceValue();
  const textOpacity = () => 1 - presenceValue();
  // Lines enter from a touch below and leave a touch upward, like text being written down the page.
  const enterShift = () => (1 - swapValue()) * 4;
  const leaveShift = () => -swapValue() * 4;

  return (
    <span class="subagent-detail edit-live">
      <span
        class="edit-live-layer edit-live-text"
        aria-hidden={textOpacity() < 0.5}
        style={{ opacity: textOpacity() }}
      >
        {props.text}
      </span>
      <Show when={presenceValue() > 0.001 ? current() : undefined}>
        {chipNow => (
          <span
            class="edit-live-layer"
            style={{ opacity: codeOpacity() }}
          >
            <span class="edit-live-file">{chipNow().file}</span>
            <span class="edit-live-chips">
              <Show when={previous() && swapValue() < 1 ? previous() : undefined}>
                {chipBefore => (
                  <LiveEditChip
                    chip={chipBefore()}
                    streaming={false}
                    opacity={1 - swapValue()}
                    shift={leaveShift()}
                  />
                )}
              </Show>
              <LiveEditChip
                chip={chipNow()}
                streaming={streaming()}
                opacity={swapValue()}
                shift={enterShift()}
              />
            </span>
          </span>
        )}
      </Show>
    </span>
  );
}
