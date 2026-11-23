// ../Unify/src/engine/unify/requests/index.ts
import * as path10 from "node:path";

// ../Unify/src/engine/unify/requests/workspace.ts
import { createHash } from "node:crypto";
import * as fs2 from "node:fs";
import * as path2 from "node:path";

// ../Unify/src/engine/unify/requests/state.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
function requestPaths(context) {
  const dshHome = path.resolve(context.dshHome || process.env.DSH_HOME || path.join(os.homedir(), ".dsh"));
  const unifyRoot = path.resolve(context.unifyRoot || process.env.UNIFY_HOME || path.join(dshHome, "unify"));
  const storageRoot = path.join(unifyRoot, "storage");
  return {
    workspaceRoot: context.workspaceRoot ? path.resolve(context.workspaceRoot) : void 0,
    dshHome,
    unifyRoot,
    storageRoot,
    toolpacksDir: path.join(storageRoot, "toolpacks"),
    agentsHome: path.resolve(process.env.AGENTS_HOME || path.join(os.homedir(), ".agents")),
    settingsFile: path.join(unifyRoot, "settings.json"),
    stateFile: path.join(unifyRoot, "state.json"),
    providersFile: path.join(unifyRoot, "providers.json"),
    toolpacksFile: path.join(unifyRoot, "toolpacks.json"),
    knowledgeFile: path.join(unifyRoot, "knowledge.json"),
    setupFile: path.join(unifyRoot, "setup.json")
  };
}
function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}
`, "utf8");
  fs.renameSync(temporary, file);
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
function relativeToWorkspace(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}
function slugify(value) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return slug || "untitled";
}

// ../Unify/src/engine/unify/requests/workspace.ts
var IGNORED_DIRECTORIES = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".venv",
  "venv",
  ".next",
  ".turbo",
  ".npm-cache",
  ".system"
]);
var MAX_SEARCH_FILES = 2e4;
var MAX_SEARCH_DEPTH = 12;
var CHANGE_DEBOUNCE_MS = 200;
var languageByExtension = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  css: "css",
  scss: "scss",
  html: "html",
  luau: "lua",
  lua: "lua",
  py: "python",
  rs: "rust",
  go: "go",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  ps1: "powershell"
};
function languageFor(file) {
  const extension = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  return languageByExtension[extension] ?? "plaintext";
}
function contentVersion(content) {
  return createHash("sha1").update(content).digest("hex");
}
function statOrUndefined(file) {
  try {
    return fs2.statSync(file);
  } catch {
    return void 0;
  }
}
function requireWorkspace(root) {
  if (!root) throw new Error("Open a project folder first.");
  if (!statOrUndefined(root)?.isDirectory()) throw new Error("The project folder is no longer available.");
  return root;
}
function readWorkspaceFile(root, relativePath) {
  const base = requireWorkspace(root);
  const file = resolveInside(base, relativePath);
  const info = statOrUndefined(file);
  if (!info || !info.isFile()) throw new Error(`No file at ${relativePath || "."}.`);
  const content = fs2.readFileSync(file, "utf8");
  return {
    path: relativeToWorkspace(base, file),
    content,
    language: languageFor(file),
    version: contentVersion(content)
  };
}
function listWorkspaceDirectory(root, relativePath) {
  const base = requireWorkspace(root);
  const directory = resolveInside(base, relativePath || "");
  let dirents;
  try {
    dirents = fs2.readdirSync(directory, { withFileTypes: true });
  } catch {
    throw new Error(`No folder at ${relativePath || "."}.`);
  }
  const entries = [];
  for (const entry of dirents) {
    if (entry.isSymbolicLink()) continue;
    const isDirectory = entry.isDirectory();
    if (!isDirectory && !entry.isFile()) continue;
    if (isDirectory && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const full = path2.join(directory, entry.name);
    entries.push({
      name: entry.name,
      path: relativeToWorkspace(base, full),
      kind: isDirectory ? "dir" : "file"
    });
    rememberPath(relativeToWorkspace(base, full));
  }
  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, void 0, { sensitivity: "base" });
  });
}
function writeWorkspaceFile(root, relativePath, content, version2) {
  const base = requireWorkspace(root);
  const file = resolveInside(base, relativePath);
  const info = statOrUndefined(file);
  if (info?.isDirectory()) throw new Error(`${relativePath} is a folder.`);
  if (info) {
    const currentContent = fs2.readFileSync(file, "utf8");
    const current = {
      path: relativeToWorkspace(base, file),
      content: currentContent,
      language: languageFor(file),
      version: contentVersion(currentContent)
    };
    if (version2 !== current.version) return { ok: false, conflict: current };
  } else if (version2) {
    return {
      ok: false,
      conflict: { path: relativePath, content: "", language: languageFor(file), version: "" }
    };
  }
  fs2.mkdirSync(path2.dirname(file), { recursive: true });
  fs2.writeFileSync(file, content, "utf8");
  rememberPath(relativeToWorkspace(base, file));
  return { ok: true, version: contentVersion(content) };
}
function findWorkspaceFiles(root, query, limit = 50) {
  const base = requireWorkspace(root);
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const max = Math.min(Math.max(1, Math.trunc(limit) || 50), 500);
  const matches = [];
  let visited = 0;
  const walk2 = (directory, depth) => {
    if (matches.length >= max * 4 || visited >= MAX_SEARCH_FILES || depth > MAX_SEARCH_DEPTH) return;
    let dirents;
    try {
      dirents = fs2.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirents) {
      if (entry.isSymbolicLink()) continue;
      const full = path2.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) walk2(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      const relative4 = relativeToWorkspace(base, full);
      if (relative4.toLowerCase().includes(needle)) {
        matches.push(relative4);
        rememberPath(relative4);
      }
    }
  };
  walk2(base, 0);
  return matches.sort((a, b) => {
    const aName = a.slice(a.lastIndexOf("/") + 1).toLowerCase();
    const bName = b.slice(b.lastIndexOf("/") + 1).toLowerCase();
    const aStarts = aName.startsWith(needle) ? 0 : 1;
    const bStarts = bName.startsWith(needle) ? 0 : 1;
    return aStarts - bStarts || a.length - b.length || a.localeCompare(b);
  }).slice(0, max);
}
var watchers = /* @__PURE__ */ new Map();
var watchedRoot;
var activeReply;
function setActiveUnifyReply(reply) {
  activeReply = reply;
}
function rememberPath(relative4) {
  const state = watchedRoot ? watchers.get(watchedRoot) : void 0;
  if (state) state.known.add(relative4);
}
function watchWorkspace(root, reply) {
  if (reply) activeReply = reply;
  if (!root) return;
  if (watchedRoot === root && watchers.has(root)) return;
  if (watchedRoot && watchedRoot !== root) disposeUnifyRequestWatchers();
  let watcher;
  try {
    watcher = fs2.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      if (!filename) return;
      const relative4 = filename.toString().replace(/\\/g, "/");
      scheduleChange(root, relative4);
    });
  } catch {
    return;
  }
  watcher.on("error", () => {
    watcher.close();
    watchers.delete(root);
    if (watchedRoot === root) watchedRoot = void 0;
  });
  watchers.set(root, { watcher, timers: /* @__PURE__ */ new Map(), known: /* @__PURE__ */ new Set() });
  watchedRoot = root;
}
function scheduleChange(root, relative4) {
  const state = watchers.get(root);
  if (!state) return;
  const existing = state.timers.get(relative4);
  if (existing) clearTimeout(existing);
  state.timers.set(relative4, setTimeout(() => {
    state.timers.delete(relative4);
    const base = path2.resolve(root);
    const full = path2.resolve(base, ...relative4.split("/"));
    if (full !== base && !full.startsWith(base + path2.sep)) return;
    if (relative4.split("/").some((part) => IGNORED_DIRECTORIES.has(part))) return;
    const exists = !!statOrUndefined(full);
    const wasKnown = state.known.has(relative4);
    if (!exists) {
      state.known.delete(relative4);
      activeReply?.({ type: "fileChanged", path: relative4, kind: "deleted" });
      return;
    }
    state.known.add(relative4);
    activeReply?.({
      type: "fileChanged",
      path: relative4,
      kind: wasKnown ? "changed" : "created"
    });
  }, CHANGE_DEBOUNCE_MS));
}
function disposeUnifyRequestWatchers() {
  for (const state of watchers.values()) {
    for (const timer of state.timers.values()) clearTimeout(timer);
    state.watcher.close();
  }
  watchers.clear();
  watchedRoot = void 0;
  activeReply = void 0;
}

// ../Unify/src/engine/unify/requests/knowledge.ts
import { spawn } from "node:child_process";
import * as fs4 from "node:fs";
import { promises as fsp } from "node:fs";
import * as path3 from "node:path";

// ../Unify/src/engine/instructions/store.ts
import { promises as fs3 } from "node:fs";
import { dirname as dirname3, join as join3, relative as relative2, resolve as resolve3, sep as sep3 } from "node:path";
var WORKSPACE_RULE_FILES = ["AGENTS.md", "AGENTS.local.md", "CLAUDE.md", "CLAUDE.local.md"];
var SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
var MAX_INSTRUCTION_BYTES = 256 * 1024;
var SKIPPED_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "build", ".venv", "venv", ".next", ".turbo", ".npm-cache", ".system"]);
var MAX_DEPTH = 6;
var MAX_ITEMS = 500;
var baseDir = (roots, base) => base === "ws" ? roots.workspace : base === "dsh" ? roots.dshHome : roots.agentsHome;
function skillDescription(text2) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text2)?.[1];
  const raw = frontmatter ? /^description:[ \t]*(.+)$/m.exec(frontmatter)?.[1]?.trim() : void 0;
  if (!raw) return void 0;
  const unquoted = /^(["'])(.*)\1$/.exec(raw)?.[2] ?? raw;
  return unquoted.slice(0, 200);
}
async function walk(directory, depth, visit, budget) {
  if (budget.left <= 0) return;
  let entries;
  try {
    entries = await fs3.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.left <= 0 || entry.isSymbolicLink()) continue;
    const full = join3(directory, entry.name);
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
    return skillDescription((await fs3.readFile(file, "utf8")).slice(0, 4096));
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
  const toRel = (root, file) => relative2(root, file).split(sep3).join("/");
  if (roots.workspace) {
    const root = roots.workspace;
    await walk(root, 0, async (file, name) => {
      const rel = toRel(root, file);
      if (name === "SKILL.md") items.push(skillItem("ws", "workspace", rel, await describe(file)));
      else items.push({ id: `ws:${rel}`, kind: "rule", scope: "workspace", name: rel, path: rel });
    }, budget);
  }
  try {
    await fs3.access(join3(roots.dshHome, "AGENTS.md"));
    items.push({ id: "dsh:AGENTS.md", kind: "rule", scope: "global", name: "AGENTS.md", path: "AGENTS.md" });
  } catch {
  }
  for (const [base, root] of [["dsh", roots.dshHome], ["agents", roots.agentsHome]]) {
    const skills = join3(root, "skills");
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
  const root = split > 0 && (base === "ws" || base === "dsh" || base === "agents") ? baseDir(roots, base) : void 0;
  if (!root || !rel || rel.includes("\0") || rel.split("/").some((part) => !part || part === "..")) throw new Error("Unknown rule or skill.");
  const file = resolve3(root, ...rel.split("/"));
  if (!file.startsWith(resolve3(root) + sep3)) throw new Error("Unknown rule or skill.");
  return file;
}
async function find(roots, id) {
  const item = (await listInstructions(roots)).find((candidate) => candidate.id === id);
  if (!item) throw new Error("That rule or skill no longer exists.");
  return { item, file: absolute(roots, id) };
}
async function readInstruction(roots, id) {
  return fs3.readFile((await find(roots, id)).file, "utf8");
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
    await fs3.writeFile(found.file, request.content, "utf8");
    return found;
  }
  if (request.kind !== "rule" && request.kind !== "skill" || request.scope !== "workspace" && request.scope !== "global") throw new Error("Choose a rule or skill and where it applies.");
  let id;
  let text2 = request.content;
  if (request.kind === "skill") {
    const name = String(request.name || "").trim();
    if (!SKILL_NAME.test(name)) throw new Error("Skill names use lowercase letters, numbers and hyphens.");
    if (request.scope === "workspace" && !roots.workspace) throw new Error("Open a workspace folder to add workspace skills.");
    id = request.scope === "workspace" ? `ws:.agents/skills/${name}/SKILL.md` : `agents:skills/${name}/SKILL.md`;
    text2 = newSkillText(name, String(request.description || ""), request.content);
  } else {
    const file = String(request.file || "");
    if (request.scope === "workspace") {
      if (!roots.workspace) throw new Error("Open a workspace folder to add workspace rules.");
      if (!WORKSPACE_RULE_FILES.includes(file)) throw new Error("Choose a supported rules file.");
      id = `ws:${file}`;
    } else {
      if (file !== "AGENTS.md") throw new Error("Global rules live in AGENTS.md.");
      id = "dsh:AGENTS.md";
    }
    if (!text2.trim()) text2 = "# Rules\n\nAdd instructions here.\n";
  }
  const target = absolute(roots, id);
  await fs3.mkdir(dirname3(target), { recursive: true });
  try {
    await fs3.writeFile(target, text2, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("That rule or skill already exists. Edit it from the list instead.");
    throw error;
  }
  const item = (await listInstructions(roots)).find((candidate) => candidate.id === id);
  return { item: item ?? { id, kind: request.kind, scope: request.scope, name: request.name || String(request.file), path: id.slice(id.indexOf(":") + 1) }, file: target };
}

// ../Unify/src/engine/unify/requests/knowledge.ts
var MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
var MAX_IMPORT_TOTAL_BYTES = 20 * 1024 * 1024;
var MAX_MEMORY_FILES = 2e3;
var DEFAULT_AUDIENCES = ["everyone"];
function metadataStore(paths) {
  const stored = readJsonFile(paths.knowledgeFile, { items: {} });
  return { items: isRecord(stored.items) ? stored.items : {} };
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
function ruleFile(paths, scope) {
  if (scope === "project") return paths.workspaceRoot ? path3.join(paths.workspaceRoot, "AGENTS.md") : void 0;
  return path3.join(paths.dshHome, "AGENTS.md");
}
function parseRuleSections(text2) {
  const lines = text2.replace(/\r\n/g, "\n").split("\n");
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
function titleOfRules(text2) {
  const heading = /^#[ \t]+(.+)$/m.exec(text2);
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
      const full = path3.join(directory, entry.name);
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
  if (scope === "project") return paths.workspaceRoot ? path3.join(paths.workspaceRoot, ".dsh", "memory") : void 0;
  return path3.join(paths.dshHome, "memory");
}
function noteTitle(content, file) {
  const heading = /^#[ \t]+(.+)$/m.exec(content);
  if (heading) return heading[1].trim();
  return path3.basename(file, path3.extname(file)).replace(/[-_]+/g, " ");
}
function skillRoots(paths) {
  const roots = [
    { root: path3.join(paths.agentsHome, "skills"), prefix: "agents" },
    { root: path3.join(paths.dshHome, "skills"), prefix: "dsh" }
  ];
  if (paths.workspaceRoot) roots.push({ root: path3.join(paths.workspaceRoot, ".agents", "skills"), prefix: "ws" });
  return roots;
}
function skillFolderOf(item, paths) {
  const prefix = item.id.slice(0, item.id.indexOf(":"));
  const rel = item.id.slice(item.id.indexOf(":") + 1);
  const base = prefix === "ws" ? paths.workspaceRoot : prefix === "agents" ? paths.agentsHome : paths.dshHome;
  return path3.dirname(path3.join(base, ...rel.split("/")));
}
function statTimeSync(file) {
  try {
    return fs4.statSync(file).mtimeMs;
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
    const text2 = await readTextFile(file);
    if (!text2.trim()) continue;
    const parsed = parseRuleSections(text2);
    const sections = parsed.sections.length ? parsed.sections : [{ slug: "general", name: titleOfRules(text2), body: parsed.preamble }];
    for (const section of sections) {
      const id = `rule:${scope}:${section.slug}`;
      items.push(ruleItem(id, scope, section.name, file, metadataFor(store, id), audiencesOf(store, id), await statTime(file)));
    }
  }
  const instructions = await listInstructions({
    workspace: paths.workspaceRoot,
    dshHome: paths.dshHome,
    agentsHome: paths.agentsHome
  });
  for (const instruction of instructions) {
    if (instruction.kind !== "skill") continue;
    const scope = instruction.scope === "workspace" ? "project" : "global";
    const folder = skillFolderOf(instruction, paths);
    const id = `skill:${instruction.id}`;
    const files = (await walkFiles(folder)).map((file) => path3.relative(folder, file).split(path3.sep).join("/")).sort();
    const metadata = metadataFor(store, id);
    items.push({
      id,
      kind: "skill",
      scope,
      name: path3.basename(folder),
      path: folder,
      description: metadata.description ?? instruction.description,
      audiences: audiencesOf(store, id),
      files,
      createdBy: metadata.createdBy ?? "you",
      createdAt: metadata.createdAt ?? statTimeSync(folder),
      updatedBy: metadata.updatedBy ?? "you",
      updatedAt: metadata.updatedAt ?? statTimeSync(path3.join(folder, "SKILL.md")),
      usedIn: 0
    });
  }
  for (const scope of ["global", "project"]) {
    const root = memoryRoot(paths, scope);
    if (!root) continue;
    for (const file of await walkFiles(root)) {
      if (path3.extname(file).toLowerCase() !== ".md") continue;
      const relative4 = path3.relative(root, file).split(path3.sep).join("/");
      const id = `memory:${scope}:${relative4}`;
      const content = await readTextFile(file);
      const metadata = metadataFor(store, id);
      const folder = path3.dirname(relative4);
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
        updatedBy: metadata.updatedBy ?? "you",
        updatedAt: metadata.updatedAt ?? statTimeSync(file),
        usedIn: 0
      });
    }
  }
  return items;
}
function ruleItem(id, scope, name, file, metadata, audiences, time) {
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
    updatedBy: metadata.updatedBy ?? "you",
    updatedAt: metadata.updatedAt ?? time,
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
  return { workspace: paths.workspaceRoot, dshHome: paths.dshHome, agentsHome: paths.agentsHome };
}
async function readKnowledge(context, paths, id, file) {
  if (id.startsWith("rule:")) {
    const { scope, slug } = parseRuleId(id);
    const target = ruleFile(paths, scope);
    if (!target) throw new Error("Open a project folder to read project rules.");
    const text2 = await readTextFile(target);
    if (!text2.trim()) throw new Error("That rule no longer exists.");
    const parsed = parseRuleSections(text2);
    if (!parsed.sections.length) return { content: parsed.preamble };
    const section = parsed.sections.find((item) => item.slug === slug);
    if (!section) throw new Error("That rule no longer exists.");
    return { content: section.body };
  }
  if (id.startsWith("skill:")) {
    const instructionId = id.slice("skill:".length);
    if (file) {
      const folder = skillFolderOf({ id: instructionId }, paths);
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
  const now2 = Date.now();
  const id = await (draft.kind === "rule" ? saveRule(paths, draft, content, store) : draft.kind === "skill" ? saveSkill(paths, draft, content, file, store) : saveMemory(paths, draft, content, store));
  const items = await listKnowledge(context, paths);
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error("The item was written, but could not be read back.");
  touchMetadata(store, id, {
    createdBy: store.items[id]?.createdBy ?? "you",
    createdAt: store.items[id]?.createdAt ?? now2,
    updatedBy: "you",
    updatedAt: now2
  });
  saveMetadata(paths, store);
  return item;
}
async function saveRule(paths, draft, content, store) {
  const scope = draft.scope === "project" ? "project" : "global";
  const target = ruleFile(paths, scope);
  if (!target) throw new Error("Open a project folder to add project rules.");
  const name = String(draft.name || "").trim();
  if (!name) throw new Error("Give the rule a name.");
  const existing = draft.id && draft.id.startsWith("rule:") ? parseRuleId(draft.id) : void 0;
  const slug = slugify(existing?.slug || name);
  const text2 = await readTextFile(target);
  const parsed = parseRuleSections(text2);
  if (parsed.sections.length) {
    const index = parsed.sections.findIndex((section2) => section2.slug === (existing?.slug || slug));
    const section = { slug, name, body: content.trim() };
    if (index >= 0) parsed.sections[index] = section;
    else parsed.sections.push(section);
  } else if (existing?.slug === "general") {
    parsed.preamble = content.trim();
  } else {
    parsed.preamble = text2.trim();
    parsed.sections = [{ slug, name, body: content.trim() }];
  }
  await fsp.mkdir(path3.dirname(target), { recursive: true });
  await fsp.writeFile(target, renderRuleSections(parsed), "utf8");
  const id = `rule:${scope}:${slug}`;
  if (existing && existing.slug !== slug) delete store.items[`rule:${scope}:${existing.slug}`];
  touchMetadata(store, id, {
    ...draft.description ? { description: draft.description } : {},
    audiences: draft.audiences?.length ? draft.audiences : audiencesOf(store, id)
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
    await fsp.mkdir(path3.dirname(target), { recursive: true });
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
  await fsp.mkdir(path3.dirname(target), { recursive: true });
  await fsp.writeFile(target, content, "utf8");
  const newId = `memory:${scope}:${relative4.split(path3.sep).join("/")}`;
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
    const text2 = await readTextFile(target);
    if (text2.trim()) {
      const parsed = parseRuleSections(text2);
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
    const folder = path3.resolve(skillFolderOf(skill, paths));
    const allowed = skillRoots(paths).some((entry) => {
      const root = path3.resolve(entry.root);
      return folder === root || folder.startsWith(root + path3.sep);
    });
    if (!allowed) throw new Error("That skill folder is outside the skills folders.");
    await fsp.rm(folder, { recursive: true, force: true });
  } else if (id.startsWith("memory:")) {
    const { scope, relative: relative4 } = parseMemoryId(id);
    const root = memoryRoot(paths, scope);
    if (!root) throw new Error("That note no longer exists.");
    const target = resolveInside(root, relative4);
    await fsp.rm(target, { force: true });
    await fsp.rmdir(path3.dirname(target)).catch(() => void 0);
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
  const destination = scope === "project" ? paths.workspaceRoot && path3.join(paths.workspaceRoot, ".agents", "skills", skillName) : path3.join(paths.agentsHome, "skills", skillName);
  if (!destination) throw new Error("Open a project folder to add project skills.");
  let total = 0;
  for (const file of files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") throw new Error("The dropped folder has an unreadable file.");
    const buffer = file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
    if (buffer.length > MAX_IMPORT_FILE_BYTES) throw new Error(`${file.path} is larger than 5 MB.`);
    total += buffer.length;
    if (total > MAX_IMPORT_TOTAL_BYTES) throw new Error("The skill folder is larger than 20 MB.");
  }
  for (const file of files) {
    const target = resolveInside(destination, file.path);
    await fsp.mkdir(path3.dirname(target), { recursive: true });
    const buffer = file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
    await fsp.writeFile(target, buffer);
  }
  const items = await listKnowledge(context, paths);
  const item = items.find((candidate) => candidate.id.startsWith("skill:") && candidate.name === skillName && candidate.scope === scope) ?? items.find((candidate) => candidate.path === destination);
  if (!item) throw new Error("The skill folder was written, but could not be read back.");
  return item;
}
function openKnowledge(paths, id, file) {
  let target;
  if (id.startsWith("rule:")) {
    const { scope } = parseRuleId(id);
    target = ruleFile(paths, scope);
  } else if (id.startsWith("memory:")) {
    const { scope, relative: relative4 } = parseMemoryId(id);
    const root = memoryRoot(paths, scope);
    if (root) target = resolveInside(root, relative4);
  } else if (id.startsWith("skill:")) {
    const instructionId = id.slice("skill:".length);
    const prefix = instructionId.slice(0, instructionId.indexOf(":"));
    const rel = instructionId.slice(instructionId.indexOf(":") + 1);
    const base = prefix === "ws" ? paths.workspaceRoot : prefix === "agents" ? paths.agentsHome : paths.dshHome;
    if (base) target = resolveInside(path3.dirname(path3.join(base, ...rel.split("/"))), file || "");
  }
  if (!target) throw new Error("Unknown knowledge item.");
  const opener = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(opener, [target], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => void 0);
  child.unref();
}

// ../Unify/src/engine/unify/requests/providers.ts
import { promises as fs5 } from "node:fs";
import * as path4 from "node:path";
var OAUTH_KEY = "dsh.oauthCliAccounts.v1";
var OAUTH_DEFAULTS_KEY = "dsh.oauthCliDefaults.v1";
var ACCOUNTS_KEY = "dsh.accounts.v1";
var ACCOUNTS_DEFAULTS_KEY = "dsh.accountDefaults.v1";
var MODEL_SETTING = "dsh.models";
function providerStore(paths) {
  const stored = readJsonFile(paths.providersFile, {});
  return {
    modelEnabled: isRecord(stored.modelEnabled) ? stored.modelEnabled : {},
    accountLabels: isRecord(stored.accountLabels) ? stored.accountLabels : {},
    accountDefaults: isRecord(stored.accountDefaults) ? stored.accountDefaults : {}
  };
}
function saveProviderStore(paths, store) {
  writeJsonFile(paths.providersFile, store);
}
function readState(paths) {
  return readJsonFile(paths.stateFile, {});
}
function saveState(paths, state) {
  writeJsonFile(paths.stateFile, state);
}
function records(state, key) {
  const value = state[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => !!item && typeof item === "object" && typeof item.id === "string" && typeof item.provider === "string");
}
function defaults(state, key) {
  const value = state[key];
  return isRecord(value) ? value : {};
}
function patchAccount(state, accountId, patch) {
  const result = { oauth: false, apiKey: false };
  for (const [key, field] of [[OAUTH_KEY, "oauth"], [ACCOUNTS_KEY, "apiKey"]]) {
    const list = records(state, key);
    const index = list.findIndex((account) => account.id === accountId);
    if (index < 0) continue;
    list[index] = { ...list[index], ...patch, id: list[index].id, provider: list[index].provider };
    state[key] = list;
    result[field] = true;
  }
  return result;
}
function accountsState(paths) {
  const state = readState(paths);
  const store = providerStore(paths);
  const oauthDefaults = defaults(state, OAUTH_DEFAULTS_KEY);
  const apiDefaults = defaults(state, ACCOUNTS_DEFAULTS_KEY);
  const accounts = [];
  for (const account of records(state, OAUTH_KEY)) {
    accounts.push({
      id: account.id,
      provider: account.provider,
      label: store.accountLabels[account.id] ?? account.label,
      email: account.email,
      isDefault: (oauthDefaults[account.provider] ?? records(state, OAUTH_KEY).find((item) => item.provider === account.provider)?.id) === account.id,
      authType: "oauth",
      ...store.accountDefaults[account.id] ? { defaultModel: store.accountDefaults[account.id] } : {}
    });
  }
  for (const account of records(state, ACCOUNTS_KEY)) {
    accounts.push({
      id: account.id,
      provider: account.provider,
      label: store.accountLabels[account.id] ?? account.label,
      email: account.email,
      isDefault: (apiDefaults[account.provider] ?? records(state, ACCOUNTS_KEY).find((item) => item.provider === account.provider)?.id) === account.id,
      authType: "api-key",
      ...account.provider === "self-hosted" && typeof account.metadata?.baseURL === "string" ? { baseURL: account.metadata.baseURL } : {},
      ...store.accountDefaults[account.id] ? { defaultModel: store.accountDefaults[account.id] } : {}
    });
  }
  return { type: "accountsState", accounts };
}
function setModelSetting(paths, modelId, enabled) {
  const state = readJsonFile(paths.settingsFile, {});
  const value = state[MODEL_SETTING];
  if (!Array.isArray(value)) return;
  let changed = false;
  state[MODEL_SETTING] = value.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const model = entry;
    if (model.name !== modelId) return entry;
    changed = true;
    return { ...model, enabled };
  });
  if (changed) writeJsonFile(paths.settingsFile, state);
}
function setModelEnabled(paths, modelId, enabled) {
  if (!modelId) throw new Error("Choose a model first.");
  const store = providerStore(paths);
  store.modelEnabled[modelId] = enabled;
  saveProviderStore(paths, store);
  setModelSetting(paths, modelId, enabled);
}
function renameAccount(paths, accountId, label) {
  const trimmed = String(label || "").trim();
  if (!trimmed) throw new Error("The account name is required.");
  const store = providerStore(paths);
  const state = readState(paths);
  const found = patchAccount(state, accountId, { label: trimmed });
  if (!found.oauth && !found.apiKey) throw new Error("Account not found.");
  saveState(paths, state);
  store.accountLabels[accountId] = trimmed;
  saveProviderStore(paths, store);
  return accountsState(paths);
}
function setAccountDefaultModel(paths, accountId, modelId) {
  const state = readState(paths);
  const found = patchAccount(state, accountId, {});
  if (!found.oauth && !found.apiKey) throw new Error("Account not found.");
  const store = providerStore(paths);
  store.accountDefaults[accountId] = String(modelId || "");
  saveProviderStore(paths, store);
  return accountsState(paths);
}
async function signOutAccount(paths, accountId) {
  const state = readState(paths);
  const account = records(state, OAUTH_KEY).find((item) => item.id === accountId);
  if (!account) {
    if (records(state, ACCOUNTS_KEY).some((item) => item.id === accountId)) {
      throw new Error("API-key accounts are removed, not signed out.");
    }
    throw new Error("Account not found.");
  }
  const directory = account.directory;
  if (typeof directory !== "string" || !directory) throw new Error("Account storage is missing.");
  const resolved = path4.resolve(directory);
  const credentialFiles = account.provider === "codex-cli" ? ["auth.json"] : ["auth.json", ".credentials.json", "credentials.json"];
  for (const name of credentialFiles) {
    const file = path4.join(resolved, name);
    if (!file.startsWith(resolved + path4.sep)) continue;
    await fs5.rm(file, { force: true }).catch(() => void 0);
  }
  await fs5.rm(path4.join(resolved, ".claude.json"), { force: true }).catch(() => void 0);
  return accountsState(paths);
}

// ../Unify/src/engine/unify/requests/toolpacks.ts
var TOOL_KINDS = ["read", "write", "run"];
var POLICIES = ["always", "ask", "off"];
function readStore(paths) {
  const stored = readJsonFile(paths.toolpacksFile, {});
  return {
    packs: isRecord(stored.packs) ? stored.packs : {},
    installed: isRecord(stored.installed) ? stored.installed : {},
    syncTargets: isRecord(stored.syncTargets) ? stored.syncTargets : {}
  };
}
function writeStore(paths, store) {
  writeJsonFile(paths.toolpacksFile, store);
}
function packSettings(store, id) {
  const current = store.packs[id];
  return {
    tools: isRecord(current?.tools) ? current.tools : {},
    permissions: isRecord(current?.permissions) ? current.permissions : {}
  };
}
function setToolpackToolEnabled(paths, id, tool, enabled) {
  if (!id || !tool) throw new Error("Unknown toolpack tool.");
  const store = readStore(paths);
  const settings = packSettings(store, id);
  settings.tools[tool] = !!enabled;
  store.packs[id] = settings;
  writeStore(paths, store);
}
function setToolpackPermission(paths, id, group, policy) {
  if (!TOOL_KINDS.includes(group)) throw new Error("Unknown tool group.");
  if (!POLICIES.includes(policy)) throw new Error("Unknown tool policy.");
  const store = readStore(paths);
  const settings = packSettings(store, id);
  settings.permissions[group] = policy;
  store.packs[id] = settings;
  writeStore(paths, store);
}
function recordHubInstall(paths, pack2, target) {
  const store = readStore(paths);
  store.installed[pack2.id] = pack2;
  store.syncTargets[pack2.id] = target;
  writeStore(paths, store);
}

// ../Unify/src/engine/unify/requests/settings.ts
import * as fs6 from "node:fs";
import * as path5 from "node:path";
function packageVersion() {
  try {
    const file = path5.join(process.cwd(), "package.json");
    const parsed = JSON.parse(fs6.readFileSync(file, "utf8"));
    return typeof parsed.version === "string" && parsed.version ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
function appInfo(paths, version2) {
  return {
    version: version2 || packageVersion(),
    channel: "stable",
    dataFolder: paths.dshHome,
    update: { state: "idle" }
  };
}
function appInfoReply(paths, version2) {
  return { type: "appInfo", info: appInfo(paths, version2) };
}
function updateChecked(paths, version2) {
  const info = appInfo(paths, version2);
  const update = { state: "current", checkedAt: Date.now() };
  return { type: "appInfo", info: { ...info, update } };
}
function updateInstallUnavailable(paths, version2) {
  const info = appInfo(paths, version2);
  const update = {
    state: "error",
    message: "Updates are installed by the app; the engine cannot install one."
  };
  return { type: "appInfo", info: { ...info, update } };
}

// ../Unify/src/engine/unify/requests/setup.ts
import * as fs7 from "node:fs";
import { promises as fsp2 } from "node:fs";
import * as path6 from "node:path";

// ../Unify/src/engine/runtime/dependencies.ts
import { createHash as createHash2 } from "node:crypto";
import { spawn as spawn3 } from "node:child_process";
import { createWriteStream, existsSync, readdirSync as readdirSync2 } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { homedir as homedir2, tmpdir } from "node:os";
import { delimiter, dirname as dirname5, join as join7, isAbsolute } from "node:path";

// ../Unify/src/engine/runtime/cancellation.ts
import { spawn as spawn2 } from "node:child_process";
var terminated = /* @__PURE__ */ new WeakSet();
function terminateProcessTree(child) {
  if (terminated.has(child)) return;
  terminated.add(child);
  if (child.pid && child.exitCode === null) {
    if (process.platform === "win32") {
      const killer = spawn2("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => {
        child.kill();
      });
      killer.on("close", (code) => {
        if (code !== 0) child.kill();
      });
      killer.unref();
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}

// ../Unify/src/engine/runtime/dependencies.ts
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
var DOWNLOAD_LIMIT = 250 * 1024 * 1024;
var DOWNLOAD_TIMEOUT = 12e4;
var PROCESS_TIMEOUT = 18e4;
var PROVIDERS = /* @__PURE__ */ new Set(["claude-cli", "cursor-acp"]);
var WINDOWS = process.platform === "win32";
function unixBinDirs() {
  const home = homedir2();
  return [join7(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", join7(home, ".volta", "bin"), join7(home, ".npm-global", "bin")];
}
function npmCli(nodeExecPath) {
  const dir = dirname5(nodeExecPath);
  return WINDOWS ? join7(dir, "node_modules", "npm", "bin", "npm-cli.js") : join7(dirname5(dir), "lib", "node_modules", "npm", "bin", "npm-cli.js");
}
function run(executable, args, timeout = 15e3, env = process.env) {
  return new Promise((resolve7, reject) => {
    const child = spawn3(executable, args, { windowsHide: true, shell: false, env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end();
    let stdout = "", stderr = "", done = false;
    const timer = setTimeout(() => {
      terminateProcessTree(child);
      finish(new Error(`${executable} timed out.`));
    }, timeout);
    const finish = (error, code = -1) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolve7({ code, stdout, stderr });
    };
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < 64e3) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 64e3) stderr += chunk.toString();
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(void 0, code ?? -1));
  });
}
function version(text2) {
  const match = text2.match(/v?(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : void 0;
}
function supported(text2) {
  const v = version(text2);
  return !!v && (v[0] >= 24 || v[0] === 22 && (v[1] > 19 || v[1] === 19 && v[2] >= 0));
}
function pathKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path");
}
function prependPath(directory) {
  const key = pathKey(process.env) || "Path";
  const current = process.env[key] || "";
  const norm = (part) => {
    const trimmed = part.replace(/[\\/]+$/, "");
    return WINDOWS ? trimmed.toLowerCase() : trimmed;
  };
  if (current.split(delimiter).some((part) => norm(part) === norm(directory))) return;
  process.env[key] = `${directory}${current ? `${delimiter}${current}` : ""}`;
}
async function download(url, destination, maxBytes = DOWNLOAD_LIMIT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
    const size = Number(response.headers.get("content-length") || 0);
    if (size > maxBytes) throw new Error(`Download exceeds ${maxBytes} bytes.`);
    let count2 = 0;
    const limited = Readable.from((async function* () {
      for await (const chunk of response.body) {
        count2 += chunk.length;
        if (count2 > maxBytes) throw new Error("Download size limit exceeded.");
        yield chunk;
      }
    })());
    await pipeline(limited, createWriteStream(destination));
  } finally {
    clearTimeout(timer);
  }
}
function safeName(provider) {
  if (!PROVIDERS.has(provider)) throw new Error(`Unsupported provider '${provider}'.`);
  return provider;
}
var WindowsDependencies = class {
  // Despite the name this also runs on macOS and Linux: there it finds tools already installed and uses the official
  // shell installers. Throwing here on other platforms stopped the extension activating, so the sidebar never loaded.
  constructor(storage, configuredNode, configuredProvider) {
    this.storage = storage;
    this.configuredNode = configuredNode;
    this.configuredProvider = configuredProvider;
  }
  nodePromise;
  providerPromises = /* @__PURE__ */ new Map();
  ensureNode() {
    if (!this.nodePromise) this.nodePromise = this.ensureNodeOnce().catch((error) => {
      this.nodePromise = void 0;
      throw error;
    });
    return this.nodePromise;
  }
  async probeNode(executable) {
    try {
      const node = await run(executable, ["--version"]);
      if (node.code !== 0 || !supported(node.stdout + node.stderr)) return false;
      const location = await run(executable, ["-p", "process.execPath"]);
      if (location.code !== 0) return false;
      const npmPath = npmCli(location.stdout.trim());
      if (!existsSync(npmPath)) return false;
      const npmRun = await run(executable, [npmPath, "--version"]);
      return npmRun.code === 0 && !!version(npmRun.stdout);
    } catch {
      return false;
    }
  }
  async ensureNodeOnce() {
    const configured = this.configuredNode?.()?.trim();
    if (configured) {
      if (!await this.probeNode(configured)) throw new Error(`Configured Node executable '${configured}' is invalid or unsupported. Install Node 22.19+ (22.x) or 24+, with working npm, or update dsh.runtime.nodePath.`);
      const location = await run(configured, ["-p", "process.execPath"]);
      const executable = location.stdout.trim();
      prependPath(dirname5(executable));
      return executable;
    }
    const candidates = WINDOWS ? [join7(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"), "node.exe"] : ["node", ...unixBinDirs().map((dir) => join7(dir, "node"))];
    for (const candidate of candidates) if (await this.probeNode(candidate)) {
      const resolved = await run(candidate, ["-p", "process.execPath"]);
      const executable = resolved.stdout.trim() || candidate;
      prependPath(dirname5(executable));
      return executable;
    }
    if (!WINDOWS) throw new Error("Node.js 22.19+ or 24+ with npm was not found. Install it (for example `brew install node` or from nodejs.org), or set dsh.runtime.nodePath, then try again.");
    const root = join7(this.storage, "dependencies", "node");
    const managed = join7(root, "node.exe");
    if (await this.probeNode(managed)) {
      prependPath(root);
      return managed;
    }
    await mkdir(root, { recursive: true });
    const stage = await mkdtemp(join7(this.storage, "node-stage-"));
    try {
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      const indexResponse = await fetch("https://nodejs.org/dist/index.json", { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) });
      if (!indexResponse.ok) throw new Error(`Could not retrieve Node releases (${indexResponse.status}).`);
      const releases = await indexResponse.json();
      const release = releases.find((item) => /^v24\.\d+\.\d+$/.test(item.version) && item.lts);
      if (!release) throw new Error("No Node 24 LTS Windows release was found.");
      const base = `https://nodejs.org/dist/${release.version}`;
      const archive = `node-${release.version}-win-${arch}.zip`;
      const zip = join7(stage, archive), sums = join7(stage, "SHASUMS256.txt");
      const downloads = await Promise.allSettled([download(`${base}/${archive}`, zip), download(`${base}/SHASUMS256.txt`, sums, 2e6)]);
      for (const result of downloads) if (result.status === "rejected") throw result.reason;
      const sumText = await readFile(sums, "utf8");
      const expected = sumText.split(/\r?\n/).find((line) => line.trim().endsWith(` ${archive}`))?.trim().split(/\s+/)[0];
      if (!expected || createHash2("sha256").update(await readFile(zip)).digest("hex").toLowerCase() !== expected.toLowerCase()) throw new Error(`SHA-256 verification failed for ${archive}.`);
      const extracted = join7(stage, "extracted");
      await mkdir(extracted);
      const expansion = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:DSH_NODE_ZIP -DestinationPath $env:DSH_NODE_DEST -Force"], PROCESS_TIMEOUT, { ...process.env, DSH_NODE_ZIP: zip, DSH_NODE_DEST: extracted });
      if (expansion.code !== 0) throw new Error(`Could not expand the downloaded Node archive: ${expansion.stderr.slice(-2e3)}`);
      const entries = await readdir(extracted);
      const unpacked = entries.map((entry) => join7(extracted, entry)).find((path11) => existsSync(join7(path11, "node.exe")));
      if (!unpacked) throw new Error("Downloaded Node archive did not contain node.exe.");
      if (!await this.probeNode(join7(unpacked, "node.exe"))) throw new Error("Downloaded Node or npm failed its version check.");
      await rm(root, { recursive: true, force: true });
      await rename(unpacked, root);
      if (!await this.probeNode(managed)) throw new Error("Installed Node or npm failed its version check.");
      prependPath(root);
      return managed;
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => void 0);
    }
  }
  async providerCommand(provider) {
    safeName(provider);
    const configured = this.configuredProvider?.(provider)?.trim();
    if (configured && !(provider === "cursor-acp" && configured === "agent")) {
      if (provider === "cursor-acp") {
        const root = /\.(cmd|ps1)$/i.test(configured) ? dirname5(configured) : configured;
        const node = this.cursorNode(root);
        if (node) return node;
      }
      return await this.isExecutable(configured) ? configured : void 0;
    }
    const candidates = this.providerCandidates(provider);
    for (const candidate of candidates) if (await this.isExecutable(candidate)) return candidate;
    return void 0;
  }
  providerCandidates(provider) {
    if (!WINDOWS) return this.unixProviderCandidates(provider);
    const appData = process.env.APPDATA || join7(homedir2(), "AppData", "Roaming");
    const local = process.env.LOCALAPPDATA || join7(homedir2(), "AppData", "Local");
    if (provider === "claude-cli") return [join7(homedir2(), ".local", "bin", "claude.exe"), join7(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), "claude.exe"];
    const root = join7(local, "cursor-agent");
    const node = this.cursorNode(root);
    return [...node ? [node] : [], "agent.exe", join7(root, "agent.exe")];
  }
  unixProviderCandidates(provider) {
    const home = homedir2();
    const inDirs = (name) => unixBinDirs().map((dir) => join7(dir, name));
    if (provider === "claude-cli") return [join7(home, ".claude", "local", "claude"), ...inDirs("claude"), "claude"];
    return [...inDirs("cursor-agent"), ...inDirs("agent"), "cursor-agent"];
  }
  cursorNode(root) {
    const versions = join7(root, "versions");
    try {
      for (const entry of readdirSync2(versions).sort().reverse()) {
        const directory = join7(versions, entry);
        const node = WINDOWS ? "node.exe" : "node";
        if (existsSync(join7(directory, node)) && existsSync(join7(directory, "index.js"))) return join7(directory, node);
      }
    } catch {
    }
    return void 0;
  }
  async isExecutable(path11) {
    if (isAbsolute(path11) && !existsSync(path11)) return false;
    const ext = path11.toLowerCase();
    try {
      if (!WINDOWS || ext.endsWith(".exe") || !/[\\/]/.test(path11)) {
        const cursorScript = join7(dirname5(path11), "index.js");
        return (await run(path11, existsSync(cursorScript) && /[\\/]node(\.exe)?$/i.test(path11) ? [cursorScript, "--version"] : ["--version"])).code === 0;
      }
      return false;
    } catch {
      return false;
    }
  }
  async installProvider(provider) {
    safeName(provider);
    const existing = await this.providerCommand(provider);
    if (existing) return;
    const pending = this.providerPromises.get(provider);
    if (pending) return pending;
    const promise = this.installProviderOnce(provider).finally(() => this.providerPromises.delete(provider));
    this.providerPromises.set(provider, promise);
    return promise;
  }
  async installProviderOnce(provider) {
    const configured = this.configuredProvider?.(provider)?.trim();
    if (configured && !(provider === "cursor-acp" && configured === "agent")) throw new Error(`Configured ${provider} executable '${configured}' was not found or could not run. Clear its custom path in Settings before installing.`);
    const stage = await mkdtemp(join7(tmpdir(), `dsh-${provider}-`));
    if (!WINDOWS) {
      try {
        const script2 = join7(stage, "install.sh");
        await download(provider === "claude-cli" ? "https://claude.ai/install.sh" : "https://cursor.com/install", script2, 4e6);
        const result = await run("/bin/bash", [script2], PROCESS_TIMEOUT);
        if (result.code !== 0) throw new Error(`${provider} installer failed: ${(result.stderr || result.stdout).slice(-2e3)}`);
        if (!await this.providerCommand(provider)) throw new Error(`${provider} installer completed, but its executable was not found.`);
      } finally {
        await rm(stage, { recursive: true, force: true }).catch(() => void 0);
      }
      return;
    }
    const script = join7(stage, "install.ps1");
    try {
      const url = provider === "claude-cli" ? "https://claude.ai/install.ps1" : "https://cursor.com/install?win32=true";
      await download(url, script, 4e6);
      const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], PROCESS_TIMEOUT);
      if (result.code !== 0) throw new Error(`${provider} installer failed: ${result.stderr.slice(-2e3)}`);
      if (!await this.providerCommand(provider)) throw new Error(`${provider} installer completed, but its native Windows executable was not found.`);
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => void 0);
    }
  }
};

