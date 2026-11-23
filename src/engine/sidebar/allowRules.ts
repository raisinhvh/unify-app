/**
 * Persistent "Always allow" rules for approval rows.
 *
 * The user can answer an approval request with `always: true`, which stores a rule for the command's
 * prefix in that workspace. Later requests whose command starts with the same prefix are approved
 * without asking. Rules live in `unifyHome()/approvals.json` as { rules: SidebarAllowRule[] }, so they
 * survive restarts and are shared by every window.
 */
import * as fs from 'fs';
import * as path from 'path';
import { unifyHome } from '../unify/settings';

/** One remembered approval: a command prefix allowed in one project folder. */
export interface SidebarAllowRule {
  /** Absolute path of the project (workspace folder) the rule applies to. */
  project: string;
  /** Leading command words, e.g. "git status". */
  prefix: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

const approvalsFile = path.join(unifyHome(), 'approvals.json');

/** Characters that let one command run another: never safe to approve by prefix. */
const SHELL_CONTROL = /[;&|`><\n\r]|\$\(/;

/** Executables whose whole purpose is deleting or overwriting data; an allow rule must never cover them. */
const DESTRUCTIVE_EXECUTABLES = new Set([
  'rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'unlink', 'shred', 'srm',
  'format', 'format-volume', 'clear-disk', 'mkfs', 'diskpart', 'dd', 'truncate',
  'shutdown', 'reboot', 'stop-computer', 'clear-content',
]);

/** Prefixes that only launch the real command, e.g. "sudo rm -rf". */
const COMMAND_WRAPPERS = new Set(['sudo', 'doas', 'runas', 'env', 'command', 'exec', 'time', 'nohup']);

/** Shells whose arguments run another command in turn, e.g. `cmd /c del file`. */
const COMMAND_INTERPRETERS = new Set(['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'fish', 'wsl']);

function normalizePrefix(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

/** A comparable project path: normalized, without a trailing separator, and lowercase on Windows. */
function normalizeProject(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const normalized = path.normalize(trimmed);
  const isRoot = /^[A-Za-z]:[\\/]$/.test(normalized) || normalized === path.sep;
  const result = isRoot || normalized.length === 1 ? normalized : normalized.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

function executableName(token: string): string {
  const unquoted = token.replace(/^["']+|["']+$/g, '');
  const base = unquoted.split(/[\\/]/).pop() || unquoted;
  return base.toLowerCase().replace(/\.(exe|com|cmd|bat|ps1)$/, '');
}

/** Whether a command deletes data or rewrites history, so it must always ask. */
export function isDestructiveCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  const tokens = command.trim().split(/\s+/).filter(Boolean).map(executableName);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (COMMAND_WRAPPERS.has(token) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1;
      continue;
    }
    break;
  }
  const executable = tokens[index];
  if (!executable) return false;
  if (DESTRUCTIVE_EXECUTABLES.has(executable)) return true;
  if (COMMAND_INTERPRETERS.has(executable)) return tokens.slice(index + 1).some(token => DESTRUCTIVE_EXECUTABLES.has(token));
  if (executable !== 'git') return false;
  const args = tokens.slice(index + 1);
  if (args.includes('rm')) return true;
  if (args.includes('push') && args.some(arg => arg === '--force' || arg === '-f' || arg.startsWith('--force-with-lease') || arg.startsWith('--force-if-includes'))) return true;
  if (args.includes('reset') && args.includes('--hard')) return true;
  if (args.includes('clean') && args.some(arg => /^-[a-zA-Z]*f/.test(arg))) return true;
  return args.includes('checkout') && args.includes('--');
}

/** Whether a command prefix is safe to auto-approve and to remember. */
function canRememberPrefix(prefix: string): boolean {
  return !!prefix && !SHELL_CONTROL.test(prefix) && !isDestructiveCommand(prefix);
}

function isAllowRule(value: unknown): value is SidebarAllowRule {
  if (!value || typeof value !== 'object') return false;
  const rule = value as Partial<SidebarAllowRule>;
  return typeof rule.project === 'string' && !!rule.project
    && typeof rule.prefix === 'string' && !!normalizePrefix(rule.prefix)
    && typeof rule.createdAt === 'number';
}

/** Every stored rule, oldest first. A missing or broken file reads as no rules. */
export function listAllowRules(): SidebarAllowRule[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(approvalsFile, 'utf8')) as { rules?: unknown };
    if (!Array.isArray(parsed.rules)) return [];
    return parsed.rules.filter(isAllowRule).map(rule => ({ ...rule, project: normalizeProject(rule.project), prefix: normalizePrefix(rule.prefix) }));
  } catch {
    return [];
  }
}

function writeRules(rules: SidebarAllowRule[]): void {
  fs.mkdirSync(path.dirname(approvalsFile), { recursive: true });
  const temporaryFile = `${approvalsFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify({ rules }, null, 2));
  fs.renameSync(temporaryFile, approvalsFile);
}

/** Store a rule, replacing an identical one. Returns the rule that is now in effect. */
export function addAllowRule(project: string, prefix: string): SidebarAllowRule {
  const normalizedProject = normalizeProject(project);
  const normalizedPrefix = normalizePrefix(prefix);
  if (!normalizedProject) throw new Error('An allow rule needs a project folder.');
  if (!normalizedPrefix) throw new Error('An allow rule needs a command prefix.');
  if (!canRememberPrefix(normalizedPrefix)) {
    throw new Error('This command cannot be remembered: it uses shell operators or deletes data, so it is always asked about.');
  }
  const rules = listAllowRules().filter(rule => !(rule.project === normalizedProject && rule.prefix === normalizedPrefix));
  const rule: SidebarAllowRule = { project: normalizedProject, prefix: normalizedPrefix, createdAt: Date.now() };
  rules.push(rule);
  writeRules(rules);
  return rule;
}

/** Whether a command in this project already has an allow rule. */
export function isAlwaysAllowed(project: string, prefix: string): boolean {
  const normalizedProject = normalizeProject(project);
  const normalizedPrefix = normalizePrefix(prefix);
  if (!normalizedProject || !canRememberPrefix(normalizedPrefix)) return false;
  return listAllowRules().some(rule => rule.project === normalizedProject && normalizedPrefix === rule.prefix);
}

/**
 * The part of a command an allow rule could remember: its first two whitespace-separated words.
 * For example "git status --short" becomes "git status"; a single-word command stays as it is.
 * Empty when the command chains or substitutes shell commands, or deletes data: such a command
 * must always be asked about, because a prefix can never make it safe.
 */
export function commandPrefix(command: unknown): string {
  if (typeof command !== 'string') return '';
  const trimmed = command.trim();
  if (!trimmed || SHELL_CONTROL.test(trimmed) || isDestructiveCommand(trimmed)) return '';
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.slice(0, 2).join(' ');
}
