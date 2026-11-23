/**
 * What the Agents side panel has selected: the General page (explorer, helper models, how subagents run), one
 * subagent profile by name, or a new profile being drafted. Also whether the Subagents folder is open.
 * Shared by the panel and the content column.
 */
import { createSignal } from 'solid-js';
import { readPersisted, writePersisted } from '../../persist';

export type AgentsSelection = { kind: 'general' } | { kind: 'profile'; name: string } | { kind: 'new' };

const [selection, setSelectionSignal] = createSignal<AgentsSelection>(
  readPersisted<AgentsSelection>('agentsSelection', { kind: 'general' }),
);
export { selection };

export function select(next: AgentsSelection): void {
  setSelectionSignal(next);
  // A draft is not worth restoring after a restart.
  writePersisted('agentsSelection', next.kind === 'new' ? { kind: 'general' } : next);
}

const [subagentsOpen, setSubagentsOpenSignal] = createSignal<boolean>(readPersisted<boolean>('agentsSubagentsOpen', true));
export { subagentsOpen };

export function setSubagentsOpen(open: boolean): void {
  setSubagentsOpenSignal(open);
  writePersisted('agentsSubagentsOpen', open);
}
