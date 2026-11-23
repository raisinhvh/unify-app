/**
 * Knowledge (rules, skills, memory) for the Knowledge screen.
 *
 * Rules are sections of Unify's shared instruction files (`## <name>` in `~/.unify/AGENTS.md` and the project's
 * `AGENTS.md`), because the screen creates many named rules while Unify's saveInstruction only knows fixed
 * file names. Skills are Unify's real skill folders, read through instructions/store. Memory is Unify's memory
 * folders: `~/.unify/memory` and `<workspace>/.unify/memory`.
 *
 * Audiences, descriptions and timestamps are Unify metadata in `~/.unify/unify/knowledge.json`; Unify's files
 * keep only the text. Audiences are stored but not yet enforced by the engine.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { listInstructions, readInstruction, saveInstruction, SKILL_NAME } from '../../instructions/store';
import type { InstructionItem } from '../../instructions/store';
import {
  Audience,
  ImportedFile,
  KnowledgeDraft,
  KnowledgeItem,
  KnowledgeScope,
  UnifyRequestContext,
} from './types';
import { RequestPaths, isRecord, readJsonFile, slugify, writeJsonFile, resolveInside } from './state';

interface KnowledgeMetadata {
  audiences?: Audience[];
  description?: string;
  folder?: string;
  createdBy?: string;
  createdAt?: number;
  updatedBy?: string;
  updatedAt?: number;
}

interface KnowledgeStore {
  items: Record<string, KnowledgeMetadata>;
  /** Previous file contents kept before an agent writes, keyed by absolute file path. */
  versions?: Record<string, KnowledgeVersion[]>;
}

interface KnowledgeVersion {
  at: number;
  by: string;
  /** null means the file did not exist before the agent's write. */
  content: string | null;
}

const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_MEMORY_FILES = 2_000;
const DEFAULT_AUDIENCES: Audience[] = ['everyone'];

function metadataStore(paths: RequestPaths): KnowledgeStore {
  const stored = readJsonFile<KnowledgeStore>(paths.knowledgeFile, { items: {} });
  return {
    items: isRecord(stored.items) ? stored.items as Record<string, KnowledgeMetadata> : {},
    versions: isRecord(stored.versions) ? stored.versions as Record<string, KnowledgeVersion[]> : {},
  };
}

function saveMetadata(paths: RequestPaths, store: KnowledgeStore): void {
  writeJsonFile(paths.knowledgeFile, store);
}

function touchMetadata(store: KnowledgeStore, id: string, patch: KnowledgeMetadata): void {
  store.items[id] = { ...(store.items[id] ?? {}), ...patch };
}

function metadataFor(store: KnowledgeStore, id: string): KnowledgeMetadata {
  return store.items[id] ?? {};
}

function audiencesOf(store: KnowledgeStore, id: string): Audience[] {
  const audiences = metadataFor(store, id).audiences;
  return Array.isArray(audiences) && audiences.length ? audiences : [...DEFAULT_AUDIENCES];
}

function versionsFor(store: KnowledgeStore, file: string): KnowledgeVersion[] {
  return store.versions?.[path.resolve(file)] ?? [];
}

/** Who changed an item last: an agent's kept version, else the metadata (the UI's `'you'`). */
function attribution(store: KnowledgeStore, file: string, metadata: KnowledgeMetadata, fallbackTime: number): { updatedBy: string; updatedAt: number } {
  const latest = versionsFor(store, file).at(-1);
  if (latest && latest.at > (metadata.updatedAt ?? 0)) return { updatedBy: latest.by, updatedAt: latest.at };
  return { updatedBy: metadata.updatedBy ?? 'you', updatedAt: metadata.updatedAt ?? fallbackTime };
}

function ruleFile(paths: RequestPaths, scope: KnowledgeScope): string | undefined {
  if (scope === 'project') return paths.workspaceRoot ? path.join(paths.workspaceRoot, 'AGENTS.md') : undefined;
  return path.join(paths.unifyHome, 'AGENTS.md');
}

