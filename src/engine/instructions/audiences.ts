/**
 * Audience filtering for agent instructions.
 *
 * Unify stores rules as `## <name>` sections of `AGENTS.md` (global: `<unifyHome>/AGENTS.md`, project:
 * `<workspace>/AGENTS.md`). Each section's audience lives in the Knowledge metadata store. Unify renders those
 * files into an agent's system prompt, so this module builds the same Markdown with only the sections that
 * target the agent being started: the main agent, or a subagent with a named profile.
 *
 * `requests/knowledge.ts` keeps its parser private, so the small parser below mirrors its `## ` heading rule and
 * slugging. Heading text and section bodies are preserved exactly; only whole sections are removed.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { appliesTo, audiencesForMany } from '../unify/knowledgeAudience';
import type { AudienceApplyOptions, AudienceTarget } from '../unify/knowledgeAudience';
import { slugify } from '../unify/requests/state';
import type { KnowledgeScope } from '../unify/requests/types';

export interface RuleAudienceRoots {
  /** The open project folder; its `AGENTS.md` supplies project rules. */
  workspace?: string;
  /** Unify's data home (the same folder as `unifyHome()`); its `AGENTS.md` supplies global rules. */
  unifyHome?: string;
}

export interface RuleAudienceOptions extends AudienceApplyOptions {
  /** Absolute path to `knowledge.json`; defaults to `<unifyHome>/knowledge.json`. */
  knowledgeFile?: string;
  /** File name to write in `writeAudienceInstructions`; defaults to `AGENTS.md`. */
  fileName?: string;
}

interface RuleSection {
  name: string;
  lines: string[];
}

interface ParsedRules {
  /** Text before the first `## ` heading. */
  preamble: string[];
  sections: RuleSection[];
}

function homeOf(roots: RuleAudienceRoots): string | undefined {
  return roots.unifyHome;
}

function parseRuleSections(text: string): ParsedRules {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const preamble: string[] = [];
  const sections: RuleSection[] = [];
  let current: RuleSection | undefined;
  const flush = (): void => {
    if (current) sections.push(current);
    current = undefined;
  };
  for (const line of lines) {
    const heading = /^##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (heading) {
      flush();
      current = { name: heading[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  flush();
  return { preamble, sections };
}

function renderRuleSections(parsed: ParsedRules): string {
  const parts: string[] = [];
  const preamble = parsed.preamble.join('\n').trim();
  if (preamble) parts.push(preamble);
  for (const section of parsed.sections) {
    parts.push(`## ${section.name}\n\n${section.lines.join('\n').trim()}`);
  }
  return parts.join('\n\n');
}

function ruleId(scope: KnowledgeScope, name: string): string {
  return `rule:${scope}:${slugify(name)}`;
}

/**
 * The rule text an agent in `scope` should see, in the original `AGENTS.md` shape. A file without sections is
 * one implicit rule (`rule:<scope>:general`), matching how the Knowledge screen lists it.
 */
export function filterRuleText(
  text: string,
  scope: KnowledgeScope,
  target: AudienceTarget,
  options?: RuleAudienceOptions,
): string {
  if (!text.trim()) return '';
  const parsed = parseRuleSections(text);
  if (!parsed.sections.length) {
    const audiences = audiencesForMany([`rule:${scope}:general`], { knowledgeFile: options?.knowledgeFile })[0];
    return appliesTo(audiences, target, { enabled: options?.enabled }) ? text.trim() : '';
  }
  const ids = parsed.sections.map(section => ruleId(scope, section.name));
  const audiences = audiencesForMany(ids, { knowledgeFile: options?.knowledgeFile });
  const kept = parsed.sections.filter((_section, index) => appliesTo(audiences[index], target, { enabled: options?.enabled }));
  // A preamble in a sectioned file is a title; without any applicable section there is nothing to send.
  if (!kept.length) return '';
  parsed.sections = kept;
  return renderRuleSections(parsed);
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Global then project rules, filtered for one agent. This is the text to hand to a system prompt or to write as
 * the agent's instruction file. Errors other than a missing file (for example a permissions failure) propagate.
 */
export async function instructionsForAudience(
  roots: RuleAudienceRoots,
  target: AudienceTarget,
  options?: RuleAudienceOptions,
): Promise<string> {
  const parts: string[] = [];
  const home = homeOf(roots);
  if (home) {
    const text = await readOptional(join(home, 'AGENTS.md'));
    const filtered = text === undefined ? '' : filterRuleText(text, 'global', target, options);
    if (filtered) parts.push(filtered);
  }
  if (roots.workspace) {
    const text = await readOptional(join(roots.workspace, 'AGENTS.md'));
    const filtered = text === undefined ? '' : filterRuleText(text, 'project', target, options);
    if (filtered) parts.push(filtered);
  }
  return parts.join('\n\n');
}

/**
 * Writes an agent-specific instruction file. The `agent-instructions` runtime plugin can then be pointed at
 * `home` with `instructionFileCandidates: [fileName]`, so the runtime never reads the unfiltered project `AGENTS.md`.
 * Returns the written path, or undefined when no rules apply (and removes a stale file from an earlier run).
 */
export async function writeAudienceInstructions(
  roots: RuleAudienceRoots,
  target: AudienceTarget,
  home: string,
  options?: RuleAudienceOptions,
): Promise<string | undefined> {
  const text = await instructionsForAudience(roots, target, options);
  const file = join(home, options?.fileName ?? 'AGENTS.md');
  if (!text.trim()) {
    await fs.rm(file, { force: true });
    return undefined;
  }
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(file, `${text}\n`, 'utf8');
  return file;
}
