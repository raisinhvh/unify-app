/**
 * DEV ONLY: the real app on the mock bridge, with triggers for the wave-3b organic motion wiring.
 *
 *   /dev-w3b/w3b.html?fixture=home&theme=walnutLight
 *
 * Every effect is pushed from outside (capture.mjs, motion-audit scenarios, the console) through `__w3b`:
 *
 *   __w3b.go('files')                      open a rail route (the Chats panel is opened for 'chats')
 *   __w3b.renameChat('s-acp', 'New name')  the engine renames a chat: its title retypes
 *   __w3b.startActive()                    three chats start running: they fill the Active group
 *   __w3b.reorderActive()                  the bottom active chat asks for approval: it lifts to the top
 *   __w3b.setUsage(62)                     Claude's session % changes: every usage counter rolls
 *   __w3b.createFile / deleteFile / renameFile / editFile   mock agent writes in the Files tree and editor
 *   __w3b.seedDocs()                       hand the mock rules and skills over as the engine's list (once, first)
 *   __w3b.createDoc / deleteDoc / renameDoc                 global rules change (as the engine reports them)
 *
 *   /dev-w3b/w3b.html?standalone=editor   FilesEditor alone in its plain view (see startEditorAlone)
 */
import type { SidebarHostMessage } from '../protocol';

export const w3bTriggers = {
  go: (_route: string) => {},
};

type MockWindow = Window & {
  __unifyMock?: { emit: (message: SidebarHostMessage) => void };
  __w3b?: Record<string, unknown>;
};

function emitHost(message: SidebarHostMessage): void {
  const mock = (window as MockWindow).__unifyMock;
  if (!mock) throw new Error('mock bridge is not installed');
  mock.emit(message);
}

function usageMessage(sessionPercent: number): SidebarHostMessage {
  return {
    type: 'usageState',
    usage: {
      'acc-claude': {
        status: 'ready',
        fetchedAt: Date.now(),
        plan: { name: 'Max', monthlyUsd: 100 },
        metrics: [
          { label: 'Session', value: `${sessionPercent}%`, usedPercent: sessionPercent, resetsAt: Date.now() + 140 * 60_000 },
          { label: 'Week', value: '21%', usedPercent: 21, resetsAt: Date.now() + 5000 * 60_000 },
        ],
      },
      'acc-codex': {
        status: 'ready',
        fetchedAt: Date.now(),
        plan: { name: 'Plus', monthlyUsd: 20 },
        metrics: [{ label: '5 hour', value: '14%', usedPercent: 14, resetsAt: Date.now() + 200 * 60_000 }],
      },
    },
  } as SidebarHostMessage;
}

const activeSessionIds = ['s-hub', 's-release', 's-acp'];

const editedSource = [
  "import type { ToolpackManifest } from './types';",
  '',
  'export class ToolpackRegistry {',
  '  private readonly packs = new Map<string, ToolpackManifest>();',
  '',
  '  register(manifest: ToolpackManifest): void {',
  '    if (this.packs.has(manifest.id)) {',
  '      throw new Error(`duplicate toolpack ${manifest.id}`);',
  '    }',
  '    this.packs.set(manifest.id, manifest);',
  '  }',
  '',
  '  list(): ToolpackManifest[] {',
  '    return [...this.packs.values()];',
  '  }',
  '}',
  '',
].join('\n');

const reEditedSource = editedSource
  .replace('      throw new Error(`duplicate toolpack ${manifest.id}`);\n', '      return;\n')
  .replace('  list(): ToolpackManifest[] {', '  /** Every registered pack, in registration order. */\n  list(): ToolpackManifest[] {');