interface RuleSection {
  slug: string;
  name: string;
  body: string;
}

interface ParsedRules {
  /** Text before the first `## ` heading. */
  preamble: string;
  sections: RuleSection[];
}

export function parseRuleSections(text: string): ParsedRules {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const preamble: string[] = [];
  const sections: RuleSection[] = [];
  let current: { name: string; lines: string[] } | undefined;
  const flush = (): void => {
    if (!current) return;
    sections.push({ slug: slugify(current.name), name: current.name, body: current.lines.join('\n').trim() });
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
  return { preamble: preamble.join('\n').trim(), sections };
}

/** Smallest markdown that Unify will read as instructions: the preamble plus the named sections. */
export function renderRuleSections(parsed: ParsedRules): string {
  const parts: string[] = [];
  if (parsed.preamble) parts.push(parsed.preamble.trim());
  for (const section of parsed.sections) {
    parts.push(`## ${section.name}\n\n${section.body.trim()}`);
  }
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}

async function readTextFile(file: string): Promise<string> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/** `# Title` or a fallback, for rule files without `##` sections. */
function titleOfRules(text: string): string {
  const heading = /^#[ \t]+(.+)$/m.exec(text);
  return heading ? heading[1].trim() : 'Rules';
}

async function walkFiles(root: string, budget = { left: MAX_MEMORY_FILES }): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    if (budget.left <= 0) return;
    let entries;
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (budget.left <= 0 || entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      budget.left -= 1;
      files.push(full);
    }
  };
  await walk(root);
  return files;
}

function memoryRoot(paths: RequestPaths, scope: KnowledgeScope): string | undefined {
  if (scope === 'project') return paths.workspaceRoot ? path.join(paths.workspaceRoot, '.unify', 'memory') : undefined;
  return path.join(paths.unifyHome, 'memory');
}

function noteTitle(content: string, file: string): string {
  const heading = /^#[ \t]+(.+)$/m.exec(content);
  if (heading) return heading[1].trim();
  return path.basename(file, path.extname(file)).replace(/[-_]+/g, ' ');
}

function skillRoots(paths: RequestPaths): { root: string; prefix: string }[] {
  const roots = [
    { root: path.join(paths.agentsHome, 'skills'), prefix: 'agents' },
    { root: path.join(paths.unifyHome, 'skills'), prefix: 'unify' },
  ];
  if (paths.workspaceRoot) roots.push({ root: path.join(paths.workspaceRoot, '.agents', 'skills'), prefix: 'ws' });
  return roots;
}

function skillFolderOf(item: Pick<InstructionItem, 'id'>, paths: RequestPaths): string {
  const prefix = item.id.slice(0, item.id.indexOf(':'));
  const rel = item.id.slice(item.id.indexOf(':') + 1);
  const base = prefix === 'ws' ? paths.workspaceRoot! : prefix === 'agents' ? paths.agentsHome : paths.unifyHome;
  return path.dirname(path.join(base, ...rel.split('/')));
}

/** True when `target` is a child of `root`; the root itself does not count. */
function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** A skill folder must be strictly inside one of the scanned skills roots before it is opened or removed. */
function assertInsideSkillRoot(paths: RequestPaths, folder: string): void {
  if (!skillRoots(paths).some(entry => isInside(entry.root, folder))) {
    throw new Error('That skill folder is outside the skills folders.');
  }
}

/** The folder of a skill the scan actually found, so a crafted id cannot point anywhere else. */
async function skillFolderForId(paths: RequestPaths, id: string): Promise<string> {
  const instructionId = id.slice('skill:'.length);
  const skill = (await listInstructions(instructionRoots(paths))).find(item => item.id === instructionId);
  if (!skill) throw new Error('That skill no longer exists.');
  const folder = skillFolderOf(skill, paths);
  assertInsideSkillRoot(paths, folder);
  return folder;
}

function statTimeSync(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return Date.now(); }
}

