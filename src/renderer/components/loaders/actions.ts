/**
 * Which loader shows for what an agent is doing.
 *
 *   actionLoader[action]          the Figma mapping (root pluginData unifyLoadersByAction)
 *   chatAction(sessionId)         what a chat is doing right now, from DSH state (approvals, run state, tools)
 *   toolAction(event)             what one tool call is doing, from its kind and title
 */
import type { SidebarToolEvent } from '../../protocol';
import { pendingInterrupt } from '../../store/activity';
import { viewState } from '../../store';
import type { LoaderId } from './definitions';

export type AgentAction =
  | 'planning'
  | 'thinking'
  | 'loading'
  | 'other'
  | 'finding'
  | 'editing'
  | 'writing'
  | 'testing'
  | 'downloading'
  | 'spawning'
  | 'delegating'
  | 'needsYou'
  | 'compacting'
  | 'remembering'
  | 'imaging';

export const actionLoader: Record<AgentAction, LoaderId> = {
  planning: 'quad',
  thinking: 'trace',
  loading: 'fill',
  other: 'pixels',
  finding: 'sift',
  editing: 'splice',
  writing: 'lay',
  testing: 'checks',
  downloading: 'pull',
  spawning: 'split',
  delegating: 'relay',
  needsYou: 'knock',
  compacting: 'press',
  remembering: 'shelve',
  imaging: 'develop',
};

export const actionLabel: Record<AgentAction, string> = {
  planning: 'Planning',
  thinking: 'Thinking',
  loading: 'Loading',
  other: 'Working',
  finding: 'Finding files',
  editing: 'Editing',
  writing: 'Writing',
  testing: 'Testing',
  downloading: 'Downloading',
  spawning: 'Spawning',
  delegating: 'Delegating',
  needsYou: 'Needs you',
  compacting: 'Compacting',
  remembering: 'Remembering',
  imaging: 'Imaging',
};

const testPattern = /\b(test|tests|vitest|jest|pytest|mocha|selene|lint|tsc|typecheck|cargo test|go test)\b/i;
const downloadPattern = /\b(download|fetch|curl|wget|install|npm i|pip install|clone|pull)\b/i;
const writePattern = /^(create|creating|write|writing|wrote|created)\b/i;
const memoryPattern = /\b(memory|remember|save_memory|note)\b/i;
const imagePattern = /\b(image|imaging|generate_image|screenshot|render)\b/i;
const compactPattern = /\bcompact/i;
const planPattern = /\b(plan|todo|todowrite)\b/i;
const delegatePattern = /\b(delegate|delegate_task)\b/i;
const loadPattern = /\b(load|loading|load_toolpack|starting)\b/i;

export function toolAction(event: Pick<SidebarToolEvent, 'kind' | 'title' | 'detail'>): AgentAction {
  const text = `${event.title} ${event.detail || ''}`;
  if (compactPattern.test(text)) return 'compacting';
  if (memoryPattern.test(event.title)) return 'remembering';
  if (imagePattern.test(event.title)) return 'imaging';
  if (delegatePattern.test(event.title)) return 'delegating';
  if (planPattern.test(event.title)) return 'planning';
  switch (event.kind) {
    case 'search':
      return 'finding';
    case 'edit':
      return writePattern.test(event.title) ? 'writing' : 'editing';
    case 'subagent':
      return 'spawning';
    case 'shell':
      if (testPattern.test(text)) return 'testing';
      if (downloadPattern.test(text)) return 'downloading';
      return 'other';
    case 'read':
      return 'other';
    default:
      if (downloadPattern.test(text)) return 'downloading';
      if (loadPattern.test(event.title)) return 'loading';
      return 'other';
  }
}

/** What a chat is doing now, or undefined when it is idle with nothing pending. */
export function chatAction(sessionId: string): AgentAction | undefined {
  if (pendingInterrupt(sessionId)) return 'needsYou';
  const run = viewState.runStates[sessionId];
  if (!run || run.state === 'idle') return undefined;
  if (run.label && compactPattern.test(run.label)) return 'compacting';
  if (run.state === 'thinking') return 'thinking';
  const timeline = viewState.timeline[sessionId] || [];
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (entry.kind === 'tool' && entry.event.state === 'running') return toolAction(entry.event);
    if (entry.kind === 'subagent') {
      const agent = viewState.subagents[sessionId]?.[entry.agentId];
      if (agent?.state === 'running') return agent.delegated ? 'delegating' : 'spawning';
    }
  }
  if (run.label) return toolAction({ kind: 'other', title: run.label });
  return run.state === 'tool' ? 'other' : 'thinking';
}
