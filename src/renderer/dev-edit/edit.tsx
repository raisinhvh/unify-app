/**
 * DEV ONLY: the live edit preview rows (screens/chats/EditPreview.tsx) in a real Timeline on the mock bridge.
 *
 *   /dev-edit/edit.html?theme=walnutDark            every row kind, the last one streaming on a 60 ms timer
 *   /dev-edit/edit.html?theme=walnutLight&hold=1    stop the stream before it lands (capture mid-stream)
 *   /dev-edit/edit.html?reduced=1                   reduced motion
 *   /dev-edit/edit.html?manual=1                    wait for __editPreview.restart() (capture.mjs)
 *
 * Rows: a landed edit collapsed with "Show N more lines", a "Multiple files" edit, a failed edit, an edit with no
 * preview (the provider sent no input), a subagent editing (its row's "Working…" fades into an inline code chip
 * of the last line it wrote: the removed line, then each added line, then back to text when the edit lands), and a
 * streaming edit whose diff grows: one old line is removed, three lines are typed in a few characters at a time.
 * `window.__editPreview.restart()` replays the stream; capture.mjs drives the screenshots.
 */
import type { SidebarEditLine, SidebarEditPreview, SidebarHostMessage, SidebarToolEvent } from '../protocol';

declare global {
  interface Window {
    __editPreview?: { restart(): void; done: boolean };
  }
}

const chatId = 'dev-edit';
const tickMs = 60;
const charactersPerTick = 4;

function context(number: number, text: string): SidebarEditLine {
  return { kind: 'context', text, oldLine: number, newLine: number };
}

function removed(number: number, text: string): SidebarEditLine {
  return { kind: 'removed', text, oldLine: number };
}

function added(number: number, text: string): SidebarEditLine {
  return { kind: 'added', text, newLine: number };
}

function preview(path: string, lines: SidebarEditLine[], extra: Partial<SidebarEditPreview> = {}): SidebarEditPreview {
  return {
    path,
    files: 1,
    lines,
    additions: lines.filter(line => line.kind === 'added').length,
    deletions: lines.filter(line => line.kind === 'removed').length,
    streaming: false,
    ...extra,
  };
}

function toolEvent(event: SidebarToolEvent): SidebarHostMessage {
  return { type: 'toolEvent', sessionId: chatId, event };
}

const landedEdit = preview('src/renderer/store/index.ts', [
  context(286, '          const sessionId = message.sessionId || state.activeSessionId;'),
  removed(287, '          if (sessionId && event.kind !== \'edit\' && event.kind !== \'subagent\') {'),
  added(287, '          // Edit calls get their own row (live edit preview).'),
  added(288, '          if (sessionId && event.kind !== \'subagent\') {'),
  context(288, '            const timeline = timelineOf(state, sessionId);'),
  context(289, '            const id = message.entryId || `tool:${event.id}`;'),
  context(290, '            const entry = timeline.find(item => item.id === id);'),
  removed(291, '            if (entry) entry.event = event;'),
  added(292, '            if (entry && entry.kind === \'tool\') entry.event = event;'),
  context(292, '            else timeline.push({ id, kind: \'tool\', event });'),
  context(293, '          }'),
  context(294, '        }));'),
]);
// The context lines carry the new numbering after the first hunk.
landedEdit.lines = landedEdit.lines.map(line => (line.kind === 'context' && line.oldLine && line.oldLine >= 288 ? { ...line, newLine: line.oldLine + 1 } : line));

const multipleFiles = preview(
  'src/engine/sidebar/view.ts',
  [
    context(351, '  media?: SidebarMedia[];'),
    added(352, '  /** Unify: the change an edit call makes, updated while its input streams in. */'),
    added(353, '  edit?: SidebarEditPreview;'),
    context(354, '}'),
    context(386, '  internal?: SidebarInternalTool;'),
    added(389, '  edit?: SidebarEditPreview;'),
    added(390, '  state?: SidebarToolEvent[\'state\'];'),
    context(391, '}'),
  ],
  { files: 3, additions: 24, deletions: 6 },
);

const failedEdit = preview('src/renderer/screens/chats/chat-pane.css', [
  context(199, ''),
  removed(200, '.diff-add {'),
  added(200, '.diff-added {'),
  context(201, '  color: var(--add);'),
], {
  error: 'old_string not found in src/renderer/screens/chats/chat-pane.css: the file changed since it was read. Read it again and retry the edit with the current text.',
});

/* The streaming edit: what arrives, step by step. */

const streamPath = 'src/renderer/screens/chats/Timeline.tsx';
const streamBefore = [
  context(79, '  for (const entry of timeline) {'),
  context(80, '    if (entry.kind === \'tool\') {'),
];
const streamRemoved = removed(81, '      if (entry.event.kind === \'edit\' || entry.event.kind === \'subagent\') continue;');
const streamAdded = [
  '      if (entry.event.kind === \'subagent\') continue;',
  '      if (entry.event.kind === \'edit\' && editRows) {',
  '        items.push({ id: entry.id, kind: \'edit\', event: entry.event });',
];
const streamAfter = [
  context(82, '      const last = items[items.length - 1];'),
  context(83, '      if (last?.kind === \'toolbatch\') last.tools.push(entry.event);'),
];