async function statTime(file: string): Promise<number> {
  try { return (await fsp.stat(file)).mtimeMs; } catch { return Date.now(); }
}

/** Every knowledge item from disk, in rule → skill → memory order, project before global within a kind. */
export async function listKnowledge(context: UnifyRequestContext, paths: RequestPaths): Promise<KnowledgeItem[]> {
  const store = metadataStore(paths);
  const items: KnowledgeItem[] = [];

  for (const scope of ['project', 'global'] as KnowledgeScope[]) {
    const file = ruleFile(paths, scope);
    if (!file) continue;
    const text = await readTextFile(file);
    if (!text.trim()) continue;
    const parsed = parseRuleSections(text);
    const sections = parsed.sections.length
      ? parsed.sections
      : [{ slug: 'general', name: titleOfRules(text), body: parsed.preamble }];
    for (const section of sections) {
      const id = `rule:${scope}:${section.slug}`;
      const metadata = metadataFor(store, id);
      const time = await statTime(file);
      items.push(ruleItem(id, scope, section.name, file, metadata, audiencesOf(store, id), time, attribution(store, file, metadata, time)));
    }
  }

  const instructions = await listInstructions({
    workspace: paths.workspaceRoot,
    unifyHome: paths.unifyHome,
    agentsHome: paths.agentsHome,
  });
  for (const instruction of instructions) {
    if (instruction.kind !== 'skill') continue;
    const scope: KnowledgeScope = instruction.scope === 'workspace' ? 'project' : 'global';
    const folder = skillFolderOf(instruction, paths);
    const id = `skill:${instruction.id}`;
    const files = (await walkFiles(folder)).map(file => path.relative(folder, file).split(path.sep).join('/')).sort();
    const metadata = metadataFor(store, id);
    const skillFile = path.join(folder, 'SKILL.md');
    const time = statTimeSync(skillFile);
    const who = attribution(store, skillFile, metadata, time);
    items.push({
      id,
      kind: 'skill',
      scope,
      name: path.basename(folder),
      path: folder,
      description: metadata.description ?? instruction.description,
      audiences: audiencesOf(store, id),
      files,
      createdBy: metadata.createdBy ?? 'you',
      createdAt: metadata.createdAt ?? statTimeSync(folder),
      updatedBy: who.updatedBy,
      updatedAt: who.updatedAt,
      usedIn: 0,
    });
  }

  for (const scope of ['global', 'project'] as KnowledgeScope[]) {
    const root = memoryRoot(paths, scope);
    if (!root) continue;
    for (const file of await walkFiles(root)) {
      if (path.extname(file).toLowerCase() !== '.md') continue;
      const relative = path.relative(root, file).split(path.sep).join('/');
      const id = `memory:${scope}:${relative}`;
      const content = await readTextFile(file);
      const metadata = metadataFor(store, id);
      const folder = path.dirname(relative);
      const time = statTimeSync(file);
      const who = attribution(store, file, metadata, time);
      items.push({
        id,
        kind: 'memory',
        scope,
        name: noteTitle(content, file),
        path: file,
        folder: folder === '.' ? undefined : folder,
        description: metadata.description,
        audiences: audiencesOf(store, id),
        createdBy: metadata.createdBy ?? 'you',
        createdAt: metadata.createdAt ?? statTimeSync(file),
        updatedBy: who.updatedBy,
        updatedAt: who.updatedAt,
        usedIn: 0,
      });
    }
  }

  return items;
}

function ruleItem(
  id: string,
  scope: KnowledgeScope,
  name: string,
  file: string,
  metadata: KnowledgeMetadata,
  audiences: Audience[],
  time: number,
  who: { updatedBy: string; updatedAt: number },
): KnowledgeItem {
  return {
    id,
    kind: 'rule',
    scope,
    name,
    path: file,
    description: metadata.description,
    audiences,
    createdBy: metadata.createdBy ?? 'you',
    createdAt: metadata.createdAt ?? time,
    updatedBy: who.updatedBy,
    updatedAt: who.updatedAt,
    usedIn: 0,
  };
}