async function installTriggers(): Promise<void> {
  const { navigate } = await import('../router');
  const files = await import('../screens/files/adapter');
  const filesState = await import('../screens/files/state');
  const knowledge = await import('../screens/knowledge/adapter');
  const { viewState } = await import('../store');

  const go = (route: string) => {
    navigate(route as Parameters<typeof navigate>[0]);
  };
  w3bTriggers.go = go;

  const findDoc = (name: string) => knowledge.knowledgeItems().find(item => item.name === name);
  // The mock bridge only logs knowledge saves, so the docs change the way the engine reports them.
  const emitInstructions = (items: typeof viewState.instructions) => {
    emitHost({ type: 'instructionsState', items: items.map(item => ({ ...item })) } as SidebarHostMessage);
  };

  (window as MockWindow).__w3b = {
    go,
    renameChat(sessionId: string, name: string) {
      const sessions = viewState.sessions.map(session => (session.id === sessionId ? { ...session, name } : { ...session }));
      emitHost({ type: 'sessionState', sessions, activeSessionId: viewState.activeSessionId } as SidebarHostMessage);
    },
    startActive() {
      for (const sessionId of activeSessionIds) {
        emitHost({ type: 'runState', sessionId, state: 'thinking', label: 'Thinking' } as SidebarHostMessage);
      }
    },
    reorderActive() {
      emitHost({
        type: 'approvalRequest',
        sessionId: activeSessionIds[0],
        id: `w3b-${Date.now()}`,
        title: 'Run npm test',
        detail: 'npm test',
      } as SidebarHostMessage);
    },
    setUsage(sessionPercent: number) {
      emitHost(usageMessage(sessionPercent));
    },
    openFile(path: string) {
      filesState.openFile(path);
    },
    createFile(path: string) {
      files.mockCreateFile(path, `// ${files.baseName(path)}\n`);
    },
    deleteFile(path: string) {
      files.mockDeleteFile(path);
    },
    renameFile(from: string, to: string) {
      files.mockRenameFile(from, to);
    },
    editFile(step: number) {
      const path = 'src/toolpacks/registry.ts';
      if (step === 0) files.mockEditFile(path, editedSource);
      else {
        files.mockEditFile(path, reEditedSource, {
          added: [8, 13],
          removed: [{ afterLine: 7, lines: ['      throw new Error(`duplicate toolpack ${manifest.id}`);'] }],
        });
      }
    },
    seedDocs() {
      emitInstructions(
        knowledge
          .knowledgeItems()
          .filter(item => item.kind !== 'memory')
          .map(item => ({
            id: item.id,
            kind: item.kind as 'rule' | 'skill',
            scope: item.scope === 'project' ? ('workspace' as const) : ('global' as const),
            name: item.name,
            path: item.path ?? `${item.kind}s/${item.name}.md`,
            description: item.description,
          })),
      );
    },
    createDoc(name: string) {
      const instruction = { id: `w3b-${name}`, kind: 'rule' as const, scope: 'global' as const, name, path: `rules/${name}.md` };
      emitInstructions([...viewState.instructions, instruction]);
    },
    deleteDoc(name: string) {
      const item = findDoc(name);
      if (item) emitInstructions(viewState.instructions.filter(instruction => instruction.id !== item.id));
    },
    renameDoc(from: string, to: string) {
      const item = findDoc(from);
      if (item) emitInstructions(viewState.instructions.map(instruction => (instruction.id === item.id ? { ...instruction, name: to } : instruction)));
    },
  };
}

/**
 * `?standalone=editor`: FilesEditor alone with `editor.enabled` off. The Shell hides the Files route whenever
 * that feature is off, so the plain view (the only one EditedLines drives) cannot be reached inside the app.
 */
async function startEditorAlone(root: HTMLElement): Promise<void> {
  const { render } = await import('solid-js/web');
  const { installTheme } = await import('../theme');
  const { connectStore } = await import('../store');
  const { FilesEditor } = await import('../screens/files/FilesEditor');
  installTheme();
  connectStore();
  render(
    () => (
      <div class="files-screen" style={{ width: '760px', height: '520px' }}>
        <FilesEditor />
      </div>
    ),
    root,
  );
  (window as MockWindow).__unifyMock?.emit({ type: 'unifyFeaturesState', features: { 'editor.enabled': false } } as SidebarHostMessage);
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const { installMockBridge } = await import('../dev/mockBridge');
  await installMockBridge();
  const persist = await import('../persist');
  persist.writePersisted('setupComplete', true);
  persist.writePersisted('panelOpen', true);
  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing');
  if (params.get('standalone') === 'editor') {
    await startEditorAlone(root);
    await installTriggers();
    return;
  }
  const { startApp } = await import('../App');
  startApp(root);
  await installTriggers();
  const route = params.get('route');
  if (route) w3bTriggers.go(route);
}

void boot();