// ../Unify/src/engine/unify/requests/setup.ts
var BASE_TOOLS = [
  { id: "git", description: "Checkpoints, diffs and branches", required: true },
  { id: "node", description: "Runs toolpacks and MCP servers", required: true }
];
var PROVIDER_TOOLS = [
  { id: "claude", provider: "claude-cli", description: "Claude Code CLI, the Anthropic agent runtime", required: true },
  { id: "codex", provider: "codex-cli", description: "Codex CLI, the OpenAI agent runtime", required: true },
  { id: "cursor-agent", provider: "cursor-acp", description: "Cursor agent CLI", required: true },
  { id: "opencode", provider: "opencode-go", description: "OpenCode CLI, for OpenCode Go accounts", required: true }
];
var TOOL_TIMEOUT = 15e3;
var INSTALLABLE_PROVIDERS = /* @__PURE__ */ new Set(["claude-cli", "cursor-acp"]);
function readSetup(paths) {
  const stored = readJsonFile(paths.setupFile, {});
  return {
    complete: stored.complete === true,
    ...stored.defaultProject && typeof stored.defaultProject.path === "string" ? { defaultProject: { name: String(stored.defaultProject.name || path6.basename(stored.defaultProject.path)), path: stored.defaultProject.path } } : {},
    ...stored.summary ? { summary: stored.summary } : {},
    ...typeof stored.completedAt === "number" ? { completedAt: stored.completedAt } : {}
  };
}
function saveSetup(paths, file) {
  writeJsonFile(paths.setupFile, file);
}
function setupState(paths) {
  const file = readSetup(paths);
  return {
    complete: file.complete,
    ...file.defaultProject ? { defaultProject: file.defaultProject } : {}
  };
}
function getSetupState(paths) {
  return { type: "setupState", ...setupState(paths) };
}
function markSetupComplete(paths, summary) {
  const file = readSetup(paths);
  file.complete = true;
  file.completedAt = Date.now();
  if (summary) file.summary = summary;
  const project = summary?.project;
  if (project && typeof project.path === "string" && project.path.trim()) {
    file.defaultProject = { name: String(project.name || path6.basename(project.path)), path: project.path };
  }
  saveSetup(paths, file);
  return getSetupState(paths);
}
function setDefaultProject(paths, project) {
  const target = typeof project?.path === "string" ? project.path.trim() : "";
  if (!target) throw new Error("Choose a project folder first.");
  const file = readSetup(paths);
  file.defaultProject = { name: typeof project?.name === "string" && project.name.trim() ? project.name.trim() : path6.basename(target), path: target };
  saveSetup(paths, file);
  return getSetupState(paths);
}
function accountProviders(paths) {
  const state = readJsonFile(paths.stateFile, {});
  const providers = /* @__PURE__ */ new Set();
  for (const key of ["dsh.oauthCliAccounts.v1", "dsh.accounts.v1"]) {
    const list = state[key];
    if (!Array.isArray(list)) continue;
    for (const account of list) {
      if (account && typeof account === "object" && typeof account.provider === "string") {
        providers.add(account.provider);
      }
    }
  }
  const cursor = state["dsh.cursor.v1"];
  if (cursor && typeof cursor === "object" && cursor.connected === true) providers.add("cursor-acp");
  return providers;
}
function toolVersion(text2) {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(text2);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : void 0;
}
async function probe(executable) {
  try {
    const result = await run(executable, ["--version"], TOOL_TIMEOUT);
    if (result.code !== 0) return { state: "missing" };
    return { state: "found", version: toolVersion(`${result.stdout}
${result.stderr}`) };
  } catch (error) {
    return { state: "missing", ...error instanceof Error && error.message.includes("timed out") ? { state: "error", error: error.message } : {} };
  }
}
function providerExecutable(tool) {
  return tool === "cursor-agent" ? "cursor-agent" : tool;
}
async function checkTools(paths) {
  const accounts = accountProviders(paths);
  const dependencies = new WindowsDependencies(paths.storageRoot);
  const tools = [];
  for (const tool of BASE_TOOLS) {
    const result = await probe(tool.id === "node" ? process.execPath : tool.id);
    tools.push({ ...tool, ...result });
  }
  for (const tool of PROVIDER_TOOLS) {
    if (!accounts.has(tool.provider)) continue;
    let executable;
    if (INSTALLABLE_PROVIDERS.has(tool.provider)) {
      executable = await dependencies.providerCommand(tool.provider).catch(() => void 0);
    }
    const result = executable ? await probe(executable) : await probe(providerExecutable(tool.id));
    tools.push({
      id: tool.id,
      description: tool.description,
      required: tool.required,
      ...result
    });
  }
  return tools;
}
async function fixTool(paths, id) {
  const provider = PROVIDER_TOOLS.find((tool) => tool.id === id)?.provider;
  if (!provider) throw new Error(`${id} is not installed by Unify. Install it from its own website and run the check again.`);
  if (!INSTALLABLE_PROVIDERS.has(provider)) {
    throw new Error(`${id} has no automatic installer here. Install it with its package manager and run the check again.`);
  }
  await new WindowsDependencies(paths.storageRoot).installProvider(provider);
  return checkTools(paths);
}
async function countSkillFolders(root) {
  let count2 = 0;
  const walk2 = async (directory, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = await fsp2.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path6.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) await walk2(full, depth + 1);
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        count2 += 1;
      }
    }
  };
  await walk2(root, 0);
  return count2;
}
async function countMemoryNotes(root) {
  let count2 = 0;
  const walk2 = async (directory, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = await fsp2.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path6.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) await walk2(full, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        count2 += 1;
      }
    }
  };
  await walk2(root, 0);
  return count2;
}
async function installedNames(paths) {
  try {
    const entries = await fsp2.readdir(paths.toolpacksDir, { withFileTypes: true });
    return new Set(entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name));
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
async function scanDshImports(paths) {
  const installed = await installedNames(paths);
  const available = [];
  try {
    const entries = await fsp2.readdir(path6.join(paths.dshHome, "toolpacks"), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || installed.has(entry.name)) continue;
      available.push(entry.name);
    }
  } catch {
  }
  let rules = 0;
  try {
    const text2 = await fsp2.readFile(path6.join(paths.dshHome, "AGENTS.md"), "utf8");
    const parsed = parseRuleSections(text2);
    rules = parsed.sections.length || (parsed.preamble.trim() ? 1 : 0);
  } catch {
  }
  const skills = await countSkillFolders(path6.join(paths.dshHome, "skills")) + await countSkillFolders(path6.join(paths.agentsHome, "skills"));
  const memoryNotes = await countMemoryNotes(path6.join(paths.dshHome, "memory"));
  return { toolpacks: available.sort(), rules, skills, memoryNotes };
}
async function importFromDsh(paths, what) {
  const scan = await scanDshImports(paths);
  if (what === "toolpacks") {
    let count2 = 0;
    await fsp2.mkdir(paths.toolpacksDir, { recursive: true });
    for (const name of scan.toolpacks) {
      const source = path6.join(paths.dshHome, "toolpacks", name);
      const destination = path6.join(paths.toolpacksDir, name);
      if (fs7.existsSync(destination)) continue;
      await fsp2.cp(source, destination, { recursive: true, force: false, errorOnExist: false });
      count2 += 1;
    }
    return { type: "dshImportResult", what, ok: true, count: count2 };
  }
  if (what === "knowledge") {
    return { type: "dshImportResult", what, ok: true, count: scan.rules + scan.skills + scan.memoryNotes };
  }
  return { type: "dshImportResult", what, ok: false, count: 0, error: "Unknown import." };
}

