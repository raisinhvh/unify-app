/**
 * Knowledge screen state shared by the panel and the document: scope tab, open folders, the selected item
 * (and file inside a skill), and Read/Edit mode. UI choices persist through persist.ts.
 */
import { createMemo, createSignal } from 'solid-js';
import { readPersisted, writePersisted } from '../../persist';
import { knowledgeItems, type Audience, type KnowledgeItem, type KnowledgeKind, type KnowledgeScope } from './adapter';

const [scope, setScopeSignal] = createSignal<KnowledgeScope>(readPersisted('knowledge.scope', 'global'));
export { scope };

export function setScope(next: KnowledgeScope): void {
  setScopeSignal(next);
  writePersisted('knowledge.scope', next);
}

const [openFolders, setOpenFolders] = createSignal<string[]>(
  readPersisted('knowledge.open', ['rules', 'skills', 'memory', 'skill:skill-apple-design', 'topic:tools']),
);
export { openFolders };

export function setFolderOpen(key: string, open: boolean): void {
  const next = openFolders().filter(item => item !== key);
  if (open) next.push(key);
  setOpenFolders(next);
  writePersisted('knowledge.open', next);
}

export interface Selection {
  id: string;
  /** A file inside a skill folder other than SKILL.md. */
  file?: string;
}

const [selection, setSelectionSignal] = createSignal<Selection | undefined>(readPersisted('knowledge.selected', { id: 'skill-apple-design' }));
export { selection };

export function select(next: Selection | undefined): void {
  setSelectionSignal(next);
  writePersisted('knowledge.selected', next);
}

const [mode, setMode] = createSignal<'read' | 'edit'>('read');
export { mode, setMode };

/** Set when a new item was just created, so the document focuses its title. */
const [focusTitle, setFocusTitle] = createSignal(false);
export { focusTitle, setFocusTitle };

export const selectedItem = createMemo<KnowledgeItem | undefined>(() => {
  const current = selection();
  return current ? knowledgeItems().find(item => item.id === current.id) : undefined;
});

export const kindLabels: Record<KnowledgeKind, { one: string; many: string }> = {
  rule: { one: 'Rule', many: 'Rules' },
  skill: { one: 'Skill', many: 'Skills' },
  memory: { one: 'Memory note', many: 'Memory' },
};

export const scopeLabels: Record<KnowledgeScope, string> = {
  global: 'Global',
  project: 'This project',
};

export function audienceLabel(audience: Audience): string {
  if (audience === 'everyone') return 'Everyone';
  if (audience === 'main') return 'Main agent';
  if (audience === 'subagents') return 'Subagents';
  return audience.slice('profile:'.length);
}
