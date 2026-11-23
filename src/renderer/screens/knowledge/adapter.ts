/**
 * Knowledge data adapter: the only place the Knowledge screen talks to the engine.
 *
 * Unify keeps rules, skills and memory in one system: every item has a kind, a scope (global / this project)
 * and audiences (Everyone, Main agent, Subagents, or named subagent profiles). The engine today only knows
 * DSH's rules and skills (`viewState.instructions`, readInstruction / saveInstruction / removeInstruction)
 * and a memory summary. The full contract the screen needs is in ./protocol-requests.md and typed below.
 *
 * Source, in order:
 *   1. `knowledgeState` from the engine (the new contract), once it has been received;
 *   2. otherwise DSH's instructions mapped onto KnowledgeItem (no memory notes, audiences = Everyone);
 *   3. otherwise (dev mock bridge, or nothing at all) the Figma "21 · Knowledge" mock.
 */
import { createSignal } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { hasHostBridge, post } from '../../bridge';
import { onHostMessage, viewState } from '../../store';
import type { SidebarWebviewMessage } from '../../protocol';

// ---------------------------------------------------------------------------------------------------------------
// Contract (mirrors protocol-requests.md)

export type KnowledgeKind = 'rule' | 'skill' | 'memory';
export type KnowledgeScope = 'global' | 'project';
/** 'everyone' | 'main' | 'subagents' | 'profile:<subagent profile name>' */
export type Audience = 'everyone' | 'main' | 'subagents' | `profile:${string}`;

export interface KnowledgeItem {
  id: string;
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  /** Rule title, skill folder name, or memory note title. */
  name: string;
  /** Absolute path of the file (rule, note) or the skill folder. */
  path: string;
  /** Memory topic folder ("workflow"). Rules and skills have none. */
  folder?: string;
  description?: string;
  audiences: Audience[];
  /** Skills: files inside the folder, relative, forward slashes ("SKILL.md", "references/springs.md"). */
  files?: string[];
  createdBy?: string;
  createdAt?: number;
  updatedBy?: string;
  updatedAt?: number;
  /** Chats that loaded it in the last 7 days. */
  usedIn?: number;
}

export interface KnowledgeDraft {
  id?: string;
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  name: string;
  folder?: string;
  description?: string;
  audiences: Audience[];
}

export interface ImportedFile {
  /** Relative to the dropped folder, forward slashes. */
  path: string;
  /** UTF-8 text, or base64 when `encoding` is 'base64' (images inside a skill). */
  content: string;
  encoding?: 'utf8' | 'base64';
}

export type KnowledgeRequest =
  | { type: 'knowledgeList' }
  | { type: 'readKnowledge'; requestId: string; id: string; file?: string }
  | { type: 'saveKnowledge'; requestId: string; item: KnowledgeDraft; content: string; file?: string }
  | { type: 'removeKnowledge'; requestId: string; id: string }
  | { type: 'setKnowledgeAudience'; id: string; audiences: Audience[] }
  | { type: 'importSkillFolder'; requestId: string; scope: KnowledgeScope; name: string; files: ImportedFile[] }
  | { type: 'openKnowledge'; id: string; file?: string };

export type KnowledgeReply =
  | { type: 'knowledgeState'; items: KnowledgeItem[] }
  | { type: 'knowledgeContent'; requestId: string; id: string; file?: string; content: string }
  | { type: 'knowledgeSaved'; requestId: string; item: KnowledgeItem }
  | { type: 'knowledgeRemoved'; requestId: string; id: string }
  | { type: 'knowledgeError'; requestId: string; message: string };

// ---------------------------------------------------------------------------------------------------------------
// Source selection and transport

const [engineItems, setEngineItems] = createSignal<KnowledgeItem[] | undefined>();
const [mockItems, setMockItems] = createStore<KnowledgeItem[]>(initialMock());
const pending = new Map<string, (reply: KnowledgeReply) => void>();
let nextId = 0;

onHostMessage(raw => {
  const message = raw as unknown as KnowledgeReply;
  if (message.type === 'knowledgeState') {
    setEngineItems(message.items);
    return;
  }
  if ('requestId' in message && pending.has(message.requestId)) {
    pending.get(message.requestId)!(message);
    pending.delete(message.requestId);
  }
});

