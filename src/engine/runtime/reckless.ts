/**
 * "Most access" approves every tool call except reckless ones: commands that destroy data outside
 * what a review can undo, rewrite shared history, publish, take the machine down, or run code
 * fetched straight from the network. Each rule names why it was blocked, so the agent can tell
 * the user what to run themselves.
 */

/** A target that means "everything": filesystem or drive root, home folder, parent folder, a bare wildcard, or the repo's .git. */
const SWEEPING_TARGET = String.raw`(?:\/\*?|~[\\/]?\*?|\$HOME[\\/]?\*?|\$env:USERPROFILE[\\/]?\*?|%USERPROFILE%[\\/]?\*?|[A-Za-z]:[\\/]*\*?|\.\.[\\/]*\*?|\*|\.git[\\/]?|\.)`;
/** End of a command argument: whitespace, a quote, a separator or the end. */
const ARG_END = String.raw`(?=$|[\s"'\`;|&)])`;
/** Start of a command argument. */
const ARG_START = String.raw`(?:^|[\s"'=(])`;

interface RecklessRule {
  reason: string;
  pattern: RegExp;
}

const RULES: RecklessRule[] = [
  {
    reason: 'recursive delete of a root, home, parent, wildcard or .git folder',
    pattern: new RegExp(String.raw`\brm\s+(?:-{1,2}[\w-]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\b[^;|&\n]*?${ARG_START}["']?${SWEEPING_TARGET}["']?${ARG_END}`),
  },
  {
    reason: 'recursive delete of a root, home, parent, wildcard or .git folder',
    pattern: new RegExp(String.raw`\b(?:Remove-Item|rm|ri|del|rd|rmdir|erase)\b[^;|&\n]*-Recurse\b[^;|&\n]*?${ARG_START}["']?${SWEEPING_TARGET}["']?${ARG_END}|\b(?:Remove-Item|ri)\b[^;|&\n]*?${ARG_START}["']?${SWEEPING_TARGET}["']?${ARG_END}[^;|&\n]*-Recurse`, 'i'),
  },
  {
    reason: 'recursive delete of a drive, home or parent folder',
    pattern: new RegExp(String.raw`\b(?:rd|rmdir|del|erase)\b[^;|&\n]*\/[sS]\b[^;|&\n]*?${ARG_START}["']?${SWEEPING_TARGET}["']?${ARG_END}`, 'i'),
  },
  { reason: 'deleting files across the whole filesystem', pattern: /\bfind\s+["']?(?:\/|~|[A-Za-z]:[\\/]*)["']?\s[^;|&\n]*-delete\b/i },
  { reason: 'force-pushing over shared history', pattern: /\bgit\s+push\b[^;|&\n]*(?:\s--force(?!-with-lease)\b|\s-[a-zA-Z]*f\b|\s\+\S+)/ },
  { reason: 'deleting a remote branch or mirroring over a remote', pattern: /\bgit\s+push\b[^;|&\n]*(?:\s--delete\b|\s-d\b|\s--mirror\b|\s:\S+)/ },
  { reason: 'discarding uncommitted work (git reset --hard)', pattern: /\bgit\s+reset\b[^;|&\n]*--hard\b/ },
  { reason: 'deleting untracked files (git clean -f)', pattern: /\bgit\s+clean\b[^;|&\n]*\s-[a-zA-Z]*f/ },
  { reason: 'discarding uncommitted work (checkout/restore of everything)', pattern: /\bgit\s+(?:checkout|restore)\b[^;|&\n]*\s(?:--\s+)?\.(?=$|[\s;|&])/ },
  { reason: 'rewriting or dropping git history', pattern: /\bgit\s+(?:filter-branch|filter-repo|reflog\s+expire|stash\s+clear|update-ref\s+-d)\b|\bgit\s+branch\s+[^;|&\n]*-D\b/ },
  { reason: 'formatting or wiping a disk', pattern: /\b(?:mkfs(?:\.\w+)?|fdisk|sfdisk|parted|wipefs|diskpart|Format-Volume|Clear-Disk|Initialize-Disk|cipher\s+\/w)\b|\bformat\s+[A-Za-z]:|\bdd\b[^;|&\n]*\bof=\/dev\/|>\s*\/dev\/(?:sd|nvme|hd|disk)/i },
  { reason: 'deleting backups or shadow copies', pattern: /\b(?:vssadmin\s+delete|wbadmin\s+delete|bcdedit)\b/i },
  { reason: 'shutting down or restarting the machine', pattern: /(?:^|[;&|(]\s*|\bsudo\s+)(?:shutdown|reboot|poweroff|halt)(?:\.exe)?\b|\b(?:Restart|Stop)-Computer\b/i },
  { reason: 'killing every process or a system process', pattern: /\bkill\s+-(?:9|KILL)\s+-1\b|\bkillall5?\b|\bpkill\s+[^;|&\n]*-f\s+["']?\.["']?|\btaskkill\b[^;|&\n]*\/im\s+["']?(?:svchost|csrss|winlogon|lsass|wininit|smss|services|explorer)(?:\.exe)?\b|\bStop-Process\b[^;|&\n]*-Name\s+["']?\*/i },
  { reason: 'opening permissions on a root or home folder', pattern: new RegExp(String.raw`\b(?:chmod|chown|icacls|takeown)\b[^;|&\n]*?${ARG_START}["']?(?:\/|~[\\/]?|\$HOME|[A-Za-z]:[\\/]*)["']?${ARG_END}`, 'i') },
  { reason: 'running a script downloaded from the network', pattern: /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^;&\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|iex|Invoke-Expression|python3?|node|pwsh|powershell)\b|\b(?:iex|Invoke-Expression)\b[^;\n]*\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString|Net\.WebClient)\b/i },
  { reason: 'publishing a package or release', pattern: /\b(?:npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bdotnet\s+nuget\s+push\b|\bgh\s+release\s+(?:create|delete|upload)\b/i },
  { reason: 'deleting a GitHub repository', pattern: /\bgh\s+repo\s+(?:delete|archive)\b|\bgh\s+api\b[^;|&\n]*-X\s*DELETE/i },
  { reason: 'dropping a database', pattern: /\bdrop\s+(?:database|schema)\b|\b(?:dropdb)\b/i },
  { reason: 'pruning all Docker data', pattern: /\bdocker\s+(?:system|volume)\s+prune\b/i },
  { reason: 'deleting registry keys', pattern: /\breg(?:\.exe)?\s+delete\b|\bRemove-Item\b[^;|&\n]*\b(?:HKLM|HKCU|HKEY_)/i },
  { reason: 'a fork bomb', pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
];

/** Paths an agent may never write under Most access: keys, credentials and operating system folders. */
const RECKLESS_PATH = /(?:^|[\\/])(?:\.ssh|\.gnupg|\.aws|\.kube|\.docker)(?:[\\/]|$)|(?:^|[\\/])(?:etc|boot|bin|sbin|usr|System)(?:[\\/]|$)|[A-Za-z]:[\\/]+(?:Windows|Program Files(?: \(x86\))?|ProgramData)(?:[\\/]|$)|[\\/]System32(?:[\\/]|$)/i;

/** Why a command (or a tool description that contains one) is reckless, or undefined when it may run. */
export function recklessReason(command: string): string | undefined {
  // Descriptions carry the tool input as JSON, where every backslash is doubled.
  const text = command.replace(/\\\\/g, '\\');
  return RULES.find(rule => rule.pattern.test(text))?.reason;
}

/**
 * The shell command a tool call would run: `input.command` (Claude), or the `"command"` field of the
 * tool input JSON inside an ACP description. Without one, the whole description is checked.
 */
export function toolCommandText(description: string, input?: Record<string, unknown>): string {
  const direct = input?.command;
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct)) return direct.map(String).join(' ');
  const quoted = /"(?:command|cmd)"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(description);
  if (quoted) {
    try {
      return JSON.parse(quoted[1]) as string;
    } catch {
      // Fall through to the whole description.
    }
  }
  const list = /"(?:command|cmd)"\s*:\s*(\[(?:[^\]"\\]|"(?:[^"\\]|\\.)*")*\])/.exec(description);
  if (list) {
    try {
      return (JSON.parse(list[1]) as unknown[]).map(String).join(' ');
    } catch {
      // Fall through to the whole description.
    }
  }
  return description;
}

/** Why a tool call is reckless under Most access, or undefined when it may run. */
export function recklessToolReason(description: string, input?: Record<string, unknown>): string | undefined {
  return recklessReason(toolCommandText(description, input));
}

/** Why writing to this path is reckless, or undefined when it may be written. */
export function recklessPathReason(path: string): string | undefined {
  return RECKLESS_PATH.test(path) ? 'writing to keys, credentials or system folders' : undefined;
}

/** The tool result an agent gets when Most access blocks a call. */
export function recklessBlockMessage(reason: string): string {
  return `Blocked by Most access: this looks like ${reason}. Do not retry it or work around it. If it is really needed, tell the user the exact command and why, so they can run it themselves or switch to Full access.`;
}