function parseRuleId(id: string): { scope: KnowledgeScope; slug: string } {
  const match = /^rule:(global|project):(.+)$/.exec(id);
  if (!match) throw new Error('That rule no longer exists.');
  return { scope: match[1] as KnowledgeScope, slug: match[2] };
}

function parseMemoryId(id: string): { scope: KnowledgeScope; relative: string } {
  const match = /^memory:(global|project):(.+)$/.exec(id);
  if (!match) throw new Error('That memory note no longer exists.');
  return { scope: match[1] as KnowledgeScope, relative: match[2] };
}

function instructionRoots(paths: RequestPaths) {
  return { workspace: paths.workspaceRoot, unifyHome: paths.unifyHome, agentsHome: paths.agentsHome };
}

/** The file an item lives in, so a kept agent version can be found and restored. */
async function knowledgeFileFor(paths: RequestPaths, id: string): Promise<string | undefined> {
  if (id.startsWith('rule:')) {
    const { scope } = parseRuleId(id);
    return ruleFile(paths, scope);
  }
  if (id.startsWith('memory:')) {
    const { scope, relative } = parseMemoryId(id);
    const root = memoryRoot(paths, scope);
    return root ? resolveInside(root, relative) : undefined;
  }
  if (id.startsWith('skill:')) {
    return path.join(await skillFolderForId(paths, id), 'SKILL.md');
  }
  return undefined;
}

/** Files an undo may write: Unify's data home, the open workspace and the shared agent skills home. */
function isInsideKnowledgeRoot(paths: RequestPaths, target: string): boolean {
  return [paths.unifyHome, paths.workspaceRoot, paths.agentsHome].some(root => !!root && isInside(root, target));
}

/**
 * Keeps the file as it was just before an agent writes it, so the Knowledge screen can undo that
 * change. Called from the approval path; the user's own saves update the metadata instead.
 */
export function recordKnowledgeVersion(paths: RequestPaths, file: string, by: string): void {
  const target = path.resolve(file);
  let content: string | null = null;
  try {
    content = fs.readFileSync(target, 'utf8');
  } catch {
    content = null;
  }
  const store = metadataStore(paths);
  const versions = store.versions ??= {};
  const list = versions[target] ??= [];
  const latest = list[list.length - 1];
  if (latest && latest.content === content) return;
  list.push({ at: Date.now(), by: by || 'an agent', content });
  if (list.length > 5) list.splice(0, list.length - 5);
  saveMetadata(paths, store);
}

/** Restores the version kept before the last agent write, then replies with the fresh state. */
export async function undoKnowledgeChange(context: UnifyRequestContext, paths: RequestPaths, id: string): Promise<KnowledgeItem[]> {
  const store = metadataStore(paths);
  const target = await knowledgeFileFor(paths, id);
  if (!target) throw new Error('Nothing to undo.');
  const key = path.resolve(target);
  if (!isInsideKnowledgeRoot(paths, key)) throw new Error('Nothing to undo.');
  const list = store.versions?.[key];
  if (!Array.isArray(list) || !list.length) throw new Error('Nothing to undo.');
  const version = list.pop()!;
  if (version.content === null) {
    await fsp.rm(target, { force: true });
  } else {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, version.content, 'utf8');
  }
  if (list && !list.length) delete store.versions![key];
  touchMetadata(store, id, { updatedBy: 'you', updatedAt: Date.now() });
  saveMetadata(paths, store);
  return listKnowledge(context, paths);
}