function streamFrames(): SidebarEditPreview[] {
  const frames: SidebarEditPreview[] = [];
  frames.push(preview(streamPath, [...streamBefore], { streaming: true }));
  frames.push(preview(streamPath, [...streamBefore, streamRemoved], { streaming: true }));
  const total = streamAdded.join('\n');
  for (let length = charactersPerTick; length < total.length + charactersPerTick; length += charactersPerTick) {
    const typed = total.slice(0, length).split('\n');
    const lines = [...streamBefore, streamRemoved, ...typed.map((text, index) => added(81 + index, text))];
    frames.push(preview(streamPath, lines, { streaming: true }));
  }
  const finalLines = [
    ...streamBefore,
    streamRemoved,
    ...streamAdded.map((text, index) => added(81 + index, text)),
    ...streamAfter.map(line => ({ ...line, newLine: (line.oldLine ?? 0) + 2 })),
  ];
  frames.push(preview(streamPath, finalLines));
  return frames;
}

/* The subagent's live line. */

const subagentId = 'dev-agent';
/** Lines the subagent writes one after another (each new one crossfades the chip). */
const subagentLines = [
  '  const seconds = Math.floor(milliseconds / 1000);',
  '  const rest = seconds % 60;',
  '  return `${Math.floor(seconds / 60)}:${rest.toString().padStart(2, \'0\')}`;',
];

/** The subagent's edit after `written` characters: first only the removed line (red), then the added lines. */
function subagentFrame(written: number, streaming: boolean): SidebarHostMessage {
  const lines: SidebarEditLine[] = [
    context(11, 'export function formatElapsed(milliseconds: number): string {'),
    removed(12, '  return String(milliseconds);'),
  ];
  let left = written;
  subagentLines.forEach((text, index) => {
    if (left <= 0) return;
    lines.push(added(12 + index, text.slice(0, left)));
    left -= text.length;
  });
  return {
    type: 'subagentEvent',
    sessionId: chatId,
    agentId: subagentId,
    messageId: 'agent-edit',
    role: 'tool',
    tool: {
      title: 'Edit',
      detail: 'src/renderer/screens/chats/format.ts',
      kind: 'edit',
      state: streaming ? 'running' : 'complete',
      edit: preview('src/renderer/screens/chats/format.ts', lines, { streaming }),
    },
  };
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const { installMockBridge } = await import('../dev/mockBridge');
  await installMockBridge();
  const persist = await import('../persist');
  persist.writePersisted('theme', params.get('theme') ?? 'walnutDark');
  const [{ render }, { installTheme }, { Timeline }, { applyHostMessage }, { setAppReducedMotion }] = await Promise.all([
    import('solid-js/web'),
    import('../theme'),
    import('../screens/chats/Timeline'),
    import('../store'),
    import('../motion'),
  ]);
  installTheme();
  if (params.get('reduced')) setAppReducedMotion(true);
  const emit = (message: SidebarHostMessage) => applyHostMessage(message);

  emit({ type: 'assistantDelta', sessionId: chatId, entryId: 'assistant:1', text: 'Updating the store so edit calls reach the timeline.' } as SidebarHostMessage);
  emit(toolEvent({ id: 'edit-landed', kind: 'edit', title: 'Edit', detail: landedEdit.path, state: 'complete', edit: landedEdit }));
  emit(toolEvent({ id: 'edit-multiple', kind: 'edit', title: 'apply_patch', detail: multipleFiles.path, state: 'complete', edit: multipleFiles }));
  emit(toolEvent({ id: 'edit-failed', kind: 'edit', title: 'Edit', detail: failedEdit.path, state: 'error', edit: failedEdit }));
  emit(toolEvent({ id: 'edit-plain', kind: 'edit', title: 'Edit', detail: 'src/renderer/store/features.ts', state: 'complete' }));
  emit({
    type: 'subagentEvent',
    sessionId: chatId,
    agentId: subagentId,
    title: 'Format elapsed time',
    model: 'sonnet-5.5',
    state: 'running',
  });

  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing');
  root.style.display = 'flex';
  root.style.justifyContent = 'center';
  render(
    () => (
      <div
        style={{
          display: 'flex',
          'flex-direction': 'column',
          width: '620px',
          height: '100%',
          'border-left': '1px solid var(--border)',
          'border-right': '1px solid var(--border)',
        }}
      >
        <Timeline chatId={chatId} />
      </div>
    ),
    root,
  );

  const hold = params.get('hold') === '1';
  const timers: number[] = [];
  const state = { done: false, restart };

  function restart(): void {
    for (const timer of timers.splice(0)) window.clearTimeout(timer);
    state.done = false;
    const frames = streamFrames();
    const streamId = `edit-stream-${Date.now()}`;
    frames.forEach((frame, index) => {
      const last = index === frames.length - 1;
      timers.push(window.setTimeout(() => {
        if (hold && last) return;
        emit(toolEvent({
          id: streamId,
          kind: 'edit',
          title: 'Edit',
          detail: streamPath,
          state: last ? 'complete' : 'running',
          edit: frame,
        }));
        if (last) state.done = true;
      }, 400 + index * tickMs));
    });
    // The removed line shows alone for a beat, the added lines type in, then the edit lands (chip fades out).
    const total = subagentLines.reduce((sum, text) => sum + text.length, 0);
    for (let written = 0; written <= total; written += 2) {
      timers.push(window.setTimeout(() => emit(subagentFrame(written, true)), 200 + (written > 0 ? 600 : 0) + written * 25));
    }
    timers.push(window.setTimeout(() => emit(subagentFrame(total, false)), 200 + 600 + total * 25 + 900));
  }

  window.__editPreview = state;
  // capture.mjs starts the stream itself (?manual=1) so its frame times have a known start.
  if (params.get('manual') !== '1') {
    restart();
  }
}

void boot();
