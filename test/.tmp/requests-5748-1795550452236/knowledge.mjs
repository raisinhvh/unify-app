// src/engine/unify/requests/knowledge.ts
import { spawn } from "node:child_process";
import * as fs3 from "node:fs";
import { promises as fsp } from "node:fs";
import * as path2 from "node:path";

// src/engine/instructions/store.ts
import { promises as fs } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
var WORKSPACE_RULE_FILES = ["AGENTS.md", "AGENTS.local.md", "CLAUDE.md", "CLAUDE.local.md"];
var SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
var MAX_INSTRUCTION_BYTES = 256 * 1024;
var SKIPPED_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "build", ".venv", "venv", ".next", ".turbo", ".npm-cache", ".system"]);
var MAX_DEPTH = 6;
var MAX_ITEMS = 500;
var homeOf = (roots) => {
  const home = roots.unifyHome;
  if (!home) throw new Error("Instruction roots have no data home.");
  return home;
};
var baseDir = (roots, base) => base === "ws" ? roots.workspace : base === "unify" ? homeOf(roots) : roots.agentsHome;
function skillDescription(text) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const raw = frontmatter ? /^description:[ \t]*(.+)$/m.exec(frontmatter)?.[1]?.trim() : void 0;
  if (!raw) return void 0;
  const unquoted = /^(["'])(.*)\1$/.exec(raw)?.[2] ?? raw;
  return unquoted.slice(0, 200);
}
async function walk(directory, depth, visit, budget) {
  if (budget.left <= 0) return;
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.left <= 0 || entry.isSymbolicLink()) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH && !SKIPPED_DIRS.has(entry.name)) await walk(full, depth + 1, visit, budget);
    } else if (entry.isFile() && (entry.name === "SKILL.md" || WORKSPACE_RULE_FILES.includes(entry.name))) {
      budget.left -= 1;
      await visit(full, entry.name);
    }
  }
}
async function describe(file) {
  try {
    return skillDescription((await fs.readFile(file, "utf8")).slice(0, 4096));
  } catch {
    return void 0;
  }
}
function skillItem(base, scope, rel, description) {
  const parts = rel.split("/");
  return { id: `${base}:${rel}`, kind: "skill", scope, name: parts[parts.length - 2] || rel, path: rel, description };
}
async function listInstructions(roots) {
  const items = [];
  const budget = { left: MAX_ITEMS };
  const toRel = (root, file) => relative(root, file).split(sep).join("/");
  if (roots.workspace) {
    const root = roots.workspace;
    await walk(root, 0, async (file, name) => {
      const rel = toRel(root, file);
      if (name === "SKILL.md") items.push(skillItem("ws", "workspace", rel, await describe(file)));
      else items.push({ id: `ws:${rel}`, kind: "rule", scope: "workspace", name: rel, path: rel });
    }, budget);
  }
  try {
    await fs.access(join(homeOf(roots), "AGENTS.md"));
    items.push({ id: "unify:AGENTS.md", kind: "rule", scope: "global", name: "AGENTS.md", path: "AGENTS.md" });
  } catch {
  }
  for (const [base, root] of [["unify", homeOf(roots)], ["agents", roots.agentsHome]]) {
    const skills = join(root, "skills");
    await walk(skills, 0, async (file, name) => {
      if (name === "SKILL.md") items.push(skillItem(base, "global", toRel(root, file), await describe(file)));
    }, budget);
  }
  const order = (item) => (item.scope === "workspace" ? 0 : 1) * 2 + (item.kind === "rule" ? 0 : 1);
  return items.sort((a, b) => order(a) - order(b) || a.path.localeCompare(b.path));
}
function absolute(roots, id) {
  const split = id.indexOf(":");
  const base = id.slice(0, split);
  const rel = id.slice(split + 1);
  const root = split > 0 && (base === "ws" || base === "unify" || base === "agents") ? baseDir(roots, base) : void 0;
  if (!root || !rel || rel.includes("\0") || rel.split("/").some((part) => !part || part === "..")) throw new Error("Unknown rule or skill.");
  const file = resolve(root, ...rel.split("/"));
  if (!file.startsWith(resolve(root) + sep)) throw new Error("Unknown rule or skill.");
  return file;
}
async function find(roots, id) {
  const item = (await listInstructions(roots)).find((candidate) => candidate.id === id);
  if (!item) throw new Error("That rule or skill no longer exists.");
  return { item, file: absolute(roots, id) };
}
async function readInstruction(roots, id) {
  return fs.readFile((await find(roots, id)).file, "utf8");
}
function newSkillText(name, description, body) {
  const summary = description.replace(/\s+/g, " ").trim() || "Describe when to use this skill.";
  return `---
name: ${name}
description: ${JSON.stringify(summary)}
---

${body.trim() ? body.replace(/\s+$/, "") : `# ${name}

Add instructions here.`}
`;
}
async function saveInstruction(roots, request) {
  if (typeof request.content !== "string" || Buffer.byteLength(request.content) > MAX_INSTRUCTION_BYTES) throw new Error("Content is too large.");
  if (request.id !== void 0 && typeof request.id !== "string") throw new Error("Unknown rule or skill.");
  if (request.id) {
    const found = await find(roots, request.id);
    await fs.writeFile(found.file, request.content, "utf8");
    return found;
  }
  if (request.kind !== "rule" && request.kind !== "skill" || request.scope !== "workspace" && request.scope !== "global") throw new Error("Choose a rule or skill and where it applies.");
  let id;
  let text = request.content;
  if (request.kind === "skill") {
    const name = String(request.name || "").trim();
    if (!SKILL_NAME.test(name)) throw new Error("Skill names use lowercase letters, numbers and hyphens.");
    if (request.scope === "workspace" && !roots.workspace) throw new Error("Open a workspace folder to add workspace skills.");
    id = request.scope === "workspace" ? `ws:.agents/skills/${name}/SKILL.md` : `agents:skills/${name}/SKILL.md`;
    text = newSkillText(name, String(request.description || ""), request.content);
  } else {
    const file = String(request.file || "");
    if (request.scope === "workspace") {
      if (!roots.workspace) throw new Error("Open a workspace folder to add workspace rules.");
      if (!WORKSPACE_RULE_FILES.includes(file)) throw new Error("Choose a supported rules file.");
      id = `ws:${file}`;
    } else {
      if (file !== "AGENTS.md") throw new Error("Global rules live in AGENTS.md.");
      id = "unify:AGENTS.md";
    }
    if (!text.trim()) text = "# Rules\n\nAdd instructions here.\n";
  }
  const target = absolute(roots, id);
  await fs.mkdir(dirname(target), { recursive: true });
  try {
    await fs.writeFile(target, text, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("That rule or skill already exists. Edit it from the list instead.");
    throw error;
  }
  const item = (await listInstructions(roots)).find((candidate) => candidate.id === id);
  return { item: item ?? { id, kind: request.kind, scope: request.scope, name: request.name || String(request.file), path: id.slice(id.indexOf(":") + 1) }, file: target };
}

// src/engine/unify/requests/state.ts
import * as fs2 from "node:fs";
import * as path from "node:path";
function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs2.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJsonFile(file, value) {
  fs2.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs2.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}
`, "utf8");
  fs2.renameSync(temporary, file);
}
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function resolveInside(root, relativePath) {
  if (typeof relativePath !== "string" || relativePath.includes("\0")) throw new Error("Invalid file path.");
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw new Error("Invalid file path.");
  if (normalized.split("/").some((part) => part === "..")) throw new Error("Invalid file path.");
  const resolved = path.resolve(root, ...normalized.split("/").filter(Boolean));
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error("Invalid file path.");
  return resolved;
}
function slugify(value) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return slug || "untitled";
}

// src/engine/unify/requests/knowledge.ts
var MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
var MAX_IMPORT_TOTAL_BYTES = 20 * 1024 * 1024;
var MAX_MEMORY_FILES = 2e3;
var DEFAULT_AUDIENCES = ["everyone"];
function metadataStore(paths) {
  const stored = readJsonFile(paths.knowledgeFile, { items: {} });
  return {
    items: isRecord(stored.items) ? stored.items : {},
    versions: isRecord(stored.versions) ? stored.versions : {}
  };
}
function saveMetadata(paths, store) {
  writeJsonFile(paths.knowledgeFile, store);
}
function touchMetadata(store, id, patch) {
  store.items[id] = { ...store.items[id] ?? {}, ...patch };
}
function metadataFor(store, id) {
  return store.items[id] ?? {};
}
function audiencesOf(store, id) {
  const audiences = metadataFor(store, id).audiences;
  return Array.isArray(audiences) && audiences.length ? audiences : [...DEFAULT_AUDIENCES];
}
function versionsFor(store, file) {
  return store.versions?.[path2.resolve(file)] ?? [];
}
function attribution(store, file, metadata, fallbackTime) {
  const latest = versionsFor(store, file).at(-1);
  if (latest && latest.at > (metadata.updatedAt ?? 0)) return { updatedBy: latest.by, updatedAt: latest.at };
  return { updatedBy: metadata.updatedBy ?? "you", updatedAt: metadata.updatedAt ?? fallbackTime };
}
function ruleFile(paths, scope) {
  if (scope === "project") return paths.workspaceRoot ? path2.join(paths.workspaceRoot, "AGENTS.md") : void 0;
  return path2.join(paths.unifyHome, "AGENTS.md");
}
function parseRuleSections(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const preamble = [];
  const sections = [];
  let current;
  const flush = () => {
    if (!current) return;
    sections.push({ slug: slugify(current.name), name: current.name, body: current.lines.join("\n").trim() });
    current = void 0;
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
  return { preamble: preamble.join("\n").trim(), sections };
}
function renderRuleSections(parsed) {
  const parts = [];
  if (parsed.preamble) parts.push(parsed.preamble.trim());
  for (const section of parsed.sections) {
    parts.push(`## ${section.name}

${section.body.trim()}`);
  }
  return parts.length ? `${parts.join("\n\n")}
` : "";
}
async function readTextFile(file) {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return "";
  }
}
function titleOfRules(text) {
  const heading = /^#[ \t]+(.+)$/m.exec(text);
  return heading ? heading[1].trim() : "Rules";
}
async function walkFiles(root, budget = { left: MAX_MEMORY_FILES }) {
  const files = [];
  const walk2 = async (directory) => {
    if (budget.left <= 0) return;
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget.left <= 0 || entry.isSymbolicLink()) continue;
      const full = path2.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) await walk2(full);
        continue;
      }
      if (!entry.isFile()) continue;
      budget.left -= 1;
      files.push(full);
    }
  };
  await walk2(root);
  return files;
}
function memoryRoot(paths, scope) {
  if (scope === "project") return paths.workspaceRoot ? path2.join(paths.workspaceRoot, ".unify", "memory") : void 0;
  return path2.join(paths.unifyHome, "memory");
}
function noteTitle(content, file) {
  const heading = /^#[ \t]+(.+)$/m.exec(content);
  if (heading) return heading[1].trim();
  return path2.basename(file, path2.extname(file)).replace(/[-_]+/g, " ");
}
function skillRoots(paths) {
  const roots = [
    { root: path2.join(paths.agentsHome, "skills"), prefix: "agents" },
    { root: path2.join(paths.unifyHome, "skills"), prefix: "unify" }
  ];
  if (paths.workspaceRoot) roots.push({ root: path2.join(paths.workspaceRoot, ".agents", "skills"), prefix: "ws" });
  return roots;
}
function skillFolderOf(item, paths) {
  const prefix = item.id.slice(0, item.id.indexOf(":"));
  const rel = item.id.slice(item.id.indexOf(":") + 1);
  const base = prefix === "ws" ? paths.workspaceRoot : prefix === "agents" ? paths.agentsHome : paths.unifyHome;
  return path2.dirname(path2.join(base, ...rel.split("/")));
}
function isInside(root, target) {
  const relative4 = path2.relative(path2.resolve(root), path2.resolve(target));
  return !!relative4 && relative4 !== ".." && !relative4.startsWith(`..${path2.sep}`) && !path2.isAbsolute(relative4);
}
function assertInsideSkillRoot(paths, folder) {
  if (!skillRoots(paths).some((entry) => isInside(entry.root, folder))) {
    throw new Error("That skill folder is outside the skills folders.");
  }
}
async function skillFolderForId(paths, id) {
  const instructionId = id.slice("skill:".length);
  const skill = (await listInstructions(instructionRoots(paths))).find((item) => item.id === instructionId);
  if (!skill) throw new Error("That skill no longer exists.");
  const folder = skillFolderOf(skill, paths);
  assertInsideSkillRoot(paths, folder);
  return folder;
}
function statTimeSync(file) {
  try {
    return fs3.statSync(file).mtimeMs;
  } catch {
    return Date.now();
  }
}
async function statTime(file) {
  try {
    return (await fsp.stat(file)).mtimeMs;
  } catch {
    return Date.now();
  }
}
async function listKnowledge(context, paths) {
  const store = metadataStore(paths);
  const items = [];
  for (const scope of ["project", "global"]) {
    const file = ruleFile(paths, scope);
    if (!file) continue;
    const text = await readTextFile(file);
    if (!text.trim()) continue;
    const parsed = parseRuleSections(text);
    const sections = parsed.sections.length ? parsed.sections : [{ slug: "general", name: titleOfRules(text), body: parsed.preamble }];
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
    agentsHome: paths.agentsHome
  });
  for (const instruction of instructions) {
    if (instruction.kind !== "skill") continue;
    const scope = instruction.scope === "workspace" ? "project" : "global";
    const folder = skillFolderOf(instruction, paths);
    const id = `skill:${instruction.id}`;
    const files = (await walkFiles(folder)).map((file) => path2.relative(folder, file).split(path2.sep).join("/")).sort();
    const metadata = metadataFor(store, id);
    const skillFile = path2.join(folder, "SKILL.md");
    const time = statTimeSync(skillFile);
    const who = attribution(store, skillFile, metadata, time);
    items.push({
      id,
      kind: "skill",
      scope,
      name: path2.basename(folder),
      path: folder,
      description: metadata.description ?? instruction.description,
      audiences: audiencesOf(store, id),
      files,
      createdBy: metadata.createdBy ?? "you",
      createdAt: metadata.createdAt ?? statTimeSync(folder),
      updatedBy: who.updatedBy,
      updatedAt: who.updatedAt,
      usedIn: 0
    });
  }
  for (const scope of ["global", "project"]) {
    const root = memoryRoot(paths, scope);
    if (!root) continue;
    for (const file of await walkFiles(root)) {
      if (path2.extname(file).toLowerCase() !== ".md") continue;
      const relative4 = path2.relative(root, file).split(path2.sep).join("/");
      const id = `memory:${scope}:${relative4}`;
      const content = await readTextFile(file);
      const metadata = metadataFor(store, id);
      const folder = path2.dirname(relative4);
      const time = statTimeSync(file);
      const who = attribution(store, file, metadata, time);
      items.push({
        id,
        kind: "memory",
        scope,
        name: noteTitle(content, file),
        path: file,
        folder: folder === "." ? void 0 : folder,
        description: metadata.description,
        audiences: audiencesOf(store, id),
        createdBy: metadata.createdBy ?? "you",
        createdAt: metadata.createdAt ?? statTimeSync(file),
        updatedBy: who.updatedBy,
        updatedAt: who.updatedAt,
        usedIn: 0
      });
    }
  }
  return items;
}
function ruleItem(id, scope, name, file, metadata, audiences, time, who) {
  return {
    id,
    kind: "rule",
    scope,
    name,
    path: file,
    description: metadata.description,
    audiences,
    createdBy: metadata.createdBy ?? "you",
    createdAt: metadata.createdAt ?? time,
    updatedBy: who.updatedBy,
    updatedAt: who.updatedAt,
    usedIn: 0
  };
}
function parseRuleId(id) {
  const match = /^rule:(global|project):(.+)$/.exec(id);
  if (!match) throw new Error("That rule no longer exists.");
  return { scope: match[1], slug: match[2] };
}
function parseMemoryId(id) {
  const match = /^memory:(global|project):(.+)$/.exec(id);
  if (!match) throw new Error("That memory note no longer exists.");
  return { scope: match[1], relative: match[2] };
}
function instructionRoots(paths) {
  return { workspace: paths.workspaceRoot, unifyHome: paths.unifyHome, agentsHome: paths.agentsHome };
}
async function knowledgeFileFor(paths, id) {
  if (id.startsWith("rule:")) {
    const { scope } = parseRuleId(id);
    return ruleFile(paths, scope);
  }
  if (id.startsWith("memory:")) {
    const { scope, relative: relative4 } = parseMemoryId(id);
    const root = memoryRoot(paths, scope);
    return root ? resolveInside(root, relative4) : void 0;
  }
  if (id.startsWith("skill:")) {
    return path2.join(await skillFolderForId(paths, id), "SKILL.md");
  }
  return void 0;
}
function isInsideKnowledgeRoot(paths, target) {
  return [paths.unifyHome, paths.workspaceRoot, paths.agentsHome].some((root) => !!root && isInside(root, target));
}
function recordKnowledgeVersion(paths, file, by) {
  const target = path2.resolve(file);
  let content = null;
  try {
    content = fs3.readFileSync(target, "utf8");
  } catch {
    content = null;
  }
  const store = metadataStore(paths);
  const versions = store.versions ??= {};
  const list = versions[target] ??= [];
  const latest = list[list.length - 1];
  if (latest && latest.content === content) return;
  list.push({ at: Date.now(), by: by || "an agent", content });
  if (list.length > 5) list.splice(0, list.length - 5);
  saveMetadata(paths, store);
}
async function undoKnowledgeChange(context, paths, id) {
  const store = metadataStore(paths);
  const target = await knowledgeFileFor(paths, id);
  if (!target) throw new Error("Nothing to undo.");
  const key = path2.resolve(target);
  if (!isInsideKnowledgeRoot(paths, key)) throw new Error("Nothing to undo.");
  const list = store.versions?.[key];
  if (!Array.isArray(list) || !list.length) throw new Error("Nothing to undo.");
  const version = list.pop();
  if (version.content === null) {
    await fsp.rm(target, { force: true });
  } else {
    await fsp.mkdir(path2.dirname(target), { recursive: true });
    await fsp.writeFile(target, version.content, "utf8");
  }
  if (list && !list.length) delete store.versions[key];
  touchMetadata(store, id, { updatedBy: "you", updatedAt: Date.now() });
  saveMetadata(paths, store);
  return listKnowledge(context, paths);
}
async function readKnowledge(context, paths, id, file) {
  if (id.startsWith("rule:")) {
    const { scope, slug } = parseRuleId(id);
    const target = ruleFile(paths, scope);
    if (!target) throw new Error("Open a project folder to read project rules.");
    const text = await readTextFile(target);
    if (!text.trim()) throw new Error("That rule no longer exists.");
    const parsed = parseRuleSections(text);
    if (!parsed.sections.length) return { content: parsed.preamble };
    const section = parsed.sections.find((item) => item.slug === slug);
    if (!section) throw new Error("That rule no longer exists.");
    return { content: section.body };
  }
  if (id.startsWith("skill:")) {
    const instructionId = id.slice("skill:".length);
    if (file) {
      const folder = await skillFolderForId(paths, id);
      return { content: await fsp.readFile(resolveInside(folder, file), "utf8"), file };
    }
    return { content: await readInstruction(instructionRoots(paths), instructionId) };
  }
  if (id.startsWith("memory:")) {
    const { scope, relative: relative4 } = parseMemoryId(id);
    const root = memoryRoot(paths, scope);
    if (!root) throw new Error("Open a project folder to read project memory.");
    return { content: await fsp.readFile(resolveInside(root, relative4), "utf8") };
  }
  throw new Error("Unknown knowledge item.");
}
async function saveKnowledge(context, paths, draft, content, file) {
  if (!draft || typeof content !== "string") throw new Error("Nothing to save.");
  const store = metadataStore(paths);
  const now = Date.now();
  const id = await (draft.kind === "rule" ? saveRule(paths, draft, content, store) : draft.kind === "skill" ? saveSkill(paths, draft, content, file, store) : saveMemory(paths, draft, content, store));
  touchMetadata(store, id, {
    createdBy: store.items[id]?.createdBy ?? "you",
    createdAt: store.items[id]?.createdAt ?? now,
    updatedBy: "you",
    updatedAt: now
  });
  saveMetadata(paths, store);
  const items = await listKnowledge(context, paths);
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error("The item was written, but could not be read back.");
  return item;
}
async function saveRule(paths, draft, content, store) {
  const scope = draft.scope === "project" ? "project" : "global";
  const target = ruleFile(paths, scope);
  if (!target) throw new Error("Open a project folder to add project rules.");
  const name = String(draft.name || "").trim();
  if (!name) throw new Error("Give the rule a name.");
  const existing = draft.id && draft.id.startsWith("rule:") ? parseRuleId(draft.id) : void 0;
  let slug = slugify(name);
  const text = await readTextFile(target);
  const parsed = parseRuleSections(text);
  if (parsed.sections.length) {
    const index = parsed.sections.findIndex((section2) => section2.slug === (existing?.slug || slug));
    const section = { slug, name, body: content.trim() };
    if (index >= 0) parsed.sections[index] = section;
    else parsed.sections.push(section);
  } else if (existing?.slug === "general") {
    parsed.preamble = content.trim();
    slug = "general";
  } else {
    parsed.preamble = text.trim();
    parsed.sections = [{ slug, name, body: content.trim() }];
  }
  await fsp.mkdir(path2.dirname(target), { recursive: true });
  await fsp.writeFile(target, renderRuleSections(parsed), "utf8");
  const id = `rule:${scope}:${slug}`;
  const oldId = existing ? `rule:${existing.scope}:${existing.slug}` : void 0;
  const previousMetadata = oldId && oldId !== id ? store.items[oldId] : void 0;
  if (oldId && oldId !== id) delete store.items[oldId];
  touchMetadata(store, id, {
    ...previousMetadata ?? {},
    ...draft.description ? { description: draft.description } : {},
    audiences: draft.audiences?.length ? draft.audiences : previousMetadata?.audiences?.length ? previousMetadata.audiences : audiencesOf(store, id)
  });
  saveMetadata(paths, store);
  return id;
}
async function saveSkill(paths, draft, content, file, store) {
  if (draft.id && draft.id.startsWith("skill:")) {
    const skill = (await listInstructions(instructionRoots(paths))).find((item) => `skill:${item.id}` === draft.id);
    if (!skill) throw new Error("That skill no longer exists.");
    const folder = skillFolderOf(skill, paths);
    const target = resolveInside(folder, file || "SKILL.md");
    await fsp.mkdir(path2.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, "utf8");
    touchMetadata(store, draft.id, {
      ...draft.description ? { description: draft.description } : {},
      audiences: draft.audiences?.length ? draft.audiences : audiencesOf(store, draft.id)
    });
    saveMetadata(paths, store);
    return draft.id;
  }
  const name = String(draft.name || "").trim();
  if (!SKILL_NAME.test(name)) throw new Error("Skill names use lowercase letters, numbers and hyphens.");
  const scope = draft.scope === "project" ? "workspace" : "global";
  if (scope === "workspace" && !paths.workspaceRoot) throw new Error("Open a project folder to add project skills.");
  const saved = await saveInstruction(instructionRoots(paths), {
    kind: "skill",
    scope,
    name,
    description: draft.description,
    content
  });
  const id = `skill:${saved.item.id}`;
  touchMetadata(store, id, {
    ...draft.description ? { description: draft.description } : {},
    audiences: draft.audiences?.length ? draft.audiences : [...DEFAULT_AUDIENCES]
  });
  saveMetadata(paths, store);
  return id;
}
async function saveMemory(paths, draft, content, store) {
  const scope = draft.scope === "project" ? "project" : "global";
  const root = memoryRoot(paths, scope);
  if (!root) throw new Error("Open a project folder to add project memory.");
  const name = String(draft.name || "").trim();
  if (!name) throw new Error("Give the note a title.");
  const folder = String(draft.folder || "").trim().replace(/^[\\/]+|[\\/]+$/g, "");
  const filename = `${slugify(name)}.md`;
  const relative4 = folder ? `${folder}/${filename}` : filename;
  const target = resolveInside(root, relative4);
  await fsp.mkdir(path2.dirname(target), { recursive: true });
  await fsp.writeFile(target, content, "utf8");
  const newId = `memory:${scope}:${relative4.split(path2.sep).join("/")}`;
  if (draft.id && draft.id.startsWith("memory:")) {
    const old = parseMemoryId(draft.id);
    const oldRoot = memoryRoot(paths, old.scope);
    if (oldRoot && (old.relative !== relative4 || old.scope !== scope)) {
      await fsp.rm(resolveInside(oldRoot, old.relative), { force: true }).catch(() => void 0);
      delete store.items[draft.id];
    }
  }
  touchMetadata(store, newId, {
    ...draft.description ? { description: draft.description } : {},
    ...folder ? { folder } : {},
    audiences: draft.audiences?.length ? draft.audiences : audiencesOf(store, newId)
  });
  saveMetadata(paths, store);
  return newId;
}
async function removeKnowledge(context, paths, id) {
  const store = metadataStore(paths);
  if (id.startsWith("rule:")) {
    const { scope, slug } = parseRuleId(id);
    const target = ruleFile(paths, scope);
    if (!target) throw new Error("That rule no longer exists.");
    const text = await readTextFile(target);
    if (text.trim()) {
      const parsed = parseRuleSections(text);
      if (parsed.sections.length) {
        parsed.sections = parsed.sections.filter((section) => section.slug !== slug);
        const rendered = renderRuleSections(parsed);
        if (rendered.trim()) await fsp.writeFile(target, rendered, "utf8");
        else await fsp.rm(target, { force: true });
      } else {
        await fsp.rm(target, { force: true });
      }
    }
  } else if (id.startsWith("skill:")) {
    const skill = (await listInstructions(instructionRoots(paths))).find((item) => `skill:${item.id}` === id);
    if (!skill) throw new Error("That skill no longer exists.");
    const folder = path2.resolve(skillFolderOf(skill, paths));
    assertInsideSkillRoot(paths, folder);
    await fsp.rm(folder, { recursive: true, force: true });
  } else if (id.startsWith("memory:")) {
    const { scope, relative: relative4 } = parseMemoryId(id);
    const root = memoryRoot(paths, scope);
    if (!root) throw new Error("That note no longer exists.");
    const target = resolveInside(root, relative4);
    await fsp.rm(target, { force: true });
    const parentDir = path2.dirname(target);
    if (isInside(root, parentDir)) {
      await fsp.rmdir(parentDir).catch(() => void 0);
    }
  } else {
    throw new Error("Unknown knowledge item.");
  }
  delete store.items[id];
  saveMetadata(paths, store);
}
function setKnowledgeAudiences(paths, id, audiences) {
  if (!Array.isArray(audiences)) throw new Error("Audiences must be a list.");
  const store = metadataStore(paths);
  touchMetadata(store, id, { audiences: audiences.length ? audiences : [...DEFAULT_AUDIENCES] });
  saveMetadata(paths, store);
}
async function importSkillFolder(context, paths, scope, name, files) {
  const skillName = String(name || "").trim();
  if (!SKILL_NAME.test(skillName)) throw new Error("Skill names use lowercase letters, numbers and hyphens.");
  if (!Array.isArray(files) || !files.length) throw new Error("The dropped folder has no files.");
  const destination = scope === "project" ? paths.workspaceRoot && path2.join(paths.workspaceRoot, ".agents", "skills", skillName) : path2.join(paths.agentsHome, "skills", skillName);
  if (!destination) throw new Error("Open a project folder to add project skills.");
  assertInsideSkillRoot(paths, destination);
  let total = 0;
  const skillDocTarget = path2.resolve(destination, "SKILL.md");
  let hasSkillDoc = false;
  const planned = [];
  for (const file of files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
      throw new Error("The dropped folder has an unreadable file.");
    }
    const target = resolveInside(destination, file.path);
    const buffer = file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
    if (buffer.length > MAX_IMPORT_FILE_BYTES) throw new Error(`${file.path} is larger than 5 MB.`);
    total += buffer.length;
    if (total > MAX_IMPORT_TOTAL_BYTES) throw new Error("The skill folder is larger than 20 MB.");
    if (path2.resolve(target) === skillDocTarget) hasSkillDoc = true;
    planned.push({ target, buffer });
  }
  if (!hasSkillDoc) {
    throw new Error("A skill folder must include SKILL.md.");
  }
  for (const entry of planned) {
    await fsp.mkdir(path2.dirname(entry.target), { recursive: true });
    await fsp.writeFile(entry.target, entry.buffer);
  }
  const items = await listKnowledge(context, paths);
  const item = items.find((candidate) => candidate.id.startsWith("skill:") && candidate.name === skillName && candidate.scope === scope) ?? items.find((candidate) => candidate.path === destination);
  if (!item) throw new Error("The skill folder was written, but could not be read back.");
  return item;
}
async function openKnowledge(paths, id, file, launch = openInFileManager) {
  let target;
  if (id.startsWith("rule:")) {
    const { scope } = parseRuleId(id);
    target = ruleFile(paths, scope);
  } else if (id.startsWith("memory:")) {
    const { scope, relative: relative4 } = parseMemoryId(id);
    const root = memoryRoot(paths, scope);
    if (root) target = resolveInside(root, relative4);
  } else if (id.startsWith("skill:")) {
    const folder = await skillFolderForId(paths, id);
    target = file ? resolveInside(folder, file) : folder;
  }
  if (!target) throw new Error("Unknown knowledge item.");
  launch(target);
}
function openInFileManager(target) {
  const opener = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [target], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => void 0);
  child.unref();
}
export {
  importSkillFolder,
  listKnowledge,
  openKnowledge,
  parseRuleSections,
  readKnowledge,
  recordKnowledgeVersion,
  removeKnowledge,
  renderRuleSections,
  saveKnowledge,
  setKnowledgeAudiences,
  undoKnowledgeChange
};