/** Reads one item, or one file inside a skill. */
export async function readKnowledge(
  context: UnifyRequestContext,
  paths: RequestPaths,
  id: string,
  file?: string,
): Promise<{ content: string; file?: string }> {
  if (id.startsWith('rule:')) {
    const { scope, slug } = parseRuleId(id);
    const target = ruleFile(paths, scope);
    if (!target) throw new Error('Open a project folder to read project rules.');
    const text = await readTextFile(target);
    if (!text.trim()) throw new Error('That rule no longer exists.');
    const parsed = parseRuleSections(text);
    if (!parsed.sections.length) return { content: parsed.preamble };
    const section = parsed.sections.find(item => item.slug === slug);
    if (!section) throw new Error('That rule no longer exists.');
    return { content: section.body };
  }
  if (id.startsWith('skill:')) {
    const instructionId = id.slice('skill:'.length);
    if (file) {
      const folder = skillFolderOf({ id: instructionId }, paths);
      return { content: await fsp.readFile(resolveInside(folder, file), 'utf8'), file };
    }
    return { content: await readInstruction(instructionRoots(paths), instructionId) };
  }
  if (id.startsWith('memory:')) {
    const { scope, relative } = parseMemoryId(id);
    const root = memoryRoot(paths, scope);
    if (!root) throw new Error('Open a project folder to read project memory.');
    return { content: await fsp.readFile(resolveInside(root, relative), 'utf8') };
  }
  throw new Error('Unknown knowledge item.');
}

/** Saves a rule section, a skill file, or a memory note. Returns the saved item. */
export async function saveKnowledge(
  context: UnifyRequestContext,
  paths: RequestPaths,
  draft: KnowledgeDraft,
  content: string,
  file?: string,
): Promise<KnowledgeItem> {
  if (!draft || typeof content !== 'string') throw new Error('Nothing to save.');
  const store = metadataStore(paths);
  const now = Date.now();
  const id = await (draft.kind === 'rule'
    ? saveRule(paths, draft, content, store)
    : draft.kind === 'skill'
      ? saveSkill(paths, draft, content, file, store)
      : saveMemory(paths, draft, content, store));
  const items = await listKnowledge(context, paths);
  const item = items.find(candidate => candidate.id === id);
  if (!item) throw new Error('The item was written, but could not be read back.');
  touchMetadata(store, id, {
    createdBy: store.items[id]?.createdBy ?? 'you',
    createdAt: store.items[id]?.createdAt ?? now,
    updatedBy: 'you',
    updatedAt: now,
  });
  saveMetadata(paths, store);
  return item;
}

async function saveRule(paths: RequestPaths, draft: KnowledgeDraft, content: string, store: KnowledgeStore): Promise<string> {
  const scope: KnowledgeScope = draft.scope === 'project' ? 'project' : 'global';
  const target = ruleFile(paths, scope);
  if (!target) throw new Error('Open a project folder to add project rules.');
  const name = String(draft.name || '').trim();
  if (!name) throw new Error('Give the rule a name.');
  const existing = draft.id && draft.id.startsWith('rule:') ? parseRuleId(draft.id) : undefined;
  const slug = slugify(existing?.slug || name);
  const text = await readTextFile(target);
  const parsed = parseRuleSections(text);
  if (parsed.sections.length) {
    const index = parsed.sections.findIndex(section => section.slug === (existing?.slug || slug));
    const section: RuleSection = { slug, name, body: content.trim() };
    if (index >= 0) parsed.sections[index] = section;
    else parsed.sections.push(section);
  } else if (existing?.slug === 'general') {
    // A flat rule file is one "general" rule; editing it replaces the text.
    parsed.preamble = content.trim();
  } else {
    // Keep a flat rule file as the preamble and add the new section below it.
    parsed.preamble = text.trim();
    parsed.sections = [{ slug, name, body: content.trim() }];
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, renderRuleSections(parsed), 'utf8');
  const id = `rule:${scope}:${slug}`;
  if (existing && existing.slug !== slug) delete store.items[`rule:${scope}:${existing.slug}`];
  touchMetadata(store, id, {
    ...(draft.description ? { description: draft.description } : {}),
    audiences: draft.audiences?.length ? draft.audiences : audiencesOf(store, id),
  });
  saveMetadata(paths, store);
  return id;
}

