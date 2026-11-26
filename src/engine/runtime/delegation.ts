import { getUnifyFeature } from '../unify/settings';

/** Subagents get a bridge that only exposes custom toolpack tools, so they cannot delegate further. */
export const TOOLPACK_SCOPE = 'toolpacks';

/** Whether a bridge config offers delegate_task, as opposed to only toolpack tools. */
export function canDelegate(delegate?: { env: Record<string, string> }): boolean {
  if (!delegate) return false;
  const scope = delegate.env.UNIFY_DELEGATE_SCOPE;
  return scope !== TOOLPACK_SCOPE;
}

export const WAIT_SUBAGENTS = 'wait_for_subagents';
export const CANCEL_SUBAGENT = 'cancel_subagent';
export type AfterTurn = 'resume' | 'hold' | 'cancel';

/** The note a batch adds once, after starting one or more subagents. */
export function messageAgentsByNameNote(exampleName: string): string {
  return `Message any of these agents by their name. Ex: { "to": "${exampleName}" }`;
}

const MESSAGE_BY_NAME_HINT = / Message it by its name\. Ex: \{ "to": "([^"]*)" \}/;

/** Ends a background delegate_task reply: how to message the subagent just started. */
export function messageByNameHint(name: string): string {
  return ` Message it by its name. Ex: { "to": "${name}" }`;
}

/** Strips the hint from a batched delegate_task reply and returns the subagent's name, if it had one. */
export function takeMessageByNameHint(outcome: { text: string }): string | undefined {
  const match = MESSAGE_BY_NAME_HINT.exec(outcome.text);
  if (!match) return undefined;
  outcome.text = outcome.text.slice(0, match.index) + outcome.text.slice(match.index + match[0].length);
  return match[1];
}

/** Unify profiles are the only supported source of subagents. */
export function delegationInstructions(available: boolean, options?: { explorer?: boolean }): string {
  const native = 'Never use native Agent/Task/spawn_agent tools or start agents from a shell.';
  const ranges = getUnifyFeature('tools.rangeEdits');
  return available
    ? `Unify subagents: run them only with delegate_task (the Unify MCP server), using exact names from list_subagents. Start independent tasks together (edit subagents need disjoint files); background: true lets you keep working. ${native}`
      + (options?.explorer ? ' For searches across several files, delegate to explorer and ask for a short answer with file:line references.' : '')
      + (options?.explorer && ranges ? ' The explorer also returns a ranges block (path:startLine-endLine why): read exactly those parts with read_file ranges and change them with edit_range { path, startLine, endLine, expected: <the hash from that read>, replacement }. Reading the range you edit satisfies the read-before-edit rule, so there is no need to read the whole file. Ask for "the ranges I need to edit X" when that is the job.' : '')
    : `Unify subagents: no delegate tool is available in this session. ${native} If a task needs a subagent, say delegation is unavailable.`;
}

export function isNativeSubagentTool(tool: string): boolean {
  return /^(?:Agent|Task|Subagent(?: activity)?|(?:collaboration[./])?(?:spawn_agent|spawnAgent))$/i.test(tool.trim());
}

/** MCP providers expose either the bare tool name or a qualified name with any server name. */
export function isDelegationTool(tool: string): boolean {
  return /^(?:(?:mcp[._/]{1,2}[\w-]+?[._/]{1,2})|(?:[\w-]+?[./]))?delegate_task$/i.test(tool.trim());
}
