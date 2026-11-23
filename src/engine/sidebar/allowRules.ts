/**
 * Persistent "Always allow" rules for approval rows.
 *
 * The user can answer an approval request with `always: true`, which stores a rule for the command's
 * prefix in that workspace. Later requests whose command starts with the same prefix are approved
 * without asking. Rules live in ~/.dsh/unify/approvals.json as { rules: SidebarAllowRule[] }, so they
 * survive restarts and are shared by every window.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** One remembered approval: a command prefix allowed in one project folder. */
export interface SidebarAllowRule {
  /** Absolute path of the project (workspace folder) the rule applies to. */
  project: string;
  /** Leading command words, e.g. "git status". */
  prefix: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

const approvalsFile = path.join(os.homedir(), '.dsh', 'unify', 'approvals.json');

function normalizePrefix(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
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
    return parsed.rules.filter(isAllowRule).map(rule => ({ ...rule, prefix: normalizePrefix(rule.prefix) }));
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
  const normalizedProject = project.trim();
  const normalizedPrefix = normalizePrefix(prefix);
  if (!normalizedProject) throw new Error('An allow rule needs a project folder.');
  if (!normalizedPrefix) throw new Error('An allow rule needs a command prefix.');
  const rules = listAllowRules().filter(rule => !(rule.project === normalizedProject && rule.prefix === normalizedPrefix));
  const rule: SidebarAllowRule = { project: normalizedProject, prefix: normalizedPrefix, createdAt: Date.now() };
  rules.push(rule);
  writeRules(rules);
  return rule;
}

/** Whether a command in this project already has an allow rule. */
export function isAlwaysAllowed(project: string, prefix: string): boolean {
  const normalizedPrefix = normalizePrefix(prefix);
  if (!project || !normalizedPrefix) return false;
  return listAllowRules().some(rule => rule.project === project && normalizedPrefix === rule.prefix);
}

/**
 * The part of a command an allow rule remembers: its first two whitespace-separated words.
 * For example "git status --short" becomes "git status"; a single-word command stays as it is.
 */
export function commandPrefix(command: unknown): string {
  if (typeof command !== 'string') return '';
  const words = command.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).join(' ');
}