async function saveSkill(paths: RequestPaths, draft: KnowledgeDraft, content: string, file: string | undefined, store: KnowledgeStore): Promise<string> {
  if (draft.id && draft.id.startsWith('skill:')) {
    const skill = (await listInstructions(instructionRoots(paths))).find(item => `skill:${item.id}` === draft.id);
    if (!skill) throw new Error('That skill no longer exists.');
    const folder = skillFolderOf(skill, paths);
    const target = resolveInside(folder, file || 'SKILL.md');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf8');
    touchMetadata(store, draft.id, {
      ...(draft.description ? { description: draft.description } : {}),
      audiences: draft.audiences?.length ? draft.audiences : audiencesOf(store, draft.id),
    });
    saveMetadata(paths, store);
    return draft.id;
  }
  const name = String(draft.name || '').trim();
  if (!SKILL_NAME.test(name)) throw new Error('Skill names use lowercase letters, numbers and hyphens.');
  const scope = draft.scope === 'project' ? 'workspace' : 'global';
  if (scope === 'workspace' && !paths.workspaceRoot) throw new Error('Open a project folder to add project skills.');
  const saved = await saveInstruction(instructionRoots(paths), {
    kind: 'skill',
    scope,
    name,
    description: draft.description,
    content,
  });
  const id = `skill:${saved.item.id}`;
  touchMetadata(store, id, {
    ...(draft.description ? { description: draft.description } : {}),
    audiences: draft.audiences?.length ? draft.audiences : [...DEFAULT_AUDIENCES],
  });
  saveMetadata(paths, store);
  return id;
}

async function saveMemory(paths: RequestPaths, draft: KnowledgeDraft, content: string, store: KnowledgeStore): Promise<string> {
  const scope: KnowledgeScope = draft.scope === 'project' ? 'project' : 'global';
  const root = memoryRoot(paths, scope);
  if (!root) throw new Error('Open a project folder to add project memory.');
  const name = String(draft.name || '').trim();
  if (!name) throw new Error('Give the note a title.');
  const folder = String(draft.folder || '').trim().replace(/^[\\/]+|[\\/]+$/g, '');
  const filename = `${slugify(name)}.md`;
  const relative = folder ? `${folder}/${filename}` : filename;
  const target = resolveInside(root, relative);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content, 'utf8');
  const newId = `memory:${scope}:${relative.split(path.sep).join('/')}`;
  if (draft.id && draft.id.startsWith('memory:')) {
    const old = parseMemoryId(draft.id);
    const oldRoot = memoryRoot(paths, old.scope);
    if (oldRoot && (old.relative !== relative || old.scope !== scope)) {
      await fsp.rm(resolveInside(oldRoot, old.relative), { force: true }).catch(() => undefined);
      delete store.items[draft.id];
    }
  }
  touchMetadata(store, newId, {
    ...(draft.description ? { description: draft.description } : {}),
    ...(folder ? { folder } : {}),
    audiences: draft.audiences?.length ? draft.audiences : audiencesOf(store, newId),
  });
  saveMetadata(paths, store);
  return newId;
}

/** Removes a rule section, a whole skill folder, or a memory note. */
export async function removeKnowledge(context: UnifyRequestContext, paths: RequestPaths, id: string): Promise<void> {
  const store = metadataStore(paths);
  if (id.startsWith('rule:')) {
    const { scope, slug } = parseRuleId(id);
    const target = ruleFile(paths, scope);
    if (!target) throw new Error('That rule no longer exists.');
    const text = await readTextFile(target);
    if (text.trim()) {
      const parsed = parseRuleSections(text);
      if (parsed.sections.length) {
        parsed.sections = parsed.sections.filter(section => section.slug !== slug);
        const rendered = renderRuleSections(parsed);
        if (rendered.trim()) await fsp.writeFile(target, rendered, 'utf8');
        else await fsp.rm(target, { force: true });
      } else {
        await fsp.rm(target, { force: true });
      }
    }
  } else if (id.startsWith('skill:')) {
    const skill = (await listInstructions(instructionRoots(paths))).find(item => `skill:${item.id}` === id);
    if (!skill) throw new Error('That skill no longer exists.');
    const folder = path.resolve(skillFolderOf(skill, paths));
    assertInsideSkillRoot(paths, folder);
    await fsp.rm(folder, { recursive: true, force: true });
  } else if (id.startsWith('memory:')) {
    const { scope, relative } = parseMemoryId(id);
    const root = memoryRoot(paths, scope);
    if (!root) throw new Error('That note no longer exists.');
    const target = resolveInside(root, relative);
    await fsp.rm(target, { force: true });
    await fsp.rmdir(path.dirname(target)).catch(() => undefined);
  } else {
    throw new Error('Unknown knowledge item.');
  }
  delete store.items[id];
  saveMetadata(paths, store);
}