if (hasHostBridge()) post({ type: 'knowledgeList' } as unknown as SidebarWebviewMessage);

type Source = 'engine' | 'instructions' | 'mock';

export function source(): Source {
  if (engineItems()) return 'engine';
  if (hasHostBridge()) return 'instructions';
  return viewState.instructions.length ? 'instructions' : 'mock';
}

function request(body: Omit<Extract<KnowledgeRequest, { requestId: string }>, 'requestId'>, timeout = 4000): Promise<KnowledgeReply | undefined> {
  const requestId = `knowledge:${Date.now()}:${nextId++}`;
  return new Promise(resolve => {
    const timer = window.setTimeout(() => {
      pending.delete(requestId);
      resolve(undefined);
    }, timeout);
    pending.set(requestId, reply => {
      window.clearTimeout(timer);
      resolve(reply);
    });
    post({ ...body, requestId } as unknown as SidebarWebviewMessage);
  });
}

/** Waits for DSH's `instructionContent` reply for one instruction. */
function readInstruction(id: string): Promise<string> {
  return new Promise(resolve => {
    const timer = window.setTimeout(() => {
      stop();
      resolve('');
    }, 4000);
    const stop = onHostMessage(message => {
      if (message.type === 'instructionContent' && message.id === id) {
        window.clearTimeout(timer);
        stop();
        resolve(message.content);
      }
    });
    post({ type: 'readInstruction', id });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Public API

export function knowledgeItems(): KnowledgeItem[] {
  const current = source();
  if (current === 'engine') return engineItems()!;
  if (current === 'instructions') {
    return viewState.instructions.map(instruction => ({
      id: instruction.id,
      kind: instruction.kind,
      scope: instruction.scope === 'workspace' ? 'project' : 'global',
      name: instruction.name,
      path: instruction.path,
      description: instruction.description,
      audiences: ['everyone'],
      files: instruction.kind === 'skill' ? ['SKILL.md'] : undefined,
    }));
  }
  return mockItems;
}

export async function readKnowledge(item: KnowledgeItem, file?: string): Promise<string> {
  const current = source();
  if (current === 'engine') {
    const reply = await request({ type: 'readKnowledge', id: item.id, file });
    if (reply?.type === 'knowledgeContent') return reply.content;
    if (reply?.type === 'knowledgeError') throw new Error(reply.message);
    throw new Error('The engine did not answer');
  }
  if (current === 'instructions') return readInstruction(item.id);
  return mockContent.get(contentKey(item.id, file)) ?? `# ${file ?? item.name}\n\n(dev mock)\n`;
}

export async function saveKnowledge(draft: KnowledgeDraft, content: string, file?: string): Promise<KnowledgeItem> {
  const current = source();
  if (current === 'engine') {
    const reply = await request({ type: 'saveKnowledge', item: draft, content, file });
    if (reply?.type === 'knowledgeSaved') return reply.item;
    throw new Error(reply?.type === 'knowledgeError' ? reply.message : 'The engine did not answer');
  }
  if (current === 'instructions' && draft.kind !== 'memory') {
    post({
      type: 'saveInstruction',
      id: draft.id,
      kind: draft.kind,
      scope: draft.scope === 'project' ? 'workspace' : 'global',
      name: draft.name,
      description: draft.description,
      content,
    });
    const existing = draft.id ? knowledgeItems().find(item => item.id === draft.id) : undefined;
    return existing ? { ...existing, ...draft, id: existing.id } : { ...draft, id: draft.id ?? `pending:${Date.now()}`, path: '' };
  }
  return mockSave(draft, content, file);
}

export async function removeKnowledge(id: string): Promise<void> {
  const current = source();
  if (current === 'engine') {
    await request({ type: 'removeKnowledge', id });
    return;
  }
  if (current === 'instructions') {
    post({ type: 'removeInstruction', id });
    return;
  }
  setMockItems(items => items.filter(item => item.id !== id));
}

export function setAudiences(id: string, audiences: Audience[]): void {
  if (source() === 'engine') {
    // Optimistic: the engine answers with a fresh knowledgeState.
    setEngineItems(items => items?.map(item => (item.id === id ? { ...item, audiences } : item)));
    post({ type: 'setKnowledgeAudience', id, audiences } as unknown as SidebarWebviewMessage);
    return;
  }
  const index = mockItems.findIndex(item => item.id === id);
  if (index >= 0) setMockItems(index, 'audiences', audiences);
}

export async function importSkillFolder(scope: KnowledgeScope, name: string, files: ImportedFile[]): Promise<KnowledgeItem> {
  if (source() === 'engine') {
    const reply = await request({ type: 'importSkillFolder', scope, name, files }, 15000);
    if (reply?.type === 'knowledgeSaved') return reply.item;
    throw new Error(reply?.type === 'knowledgeError' ? reply.message : 'The engine did not answer');
  }
  // DSH can only save a skill's SKILL.md; the other files need the new message.
  const skill = files.find(file => file.path.toLowerCase() === 'skill.md');
  const draft: KnowledgeDraft = { kind: 'skill', scope, name, audiences: ['everyone'], description: frontmatter(skill?.content ?? '').description };
  if (source() === 'instructions') return saveKnowledge(draft, skill?.content ?? '');
  const item = mockSave(draft, skill?.content ?? `# ${name}\n`, undefined, files.map(file => file.path));
  for (const file of files) mockContent.set(contentKey(item.id, file.path === 'SKILL.md' ? undefined : file.path), file.content);
  return item;
}

export function openKnowledgeExternally(item: KnowledgeItem, file?: string): void {
  if (source() === 'engine') {
    post({ type: 'openKnowledge', id: item.id, file } as unknown as SidebarWebviewMessage);
    return;
  }
  if (source() === 'instructions') {
    post({ type: 'openInstruction', id: item.id });
    return;
  }
  console.info('[knowledge mock] open', item.path, file);
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

/** Splits `---\nname: x\ndescription: y\n---\nbody` into fields and body. */
export function frontmatter(text: string): { name?: string; description?: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { body: text };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([\w-]+):\s*(.*)$/.exec(line);
    if (pair) fields[pair[1]] = pair[2].replace(/^["']|["']$/g, '');
  }
  return { name: fields.name, description: fields.description, body: text.slice(match[0].length) };
}

function contentKey(id: string, file?: string): string {
  return file ? `${id}::${file}` : id;
}

// ---------------------------------------------------------------------------------------------------------------
// Mock (Figma 306:2710). Dev and fallback only.

const mockContent = new Map<string, string>();

function mockSave(draft: KnowledgeDraft, content: string, file?: string, files?: string[]): KnowledgeItem {
  const id = draft.id ?? `mock-${draft.kind}-${Date.now()}`;
  const existing = mockItems.findIndex(item => item.id === id);
  const now = Date.now();
  if (existing >= 0) {
    setMockItems(existing, produce(item => {
      item.name = draft.name;
      item.description = draft.description;
      item.audiences = draft.audiences;
      item.scope = draft.scope;
      item.folder = draft.folder;
      item.updatedAt = now;
      item.updatedBy = 'you';
    }));
  } else {
    // organic: a new item's name should type into its row.
    setMockItems(items => [
      ...items,
      {
        ...draft,
        id,
        path: `~/.dsh/${draft.kind}s/${draft.name}`,
        files: draft.kind === 'skill' ? files ?? ['SKILL.md'] : undefined,
        createdBy: 'you',
        createdAt: now,
        updatedBy: 'you',
        updatedAt: now,
        usedIn: 0,
      },
    ]);
  }
  mockContent.set(contentKey(id, file), content);
  return mockItems.find(item => item.id === id)!;
}

function initialMock(): KnowledgeItem[] {
  const hour = 3600000;
  const day = 24 * hour;
  const now = Date.now();
  const rule = (name: string, index: number): KnowledgeItem => ({
    id: `rule-${index}`,
    kind: 'rule',
    scope: 'global',
    name,
    path: `~/.dsh/rules/${name}.md`,
    audiences: index === 6 ? ['main'] : index === 4 ? ['subagents'] : ['everyone'],
    createdBy: 'you',
    createdAt: now - (40 + index) * day,
    updatedBy: 'you',
    updatedAt: now - (index + 1) * day,
    usedIn: 30 - index,
  });
  const skill = (name: string, files: string[], description: string, extra: Partial<KnowledgeItem> = {}): KnowledgeItem => ({
    id: `skill-${name}`,
    kind: 'skill',
    scope: 'global',
    name,
    path: `~/.dsh/skills/${name}`,
    description,
    files,
    audiences: ['everyone'],
    createdBy: 'you',
    createdAt: now - 50 * day,
    updatedBy: 'you',
    updatedAt: now - 5 * day,
    usedIn: 3,
    ...extra,
  });
  const note = (folder: string, name: string, index: number): KnowledgeItem => ({
    id: `memory-${folder}-${index}`,
    kind: 'memory',
    scope: 'global',
    name,
    folder,
    path: `~/.dsh/memory/${folder}/${name.toLowerCase().replace(/\s+/g, '-')}.md`,
    audiences: ['everyone'],
    createdBy: index % 2 ? 'Sol' : 'you',
    createdAt: now - (10 + index) * day,
    updatedBy: 'Sol',
    updatedAt: now - (index + 2) * hour,
    usedIn: 6,
  });
  const items: KnowledgeItem[] = [
    ...[
      "Don't edit project.json",
      'Read PLAN before building',
      'Use existing packages',
      'Batch commands',
      'Ask when a choice is unclear',
      'Generalize agent tools',
      'Review the code, not the report',
      'Clean up temporary images',
    ].map(rule),
    skill('apple-design', ['SKILL.md', 'references/springs.md', 'references/easing.md'], 'UI animation timing, springs and easing', {
      audiences: ['profile:Builder', 'profile:Reviewer', 'profile:UI designer'],
      createdAt: new Date(new Date().getFullYear(), 8, 30).getTime(),
      updatedBy: 'Sol',
      updatedAt: now - 3 * hour,
      usedIn: 14,
    }),
    skill('dataviz', ['SKILL.md', 'references/palette.md'], 'Charts that read as one system'),
    skill('image-generation', ['SKILL.md'], 'Prompting image models'),
    skill('roblox-particles', ['SKILL.md'], 'Particles in Roblox Studio'),
    skill('roblox-rig-animation', ['SKILL.md'], 'Animating rigs'),
    skill('skill-creator', ['SKILL.md'], 'Write and test new skills'),
    note('workflow', 'Release flow', 0),
    note('workflow', 'Commit quoting', 1),
    note('workflow', 'Cloud sessions push to main', 2),
    note('tools', 'Sidebar preview', 3),
    note('tools', 'Figma page loading', 4),
    note('runtime', 'Claude CLI print mode', 5),
    note('runtime', 'Background task events', 6),
    note('runtime', 'Usage fields', 7),
    note('runtime', 'Token savings spec', 8),
    { ...rule('Run selene before commit', 20), scope: 'project' },
    { ...rule('Studio models only', 21), scope: 'project' },
    { ...note('project', 'Pane grid layout ids', 22), scope: 'project' },
  ];
  return items;
}

mockContent.set(
  'skill-apple-design',
  `---
name: apple-design
description: UI animation timing, springs and easing
---
Motion should feel physical and calm. Prefer springs over fixed-duration easing. Nothing bounces unless it was thrown.

## Springs

- Default: response 0.35, damping 1.0, no overshoot
- Drags and swipes: response 0.25, damping 0.85
- Animate layout and opacity on the same curve

## Timing

- Hover and press feedback: under 100 ms
- Panels, sheets and menus: 250 to 350 ms
- Reduced motion: crossfade instead of moving

## Avoid

- Staggering more than four items
- Animating colour while scrolling
- Scale on hover for anything larger than a button

See \`references/springs.md\` for \`vide.spring\` presets.
`,
);

mockContent.set(
  'skill-apple-design::references/springs.md',
  `# Spring presets

- \`vide.spring(target, 0.35, 1)\` for panels
- \`vide.spring(target, 0.25, 0.85)\` for drags
`,
);

mockContent.set(
  'memory-tools-3',
  `Run \`.dsh/tools/sidebar-preview.mjs\` to render the sidebar without VS Code.

## Notes

- Preview-only colour bugs live in the tool's theme map
- Pass \`--theme\` to check light themes
`,
);

mockContent.set(
  'rule-0',
  `Never edit \`project.json\`. Rojo owns it; changes there break script sync for everyone.
`,
);