// ../Unify/src/engine/hub/githubRegistry.ts
import { promises as fsp3 } from "node:fs";
import * as path7 from "node:path";
var HUB_REPOSITORY = "raisinhvh/unify-hub";
var HUB_BRANCH = "main";
var HUB_INDEX_URL = `https://raw.githubusercontent.com/${HUB_REPOSITORY}/${HUB_BRANCH}/index.json`;
var HUB_API = `https://api.github.com/repos/${HUB_REPOSITORY}`;
var REQUEST_TIMEOUT = 15e3;
function isRecord2(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
function count(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function validPack(value) {
  if (!isRecord2(value)) return false;
  if (typeof value.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id)) return false;
  if (typeof value.name !== "string" || !value.name.trim()) return false;
  if (typeof value.description !== "string") return false;
  return Array.isArray(value.tools) && value.tools.every((tool) => typeof tool === "string");
}
function validCategory(value) {
  return isRecord2(value) && typeof value.id === "string" && typeof value.label === "string";
}
function validDevice(value) {
  return isRecord2(value) && typeof value.id === "string" && typeof value.label === "string" && typeof value.current === "boolean";
}
function normalisePack(value) {
  return {
    ...value,
    author: text(value.author, "unknown"),
    category: text(value.category, "dev"),
    installs: count(value.installs),
    version: text(value.version, "1.0.0"),
    updatedAt: count(value.updatedAt),
    publishedAt: count(value.publishedAt),
    license: text(value.license, "MIT"),
    ...typeof value.icon === "string" ? { icon: value.icon } : {}
  };
}
async function fetchText(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    headers: { accept: "application/json, text/plain, */*", "user-agent": "unify-engine" }
  });
  if (!response.ok) throw new Error(`The Hub registry answered ${response.status}.`);
  return response.text();
}
var GithubHubRegistry = class {
  id = "github";
  async state() {
    try {
      const index = JSON.parse(await fetchText(HUB_INDEX_URL));
      const packs = Array.isArray(index.packs) ? index.packs.filter(validPack).map(normalisePack) : [];
      const categories = Array.isArray(index.categories) ? index.categories.filter(validCategory) : [];
      const devices = Array.isArray(index.devices) ? index.devices.filter(validDevice) : [];
      return {
        packs,
        categories,
        featured: Array.isArray(index.featured) ? index.featured.filter((id) => typeof id === "string" && packs.some((pack2) => pack2.id === id)) : [],
        authors: count(index.authors, new Set(packs.map((pack2) => pack2.author)).size),
        devices: devices.length ? devices : [{ id: "desktop", label: "Desktop", current: true }],
        fetchedAt: Date.now()
      };
    } catch (error) {
      return {
        packs: [],
        categories: [],
        featured: [],
        authors: 0,
        devices: [{ id: "desktop", label: "Desktop", current: true }],
        fetchedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  async detail(id) {
    const pack2 = (await this.state()).packs.find((candidate) => candidate.id === id);
    if (!pack2) return void 0;
    let readme;
    try {
      readme = await fetchText(`https://raw.githubusercontent.com/${HUB_REPOSITORY}/${HUB_BRANCH}/packs/${encodeURIComponent(id)}/README.md`);
    } catch {
    }
    return { pack: pack2, ...readme ? { readme } : {} };
  }
  async download(id, destination) {
    await fsp3.mkdir(destination, { recursive: true });
    const base = `https://raw.githubusercontent.com/${HUB_REPOSITORY}/${HUB_BRANCH}/packs/${encodeURIComponent(id)}`;
    const source = await fetchText(`${base}/pack.ts`);
    await fsp3.writeFile(path7.join(destination, "pack.ts"), source, "utf8");
    for (const script of ["install.js", "install.ps1", "install.sh"]) {
      try {
        const content = await fetchText(`${base}/${script}`);
        await fsp3.writeFile(path7.join(destination, script), content, "utf8");
      } catch {
      }
    }
  }
  /** Release metadata for one pack, for a future "what's new" view. Never used for publishing. */
  async releases(id) {
    const response = await fetch(`${HUB_API}/releases?per_page=20`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      headers: { accept: "application/vnd.github+json", "user-agent": "unify-engine" }
    });
    if (!response.ok) throw new Error(`The Hub releases API answered ${response.status}.`);
    const releases = await response.json();
    if (!Array.isArray(releases)) return [];
    return releases.filter((release) => isRecord2(release) && text(release.tag_name).startsWith(`${id}@`));
  }
};

// ../Unify/src/engine/hub/localRegistry.ts
import { promises as fsp4 } from "node:fs";
import * as path8 from "node:path";

// ../Unify/src/engine/hub/fixtures/catalogue.ts
var day = 864e5;
var now = Date.now();
var catalogueCategories = [
  { id: "studio", label: "Studio & 3D" },
  { id: "design", label: "Design" },
  { id: "media", label: "Media" },
  { id: "dev", label: "Dev tools" },
  { id: "web", label: "Web" },
  { id: "data", label: "Data" }
];
function pack(id, name, author, category, icon, installs, toolCount, description, ageDays) {
  const prefix = id.split("-")[0];
  const verbs = ["tree", "inspect", "set_property", "prefab_edit", "play", "find", "export", "import", "list", "run", "query", "open", "close", "capture", "search", "select"];
  return {
    id,
    name,
    author,
    category,
    description,
    icon,
    installs,
    tools: Array.from({ length: toolCount }, (_, index) => `${prefix}_${verbs[index % verbs.length]}${index >= verbs.length ? `_${index}` : ""}`),
    version: `1.${installs % 7 + 1}.${toolCount % 4}`,
    updatedAt: now - (installs % 9 + 1) * day,
    publishedAt: now - ageDays * day,
    license: installs % 3 ? "MIT" : "Apache-2.0"
  };
}
var cataloguePacks = [
  pack("roblox-studio", "Roblox Studio", "dsh", "studio", "roblox", 12400, 24, "Read and edit the open place: explorer, properties, scripts and playtests.", 300),
  pack("figma-bridge", "Figma bridge", "dsh", "design", "figma", 8100, 8, "Run plugin code, inspect nodes and capture frames from the open file.", 280),
  pack("imaging", "Imaging", "dsh", "media", "imaging", 6700, 17, "Resize, trim, composite and remove backgrounds without leaving the chat.", 260),
  pack("blender", "Blender", "mira.tools", "studio", "blender", 4200, 11, "Build and render scenes, apply modifiers and export assets.", 200),
  pack("unity-editor", "Unity Editor", "northbeam", "studio", "engine", 3900, 14, "Inspect scenes, edit prefabs and components, and enter play mode from an agent. Works with Unity 2022.3 and later.", 40),
  pack("postgres", "Postgres", "dataloom", "data", "database", 3100, 9, "Query a database, read-only by default.", 90),
  pack("playwright-browser", "Playwright browser", "webkitchen", "web", "browser", 2800, 12, "Drive a headless browser: navigate, click, fill forms, take screenshots.", 120),
  pack("linear-issues", "Linear issues", "trackside", "dev", "issues", 1900, 10, "Read, create and update issues and cycles in your workspace.", 60),
  pack("audio-tools", "Audio tools", "sonar", "media", "audio", 1200, 7, "Trim, normalise and convert audio files; generate waveforms.", 30),
  pack("containers", "Containers", "dockyard", "dev", "containers", 5200, 16, "Build, run and inspect containers and read their logs.", 14),
  pack("spreadsheets", "Spreadsheets", "gridworks", "data", "sheet", 2400, 12, "Read and edit sheets, formulas and charts in xlsx and csv.", 10),
  pack("screen-recorder", "Screen recorder", "sonar", "media", "recorder", 1100, 5, "Record a window or region and hand the clip to an agent.", 6),
  pack("git-helpers", "Git helpers", "dsh", "dev", "git", 3300, 6, "Blame, bisect and summarise history without leaving the chat.", 240),
  pack("web-search", "Web search", "dsh", "web", "web", 7300, 3, "Search the web and read pages as clean text.", 310)
];
var catalogueFeatured = ["containers", "spreadsheets", "screen-recorder"];
function catalogueState() {
  return {
    packs: cataloguePacks,
    categories: catalogueCategories,
    featured: catalogueFeatured,
    authors: 74,
    devices: [
      { id: "desktop", label: "Desktop", current: true },
      { id: "laptop", label: "Laptop", current: false }
    ],
    fetchedAt: now
  };
}
function findCataloguePack(id) {
  return cataloguePacks.find((pack2) => pack2.id === id);
}
function catalogueReadme(pack2) {
  return [
    `# ${pack2.name}`,
    "",
    pack2.description,
    "",
    `Published by ${pack2.author} under the ${pack2.license} license.`,
    `Version ${pack2.version}. Tools: ${pack2.tools.join(", ")}.`,
    "",
    "This is the local development catalogue; the real README comes from the Hub registry."
  ].join("\n");
}

// ../Unify/src/engine/hub/fixtures/packSource.ts
var TOOLPACK_NAME = /^[a-z][a-z0-9_]{0,31}$/;
function toolpackIdFor(hubId) {
  const sanitized = hubId.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const withLetter = /^[a-z]/.test(sanitized) ? sanitized : `pack_${sanitized}`;
  const id = withLetter.slice(0, 32);
  if (!TOOLPACK_NAME.test(id)) throw new Error(`Cannot turn Hub id "${hubId}" into a toolpack id.`);
  return id;
}
function toolNames(pack2) {
  const prefix = `${pack2.id.split("-")[0]}_`;
  return pack2.tools.map((name) => {
    const short = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    const safe = short.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
    return TOOLPACK_NAME.test(safe) ? safe : `tool_${safe}`.slice(0, 32);
  });
}
function uniqueToolNames(pack2) {
  const seen = /* @__PURE__ */ new Set();
  const names = [];
  for (const name of toolNames(pack2)) {
    let candidate = name;
    let suffix = 1;
    while (seen.has(candidate)) {
      candidate = `${name.slice(0, 28)}_${suffix++}`;
    }
    seen.add(candidate);
    names.push(candidate);
  }
  return names;
}
function fixturePack(hubId) {
  const pack2 = findCataloguePack(hubId);
  if (!pack2) throw new Error(`Unknown Hub pack "${hubId}".`);
  return {
    id: toolpackIdFor(pack2.id),
    hubId: pack2.id,
    name: pack2.name,
    description: pack2.description,
    tools: uniqueToolNames(pack2)
  };
}
function toolResult(pack2, tool) {
  return `${pack2.name}: ${tool} (local Hub fixture, nothing was changed).`;
}
function packSourceFor(hubId) {
  const pack2 = findCataloguePack(hubId);
  if (!pack2) throw new Error(`Unknown Hub pack "${hubId}".`);
  const fixture = fixturePack(hubId);
  const tools = fixture.tools.map((tool) => [
    "    {",
    `      name: ${JSON.stringify(tool)},`,
    `      description: ${JSON.stringify(`${pack2.name} fixture tool.`)},`,
    "      run() {",
    `        return ${JSON.stringify(toolResult(pack2, tool))};`,
    "      },",
    "    },"
  ].join("\n")).join("\n");
  return [
    "// Generated by the Unify local Hub fixture. No network, no real integrations.",
    "export default {",
    `  name: ${JSON.stringify(fixture.id)},`,
    `  description: ${JSON.stringify(pack2.description)},`,
    "  tools: [",
    tools,
    "  ],",
    "};",
    ""
  ].join("\n");
}
function packJavaScriptFor(hubId) {
  const pack2 = findCataloguePack(hubId);
  if (!pack2) throw new Error(`Unknown Hub pack "${hubId}".`);
  const fixture = fixturePack(hubId);
  const tools = fixture.tools.map((tool) => [
    "    {",
    `      name: ${JSON.stringify(tool)},`,
    `      description: ${JSON.stringify(`${pack2.name} fixture tool.`)},`,
    "      run: function () {",
    `        return ${JSON.stringify(toolResult(pack2, tool))};`,
    "      },",
    "    },"
  ].join("\n")).join("\n");
  return [
    "// Generated by the Unify local Hub fixture.",
    "const pack = {",
    `  name: ${JSON.stringify(fixture.id)},`,
    `  description: ${JSON.stringify(pack2.description)},`,
    "  tools: [",
    tools,
    "  ],",
    "};",
    "module.exports = { default: pack };",
    ""
  ].join("\n");
}

// ../Unify/src/engine/hub/localRegistry.ts
var INSTALL_SCRIPT = [
  "// Generated by the Unify local Hub fixture. It only leaves a marker so dev installs are visible.",
  "const fs = require('node:fs');",
  "fs.writeFileSync(require('node:path').join(process.cwd(), 'install-ran.txt'), 'Unify local Hub fixture install script ran.\\n');",
  ""
].join("\n");
var LocalHubRegistry = class {
  id = "local";
  async state() {
    return catalogueState();
  }
  async detail(id) {
    const pack2 = findCataloguePack(id);
    return pack2 ? { pack: pack2, readme: catalogueReadme(pack2) } : void 0;
  }
  async download(id, destination) {
    if (!findCataloguePack(id)) throw new Error(`Unknown Hub pack "${id}".`);
    await fsp4.mkdir(destination, { recursive: true });
    await fsp4.writeFile(path8.join(destination, "pack.ts"), packSourceFor(id), "utf8");
    await fsp4.writeFile(path8.join(destination, "pack.js"), packJavaScriptFor(id), "utf8");
    await fsp4.writeFile(path8.join(destination, "install.js"), INSTALL_SCRIPT, "utf8");
  }
};

// ../Unify/src/engine/hub/install.ts
import { spawn as spawn4 } from "node:child_process";
import { promises as fsp5 } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path9 from "node:path";
var INSTALL_TIMEOUT = 6e4;
var SCRIPT_NAMES = ["install.js", "install.ps1", "install.sh"];
function installScriptFor(files) {
  return SCRIPT_NAMES.find((name) => files.includes(name));
}
function commandFor(script) {
  if (script.endsWith(".js")) return { command: process.execPath, args: [script] };
  if (script.endsWith(".ps1")) return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script] };
  if (script.endsWith(".sh")) return { command: "bash", args: [script] };
  return void 0;
}
function runInstallScript(destination, script) {
  const invocation = commandFor(script);
  if (!invocation) return Promise.resolve();
  return new Promise((resolve7, reject) => {
    const child = spawn4(invocation.command, invocation.args, {
      cwd: destination,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolve7();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`The install script took longer than ${INSTALL_TIMEOUT / 1e3}s.`));
    }, INSTALL_TIMEOUT);
    child.stdout?.on("data", (chunk) => {
      if (output.length < 16e3) output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      if (output.length < 16e3) output += chunk.toString();
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`The install script exited with code ${code}${output ? `: ${output.slice(-2e3)}` : "."}`));
    });
  });
}
async function readExistingMeta(destination) {
  try {
    const parsed = JSON.parse(await fsp5.readFile(path9.join(destination, "meta.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
async function compilePack(source) {
  const esbuild = await import("esbuild");
  const result = await esbuild.transform(source, { loader: "ts", format: "cjs", target: "node20" });
  return result.code;
}
async function installHubPack(options) {
  const { registry, id, toolpacksDir, reply } = options;
  const send = (progress) => {
    reply({ type: "hubInstallProgress", ...progress });
  };
  const packId = (() => {
    try {
      return toolpackIdFor(id);
    } catch {
      return id.replace(/[^a-z0-9_]/g, "_");
    }
  })();
  const destination = path9.join(toolpacksDir, packId);
  const staging = path9.join(toolpacksDir, `.staging-${packId}-${randomUUID()}`);
  let existing = {};
  try {
    const hub = await registry.state();
    const pack2 = hub.packs.find((candidate) => candidate.id === id);
    if (!pack2) throw new Error(`The Hub has no pack "${id}".`);
    existing = await readExistingMeta(destination);
    await fsp5.mkdir(staging, { recursive: true });
    send({ id, percent: 5, state: "downloading" });
    await registry.download(id, staging);
    send({ id, percent: 60, state: "installing" });
    let files;
    try {
      files = await fsp5.readdir(staging);
    } catch {
      throw new Error("The download did not write any files.");
    }
    const sourceFile = path9.join(staging, "pack.ts");
    const compiledFile = path9.join(staging, "pack.js");
    let source;
    try {
      source = await fsp5.readFile(sourceFile, "utf8");
    } catch {
      throw new Error("The pack has no pack.ts.");
    }
    if (!source.trim()) throw new Error("The pack.ts file is empty.");
    try {
      await fsp5.access(compiledFile);
    } catch {
      await fsp5.writeFile(compiledFile, await compilePack(source), "utf8");
    }
    await fsp5.mkdir(path9.dirname(destination), { recursive: true });
    await fsp5.rm(destination, { recursive: true, force: true });
    await fsp5.cp(staging, destination, { recursive: true, force: true });
    const meta = {
      description: pack2.description,
      enabled: existing.enabled !== false,
      hubId: pack2.id,
      version: pack2.version
    };
    await fsp5.writeFile(path9.join(destination, "meta.json"), `${JSON.stringify(meta, null, 2)}
`, "utf8");
    const scriptName = installScriptFor(files);
    if (scriptName) await runInstallScript(destination, scriptName);
    const installed = {
      id: pack2.id,
      name: pack2.name,
      description: pack2.description,
      ...pack2.icon ? { icon: pack2.icon } : {},
      version: pack2.version,
      source: "hub",
      tools: [...pack2.tools],
      syncedDevices: options.target === "this" ? 1 : 2,
      installedAt: Date.now()
    };
    options.onInstalled?.(installed);
    send({ id, percent: 100, state: "done" });
    return { ok: true, id, pack: installed };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send({ id, percent: 100, state: "error", error: message });
    return { ok: false, id, error: message };
  } finally {
    await fsp5.rm(staging, { recursive: true, force: true }).catch(() => void 0);
  }
}

// ../Unify/src/engine/hub/index.ts
function createHubRegistry(kind = "local") {
  return kind === "github" ? new GithubHubRegistry() : new LocalHubRegistry();
}

// ../Unify/src/engine/unify/requests/hub.ts
var PUBLISH_UNAVAILABLE = "Publishing is not available yet.";
async function handleHubRequest(message, reply, paths, registry = createHubRegistry()) {
  const requestId = typeof message.requestId === "string" ? message.requestId : void 0;
  const send = (payload) => {
    if (requestId && payload && typeof payload === "object") reply({ ...payload, requestId });
    else reply(payload);
  };
  if (message.type === "hubBrowse") {
    const hub = await registry.state();
    send({ type: "hubState", hub });
    return true;
  }
  if (message.type === "hubInstall") {
    const id = typeof message.id === "string" ? message.id : "";
    const target = message.target === "this" ? "this" : "all";
    if (!id) {
      send({ type: "hubInstallProgress", id, percent: 100, state: "error", error: "Choose a pack first." });
      return true;
    }
    await installHubPack({
      registry,
      id,
      toolpacksDir: paths.toolpacksDir,
      target,
      reply: send,
      onInstalled: (pack2) => recordHubInstall(paths, pack2, target)
    });
    return true;
  }
  if (message.type === "hubPublish") {
    const hub = await registry.state();
    send({ type: "hubState", hub: { ...hub, error: PUBLISH_UNAVAILABLE } });
    return true;
  }
  return false;
}

// ../Unify/src/engine/unify/requests/index.ts
var announcedWorkspace;
function announceWorkspace(context, reply) {
  if (!context.workspaceRoot) return;
  if (announcedWorkspace === context.workspaceRoot) return;
  announcedWorkspace = context.workspaceRoot;
  reply({ type: "workspaceState", root: path10.resolve(context.workspaceRoot), name: path10.basename(context.workspaceRoot) });
}
function stringField(message, key) {
  const value = message[key];
  return typeof value === "string" ? value : "";
}
function isFilesType(type) {
  return type === "listDir" || type === "readFile" || type === "writeFile" || type === "findFiles";
}
async function handleUnifyRequest(message, reply, context) {
  if (!message || typeof message.type !== "string") return false;
  const requestId = typeof message.requestId === "string" ? message.requestId : void 0;
  const send = (payload) => {
    if (requestId && payload && typeof payload === "object") reply({ ...payload, requestId });
    else reply(payload);
  };
  const paths = requestPaths(context);
  const type = message.type;
  if (isFilesType(type)) {
    setActiveUnifyReply(reply);
    watchWorkspace(context.workspaceRoot, reply);
    announceWorkspace(context, reply);
    try {
      if (type === "listDir") {
        const relative4 = stringField(message, "path");
        send({ type: "dirListing", path: relative4, entries: listWorkspaceDirectory(context.workspaceRoot, relative4) });
        return true;
      }
      if (type === "readFile") {
        const relative4 = stringField(message, "path");
        send({ type: "fileContent", file: readWorkspaceFile(context.workspaceRoot, relative4) });
        return true;
      }
      if (type === "writeFile") {
        const relative4 = stringField(message, "path");
        const content = stringField(message, "content");
        const version2 = stringField(message, "version");
        const result = writeWorkspaceFile(context.workspaceRoot, relative4, content, version2);
        if (result.ok) send({ type: "fileSaved", path: relative4, version: result.version });
        else send({ type: "fileConflict", current: result.conflict });
        return true;
      }
      const query = stringField(message, "query");
      const limit = typeof message.limit === "number" ? message.limit : void 0;
      send({ type: "fileMatches", query, paths: findWorkspaceFiles(context.workspaceRoot, query, limit) });
      return true;
    } catch (error) {
      send({ type: "filesError", message: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }
  if (type === "knowledgeList") {
    try {
      send({ type: "knowledgeState", items: await listKnowledge(context, paths) });
    } catch (error) {
      send({ type: "knowledgeError", message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (type === "readKnowledge") {
    try {
      const id = stringField(message, "id");
      const file = typeof message.file === "string" ? message.file : void 0;
      const result = await readKnowledge(context, paths, id, file);
      send({ type: "knowledgeContent", id, ...result.file ? { file: result.file } : {}, content: result.content });
    } catch (error) {
      send({ type: "knowledgeError", message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (type === "saveKnowledge") {
    try {
      const item = message.item;
      const content = stringField(message, "content");
      const file = typeof message.file === "string" ? message.file : void 0;
      const saved = await saveKnowledge(context, paths, item, content, file);
      send({ type: "knowledgeSaved", item: saved });
    } catch (error) {
      send({ type: "knowledgeError", message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (type === "removeKnowledge") {
    try {
      const id = stringField(message, "id");
      await removeKnowledge(context, paths, id);
      send({ type: "knowledgeRemoved", id });
    } catch (error) {
      send({ type: "knowledgeError", message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (type === "setKnowledgeAudience") {
    try {
      const audiences = Array.isArray(message.audiences) ? message.audiences : [];
      setKnowledgeAudiences(paths, stringField(message, "id"), audiences);
      send({ type: "knowledgeState", items: await listKnowledge(context, paths) });
    } catch (error) {
      send({ type: "knowledgeError", message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (type === "importSkillFolder") {
    try {
      const scope = message.scope === "project" ? "project" : "global";
      const files = Array.isArray(message.files) ? message.files : [];
      const item = await importSkillFolder(context, paths, scope, stringField(message, "name"), files);
      send({ type: "knowledgeSaved", item });
    } catch (error) {
      send({ type: "knowledgeError", message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (type === "openKnowledge") {
    try {
      openKnowledge(paths, stringField(message, "id"), typeof message.file === "string" ? message.file : void 0);
    } catch {
    }
    return true;
  }
  if (type === "toolpackToolEnabled") {
    try {
      setToolpackToolEnabled(paths, stringField(message, "id"), stringField(message, "tool"), message.enabled === true);
    } catch {
    }
    return true;
  }
  if (type === "toolpackPermission") {
    try {
      setToolpackPermission(paths, stringField(message, "id"), message.group, message.policy);
    } catch {
    }
    return true;
  }
  if (type === "setModelEnabled") {
    try {
      setModelEnabled(paths, stringField(message, "modelId"), message.enabled === true);
    } catch {
    }
    return true;
  }
  if (type === "renameAccount" || type === "setAccountDefaultModel" || type === "signOutAccount") {
    try {
      if (type === "renameAccount") {
        send(renameAccount(paths, stringField(message, "accountId"), stringField(message, "label")));
      } else if (type === "setAccountDefaultModel") {
        send(setAccountDefaultModel(paths, stringField(message, "accountId"), stringField(message, "modelId")));
      } else {
        send(await signOutAccount(paths, stringField(message, "accountId")));
      }
    } catch {
      send(accountsState(paths));
    }
    return true;
  }
  if (type === "getAppInfo") {
    send(appInfoReply(paths, context.version));
    return true;
  }
  if (type === "checkForUpdates") {
    send({ type: "appInfo", info: updateChecked(paths, context.version).info });
    return true;
  }
  if (type === "installUpdate") {
    send(updateInstallUnavailable(paths, context.version));
    return true;
  }
  if (type === "checkTools") {
    send({ type: "toolsState", tools: await checkTools(paths) });
    return true;
  }
  if (type === "fixTool") {
    const id = stringField(message, "id");
    try {
      send({ type: "toolsState", tools: await fixTool(paths, id) });
    } catch (error) {
      const tools = await checkTools(paths);
      send({
        type: "toolsState",
        tools: tools.map((tool) => tool.id === id ? { ...tool, state: "error", error: error instanceof Error ? error.message : String(error) } : tool)
      });
    }
    return true;
  }
  if (type === "scanDshImports") {
    send({ type: "dshImportState", scan: await scanDshImports(paths) });
    return true;
  }
  if (type === "importFromDsh") {
    const what = message.what === "knowledge" ? "knowledge" : "toolpacks";
    try {
      send(await importFromDsh(paths, what));
    } catch (error) {
      send({ type: "dshImportResult", what, ok: false, count: 0, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (type === "getSetupState") {
    send(getSetupState(paths));
    return true;
  }
  if (type === "setupComplete") {
    send(markSetupComplete(paths, message.summary));
    return true;
  }
  if (type === "setDefaultProject") {
    try {
      send(setDefaultProject(paths, message.project));
    } catch {
      send(getSetupState(paths));
    }
    return true;
  }
  if (type === "hubBrowse" || type === "hubInstall" || type === "hubPublish") {
    return handleHubRequest(message, send, paths);
  }
  return false;
}
export {
  disposeUnifyRequestWatchers,
  handleUnifyRequest
};