/** Stores audiences in Unify metadata; Unify itself does not filter by them yet. */
export function setKnowledgeAudiences(paths: RequestPaths, id: string, audiences: Audience[]): void {
  if (!Array.isArray(audiences)) throw new Error('Audiences must be a list.');
  const store = metadataStore(paths);
  touchMetadata(store, id, { audiences: audiences.length ? audiences : [...DEFAULT_AUDIENCES] });
  saveMetadata(paths, store);
}

/** Imports a dropped skill folder, keeping the folder layout (SKILL.md plus references, scripts, images). */
export async function importSkillFolder(
  context: UnifyRequestContext,
  paths: RequestPaths,
  scope: KnowledgeScope,
  name: string,
  files: ImportedFile[],
): Promise<KnowledgeItem> {
  const skillName = String(name || '').trim();
  if (!SKILL_NAME.test(skillName)) throw new Error('Skill names use lowercase letters, numbers and hyphens.');
  if (!Array.isArray(files) || !files.length) throw new Error('The dropped folder has no files.');
  const destination = scope === 'project'
    ? paths.workspaceRoot && path.join(paths.workspaceRoot, '.agents', 'skills', skillName)
    : path.join(paths.agentsHome, 'skills', skillName);
  if (!destination) throw new Error('Open a project folder to add project skills.');
  let total = 0;
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') throw new Error('The dropped folder has an unreadable file.');
    const buffer = file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf8');
    if (buffer.length > MAX_IMPORT_FILE_BYTES) throw new Error(`${file.path} is larger than 5 MB.`);
    total += buffer.length;
    if (total > MAX_IMPORT_TOTAL_BYTES) throw new Error('The skill folder is larger than 20 MB.');
  }
  for (const file of files) {
    const target = resolveInside(destination, file.path);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const buffer = file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : Buffer.from(file.content, 'utf8');
    await fsp.writeFile(target, buffer);
  }
  const items = await listKnowledge(context, paths);
  const item = items.find(candidate => candidate.id.startsWith('skill:') && candidate.name === skillName && candidate.scope === scope)
    ?? items.find(candidate => candidate.path === destination);
  if (!item) throw new Error('The skill folder was written, but could not be read back.');
  return item;
}

/** Opens an item (or one file inside a skill) in the OS file manager or its default app. */
export async function openKnowledge(
  paths: RequestPaths,
  id: string,
  file?: string,
  launch: (target: string) => void = openInFileManager,
): Promise<void> {
  let target: string | undefined;
  if (id.startsWith('rule:')) {
    const { scope } = parseRuleId(id);
    target = ruleFile(paths, scope);
  } else if (id.startsWith('memory:')) {
    const { scope, relative } = parseMemoryId(id);
    const root = memoryRoot(paths, scope);
    if (root) target = resolveInside(root, relative);
  } else if (id.startsWith('skill:')) {
    // Only a skill the scan found can be opened; a crafted id never becomes a path.
    const folder = await skillFolderForId(paths, id);
    target = file ? resolveInside(folder, file) : folder;
  }
  if (!target) throw new Error('Unknown knowledge item.');
  launch(target);
}

function openInFileManager(target: string): void {
  const opener = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(opener, [target], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
}
