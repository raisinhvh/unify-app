/** Slash commands typed at the start of a chat message. Add an entry here to offer a new command in the composer menu. */
export interface SlashCommand { name: string; description: string; usage: string }

/** Usage text shared by the command menu and the `/schedule` parse errors. */
export const SCHEDULE_USAGE = '/schedule <in 2h | at 15:30 | 9am tomorrow> <prompt>';

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'job', description: 'Plan a checklist from your spec, then work and review until it passes', usage: '/job <spec>' },
  { name: 'permissions', description: 'Show or change the approval mode for this workspace', usage: '/permissions [ask | auto | full]' },
  { name: 'schedule', description: 'Send a prompt later, at a time or after a delay', usage: SCHEDULE_USAGE },
];

export const APPROVAL_MODES = {
  ask: { label: 'Ask approval', description: 'Ask before running tools' },
  auto: { label: 'Approve for me', description: 'Routine actions run automatically; risky ones still ask' },
  full: { label: 'Full access', description: 'No approval prompts; unrestricted file and network access' },
} as const;

export type ApprovalMode = keyof typeof APPROVAL_MODES;

/** Only recognized modes are allowed through to the approval setting. */
export function parseApprovalMode(value: string): ApprovalMode | undefined {
  const mode = value.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(APPROVAL_MODES, mode) ? mode as ApprovalMode : undefined;
}

/** Splits a message that starts with a known `/name`. Unknown commands return undefined so they are sent as ordinary text. */
export function parseSlash(text: string): { name: string; args: string } | undefined {
  const match = /^\s*\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  if (!SLASH_COMMANDS.some(command => command.name === name)) return undefined;
  return { name, args: (match[2] || '').trim() };
}
