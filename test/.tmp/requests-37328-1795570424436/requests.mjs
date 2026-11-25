// src/engine/unify/requests/index.ts
import * as path15 from "node:path";
import * as fs8 from "node:fs";
import { promises as fsp6 } from "node:fs";

// src/engine/unify/requests/workspace.ts
import { createHash } from "node:crypto";
import * as fs4 from "node:fs";
import * as path3 from "node:path";

// src/engine/unify/settings.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
var ENGINE_FEATURE_DEFAULTS = {
  "agents.messaging": true,
  "agents.messaging.scope": "everyone",
  "agents.blockNativeAgents": true,
  "agents.codexRuntime": true,
  "agents.maxParallel": 4,
  "agents.imagesToParent": true,
  "agents.explorerRanges": true,
  "agents.stuckCommandMinutes": 5,
  "agents.noQuestions": false,
  "tools.rangeEdits": true,
  "chats.showYourWork": true,
  "chat.friendlyInternalRows": true,
  "knowledge.agentWrites": true,
  "knowledge.audiences": true,
  "notifications.desktop": true,
  "toolpacks.autoUpdate": false,
  "power.shutdownWhenIdle": false,
  "power.rememberArmed": false
};
function unifyHome() {
  return process.env.UNIFY_HOME || path.join(os.homedir(), ".unify");
}
function settingsFilePath() {
  return path.join(unifyHome(), "settings.json");
}
var cachedValues;
function loadValues() {
  if (cachedValues) return cachedValues;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFilePath(), "utf8"));
    cachedValues = parsed.features && typeof parsed.features === "object" ? { ...parsed.features } : {};
  } catch {
    cachedValues = {};
  }
  return cachedValues;
}
function getUnifyFeature(id) {
  const stored = loadValues()[id];
  const fallback = ENGINE_FEATURE_DEFAULTS[id];
  const value = stored === void 0 || typeof stored !== typeof fallback ? fallback : stored;
  return value;
}

// src/engine/unify/requests/gitignore.ts
import * as fs2 from "node:fs";
var GitIgnore = class {
  constructor(root) {
    this.root = root;
  }
  rules = [];
  mtime = -1;
  /** Reads `<root>/.gitignore` again when its mtime changed; a missing file means nothing is ignored. */
  refresh() {
    const file = `${this.root}/.gitignore`;
    let mtime;
    try {
      mtime = fs2.statSync(file).mtimeMs;
    } catch {
      this.rules = [];
      this.mtime = -1;
      return;
    }
    if (mtime === this.mtime) return;
    let text2 = "";
    try {
      text2 = fs2.readFileSync(file, "utf8");
    } catch {
      return;
    }
    this.rules = text2.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map(compileRule).filter((rule) => !!rule);
    this.mtime = mtime;
  }
  /** Whether a root-relative path (forward slashes) is ignored; check directories with `isDirectory`. */
  ignores(relativePath, isDirectory) {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.directoryOnly && !isDirectory) continue;
      if (rule.expression.test(relativePath)) ignored = !rule.negate;
    }
    return ignored;
  }
};
function escapeRegExp(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}
function globBody(glob) {
  let output = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          output += "(?:.*/)?";
        } else {
          output += ".*";
        }
      } else {
        output += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      output += "[^/]";
      continue;
    }
    output += escapeRegExp(character);
  }
  return output;
}
function compileRule(line) {
  let pattern = line;
  const negate = pattern.startsWith("!");
  if (negate) pattern = pattern.slice(1);
  if (!pattern) return void 0;
  const directoryOnly = pattern.endsWith("/");
  if (directoryOnly) pattern = pattern.slice(0, -1);
  const anchored = pattern.startsWith("/");
  if (anchored) pattern = pattern.slice(1);
  if (!pattern) return void 0;
  const body = globBody(pattern);
  const source = anchored || pattern.includes("/") ? `^${body}$` : `(?:^|/)${body}$`;
  return { negate, directoryOnly, expression: new RegExp(source) };
}

// src/engine/unify/requests/state.ts
import * as fs3 from "node:fs";
import * as os2 from "node:os";
import * as path2 from "node:path";
function requestPaths(context) {
  const dataHome = path2.resolve(context.unifyHome || process.env.UNIFY_HOME || unifyHome());
  const unifyRoot = path2.resolve(context.unifyRoot || process.env.UNIFY_HOME || dataHome);
  const storageRoot = path2.join(unifyRoot, "storage");
  return {
    workspaceRoot: context.workspaceRoot ? path2.resolve(context.workspaceRoot) : void 0,
    unifyHome: dataHome,
    unifyRoot,
    storageRoot,
    toolpacksDir: path2.join(storageRoot, "toolpacks"),
    agentsHome: path2.resolve(process.env.AGENTS_HOME || path2.join(os2.homedir(), ".agents")),
    settingsFile: path2.join(unifyRoot, "settings.json"),
    stateFile: path2.join(unifyRoot, "state.json"),
    providersFile: path2.join(unifyRoot, "providers.json"),
    toolpacksFile: path2.join(unifyRoot, "toolpacks.json"),
    knowledgeFile: path2.join(unifyRoot, "knowledge.json"),
    setupFile: path2.join(unifyRoot, "setup.json")
  };
}
function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs3.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJsonFile(file, value) {
  fs3.mkdirSync(path2.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs3.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}
`, "utf8");
  fs3.renameSync(temporary, file);
}
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function resolveInside(root, relativePath) {
  if (typeof relativePath !== "string" || relativePath.includes("\0")) throw new Error("Invalid file path.");
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw new Error("Invalid file path.");
  if (normalized.split("/").some((part) => part === "..")) throw new Error("Invalid file path.");
  const resolved = path2.resolve(root, ...normalized.split("/").filter(Boolean));
  const base = path2.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path2.sep)) throw new Error("Invalid file path.");
  return resolved;
}
function relativeToWorkspace(root, file) {
  return path2.relative(root, file).split(path2.sep).join("/");
}
function slugify(value) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return slug || "untitled";
}
function titleFromId(id) {
  return id.split(/[-_\s]+/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

// src/engine/unify/requests/workspace.ts
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
var MAX_READ_BYTES = 2 * 1024 * 1024;
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
    return fs4.statSync(file);
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
  if (info.size > MAX_READ_BYTES) throw new Error("Files larger than 2 MB are not shown in the editor.");
  const bytes = fs4.readFileSync(file);
  if (bytes.subarray(0, 8e3).includes(0)) throw new Error("Binary files are not shown in the editor.");
  const content = bytes.toString("utf8");
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
    dirents = fs4.readdirSync(directory, { withFileTypes: true });
  } catch {
    throw new Error(`No folder at ${relativePath || "."}.`);
  }
  const entries = [];
  for (const entry of dirents) {
    if (entry.isSymbolicLink()) continue;
    const isDirectory = entry.isDirectory();
    if (!isDirectory && !entry.isFile()) continue;
    if (isDirectory && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const full = path3.join(directory, entry.name);
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
    const currentContent = fs4.readFileSync(file, "utf8");
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
  fs4.mkdirSync(path3.dirname(file), { recursive: true });
  fs4.writeFileSync(file, content, "utf8");
  rememberPath(relativeToWorkspace(base, file));
  return { ok: true, version: contentVersion(content) };
}
function entryPath(base, relativePath) {
  const file = resolveInside(base, relativePath);
  if (file === path3.resolve(base)) throw new Error("Pick a file or folder inside the project.");
  const name = path3.basename(file);
  if (/[<>:"|?*]/.test(name) || /[. ]$/.test(name)) throw new Error(`"${name}" is not a valid name.`);
  return file;
}
function createWorkspaceEntry(root, relativePath, kind) {
  const base = requireWorkspace(root);
  const file = entryPath(base, relativePath);
  if (statOrUndefined(file)) throw new Error(`${relativeToWorkspace(base, file)} already exists.`);
  if (kind === "dir") fs4.mkdirSync(file, { recursive: true });
  else {
    fs4.mkdirSync(path3.dirname(file), { recursive: true });
    fs4.writeFileSync(file, "", { encoding: "utf8", flag: "wx" });
  }
  const relative5 = relativeToWorkspace(base, file);
  rememberPath(relative5);
  return relative5;
}
function renameWorkspaceEntry(root, from, to) {
  const base = requireWorkspace(root);
  const source = entryPath(base, from);
  const target = entryPath(base, to);
  if (!statOrUndefined(source)) throw new Error(`No file at ${from}.`);
  if (statOrUndefined(target) && source.toLowerCase() !== target.toLowerCase()) throw new Error(`${relativeToWorkspace(base, target)} already exists.`);
  if ((target + path3.sep).startsWith(source + path3.sep)) throw new Error("A folder cannot move inside itself.");
  fs4.mkdirSync(path3.dirname(target), { recursive: true });
  fs4.renameSync(source, target);
  const relative5 = relativeToWorkspace(base, target);
  rememberPath(relative5);
  return relative5;
}
function freeTarget(folder, name) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let candidate = path3.join(folder, name);
  for (let index = 1; statOrUndefined(candidate); index += 1) {
    candidate = path3.join(folder, `${stem} copy${index > 1 ? ` ${index}` : ""}${extension}`);
  }
  return candidate;
}
function targetFolder(base, relativeFolder) {
  const folder = resolveInside(base, relativeFolder || "");
  if (!statOrUndefined(folder)?.isDirectory()) throw new Error(`No folder at ${relativeFolder || "."}.`);
  return folder;
}
function copyWorkspaceEntry(root, from, toFolder) {
  const base = requireWorkspace(root);
  const source = entryPath(base, from);
  if (!statOrUndefined(source)) throw new Error(`No file at ${from}.`);
  const folder = targetFolder(base, toFolder);
  if ((folder + path3.sep).startsWith(source + path3.sep)) throw new Error("A folder cannot be copied into itself.");
  const target = freeTarget(folder, path3.basename(source));
  fs4.cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
  const relative5 = relativeToWorkspace(base, target);
  rememberPath(relative5);
  return relative5;
}
function importWorkspaceEntries(root, sources, toFolder) {
  const base = requireWorkspace(root);
  const folder = targetFolder(base, toFolder);
  const copied = [];
  for (const source of sources) {
    if (typeof source !== "string" || !path3.isAbsolute(source) || !statOrUndefined(source)) throw new Error(`Cannot read ${source}.`);
    const resolved = path3.resolve(source);
    if ((folder + path3.sep).startsWith(resolved + path3.sep)) throw new Error("A folder cannot be copied into itself.");
    const target = freeTarget(folder, path3.basename(resolved));
    fs4.cpSync(resolved, target, { recursive: true, errorOnExist: true, force: false });
    const relative5 = relativeToWorkspace(base, target);
    rememberPath(relative5);
    copied.push(relative5);
  }
  return copied;
}
function deleteWorkspaceEntry(root, relativePath) {
  const base = requireWorkspace(root);
  const file = entryPath(base, relativePath);
  if (!statOrUndefined(file)) throw new Error(`No file at ${relativePath}.`);
  fs4.rmSync(file, { recursive: true, force: true });
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
      dirents = fs4.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirents) {
      if (entry.isSymbolicLink()) continue;
      const full = path3.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) walk2(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      const relative5 = relativeToWorkspace(base, full);
      if (relative5.toLowerCase().includes(needle)) {
        matches.push(relative5);
        rememberPath(relative5);
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
var SEARCH_IGNORED = /* @__PURE__ */ new Set([...IGNORED_DIRECTORIES, "out", "coverage", ".unify"]);
var watchers = /* @__PURE__ */ new Map();
var activeReply;
function setActiveUnifyReply(reply) {
  activeReply = reply;
}
function rememberPath(relative5) {
  for (const state of watchers.values()) state.known.add(relative5);
}
function normaliseRoots(roots) {
  const list = Array.isArray(roots) ? roots : roots ? [roots] : [];
  const resolved = [];
  for (const root of list) {
    if (typeof root !== "string" || !root) continue;
    const full = path3.resolve(root);
    if (resolved.includes(full) || !statOrUndefined(full)?.isDirectory()) continue;
    resolved.push(full);
  }
  return resolved;
}
function skippedSegment(segment) {
  return IGNORED_DIRECTORIES.has(segment) || segment === ".unify";
}
function isIgnored(root, relative5, isDirectory) {
  const segments = relative5.split("/").filter(Boolean);
  if (!segments.length) return false;
  if (segments.some(skippedSegment)) return true;
  const full = path3.resolve(root, ...segments);
  const home = path3.resolve(unifyHome());
  if (full === home || full.startsWith(home + path3.sep)) return true;
  const state = watchers.get(root);
  if (!state) return false;
  state.ignore.refresh();
  let prefix = "";
  for (const segment of segments.slice(0, -1)) {
    prefix = prefix ? `${prefix}/${segment}` : segment;
    if (state.ignore.ignores(prefix, true)) return true;
  }
  return state.ignore.ignores(relative5, isDirectory);
}
function watchWorkspace(roots, reply) {
  if (reply) activeReply = reply;
  for (const root of normaliseRoots(roots)) {
    if (watchers.has(root)) continue;
    let watcher;
    try {
      watcher = fs4.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename) return;
        const relative5 = filename.toString().replace(/\\/g, "/");
        scheduleChange(root, relative5);
      });
    } catch {
      continue;
    }
    watcher.on("error", () => {
      watcher.close();
      watchers.delete(root);
    });
    watchers.set(root, { watcher, timers: /* @__PURE__ */ new Map(), known: /* @__PURE__ */ new Set(), ignore: new GitIgnore(root) });
  }
}
function scheduleChange(root, relative5) {
  const state = watchers.get(root);
  if (!state) return;
  const existing = state.timers.get(relative5);
  if (existing) clearTimeout(existing);
  state.timers.set(relative5, setTimeout(() => {
    state.timers.delete(relative5);
    const base = path3.resolve(root);
    const full = path3.resolve(base, ...relative5.split("/"));
    if (full !== base && !full.startsWith(base + path3.sep)) return;
    const info = statOrUndefined(full);
    if (isIgnored(root, relative5, !!info?.isDirectory())) return;
    if (info?.isDirectory()) return;
    const wasKnown = state.known.has(relative5);
    if (!info) {
      state.known.delete(relative5);
      activeReply?.({ type: "fileChanged", root: base, path: relative5, kind: "deleted" });
      return;
    }
    state.known.add(relative5);
    activeReply?.({
      type: "fileChanged",
      root: base,
      path: relative5,
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
  activeReply = void 0;
}

// src/engine/unify/requests/knowledge.ts
import { spawn } from "node:child_process";
import * as fs6 from "node:fs";
import { promises as fsp } from "node:fs";
import * as path4 from "node:path";

// src/engine/instructions/store.ts
import { promises as fs5 } from "node:fs";
import { dirname as dirname4, join as join4, relative as relative2, resolve as resolve3, sep as sep3 } from "node:path";
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
    entries = await fs5.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.left <= 0 || entry.isSymbolicLink()) continue;
    const full = join4(directory, entry.name);
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
    return skillDescription((await fs5.readFile(file, "utf8")).slice(0, 4096));
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
    await fs5.access(join4(homeOf(roots), "AGENTS.md"));
    items.push({ id: "unify:AGENTS.md", kind: "rule", scope: "global", name: "AGENTS.md", path: "AGENTS.md" });
  } catch {
  }
  for (const [base, root] of [["unify", homeOf(roots)], ["agents", roots.agentsHome]]) {
    const skills = join4(root, "skills");
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
  return fs5.readFile((await find(roots, id)).file, "utf8");
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
    await fs5.writeFile(found.file, request.content, "utf8");
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
      id = "unify:AGENTS.md";
    }
    if (!text2.trim()) text2 = "# Rules\n\nAdd instructions here.\n";
  }
  const target = absolute(roots, id);
  await fs5.mkdir(dirname4(target), { recursive: true });
  try {
    await fs5.writeFile(target, text2, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("That rule or skill already exists. Edit it from the list instead.");
    throw error;
  }
  const item = (await listInstructions(roots)).find((candidate) => candidate.id === id);
  return { item: item ?? { id, kind: request.kind, scope: request.scope, name: request.name || String(request.file), path: id.slice(id.indexOf(":") + 1) }, file: target };
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
  return store.versions?.[path4.resolve(file)] ?? [];
}
function attribution(store, file, metadata, fallbackTime) {
  const latest = versionsFor(store, file).at(-1);
  if (latest && latest.at > (metadata.updatedAt ?? 0)) return { updatedBy: latest.by, updatedAt: latest.at };
  return { updatedBy: metadata.updatedBy ?? "you", updatedAt: metadata.updatedAt ?? fallbackTime };
}
function ruleFile(paths, scope) {
  if (scope === "project") return paths.workspaceRoot ? path4.join(paths.workspaceRoot, "AGENTS.md") : void 0;
  return path4.join(paths.unifyHome, "AGENTS.md");
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
      const full = path4.join(directory, entry.name);
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
  if (scope === "project") return paths.workspaceRoot ? path4.join(paths.workspaceRoot, ".unify", "memory") : void 0;
  return path4.join(paths.unifyHome, "memory");
}
function noteTitle(content, file) {
  const heading = /^#[ \t]+(.+)$/m.exec(content);
  if (heading) return heading[1].trim();
  return path4.basename(file, path4.extname(file)).replace(/[-_]+/g, " ");
}
function skillRoots(paths) {
  const roots = [
    { root: path4.join(paths.agentsHome, "skills"), prefix: "agents" },
    { root: path4.join(paths.unifyHome, "skills"), prefix: "unify" }
  ];
  if (paths.workspaceRoot) roots.push({ root: path4.join(paths.workspaceRoot, ".agents", "skills"), prefix: "ws" });
  return roots;
}
function skillFolderOf(item, paths) {
  const prefix = item.id.slice(0, item.id.indexOf(":"));
  const rel = item.id.slice(item.id.indexOf(":") + 1);
  const base = prefix === "ws" ? paths.workspaceRoot : prefix === "agents" ? paths.agentsHome : paths.unifyHome;
  return path4.dirname(path4.join(base, ...rel.split("/")));
}
function isInside(root, target) {
  const relative5 = path4.relative(path4.resolve(root), path4.resolve(target));
  return !!relative5 && relative5 !== ".." && !relative5.startsWith(`..${path4.sep}`) && !path4.isAbsolute(relative5);
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
    return fs6.statSync(file).mtimeMs;
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
    const files = (await walkFiles(folder)).map((file) => path4.relative(folder, file).split(path4.sep).join("/")).sort();
    const metadata = metadataFor(store, id);
    const skillFile = path4.join(folder, "SKILL.md");
    const time = statTimeSync(skillFile);
    const who = attribution(store, skillFile, metadata, time);
    items.push({
      id,
      kind: "skill",
      scope,
      name: path4.basename(folder),
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
      if (path4.extname(file).toLowerCase() !== ".md") continue;
      const relative5 = path4.relative(root, file).split(path4.sep).join("/");
      const id = `memory:${scope}:${relative5}`;
      const content = await readTextFile(file);
      const metadata = metadataFor(store, id);
      const folder = path4.dirname(relative5);
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
    const { scope, relative: relative5 } = parseMemoryId(id);
    const root = memoryRoot(paths, scope);
    return root ? resolveInside(root, relative5) : void 0;
  }
  if (id.startsWith("skill:")) {
    return path4.join(await skillFolderForId(paths, id), "SKILL.md");
  }
  return void 0;
}
function isInsideKnowledgeRoot(paths, target) {
  return [paths.unifyHome, paths.workspaceRoot, paths.agentsHome].some((root) => !!root && isInside(root, target));
}
async function undoKnowledgeChange(context, paths, id) {
  const store = metadataStore(paths);
  const target = await knowledgeFileFor(paths, id);
  if (!target) throw new Error("Nothing to undo.");
  const key = path4.resolve(target);
  if (!isInsideKnowledgeRoot(paths, key)) throw new Error("Nothing to undo.");
  const list = store.versions?.[key];
  if (!Array.isArray(list) || !list.length) throw new Error("Nothing to undo.");
  const version2 = list.pop();
  if (version2.content === null) {
    await fsp.rm(target, { force: true });
  } else {
    await fsp.mkdir(path4.dirname(target), { recursive: true });
    await fsp.writeFile(target, version2.content, "utf8");
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
      const folder = await skillFolderForId(paths, id);
      return { content: await fsp.readFile(resolveInside(folder, file), "utf8"), file };
    }
    return { content: await readInstruction(instructionRoots(paths), instructionId) };
  }
  if (id.startsWith("memory:")) {
    const { scope, relative: relative5 } = parseMemoryId(id);
    const root = memoryRoot(paths, scope);
    if (!root) throw new Error("Open a project folder to read project memory.");
    return { content: await fsp.readFile(resolveInside(root, relative5), "utf8") };
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
  const text2 = await readTextFile(target);
  const parsed = parseRuleSections(text2);
  if (parsed.sections.length) {
    const index = parsed.sections.findIndex((section2) => section2.slug === (existing?.slug || slug));
    const section = { slug, name, body: content.trim() };
    if (index >= 0) parsed.sections[index] = section;
    else parsed.sections.push(section);
  } else if (existing?.slug === "general") {
    parsed.preamble = content.trim();
    slug = "general";
  } else {
    parsed.preamble = text2.trim();
    parsed.sections = [{ slug, name, body: content.trim() }];
  }
  await fsp.mkdir(path4.dirname(target), { recursive: true });
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
    await fsp.mkdir(path4.dirname(target), { recursive: true });
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
  const relative5 = folder ? `${folder}/${filename}` : filename;
  const target = resolveInside(root, relative5);
  await fsp.mkdir(path4.dirname(target), { recursive: true });
  await fsp.writeFile(target, content, "utf8");
  const newId = `memory:${scope}:${relative5.split(path4.sep).join("/")}`;
  if (draft.id && draft.id.startsWith("memory:")) {
    const old = parseMemoryId(draft.id);
    const oldRoot = memoryRoot(paths, old.scope);
    if (oldRoot && (old.relative !== relative5 || old.scope !== scope)) {
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
    const folder = path4.resolve(skillFolderOf(skill, paths));
    assertInsideSkillRoot(paths, folder);
    await fsp.rm(folder, { recursive: true, force: true });
  } else if (id.startsWith("memory:")) {
    const { scope, relative: relative5 } = parseMemoryId(id);
    const root = memoryRoot(paths, scope);
    if (!root) throw new Error("That note no longer exists.");
    const target = resolveInside(root, relative5);
    await fsp.rm(target, { force: true });
    const parentDir = path4.dirname(target);
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
  const destination = scope === "project" ? paths.workspaceRoot && path4.join(paths.workspaceRoot, ".agents", "skills", skillName) : path4.join(paths.agentsHome, "skills", skillName);
  if (!destination) throw new Error("Open a project folder to add project skills.");
  assertInsideSkillRoot(paths, destination);
  let total = 0;
  const skillDocTarget = path4.resolve(destination, "SKILL.md");
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
    if (path4.resolve(target) === skillDocTarget) hasSkillDoc = true;
    planned.push({ target, buffer });
  }
  if (!hasSkillDoc) {
    throw new Error("A skill folder must include SKILL.md.");
  }
  for (const entry of planned) {
    await fsp.mkdir(path4.dirname(entry.target), { recursive: true });
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
    const { scope, relative: relative5 } = parseMemoryId(id);
    const root = memoryRoot(paths, scope);
    if (root) target = resolveInside(root, relative5);
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

// src/engine/unify/requests/providers.ts
var PROVIDER_USAGE_URLS = {
  "codex-cli": "https://chatgpt.com/settings/usage?tab=overview",
  "claude-cli": "https://claude.ai/settings/usage",
  "cursor-acp": "https://cursor.com/dashboard?tab=usage",
  "deepseek-official": "https://platform.deepseek.com/usage",
  "openrouter": "https://openrouter.ai/activity",
  "opencode-go": "https://opencode.ai/console",
  "mistral": "https://console.mistral.ai/usage"
};
var OAUTH_KEY = "unify.oauthCliAccounts.v1";
var OAUTH_DEFAULTS_KEY = "unify.oauthCliDefaults.v1";
var ACCOUNTS_KEY = "unify.accounts.v1";
var ACCOUNTS_DEFAULTS_KEY = "unify.accountDefaults.v1";
var MODEL_SETTING = "unify.models";
function providerStore(paths) {
  const stored = readJsonFile(paths.providersFile, {});
  const store = {
    modelEnabled: isRecord(stored.modelEnabled) ? stored.modelEnabled : {},
    accountLabels: isRecord(stored.accountLabels) ? stored.accountLabels : {},
    providerDefaults: isRecord(stored.providerDefaults) ? stored.providerDefaults : {}
  };
  if (isRecord(stored.accountDefaults)) {
    const state = readState(paths);
    const providerOf = /* @__PURE__ */ new Map();
    for (const item of [...records(state, OAUTH_KEY), ...records(state, ACCOUNTS_KEY)]) providerOf.set(item.id, item.provider);
    for (const [accountId, modelId] of Object.entries(stored.accountDefaults)) {
      const provider = providerOf.get(accountId);
      if (provider && typeof modelId === "string" && modelId && !store.providerDefaults[provider]) store.providerDefaults[provider] = modelId;
    }
    saveProviderStore(paths, store);
  }
  return store;
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
      ...store.providerDefaults[account.provider] ? { defaultModel: store.providerDefaults[account.provider] } : {}
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
      ...store.providerDefaults[account.provider] ? { defaultModel: store.providerDefaults[account.provider] } : {}
    });
  }
  return { type: "accountsState", accounts, providerDefaults: store.providerDefaults };
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
function setProviderDefaultModel(paths, provider, modelId) {
  const name = String(provider || "").trim();
  if (!name) throw new Error("Choose a provider first.");
  const store = providerStore(paths);
  if (modelId) store.providerDefaults[name] = String(modelId);
  else delete store.providerDefaults[name];
  saveProviderStore(paths, store);
  return accountsState(paths);
}
function setAccountDefaultModel(paths, accountId, modelId) {
  const provider = providerOfAccount(paths, accountId);
  if (!provider) throw new Error("Account not found.");
  return setProviderDefaultModel(paths, provider, modelId);
}
async function signOutAccount(paths, accountId, removeAccount) {
  if (!providerOfAccount(paths, accountId)) throw new Error("Account not found.");
  if (!removeAccount) throw new Error("Signing out needs the Unify engine. Restart Unify and try again.");
  await removeAccount(accountId);
  return accountsState(paths);
}
function providerOfAccount(paths, accountId) {
  if (accountId === "cursor-login") return "cursor-acp";
  const state = readState(paths);
  return records(state, OAUTH_KEY).find((item) => item.id === accountId)?.provider ?? records(state, ACCOUNTS_KEY).find((item) => item.id === accountId)?.provider;
}
function openProviderUsage(paths, accountId, hooks) {
  const provider = providerOfAccount(paths, accountId);
  if (!provider) return { type: "providerRequestResult", ok: false, error: "Account not found." };
  hooks.refreshUsageState?.(accountId);
  const url = PROVIDER_USAGE_URLS[provider];
  if (url && hooks.openExternal) {
    void Promise.resolve().then(() => hooks.openExternal?.(url)).catch(() => void 0);
  }
  return { type: "providerRequestResult", ok: true };
}

// src/engine/unify/requests/toolpacks.ts
import { existsSync as existsSync2 } from "node:fs";
import * as path5 from "node:path";

// src/engine/toolpacks/sync-state.ts
import { existsSync, mkdirSync as mkdirSync4, readFileSync as readFileSync6, renameSync as renameSync4, rmSync as rmSync2, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join6 } from "node:path";

// src/engine/hub/ids.ts
var TOOLPACK_NAME = /^[a-z][a-z0-9_]{0,31}$/;
function toolpackIdFor(hubId) {
  const sanitized = hubId.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const withLetter = /^[a-z]/.test(sanitized) ? sanitized : `pack_${sanitized}`;
  const id = withLetter.slice(0, 32);
  if (!TOOLPACK_NAME.test(id)) throw new Error(`Cannot turn Hub id "${hubId}" into a toolpack id.`);
  return id;
}

// src/engine/toolpacks/sync-state.ts
var INSTALL_ERRORS_FILE = ".install-errors.json";
function isRecord2(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function readJson(file) {
  try {
    return JSON.parse(readFileSync6(file, "utf8"));
  } catch {
    return void 0;
  }
}
function readInstallErrors(dir) {
  const stored = readJson(join6(dir, INSTALL_ERRORS_FILE));
  if (!isRecord2(stored)) return {};
  return Object.fromEntries(Object.entries(stored).filter((entry) => typeof entry[1] === "string"));
}
function writeInstallErrors(dir, errors) {
  const file = join6(dir, INSTALL_ERRORS_FILE);
  if (!Object.keys(errors).length) {
    rmSync2(file, { force: true });
    return;
  }
  mkdirSync4(dir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync4(temporary, `${JSON.stringify(errors, null, 2)}
`, "utf8");
  renameSync4(temporary, file);
}
function setInstallError(dir, id, message) {
  writeInstallErrors(dir, { ...readInstallErrors(dir), [id]: message });
}
function clearInstallError(dir, id) {
  const errors = readInstallErrors(dir);
  if (!Object.hasOwn(errors, id)) return;
  delete errors[id];
  writeInstallErrors(dir, errors);
}

// src/engine/unify/requests/toolpacks.ts
var TOOL_KINDS = ["read", "write", "run"];
var POLICIES = ["always", "ask", "off"];
function readStore(paths) {
  const stored = readJsonFile(paths.toolpacksFile, {});
  return {
    packs: isRecord(stored.packs) ? stored.packs : {},
    installed: isRecord(stored.installed) ? stored.installed : {}
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
function installedHubPacks(paths) {
  return readStore(paths).installed;
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
function recordHubInstall(paths, pack) {
  const store = readStore(paths);
  store.installed[pack.id] = pack;
  writeStore(paths, store);
}
async function handleToolpackInstallRequest(message, paths, context) {
  if (message.type !== "reinstallToolpack") return false;
  const id = typeof message.id === "string" ? message.id : "";
  try {
    if (!id.trim() || id !== path5.basename(id) || id === "." || id === "..") throw new Error("Unknown toolpack.");
    const sourcePath = path5.join(paths.toolpacksDir, id, "pack.ts");
    if (!existsSync2(sourcePath)) throw new Error(`"${id}" has no source on this PC. Install it again from the Hub.`);
    if (!context.installToolpack) throw new Error("Installing toolpacks is not available here.");
    await context.installToolpack(sourcePath);
    clearInstallError(paths.toolpacksDir, id);
  } catch (error) {
    if (id) setInstallError(paths.toolpacksDir, id, error instanceof Error ? error.message : String(error));
  }
  context.refreshToolpacks?.();
  return true;
}

// src/engine/hub/setup.ts
import { spawn as spawn3 } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync as existsSync4, promises as fsp2 } from "node:fs";
import * as os4 from "node:os";
import * as path7 from "node:path";
import { pathToFileURL } from "node:url";

// src/shim/vscode/host.ts
import { appendFileSync, mkdirSync as mkdirSync5 } from "node:fs";

// src/shim/vscode/events.ts
var Disposable = class _Disposable {
  disposed = false;
  callback;
  constructor(callback) {
    this.callback = callback;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.callback();
  }
  static from(...items) {
    return new _Disposable(() => {
      for (const item of items) item.dispose();
    });
  }
};
var EventEmitter = class {
  listeners = /* @__PURE__ */ new Set();
  event = (listener, _thisArgs, disposables) => {
    this.listeners.add(listener);
    const subscription = new Disposable(() => this.listeners.delete(listener));
    if (disposables) disposables.push(subscription);
    return subscription;
  };
  fire(value) {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (error) {
        console.error("[unify] event listener failed", error);
      }
    }
  }
  dispose() {
    this.listeners.clear();
  }
};

// src/shim/vscode/host.ts
var bridge;
var logFile = "";
var pendingMessages = [];
function postToRenderer(message) {
  if (bridge) bridge.post(message);
  else pendingMessages.push(message);
}
var windowStateChanged = new EventEmitter();
var onDidChangeWindowState = windowStateChanged.event;
function appendLog(line, channel = "engine") {
  if (!logFile) return;
  try {
    appendFileSync(logFile, `${(/* @__PURE__ */ new Date()).toISOString()} [${channel}] ${line}
`, "utf8");
  } catch {
  }
}

// src/engine/hub/packages.ts
import { spawn as spawn2, spawnSync } from "node:child_process";
import { existsSync as existsSync3, lstatSync, readdirSync as readdirSync2 } from "node:fs";
import * as os3 from "node:os";
import * as path6 from "node:path";
var PACKAGE_INSTALL_TIMEOUT = 6e5;
var PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._+\-[\],=<>@/]*$/;
function packageCommandFor(install, platform = process.platform) {
  if (!install) return void 0;
  if (platform === "win32" && install.winget) {
    return { manager: "winget", id: install.winget, display: `winget install --id ${install.winget} --exact` };
  }
  if (platform === "darwin" && install.brew) {
    return { manager: "brew", id: install.brew, display: `brew install ${install.brew}` };
  }
  if (install.pip) {
    return { manager: "pip", id: install.pip, display: `python -m pip install --user "${install.pip}"` };
  }
  return void 0;
}
function isValidPackageId(id) {
  return PACKAGE_ID.test(id);
}
var savedWindowsPath;
function windowsSavedPath() {
  if (process.platform !== "win32") return [];
  if (savedWindowsPath && Date.now() - savedWindowsPath.at < 5e3) return savedWindowsPath.value;
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const powershell = path6.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')";
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 1e4
  });
  const value = result.status === 0 ? result.stdout.split(";").map((item) => item.trim()).filter(Boolean) : [];
  savedWindowsPath = { value, at: Date.now() };
  return value;
}
function wingetLinks() {
  const local = process.env.LOCALAPPDATA;
  return process.platform === "win32" && local ? [path6.join(local, "Microsoft", "WinGet", "Links")] : [];
}
function pythonUserScripts() {
  if (process.platform !== "win32") return [path6.join(os3.homedir(), ".local", "bin")];
  const dirs = [];
  const bases = [
    process.env.APPDATA && path6.join(process.env.APPDATA, "Python"),
    process.env.LOCALAPPDATA && path6.join(process.env.LOCALAPPDATA, "Programs", "Python")
  ].filter((item) => !!item);
  for (const base of bases) {
    try {
      for (const entry of readdirSync2(base, { withFileTypes: true })) {
        if (entry.isDirectory() && /^Python3/i.test(entry.name)) dirs.push(path6.join(base, entry.name, "Scripts"));
      }
    } catch {
    }
  }
  return dirs;
}
function searchDirs() {
  const current = (process.env.PATH ?? process.env.Path ?? "").split(path6.delimiter).filter(Boolean);
  const extra = process.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : [];
  return [.../* @__PURE__ */ new Set([...current, ...windowsSavedPath(), ...wingetLinks(), ...extra, ...pythonUserScripts()])];
}
function programExists(candidate) {
  if (existsSync3(candidate)) return true;
  if (process.platform !== "win32") return false;
  try {
    lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}
function findCommand(name) {
  if (!name || /[\\/]/.test(name)) return void 0;
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const hasExtension = process.platform === "win32" && extensions.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()));
  for (const dir of searchDirs()) {
    for (const ext of hasExtension ? [""] : extensions) {
      const candidate = path6.join(dir, `${name}${ext}`);
      if (programExists(candidate)) return candidate;
    }
  }
  return void 0;
}
function refreshPath() {
  if (process.platform !== "win32") return;
  savedWindowsPath = void 0;
  const key = Object.keys(process.env).find((name) => name.toLowerCase() === "path") ?? "Path";
  const current = (process.env[key] ?? "").split(";").filter(Boolean);
  const known = new Set(current.map((item) => item.toLowerCase()));
  const added = [...windowsSavedPath(), ...wingetLinks()].filter((item) => !known.has(item.toLowerCase()));
  if (added.length) process.env[key] = [...current, ...added].join(";");
}
function lastLine(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^[-\\|/ ]+$/.test(line));
  return lines.length ? lines[lines.length - 1].slice(0, 500) : void 0;
}
function run(command, args, timeout) {
  return new Promise((resolve9) => {
    let output = "";
    let settled = false;
    const child = spawn2(command, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve9({ code, output, ...error ? { error } : {} });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null, `The installer took longer than ${Math.round(timeout / 6e4)} minutes.`);
    }, timeout);
    const collect = (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-16e3);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => finish(null, error.message));
    child.once("close", (code) => finish(code));
  });
}
function pythonCommandFor(platform = process.platform) {
  if (platform === "win32") return packageCommandFor({ winget: "Python.Python.3.12" }, platform);
  if (platform === "darwin") return packageCommandFor({ brew: "python@3.12" }, platform);
  return void 0;
}
function isPythonPackage(command) {
  if (command.manager === "winget") return /^Python\.Python\./i.test(command.id);
  if (command.manager === "brew") return /^python(@|$)/i.test(command.id);
  return false;
}
function windowsPythonInstalls() {
  if (process.platform !== "win32") return [];
  const bases = [
    process.env.LOCALAPPDATA && path6.join(process.env.LOCALAPPDATA, "Programs", "Python"),
    process.env.ProgramFiles
  ].filter((item) => !!item);
  const found = [];
  for (const base of bases) {
    try {
      const entries = readdirSync2(base, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^Python3\d*$/i.test(entry.name)).map((entry) => entry.name).sort().reverse();
      for (const name of entries) {
        const candidate = path6.join(base, name, "python.exe");
        if (existsSync3(candidate)) found.push(candidate);
      }
    } catch {
    }
  }
  return found;
}
function findPython() {
  const candidates = process.platform === "win32" ? [{ name: "py", prefix: ["-3"] }, { name: "python", prefix: [] }] : [{ name: "python3", prefix: [] }, { name: "python", prefix: [] }];
  for (const candidate of candidates) {
    const found = findCommand(candidate.name);
    if (found && !/WindowsApps/i.test(found)) return { command: found, prefix: candidate.prefix };
  }
  const installed = windowsPythonInstalls()[0];
  return installed ? { command: installed, prefix: [] } : void 0;
}
function hasPython() {
  return !!findPython();
}
async function installPackage(command, timeout = PACKAGE_INSTALL_TIMEOUT) {
  if (!isValidPackageId(command.id)) return { ok: false, lastLine: `"${command.id}" is not a valid package id.` };
  let program;
  let args;
  if (command.manager === "winget") {
    program = findCommand("winget");
    if (!program) return { ok: false, lastLine: 'winget was not found. Install "App Installer" from the Microsoft Store, then try again.' };
    args = ["install", "--id", command.id, "--exact", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"];
  } else if (command.manager === "brew") {
    program = findCommand("brew");
    if (!program) return { ok: false, lastLine: "Homebrew was not found. Install it from https://brew.sh, then try again." };
    args = ["install", command.id];
  } else {
    const python = findPython();
    if (!python) return { ok: false, lastLine: "Python 3 was not found. Install it, then try again." };
    program = python.command;
    args = [...python.prefix, "-m", "pip", "install", "--user", "--upgrade", command.id];
  }
  const result = await run(program, args, timeout);
  refreshPath();
  const alreadyInstalled = command.manager === "winget" && /already installed|No available upgrade|No newer package/i.test(result.output);
  const ok = result.code === 0 || alreadyInstalled;
  const line = result.error ?? lastLine(result.output) ?? (ok ? void 0 : `${command.manager} exited with code ${result.code}.`);
  return { ok, ...line ? { lastLine: line } : {} };
}

// src/engine/hub/types.ts
var PYTHON_DEPENDENCY_ID = "unify:python";

// src/engine/hub/scripts.ts
var INSTALL_SCRIPT_NAMES = ["install.js", "install.ps1", "install.sh"];
var UNINSTALL_SCRIPT_NAMES = ["uninstall.js", "uninstall.ps1", "uninstall.sh"];
var PACK_SCRIPT_NAMES = [...INSTALL_SCRIPT_NAMES, ...UNINSTALL_SCRIPT_NAMES];

// src/engine/hub/setup.ts
var PACK_SCRIPT_TIMEOUT = 6e5;
function emptyStateFile() {
  return { ticks: {} };
}
function stateFileFor(packDir) {
  return path7.join(packDir, "setup-state.json");
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
async function readStateFile(packDir) {
  let text2;
  try {
    text2 = await fsp2.readFile(stateFileFor(packDir), "utf8");
  } catch {
    return emptyStateFile();
  }
  let parsed;
  try {
    parsed = JSON.parse(text2);
  } catch {
    return emptyStateFile();
  }
  if (!parsed || typeof parsed !== "object") return emptyStateFile();
  const record = parsed;
  const ticks = {};
  if (record.ticks && typeof record.ticks === "object" && !Array.isArray(record.ticks)) {
    for (const [id, value] of Object.entries(record.ticks)) {
      if (value === true) ticks[id] = true;
    }
  }
  const script = parseRunRecord(record.script);
  const packages = {};
  if (record.packages && typeof record.packages === "object" && !Array.isArray(record.packages)) {
    for (const [id, value] of Object.entries(record.packages)) {
      const parsedRecord = parseRunRecord(value);
      if (parsedRecord) packages[id] = parsedRecord;
    }
  }
  return {
    ticks,
    ...script ? { script } : {},
    ...Object.keys(packages).length ? { packages } : {}
  };
}
function parseRunRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const record = value;
  if (typeof record.ok !== "boolean") return void 0;
  return {
    ok: record.ok,
    ...typeof record.lastLine === "string" ? { lastLine: record.lastLine } : {},
    ...typeof record.at === "number" ? { at: record.at } : {}
  };
}
async function writeStateFile(packDir, state) {
  await fsp2.mkdir(packDir, { recursive: true });
  const file = stateFileFor(packDir);
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp2.writeFile(temporary, `${JSON.stringify(state, null, 2)}
`, "utf8");
  await fsp2.rename(temporary, file);
}
async function recordPackScriptResult(packDir, ok, lastLine2) {
  const state = await readStateFile(packDir);
  state.script = { ok, ...lastLine2 ? { lastLine: lastLine2 } : {}, at: Date.now() };
  await writeStateFile(packDir, state);
}
async function setPackSetupStepDone(packDir, stepId, done) {
  if (!stepId.trim()) throw new Error("Choose a setup step first.");
  const state = await readStateFile(packDir);
  if (done) state.ticks[stepId] = true;
  else delete state.ticks[stepId];
  await writeStateFile(packDir, state);
}
function lastOutputLine(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  return last ? last.slice(0, 500) : void 0;
}
function commandFor(script, packDir, unifyHome2) {
  const file = path7.join(packDir, script);
  const env = {
    ...process.env,
    UNIFY_PACK_DIR: packDir,
    UNIFY_HOME: unifyHome2
  };
  if (script.endsWith(".js")) {
    env.ELECTRON_RUN_AS_NODE = "1";
    return { command: process.execPath, args: [file], env };
  }
  if (script.endsWith(".ps1")) {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const powershell = path7.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return { command: powershell, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], env };
  }
  if (script.endsWith(".sh")) {
    return { command: "bash", args: [file], env };
  }
  return void 0;
}
function runScriptProcess(packDir, script, unifyHome2) {
  const kind = UNINSTALL_SCRIPT_NAMES.includes(script) ? "uninstall" : "install";
  const invocation = commandFor(script, packDir, unifyHome2);
  if (!invocation) {
    return Promise.resolve({ ok: false, lastLine: `Unsupported ${kind} script "${script}".`, error: `Unsupported ${kind} script "${script}".`, output: "" });
  }
  return new Promise((resolve9) => {
    const child = spawn3(invocation.command, invocation.args, {
      cwd: packDir,
      env: invocation.env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let settled = false;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const lastLine2 = lastOutputLine(output) ?? error;
      resolve9({ ok, ...lastLine2 ? { lastLine: lastLine2 } : {}, ...error ? { error } : {}, output });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false, `The ${kind} script took longer than ${Math.round(PACK_SCRIPT_TIMEOUT / 1e3)}s.`);
    }, PACK_SCRIPT_TIMEOUT);
    child.stdout?.on("data", (chunk) => {
      if (output.length < 16e3) output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      if (output.length < 16e3) output += chunk.toString();
    });
    child.once("error", (error) => finish(false, error.message));
    child.once("close", (code) => {
      if (code === 0) finish(true);
      else finish(false, `The ${kind} script exited with code ${code}${output ? `: ${output.slice(-2e3)}` : "."}`);
    });
  });
}
async function runPackInstallScript(packDir, script, options = {}) {
  const unifyHome2 = options.unifyHome || process.env.UNIFY_HOME || path7.join(os4.homedir(), ".unify");
  const result = await runScriptProcess(packDir, script, unifyHome2);
  await recordPackScriptResult(packDir, result.ok, result.lastLine).catch((error) => appendLog(`Could not save the install script result for ${packDir}: ${errorMessage(error)}`));
  return result;
}
async function firstExisting(packDir, names) {
  for (const name of names) {
    try {
      await fsp2.access(path7.join(packDir, name));
      return name;
    } catch {
    }
  }
  return void 0;
}
function findInstallScript(packDir) {
  return firstExisting(packDir, INSTALL_SCRIPT_NAMES);
}
function expandTokens(value, packDir) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (token, name) => {
    if (name === "PACK") return packDir;
    if (name === "HOME") return os4.homedir();
    const environment = process.env[name];
    return environment !== void 0 ? environment : token;
  });
}
function toPlatformPath(value) {
  return value.replace(/\//g, path7.sep);
}
function isUrl(value) {
  if (path7.isAbsolute(toPlatformPath(value))) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}
function setupPath(value, packDir) {
  const normalized = toPlatformPath(value);
  return path7.isAbsolute(normalized) ? normalized : path7.resolve(packDir, normalized);
}
function displayedPath(value, packDir) {
  const expanded = expandTokens(value, packDir);
  if (isUrl(expanded)) return expanded;
  const normalized = toPlatformPath(expanded);
  return path7.isAbsolute(normalized) ? normalized : expanded;
}
function parseStep(raw, index, name) {
  const fail = (detail) => {
    throw new Error(`The setup.json in "${name}" has an invalid step at index ${index}: ${detail}`);
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("the step must be an object.");
  const step = raw;
  if (typeof step.id !== "string" || !step.id.trim()) fail('"id" must be a non-empty string.');
  if (typeof step.title !== "string" || !step.title.trim()) fail('"title" must be a non-empty string.');
  if (step.kind !== "auto" && step.kind !== "manual") fail('"kind" must be "auto" or "manual".');
  for (const key of ["detail", "copy", "open"]) {
    if (step[key] !== void 0 && typeof step[key] !== "string") fail(`"${key}" must be a string.`);
  }
  let check;
  if (step.check !== void 0) {
    if (!step.check || typeof step.check !== "object" || Array.isArray(step.check)) fail('"check" must be an object.');
    const { exists, command } = step.check;
    const paths = Array.isArray(exists) ? exists : [exists];
    if (exists !== void 0 && (!paths.length || paths.some((item) => typeof item !== "string" || !item.trim()))) {
      fail('"check.exists" must be a path or a list of paths.');
    }
    if (command !== void 0 && (typeof command !== "string" || !/^[A-Za-z0-9._+-]+$/.test(command))) {
      fail('"check.command" must be a bare program name.');
    }
    if (exists === void 0 && command === void 0) fail('"check" needs "exists" or "command".');
    check = {
      ...exists !== void 0 ? { exists } : {},
      ...typeof command === "string" ? { command } : {}
    };
  }
  let install;
  if (step.install !== void 0) {
    if (!step.install || typeof step.install !== "object" || Array.isArray(step.install)) fail('"install" must be an object.');
    const record = step.install;
    install = {};
    for (const manager of ["winget", "brew", "pip"]) {
      const id = record[manager];
      if (id === void 0) continue;
      if (typeof id !== "string" || !isValidPackageId(id)) fail(`"install.${manager}" must be a package id.`);
      install[manager] = id;
    }
    if (!Object.keys(install).length) fail('"install" needs "winget", "brew" or "pip".');
  }
  if (step.optional !== void 0 && typeof step.optional !== "boolean") fail('"optional" must be true or false.');
  let platforms;
  if (step.platforms !== void 0) {
    if (!Array.isArray(step.platforms) || step.platforms.some((item) => typeof item !== "string")) {
      fail('"platforms" must be an array of platform names.');
    }
    platforms = step.platforms;
  }
  return {
    id: step.id,
    title: step.title,
    ...typeof step.detail === "string" ? { detail: step.detail } : {},
    kind: step.kind,
    ...typeof step.copy === "string" ? { copy: step.copy } : {},
    ...typeof step.open === "string" ? { open: step.open } : {},
    ...check ? { check } : {},
    ...install ? { install } : {},
    ...step.optional === true ? { optional: true } : {},
    ...platforms ? { platforms } : {}
  };
}
function parseDefinition(raw, name) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`The setup.json in "${name}" must contain a "steps" array.`);
  }
  const steps = raw.steps;
  if (!Array.isArray(steps)) throw new Error(`The setup.json in "${name}" must contain a "steps" array.`);
  return { steps: steps.map((step, index) => parseStep(step, index, name)) };
}
function checkStep(definition, packDir) {
  const check = definition.check;
  if (!check) return void 0;
  if (check.exists) {
    const paths = (Array.isArray(check.exists) ? check.exists : [check.exists]).map((item) => setupPath(expandTokens(item, packDir), packDir));
    if (paths.some((item) => existsSync4(item))) return { passed: true };
    if (!check.command) return { passed: false, missing: `${paths[0]} was not found.` };
  }
  if (check.command) {
    if (findCommand(check.command)) return { passed: true };
    return { passed: false, missing: `${check.command} was not found.` };
  }
  return { passed: false };
}
function evaluateStep(definition, state, packDir) {
  const detail = definition.detail ? expandTokens(definition.detail, packDir) : void 0;
  const copy = definition.copy ? displayedPath(definition.copy, packDir) : void 0;
  const open = definition.open ? displayedPath(definition.open, packDir) : void 0;
  const install = packageCommandFor(definition.install);
  const checked = checkStep(definition, packDir);
  const ticked = state.ticks[definition.id] === true;
  const packageRun = state.packages?.[definition.id];
  let status;
  let error;
  if (checked) {
    if (checked.passed) status = "done";
    else if (definition.kind === "manual") status = ticked ? "done" : "todo";
    else if (definition.optional && !(packageRun && !packageRun.ok)) status = "todo";
    else {
      status = "failed";
      error = packageRun && !packageRun.ok && packageRun.lastLine ? packageRun.lastLine : checked.missing;
    }
  } else if (install) {
    if (packageRun?.ok) status = "done";
    else if (definition.kind === "manual") status = ticked ? "done" : "todo";
    else if (definition.optional && !packageRun) status = "todo";
    else {
      status = "failed";
      error = packageRun?.lastLine || "Not installed yet.";
    }
  } else if (definition.kind === "auto") {
    if (state.script?.ok) status = "done";
    else {
      status = "failed";
      error = state.script?.lastLine || "The install script has not run successfully yet.";
    }
  } else {
    status = ticked ? "done" : "todo";
  }
  return {
    id: definition.id,
    title: definition.title,
    ...detail ? { detail } : {},
    kind: definition.kind,
    ...copy ? { copy } : {},
    ...open ? { open } : {},
    status,
    ...error ? { error } : {},
    ...install ? { install: install.display } : {},
    ...definition.optional ? { optional: true } : {}
  };
}
async function readDefinition(packDir, name) {
  let text2;
  try {
    text2 = await fsp2.readFile(path7.join(packDir, "setup.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Could not read setup.json in "${name}": ${errorMessage(error)}`);
  }
  let raw;
  try {
    raw = JSON.parse(text2);
  } catch (error) {
    throw new Error(`The setup.json in "${name}" is not valid JSON: ${errorMessage(error)}`);
  }
  return parseDefinition(raw, name);
}
function onThisPlatform(step) {
  return !step.platforms || step.platforms.includes(process.platform);
}
function withImplicitPython(pending) {
  const pip = pending.filter((item) => item.command.manager === "pip");
  if (!pip.length || pending.some((item) => isPythonPackage(item.command)) || hasPython()) return pending;
  const command = pythonCommandFor();
  if (!command) return pending;
  const python = {
    stepId: PYTHON_DEPENDENCY_ID,
    title: "Python 3.12",
    command,
    ...pip.every((item) => item.optional) ? { optional: true } : {},
    neededBy: pip.map((item) => item.stepId)
  };
  return [python, ...pending];
}
async function pendingPackages(packDir, name, stepId, options = {}) {
  const definition = await readDefinition(packDir, name);
  if (!definition) return [];
  const pending = [];
  for (const step of definition.steps) {
    if (!onThisPlatform(step)) continue;
    if (stepId ? step.id !== stepId : step.optional && !options.includeOptional) continue;
    const command = packageCommandFor(step.install);
    if (!command) continue;
    if (checkStep(step, packDir)?.passed) continue;
    pending.push({
      stepId: step.id,
      title: step.title,
      command,
      ...step.optional ? { optional: true } : {}
    });
  }
  return withImplicitPython(pending);
}
function chosenPackages(pending, selectedOptional) {
  const chosen = pending.filter((item) => item.stepId !== PYTHON_DEPENDENCY_ID && (!item.optional || selectedOptional.includes(item.stepId)));
  const python = pending.find((item) => item.stepId === PYTHON_DEPENDENCY_ID);
  const needsPython = python && chosen.some((item) => python.neededBy?.includes(item.stepId));
  const ordered = [...chosen.filter((item) => isPythonPackage(item.command)), ...chosen.filter((item) => !isPythonPackage(item.command))];
  return needsPython ? [python, ...ordered] : ordered;
}
async function installSetupPackages(packDir, name, stepId, selectedOptional = []) {
  const pending = await pendingPackages(packDir, name, stepId, { includeOptional: selectedOptional.length > 0 });
  if (stepId && !pending.length) {
    const definition = await readDefinition(packDir, name);
    const step = definition?.steps.find((item) => item.id === stepId);
    if (!step || !packageCommandFor(step.install)) throw new Error("This setup step has nothing to install on this computer.");
    return;
  }
  const toInstall = stepId ? chosenPackages(pending, [stepId]) : chosenPackages(pending, selectedOptional);
  for (const item of toInstall) {
    const id = `pack-package-${randomUUID()}`;
    const title = `${name}: ${item.title}`;
    postToRenderer({ type: "progressNotice", id, title, message: item.command.display, state: "running" });
    const result = await installPackage(item.command);
    appendLog(`${item.command.display} -> ${result.ok ? "ok" : "failed"}${result.lastLine ? `: ${result.lastLine}` : ""}`);
    const state = await readStateFile(packDir);
    state.packages = { ...state.packages, [item.stepId]: { ok: result.ok, ...result.lastLine ? { lastLine: result.lastLine } : {}, at: Date.now() } };
    await writeStateFile(packDir, state).catch((error) => appendLog(`Could not save the package result for ${packDir}: ${errorMessage(error)}`));
    postToRenderer({
      type: "progressNotice",
      id,
      title,
      message: result.ok ? "Installed" : result.lastLine ?? "The install failed.",
      state: result.ok ? "done" : "error"
    });
  }
}
async function readPackSetup(packDir, packId, name) {
  const definition = await readDefinition(packDir, name);
  if (!definition) return null;
  const state = await readStateFile(packDir);
  const steps = definition.steps.filter(onThisPlatform).map((step) => evaluateStep(step, state, packDir));
  const pending = steps.filter((step) => step.status !== "done" && !step.optional).length;
  const hasPackages = definition.steps.some((step) => onThisPlatform(step) && !step.optional && !!packageCommandFor(step.install));
  const canRerunScript = hasPackages || !!await findInstallScript(packDir);
  return { id: packId, name, steps, pending, canRerunScript };
}
async function rerunPackSetupScript(packDir, options = {}) {
  const name = options.packName ?? path7.basename(packDir);
  const script = await findInstallScript(packDir);
  const packages = await pendingPackages(packDir, name);
  if (!script && !packages.length) {
    if ((await readPackSetup(packDir, path7.basename(packDir), name))?.canRerunScript) return;
    throw new Error(`The pack "${name}" has no install script to run.`);
  }
  await installSetupPackages(packDir, name);
  if (script) await runScriptWithNotice(packDir, script, name, options.unifyHome);
}
async function runScriptWithNotice(packDir, script, name, unifyHome2) {
  const options = { unifyHome: unifyHome2 };
  const id = `pack-setup-${randomUUID()}`;
  const title = `Setting up ${name}`;
  postToRenderer({ type: "progressNotice", id, title, message: `Running ${script}`, state: "running" });
  const result = await runPackInstallScript(packDir, script, { unifyHome: options.unifyHome });
  postToRenderer({
    type: "progressNotice",
    id,
    title,
    ...result.lastLine ? { message: result.lastLine } : {},
    state: result.ok ? "done" : "error"
  });
}
async function openSetupTarget(target, openExternal, packDir) {
  const value = target.trim();
  if (!value) throw new Error("This setup step has nothing to open.");
  const pathValue = packDir ? setupPath(value, packDir) : value;
  const resolved = isUrl(value) ? value : toPlatformPath(pathValue);
  if (openExternal) {
    await openExternal(isUrl(resolved) ? resolved : pathToFileURL(resolved).href);
    return;
  }
  const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", resolved] : [resolved];
  await new Promise((resolve9, reject) => {
    const child = spawn3(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve9();
    });
  });
}

// src/engine/unify/requests/settings.ts
import * as fs7 from "node:fs";
import * as path8 from "node:path";
function packageVersion() {
  try {
    const file = path8.join(process.cwd(), "package.json");
    const parsed = JSON.parse(fs7.readFileSync(file, "utf8"));
    return typeof parsed.version === "string" && parsed.version ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
function appInfo(paths, version2) {
  return {
    version: version2 || packageVersion(),
    channel: "stable",
    dataFolder: paths.unifyHome,
    update: { state: "idle" }
  };
}
function appInfoReply(paths, version2) {
  return { type: "appInfo", info: appInfo(paths, version2) };
}
function updateInstallUnavailable(paths, version2) {
  const info = appInfo(paths, version2);
  const update = {
    state: "error",
    message: "Updates are installed by the app; the engine cannot install one."
  };
  return { type: "appInfo", info: { ...info, update } };
}

// src/engine/unify/requests/setup.ts
import * as path9 from "node:path";

// src/engine/runtime/dependencies.ts
import { createHash as createHash2 } from "node:crypto";
import { spawn as spawn5 } from "node:child_process";
import { createWriteStream, existsSync as existsSync5, readdirSync as readdirSync3 } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { homedir as homedir5, tmpdir } from "node:os";
import { delimiter as delimiter2, dirname as dirname6, join as join11, isAbsolute as isAbsolute4 } from "node:path";

// src/engine/runtime/cancellation.ts
import { spawn as spawn4 } from "node:child_process";
var terminated = /* @__PURE__ */ new WeakSet();
function terminateProcessTree(child) {
  if (terminated.has(child)) return;
  terminated.add(child);
  if (child.pid && child.exitCode === null) {
    if (process.platform === "win32") {
      const killer = spawn4("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
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

// src/engine/runtime/dependencies.ts
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
var DOWNLOAD_LIMIT = 250 * 1024 * 1024;
var DOWNLOAD_TIMEOUT = 12e4;
var PROCESS_TIMEOUT = 18e4;
var PROVIDERS = /* @__PURE__ */ new Set(["claude-cli", "cursor-acp"]);
var WINDOWS = process.platform === "win32";
function unixBinDirs() {
  const home = homedir5();
  return [join11(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", join11(home, ".volta", "bin"), join11(home, ".npm-global", "bin")];
}
function npmCli(nodeExecPath) {
  const dir = dirname6(nodeExecPath);
  return WINDOWS ? join11(dir, "node_modules", "npm", "bin", "npm-cli.js") : join11(dirname6(dir), "lib", "node_modules", "npm", "bin", "npm-cli.js");
}
function run2(executable, args, timeout = 15e3, env = process.env) {
  return new Promise((resolve9, reject) => {
    const child = spawn5(executable, args, { windowsHide: true, shell: false, env, stdio: ["pipe", "pipe", "pipe"] });
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
      error ? reject(error) : resolve9({ code, stdout, stderr });
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
  if (current.split(delimiter2).some((part) => norm(part) === norm(directory))) return;
  process.env[key] = `${directory}${current ? `${delimiter2}${current}` : ""}`;
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
      const node = await run2(executable, ["--version"]);
      if (node.code !== 0 || !supported(node.stdout + node.stderr)) return false;
      const location = await run2(executable, ["-p", "process.execPath"]);
      if (location.code !== 0) return false;
      const npmPath = npmCli(location.stdout.trim());
      if (!existsSync5(npmPath)) return false;
      const npmRun = await run2(executable, [npmPath, "--version"]);
      return npmRun.code === 0 && !!version(npmRun.stdout);
    } catch {
      return false;
    }
  }
  async ensureNodeOnce() {
    const configured = this.configuredNode?.()?.trim();
    if (configured) {
      if (!await this.probeNode(configured)) throw new Error(`Configured Node executable '${configured}' is invalid or unsupported. Install Node 22.19+ (22.x) or 24+, with working npm, or update unify.runtime.nodePath.`);
      const location = await run2(configured, ["-p", "process.execPath"]);
      const executable = location.stdout.trim();
      prependPath(dirname6(executable));
      return executable;
    }
    const candidates = WINDOWS ? [join11(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"), "node.exe"] : ["node", ...unixBinDirs().map((dir) => join11(dir, "node"))];
    for (const candidate of candidates) if (await this.probeNode(candidate)) {
      const resolved = await run2(candidate, ["-p", "process.execPath"]);
      const executable = resolved.stdout.trim() || candidate;
      prependPath(dirname6(executable));
      return executable;
    }
    if (!WINDOWS) throw new Error("Node.js 22.19+ or 24+ with npm was not found. Install it (for example `brew install node` or from nodejs.org), or set unify.runtime.nodePath, then try again.");
    const root = join11(this.storage, "dependencies", "node");
    const managed = join11(root, "node.exe");
    if (await this.probeNode(managed)) {
      prependPath(root);
      return managed;
    }
    await mkdir(root, { recursive: true });
    const stage = await mkdtemp(join11(this.storage, "node-stage-"));
    try {
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      const indexResponse = await fetch("https://nodejs.org/dist/index.json", { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) });
      if (!indexResponse.ok) throw new Error(`Could not retrieve Node releases (${indexResponse.status}).`);
      const releases = await indexResponse.json();
      const release = releases.find((item) => /^v24\.\d+\.\d+$/.test(item.version) && item.lts);
      if (!release) throw new Error("No Node 24 LTS Windows release was found.");
      const base = `https://nodejs.org/dist/${release.version}`;
      const archive = `node-${release.version}-win-${arch}.zip`;
      const zip = join11(stage, archive), sums = join11(stage, "SHASUMS256.txt");
      const downloads = await Promise.allSettled([download(`${base}/${archive}`, zip), download(`${base}/SHASUMS256.txt`, sums, 2e6)]);
      for (const result of downloads) if (result.status === "rejected") throw result.reason;
      const sumText = await readFile(sums, "utf8");
      const expected = sumText.split(/\r?\n/).find((line) => line.trim().endsWith(` ${archive}`))?.trim().split(/\s+/)[0];
      if (!expected || createHash2("sha256").update(await readFile(zip)).digest("hex").toLowerCase() !== expected.toLowerCase()) throw new Error(`SHA-256 verification failed for ${archive}.`);
      const extracted = join11(stage, "extracted");
      await mkdir(extracted);
      const expansion = await run2("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:UNIFY_NODE_ZIP -DestinationPath $env:UNIFY_NODE_DEST -Force"], PROCESS_TIMEOUT, { ...process.env, UNIFY_NODE_ZIP: zip, UNIFY_NODE_DEST: extracted });
      if (expansion.code !== 0) throw new Error(`Could not expand the downloaded Node archive: ${expansion.stderr.slice(-2e3)}`);
      const entries = await readdir(extracted);
      const unpacked = entries.map((entry) => join11(extracted, entry)).find((path16) => existsSync5(join11(path16, "node.exe")));
      if (!unpacked) throw new Error("Downloaded Node archive did not contain node.exe.");
      if (!await this.probeNode(join11(unpacked, "node.exe"))) throw new Error("Downloaded Node or npm failed its version check.");
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
        const root = /\.(cmd|ps1)$/i.test(configured) ? dirname6(configured) : configured;
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
    const appData = process.env.APPDATA || join11(homedir5(), "AppData", "Roaming");
    const local = process.env.LOCALAPPDATA || join11(homedir5(), "AppData", "Local");
    if (provider === "claude-cli") return [join11(homedir5(), ".local", "bin", "claude.exe"), join11(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), "claude.exe"];
    const root = join11(local, "cursor-agent");
    const node = this.cursorNode(root);
    return [...node ? [node] : [], "agent.exe", join11(root, "agent.exe")];
  }
  unixProviderCandidates(provider) {
    const home = homedir5();
    const inDirs = (name) => unixBinDirs().map((dir) => join11(dir, name));
    if (provider === "claude-cli") return [join11(home, ".claude", "local", "claude"), ...inDirs("claude"), "claude"];
    return [...inDirs("cursor-agent"), ...inDirs("agent"), "cursor-agent"];
  }
  cursorNode(root) {
    const versions = join11(root, "versions");
    try {
      for (const entry of readdirSync3(versions).sort().reverse()) {
        const directory = join11(versions, entry);
        const node = WINDOWS ? "node.exe" : "node";
        if (existsSync5(join11(directory, node)) && existsSync5(join11(directory, "index.js"))) return join11(directory, node);
      }
    } catch {
    }
    return void 0;
  }
  async isExecutable(path16) {
    if (isAbsolute4(path16) && !existsSync5(path16)) return false;
    const ext = path16.toLowerCase();
    try {
      if (!WINDOWS || ext.endsWith(".exe") || !/[\\/]/.test(path16)) {
        const cursorScript = join11(dirname6(path16), "index.js");
        return (await run2(path16, existsSync5(cursorScript) && /[\\/]node(\.exe)?$/i.test(path16) ? [cursorScript, "--version"] : ["--version"])).code === 0;
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
    const stage = await mkdtemp(join11(tmpdir(), `unify-${provider}-`));
    if (!WINDOWS) {
      try {
        const script2 = join11(stage, "install.sh");
        await download(provider === "claude-cli" ? "https://claude.ai/install.sh" : "https://cursor.com/install", script2, 4e6);
        const result = await run2("/bin/bash", [script2], PROCESS_TIMEOUT);
        if (result.code !== 0) throw new Error(`${provider} installer failed: ${(result.stderr || result.stdout).slice(-2e3)}`);
        if (!await this.providerCommand(provider)) throw new Error(`${provider} installer completed, but its executable was not found.`);
      } finally {
        await rm(stage, { recursive: true, force: true }).catch(() => void 0);
      }
      return;
    }
    const script = join11(stage, "install.ps1");
    try {
      const url = provider === "claude-cli" ? "https://claude.ai/install.ps1" : "https://cursor.com/install?win32=true";
      await download(url, script, 4e6);
      const result = await run2("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], PROCESS_TIMEOUT);
      if (result.code !== 0) throw new Error(`${provider} installer failed: ${result.stderr.slice(-2e3)}`);
      if (!await this.providerCommand(provider)) throw new Error(`${provider} installer completed, but its native Windows executable was not found.`);
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(() => void 0);
    }
  }
};

// src/engine/unify/requests/setup.ts
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
    ...stored.defaultProject && typeof stored.defaultProject.path === "string" ? { defaultProject: { name: String(stored.defaultProject.name || path9.basename(stored.defaultProject.path)), path: stored.defaultProject.path } } : {},
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
    file.defaultProject = { name: String(project.name || path9.basename(project.path)), path: project.path };
  }
  saveSetup(paths, file);
  return getSetupState(paths);
}
function setDefaultProject(paths, project) {
  const target = typeof project?.path === "string" ? project.path.trim() : "";
  if (!target) throw new Error("Choose a project folder first.");
  const file = readSetup(paths);
  file.defaultProject = { name: typeof project?.name === "string" && project.name.trim() ? project.name.trim() : path9.basename(target), path: target };
  saveSetup(paths, file);
  return getSetupState(paths);
}
function accountProviders(paths) {
  const state = readJsonFile(paths.stateFile, {});
  const providers = /* @__PURE__ */ new Set();
  for (const key of ["unify.oauthCliAccounts.v1", "unify.accounts.v1"]) {
    const list = state[key];
    if (!Array.isArray(list)) continue;
    for (const account of list) {
      if (account && typeof account === "object" && typeof account.provider === "string") {
        providers.add(account.provider);
      }
    }
  }
  const cursor = state["unify.cursor.v1"];
  if (cursor && typeof cursor === "object" && cursor.connected === true) providers.add("cursor-acp");
  return providers;
}
function toolVersion(text2) {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(text2);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : void 0;
}
async function probe(executable) {
  try {
    const result = await run2(executable, ["--version"], TOOL_TIMEOUT);
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
    if (!accounts.has(tool.provider) || tool.provider === "codex-cli" && getUnifyFeature("agents.codexRuntime")) continue;
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

// src/engine/unify/requests/hub.ts
import * as path14 from "node:path";

// src/engine/hub/githubRegistry.ts
import { promises as fsp4 } from "node:fs";
import * as path11 from "node:path";

// src/engine/hub/publish.ts
import { promises as fsp3 } from "node:fs";
import { createRequire } from "node:module";
import * as path10 from "node:path";
import * as vm from "node:vm";

// src/engine/toolpacks/types.ts
var TOOLPACK_SYNC_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/;
var TOOLPACK_NAME2 = /^[a-z][a-z0-9_]{0,31}$/;

// src/engine/hub/publishing.ts
var PUBLISH_SIGNED_OUT = "Sign in to GitHub to publish.";
var PUBLISH_NOT_APPROVED = "Publishing is limited to approved accounts.";
function publishAccessError(auth, publishers) {
  if (!auth) return { ok: false, message: PUBLISH_SIGNED_OUT };
  const login = auth.login.trim().toLowerCase();
  const approved = publishers.some((publisher) => publisher.trim().toLowerCase() === login);
  if (!approved) return { ok: false, message: PUBLISH_NOT_APPROVED };
  return void 0;
}

// src/engine/hub/publish.ts
var HUB_REPOSITORY = "raisinhvh/unify-hub";
var HUB_BRANCH = "main";
var HUB_PUBLISHERS_URL = `https://raw.githubusercontent.com/${HUB_REPOSITORY}/${HUB_BRANCH}/publishers.json`;
var REQUEST_TIMEOUT = 15e3;
var SCRIPT_NAMES = PACK_SCRIPT_NAMES;
var HUB_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
var SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
var SAFETY_RULES = [
  { type: "PEM block", pattern: /-----BEGIN [A-Z0-9 ]+-----/ },
  { type: "API key or token (sk-)", pattern: /\bsk-[A-Za-z0-9_-]{10,}/ },
  { type: "GitHub token (ghp_)", pattern: /\bghp_[A-Za-z0-9]{10,}\b/ },
  { type: "GitHub token (gho_)", pattern: /\bgho_[A-Za-z0-9]{10,}\b/ },
  { type: "GitHub token (github_pat_)", pattern: /\bgithub_pat_[A-Za-z0-9_]{10,}\b/ },
  { type: "Slack token (xox)", pattern: /\bxox[a-zA-Z]-[A-Za-z0-9-]{8,}\b/ },
  { type: "AWS access key (AKIA)", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { type: "Google API key (AIza)", pattern: /\bAIza[0-9A-Za-z_-]{16,}\b/ },
  { type: "email address", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { type: "absolute user path", pattern: /[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)/i },
  { type: "absolute user path", pattern: /(?:^|[\s"'`(=:,])\/Users\// },
  { type: "absolute user path", pattern: /(?:^|[\s"'`(=:,])\/home\// }
];
function isRecord3(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function titleFromId2(id) {
  return id.split(/[-_\s]+/).filter(Boolean).map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}
function compareSemver(a, b) {
  const left = SEMVER_PATTERN.exec(a);
  const right = SEMVER_PATTERN.exec(b);
  if (!left || !right) return 0;
  for (let index = 1; index <= 3; index++) {
    const diff = Number(left[index]) - Number(right[index]);
    if (diff !== 0) return diff;
  }
  return 0;
}
function bumpPatch(version2) {
  const match = SEMVER_PATTERN.exec(version2);
  if (!match) return "1.0.1";
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}
function nextPackVersion(options) {
  const packVer = options.packVersion && SEMVER_PATTERN.test(options.packVersion) ? options.packVersion : void 0;
  const metaVer = options.metaVersion && SEMVER_PATTERN.test(options.metaVersion) ? options.metaVersion : void 0;
  const existingVer = options.existingVersion && SEMVER_PATTERN.test(options.existingVersion) ? options.existingVersion : void 0;
  const localVer = packVer ?? metaVer;
  if (!existingVer) return localVer ?? "1.0.0";
  if (localVer && compareSemver(localVer, existingVer) > 0) return localVer;
  return bumpPatch(existingVer);
}
function scanPublishFiles(files) {
  const findings = [];
  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      for (const rule of SAFETY_RULES) {
        if (rule.pattern.test(line)) {
          findings.push({ file: file.name, line: index + 1, type: rule.type });
          break;
        }
      }
    }
  }
  return findings;
}
async function validateToolpackSource(source, sourcePath) {
  if (!source.trim()) throw new Error("The pack.ts file is empty.");
  const esbuild = await import("esbuild");
  const transformed = await esbuild.transform(source, { loader: "ts", format: "cjs", target: "node20" });
  const absolutePath = path10.resolve(sourcePath);
  const mod = { exports: {} };
  const localRequire = createRequire(absolutePath);
  const wrapper = `(function (exports, require, module, __filename, __dirname) {
${transformed.code}
})`;
  const runner = vm.runInThisContext(wrapper, { filename: absolutePath, timeout: 1e4 });
  runner(mod.exports, localRequire, mod, absolutePath, path10.dirname(absolutePath));
  const exported = mod.exports;
  const candidate = exported && typeof exported === "object" && "default" in exported ? exported.default : void 0;
  if (!candidate || typeof candidate !== "object") {
    throw new Error("The script must `export default` a toolpack object.");
  }
  if (typeof candidate.name !== "string" || !TOOLPACK_NAME2.test(candidate.name)) {
    throw new Error('Toolpack "name" must be lowercase letters, digits or _ and start with a letter.');
  }
  if (typeof candidate.description !== "string" || !candidate.description.trim()) {
    throw new Error('Toolpack "description" is required.');
  }
  if (!Array.isArray(candidate.tools) || !candidate.tools.length) {
    throw new Error('Toolpack "tools" must be a non-empty array.');
  }
  const seen = /* @__PURE__ */ new Set();
  const tools = [];
  for (const tool of candidate.tools) {
    if (!isRecord3(tool) || typeof tool.name !== "string" || !TOOLPACK_NAME2.test(tool.name)) {
      throw new Error('Every tool needs a lowercase "name".');
    }
    if (seen.has(tool.name)) throw new Error(`Duplicate tool name "${tool.name}".`);
    seen.add(tool.name);
    if (typeof tool.description !== "string" || !tool.description.trim()) {
      throw new Error(`Tool "${tool.name}" needs a description.`);
    }
    if (typeof tool.run !== "function") {
      throw new Error(`Tool "${tool.name}" needs a run function.`);
    }
    tools.push({ name: tool.name, description: tool.description });
  }
  if (candidate.sync !== void 0) {
    const sync = candidate.sync;
    const validList = (value, max, check) => Array.isArray(value) && value.length <= max && value.every((item) => typeof item === "string" && check(item));
    if (!isRecord3(sync) || !validList(sync.files, 8, (item) => TOOLPACK_SYNC_FILE.test(item))) {
      throw new Error('Toolpack "sync.files" must list up to 8 .json file names in dataDir.');
    }
    if (sync.secrets !== void 0 && !validList(sync.secrets, 64, (item) => item.length > 0 && item.length <= 64)) {
      throw new Error('Toolpack "sync.secrets" must list up to 64 key names.');
    }
  }
  const version2 = typeof candidate.version === "string" && candidate.version.trim() ? candidate.version.trim() : void 0;
  return {
    name: candidate.name,
    description: candidate.description.trim(),
    ...version2 ? { version: version2 } : {},
    tools
  };
}
function generateReadme(displayName, pack) {
  const toolLines = pack.tools.map((tool) => `- \`${pack.name}_${tool.name}\` \u2014 ${tool.description}`);
  return `# ${displayName}

${pack.description}

## Tools

${toolLines.join("\n")}
`;
}
async function readPackMeta(folderPath) {
  try {
    const parsed = JSON.parse(await fsp3.readFile(path10.join(folderPath, "meta.json"), "utf8"));
    if (!isRecord3(parsed)) return {};
    return {
      name: typeof parsed.name === "string" ? parsed.name : void 0,
      description: typeof parsed.description === "string" ? parsed.description : void 0,
      hubId: typeof parsed.hubId === "string" ? parsed.hubId : void 0,
      version: typeof parsed.version === "string" ? parsed.version : void 0,
      category: typeof parsed.category === "string" ? parsed.category : void 0,
      icon: typeof parsed.icon === "string" ? parsed.icon : void 0,
      license: typeof parsed.license === "string" ? parsed.license : void 0
    };
  } catch {
    return {};
  }
}
async function listInstalledToolpacks(toolpacksDir) {
  if (!toolpacksDir) return [];
  let entries;
  try {
    entries = await fsp3.readdir(toolpacksDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const folderPath = path10.join(toolpacksDir, entry.name);
    try {
      await fsp3.access(path10.join(folderPath, "pack.ts"));
    } catch {
      continue;
    }
    const meta = await readPackMeta(folderPath);
    candidates.push({ folderName: entry.name, folderPath, meta });
  }
  candidates.sort((left, right) => left.folderName.localeCompare(right.folderName));
  return candidates;
}
function hubIdFor(validatedName, metaHubId) {
  if (metaHubId && HUB_ID_PATTERN.test(metaHubId)) return metaHubId;
  const converted = validatedName.toLowerCase().replace(/_/g, "-");
  if (!HUB_ID_PATTERN.test(converted)) {
    throw new Error(`Cannot derive a Hub pack id from "${validatedName}".`);
  }
  return converted;
}
async function errorMessageFromResponse(response, action) {
  let detail = "";
  try {
    const raw = await response.text();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        detail = typeof parsed.message === "string" ? parsed.message : raw.slice(0, 200);
      } catch {
        detail = raw.slice(0, 200);
      }
    }
  } catch {
  }
  return detail ? `Could not ${action} (HTTP ${response.status}): ${detail}` : `Could not ${action} (HTTP ${response.status}).`;
}
async function githubRequest(fetchFn, url, token, action, options = {}) {
  const headers = {
    accept: options.accept ?? "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "unify-engine",
    "x-github-api-version": "2022-11-28"
  };
  let body;
  if (options.body !== void 0) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetchFn(url, {
      method: options.method ?? "GET",
      headers,
      ...body !== void 0 ? { body } : {},
      signal: AbortSignal.timeout(REQUEST_TIMEOUT)
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not ${action}: ${reason}`);
  }
  if (!response.ok) {
    throw new Error(await errorMessageFromResponse(response, action));
  }
  return response;
}
async function githubJson(fetchFn, url, token, action, options = {}) {
  const response = await githubRequest(fetchFn, url, token, action, options);
  return response.json();
}
async function fetchApprovedPublishers(fetchFn, url) {
  const response = await fetchFn(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    headers: { accept: "application/json, text/plain, */*", "user-agent": "unify-engine" }
  });
  if (!response.ok) throw new Error(`The Hub registry answered ${response.status}.`);
  const parsed = JSON.parse(await response.text());
  return Array.isArray(parsed.publishers) ? parsed.publishers.filter((login) => typeof login === "string") : [];
}
function buildUpdatedIndex(currentIndex, entry) {
  const existingPacks = Array.isArray(currentIndex.packs) ? currentIndex.packs.filter(isRecord3) : [];
  const nextPacks = existingPacks.slice();
  const existingPos = nextPacks.findIndex((pack) => pack.id === entry.id);
  if (existingPos >= 0) nextPacks[existingPos] = entry;
  else nextPacks.push(entry);
  const authorCount = new Set(
    nextPacks.map((pack) => typeof pack.author === "string" ? pack.author : "").filter(Boolean)
  ).size;
  return {
    ...currentIndex,
    packs: nextPacks,
    authors: authorCount
  };
}
async function publishHubPack(auth, options) {
  if (!auth) return { ok: false, message: PUBLISH_SIGNED_OUT };
  const fetchFn = options.fetch ?? globalThis.fetch;
  const repository = options.repository ?? HUB_REPOSITORY;
  const branch = options.branch ?? HUB_BRANCH;
  const publishersUrl = options.publishersUrl ?? HUB_PUBLISHERS_URL;
  const apiBase = `https://api.github.com/repos/${repository}`;
  let publishers;
  try {
    publishers = await fetchApprovedPublishers(fetchFn, publishersUrl);
  } catch (error) {
    return {
      ok: false,
      message: `Could not read the approved accounts: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  const accessError = publishAccessError(auth, publishers);
  if (accessError) return accessError;
  const candidates = await listInstalledToolpacks(options.toolpacksDir);
  if (!candidates.length) {
    return { ok: false, message: "No installed toolpacks found to publish." };
  }
  if (!options.pickOption) {
    return { ok: false, message: "No picker is available to choose a toolpack." };
  }
  const pickItems = candidates.map((candidate2) => ({
    id: candidate2.folderName,
    label: candidate2.meta.hubId ?? candidate2.folderName,
    ...candidate2.meta.version ? { description: `v${candidate2.meta.version}` } : {},
    ...candidate2.meta.description ? { detail: candidate2.meta.description } : {}
  }));
  const chosenFolder = await options.pickOption(pickItems, "Choose an installed toolpack to publish to the Hub");
  if (!chosenFolder) return { ok: false, message: "Publishing cancelled." };
  const candidate = candidates.find((item) => item.folderName === chosenFolder);
  if (!candidate) return { ok: false, message: `Unknown toolpack "${chosenFolder}".` };
  const packTsPath = path10.join(candidate.folderPath, "pack.ts");
  let packSource;
  try {
    packSource = await fsp3.readFile(packTsPath, "utf8");
  } catch (error) {
    return {
      ok: false,
      message: `Could not read pack.ts: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  let validated;
  try {
    validated = await validateToolpackSource(packSource, packTsPath);
  } catch (error) {
    return {
      ok: false,
      message: `Pack validation failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  let hubId;
  try {
    hubId = hubIdFor(validated.name, candidate.meta.hubId);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const displayName = candidate.meta.name?.trim() || titleFromId2(hubId);
  let readmeContent;
  try {
    const existingReadme = await fsp3.readFile(path10.join(candidate.folderPath, "README.md"), "utf8");
    if (existingReadme.trim()) readmeContent = existingReadme;
  } catch {
  }
  if (!readmeContent) readmeContent = generateReadme(displayName, validated);
  const packFiles = [
    { name: "pack.ts", repoPath: `packs/${hubId}/pack.ts`, content: packSource },
    { name: "README.md", repoPath: `packs/${hubId}/README.md`, content: readmeContent }
  ];
  for (const scriptName of SCRIPT_NAMES) {
    try {
      const scriptContent = await fsp3.readFile(path10.join(candidate.folderPath, scriptName), "utf8");
      packFiles.push({
        name: scriptName,
        repoPath: `packs/${hubId}/${scriptName}`,
        content: scriptContent
      });
    } catch {
    }
  }
  const findings = scanPublishFiles(packFiles.map((file) => ({ name: file.name, content: file.content })));
  if (findings.length) {
    const summary = findings.slice(0, 3).map((finding) => `${finding.file}:${finding.line} (${finding.type})`).join(", ");
    const extra = findings.length > 3 ? ` (+${findings.length - 3} more)` : "";
    return { ok: false, message: `Safety scan blocked publishing: ${summary}${extra}.` };
  }
  let currentIndex;
  try {
    const indexResponse = await githubRequest(
      fetchFn,
      `${apiBase}/contents/index.json?ref=${encodeURIComponent(branch)}`,
      auth.token,
      "read index.json from the Hub",
      { accept: "application/vnd.github.raw+json" }
    );
    const parsedIndex = JSON.parse(await indexResponse.text());
    if (!isRecord3(parsedIndex)) throw new Error("index.json is not a JSON object.");
    currentIndex = parsedIndex;
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const existingEntries = Array.isArray(currentIndex.packs) ? currentIndex.packs.filter(isRecord3) : [];
  const existing = existingEntries.find((pack) => pack.id === hubId);
  const version2 = nextPackVersion({
    metaVersion: candidate.meta.version,
    packVersion: validated.version,
    existingVersion: typeof existing?.version === "string" ? existing.version : void 0
  });
  const now = Date.now();
  const icon = candidate.meta.icon ?? (typeof existing?.icon === "string" ? existing.icon : void 0);
  const updatedEntry = {
    id: hubId,
    name: typeof existing?.name === "string" && existing.name.trim() ? existing.name : displayName,
    author: auth.login,
    category: typeof existing?.category === "string" && existing.category ? existing.category : candidate.meta.category ?? "dev",
    description: validated.description,
    ...icon ? { icon } : {},
    installs: typeof existing?.installs === "number" && Number.isFinite(existing.installs) ? existing.installs : 0,
    tools: validated.tools.map((tool) => `${validated.name}_${tool.name}`),
    version: version2,
    updatedAt: now,
    publishedAt: typeof existing?.publishedAt === "number" && Number.isFinite(existing.publishedAt) ? existing.publishedAt : now,
    license: candidate.meta.license ?? (typeof existing?.license === "string" && existing.license ? existing.license : "MIT")
  };
  const updatedIndex = buildUpdatedIndex(currentIndex, updatedEntry);
  const commitFiles = [
    ...packFiles,
    {
      name: "index.json",
      repoPath: "index.json",
      content: `${JSON.stringify(updatedIndex, null, 2)}
`
    }
  ];
  if (!options.confirm) {
    return { ok: false, message: "No confirmation dialog is available to publish." };
  }
  const publishBranch = `publish/${hubId}-${version2}`;
  const confirmMessage = `Publish "${hubId}" v${version2} to the Toolpack Hub?`;
  const confirmDetail = [
    `Pack: ${hubId}`,
    `Version: ${version2}`,
    `Branch: ${publishBranch}`,
    "Files:",
    ...commitFiles.map((file) => `  - ${file.repoPath}`)
  ].join("\n");
  const confirmed = await options.confirm(confirmMessage, confirmDetail);
  if (!confirmed) return { ok: false, message: "Publishing cancelled." };
  try {
    const baseRef = await githubJson(
      fetchFn,
      `${apiBase}/git/ref/heads/${encodeURIComponent(branch)}`,
      auth.token,
      `read ${branch} branch ref`
    );
    const baseCommitSha = baseRef.object?.sha;
    if (!baseCommitSha) throw new Error(`GitHub returned no commit SHA for branch "${branch}".`);
    const baseCommit = await githubJson(
      fetchFn,
      `${apiBase}/git/commits/${baseCommitSha}`,
      auth.token,
      "read base commit"
    );
    const baseTreeSha = baseCommit.tree?.sha;
    if (!baseTreeSha) throw new Error("GitHub returned no tree SHA for the base commit.");
    const treeEntries = [];
    for (const file of commitFiles) {
      const blob = await githubJson(
        fetchFn,
        `${apiBase}/git/blobs`,
        auth.token,
        `create blob for ${file.repoPath}`,
        { method: "POST", body: { content: file.content, encoding: "utf-8" } }
      );
      if (!blob.sha) throw new Error(`GitHub returned no blob SHA for ${file.repoPath}.`);
      treeEntries.push({ path: file.repoPath, mode: "100644", type: "blob", sha: blob.sha });
    }
    const newTree = await githubJson(
      fetchFn,
      `${apiBase}/git/trees`,
      auth.token,
      "create git tree",
      { method: "POST", body: { base_tree: baseTreeSha, tree: treeEntries } }
    );
    if (!newTree.sha) throw new Error("GitHub returned no tree SHA.");
    const commitMessage = `Publish ${hubId} ${version2}`;
    const newCommit = await githubJson(
      fetchFn,
      `${apiBase}/git/commits`,
      auth.token,
      "create commit",
      {
        method: "POST",
        body: { message: commitMessage, tree: newTree.sha, parents: [baseCommitSha] }
      }
    );
    if (!newCommit.sha) throw new Error("GitHub returned no commit SHA.");
    await githubJson(
      fetchFn,
      `${apiBase}/git/refs`,
      auth.token,
      `create branch ${publishBranch}`,
      { method: "POST", body: { ref: `refs/heads/${publishBranch}`, sha: newCommit.sha } }
    );
    const prBody = [
      `Publishes toolpack \`${hubId}\` \`v${version2}\` (${updatedEntry.tools.length} tools).`,
      "",
      "Files:",
      ...commitFiles.map((file) => `- \`${file.repoPath}\``)
    ].join("\n");
    const pullRequest = await githubJson(
      fetchFn,
      `${apiBase}/pulls`,
      auth.token,
      "open pull request",
      {
        method: "POST",
        body: {
          title: commitMessage,
          head: publishBranch,
          base: branch,
          body: prBody
        }
      }
    );
    if (!pullRequest.html_url) throw new Error("GitHub returned no pull request URL.");
    return {
      ok: true,
      message: "Opened a pull request to the Hub.",
      url: pullRequest.html_url
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

// src/engine/hub/githubRegistry.ts
var HUB_INDEX_URL = `https://raw.githubusercontent.com/${HUB_REPOSITORY}/${HUB_BRANCH}/index.json`;
var HUB_API = `https://api.github.com/repos/${HUB_REPOSITORY}`;
var REQUEST_TIMEOUT2 = 15e3;
function isRecord4(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
function count(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function setupFileNames(setupText) {
  let parsed;
  try {
    parsed = JSON.parse(setupText);
  } catch {
    return [];
  }
  if (!isRecord4(parsed) || !Array.isArray(parsed.files)) return [];
  const reserved = /* @__PURE__ */ new Set(["pack.ts", "pack.js", "meta.json", "setup.json", ...PACK_SCRIPT_NAMES]);
  return parsed.files.filter((name) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) && !reserved.has(name.toLowerCase()));
}
function validPack(value) {
  if (!isRecord4(value)) return false;
  if (typeof value.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id)) return false;
  if (typeof value.name !== "string" || !value.name.trim()) return false;
  if (typeof value.description !== "string") return false;
  return Array.isArray(value.tools) && value.tools.every((tool) => typeof tool === "string");
}
function validCategory(value) {
  return isRecord4(value) && typeof value.id === "string" && typeof value.label === "string";
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
var GithubHubRegistry = class {
  id = "github";
  fetchFn;
  constructor(fetchFn) {
    this.fetchFn = fetchFn;
  }
  async fetchText(url) {
    const fetchImpl = this.fetchFn ?? globalThis.fetch;
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT2),
      headers: { accept: "application/json, text/plain, */*", "user-agent": "unify-engine" }
    });
    if (!response.ok) throw new Error(`The Hub registry answered ${response.status}.`);
    return response.text();
  }
  async state() {
    try {
      const index = JSON.parse(await this.fetchText(HUB_INDEX_URL));
      const packs = Array.isArray(index.packs) ? index.packs.filter(validPack).map(normalisePack) : [];
      const categories = Array.isArray(index.categories) ? index.categories.filter(validCategory) : [];
      return {
        packs,
        categories,
        featured: Array.isArray(index.featured) ? index.featured.filter((id) => typeof id === "string" && packs.some((pack) => pack.id === id)) : [],
        authors: count(index.authors, new Set(packs.map((pack) => pack.author)).size),
        fetchedAt: Date.now()
      };
    } catch (error) {
      return {
        packs: [],
        categories: [],
        featured: [],
        authors: 0,
        fetchedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  async detail(id) {
    const pack = (await this.state()).packs.find((candidate) => candidate.id === id);
    if (!pack) return void 0;
    let readme;
    try {
      readme = await this.fetchText(
        `https://raw.githubusercontent.com/${HUB_REPOSITORY}/${HUB_BRANCH}/packs/${encodeURIComponent(id)}/README.md`
      );
    } catch {
    }
    return { pack, ...readme ? { readme } : {} };
  }
  /**
   * The Hub branch's current commit id, or the branch name when GitHub can't be asked. raw.githubusercontent.com
   * caches branch URLs for about 5 minutes, so a pack installed right after a push would get stale files; a commit
   * URL is never stale, and every file of one install comes from the same commit.
   */
  async latestCommit() {
    try {
      const fetchImpl = this.fetchFn ?? globalThis.fetch;
      const response = await fetchImpl(`${HUB_API}/commits/${HUB_BRANCH}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT2),
        headers: { accept: "application/vnd.github.sha", "user-agent": "unify-engine" }
      });
      const sha = response.ok ? (await response.text()).trim() : "";
      return /^[0-9a-f]{40}$/.test(sha) ? sha : HUB_BRANCH;
    } catch {
      return HUB_BRANCH;
    }
  }
  async download(id, destination) {
    await fsp4.mkdir(destination, { recursive: true });
    const ref = await this.latestCommit();
    const base = `https://raw.githubusercontent.com/${HUB_REPOSITORY}/${ref}/packs/${encodeURIComponent(id)}`;
    const source = await this.fetchText(`${base}/pack.ts`);
    await fsp4.writeFile(path11.join(destination, "pack.ts"), source, "utf8");
    for (const script of PACK_SCRIPT_NAMES) {
      try {
        const content = await this.fetchText(`${base}/${script}`);
        await fsp4.writeFile(path11.join(destination, script), content, "utf8");
      } catch {
      }
    }
    let setupText;
    try {
      setupText = await this.fetchText(`${base}/setup.json`);
    } catch {
    }
    if (setupText === void 0) return;
    await fsp4.writeFile(path11.join(destination, "setup.json"), setupText, "utf8");
    for (const name of setupFileNames(setupText)) {
      const content = await this.fetchText(`${base}/${encodeURIComponent(name)}`);
      await fsp4.writeFile(path11.join(destination, name), content, "utf8");
    }
  }
  /** Checks approval, picks and validates an installed pack, and opens a pull request to the Hub. */
  async publish(auth, options) {
    return publishHubPack(auth, {
      toolpacksDir: options?.toolpacksDir ?? "",
      pickOption: options?.pickOption,
      confirm: options?.confirm,
      fetch: options?.fetch ?? this.fetchFn
    });
  }
  /** Release metadata for one pack, for a future "what's new" view. Never used for publishing. */
  async releases(id) {
    const fetchImpl = this.fetchFn ?? globalThis.fetch;
    const response = await fetchImpl(`${HUB_API}/releases?per_page=20`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT2),
      headers: { accept: "application/vnd.github+json", "user-agent": "unify-engine" }
    });
    if (!response.ok) throw new Error(`The Hub releases API answered ${response.status}.`);
    const releases = await response.json();
    if (!Array.isArray(releases)) return [];
    return releases.filter((release) => isRecord4(release) && text(release.tag_name).startsWith(`${id}@`));
  }
};

// src/engine/hub/install.ts
import { existsSync as existsSync6, promises as fsp5 } from "node:fs";
import { createHash as createHash3, randomUUID as randomUUID2 } from "node:crypto";
import * as path12 from "node:path";
var MAX_SCRIPT_TEXT_BYTES = 64 * 1024;
function scriptTextForUi(text2) {
  const totalBytes = Buffer.byteLength(text2, "utf8");
  if (totalBytes <= MAX_SCRIPT_TEXT_BYTES) return text2;
  const note = `
(truncated, ${totalBytes} bytes total)`;
  const budget = MAX_SCRIPT_TEXT_BYTES - Buffer.byteLength(note, "utf8");
  let truncated = Buffer.from(text2, "utf8").subarray(0, budget).toString("utf8");
  while (Buffer.byteLength(truncated, "utf8") > budget) truncated = truncated.slice(0, -1);
  return `${truncated}${note}`;
}
function packScriptHash(scriptName, scriptText, uninstallScriptName, uninstallScriptText) {
  return createHash3("sha256").update([scriptName ?? "", scriptText ?? "", uninstallScriptName ?? "", uninstallScriptText ?? ""].join("\0")).digest("hex");
}
function installScriptFor(files) {
  return INSTALL_SCRIPT_NAMES.find((name) => files.includes(name));
}
function uninstallScriptFor(files) {
  return UNINSTALL_SCRIPT_NAMES.find((name) => files.includes(name));
}
async function readExistingMeta(destination) {
  try {
    const parsed = JSON.parse(await fsp5.readFile(path12.join(destination, "meta.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function assertInsideToolpacksDir(toolpacksDir, destination) {
  const relative5 = path12.relative(path12.resolve(toolpacksDir), path12.resolve(destination));
  if (!relative5 || relative5 === ".." || relative5.startsWith(`..${path12.sep}`) || path12.isAbsolute(relative5)) {
    throw new Error(`Refusing to install "${destination}" outside the toolpacks folder.`);
  }
}
function assertSameHubPack(existing, packId, hubId) {
  if (existing.hubId && existing.hubId !== hubId) {
    throw new Error(
      `The toolpack folder "${packId}" belongs to Hub pack "${existing.hubId}", not "${hubId}".`
    );
  }
}
async function compilePack(source) {
  const esbuild = await import("esbuild");
  const result = await esbuild.transform(source, { loader: "ts", format: "cjs", target: "node20" });
  return result.code;
}
async function installHubPack(options) {
  const { registry, id, toolpacksDir, reply } = options;
  if (!id.trim()) throw new Error("Cannot install a pack with an empty id.");
  const send = (progress) => {
    reply({ type: "hubInstallProgress", ...progress });
  };
  const packId = (() => {
    try {
      return toolpackIdFor(id);
    } catch {
      const fallback = id.replace(/[^a-z0-9_]/g, "_");
      if (!fallback) throw new Error("Cannot install a pack with an empty id.");
      return fallback;
    }
  })();
  const destination = path12.join(toolpacksDir, packId);
  assertInsideToolpacksDir(toolpacksDir, destination);
  const staging = path12.join(toolpacksDir, `.staging-${packId}-${randomUUID2()}`);
  let existing = {};
  try {
    const hub = await registry.state();
    const pack = hub.packs.find((candidate) => candidate.id === id);
    if (!pack) throw new Error(`The Hub has no pack "${id}".`);
    existing = await readExistingMeta(destination);
    assertSameHubPack(existing, packId, pack.id);
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
    const scriptName = installScriptFor(files);
    const uninstallScriptName = uninstallScriptFor(files);
    const scriptText = scriptName ? await fsp5.readFile(path12.join(staging, scriptName), "utf8") : void 0;
    const uninstallScriptText = uninstallScriptName ? await fsp5.readFile(path12.join(staging, uninstallScriptName), "utf8") : void 0;
    const scriptHash = scriptName || uninstallScriptName ? packScriptHash(scriptName, scriptText, uninstallScriptName, uninstallScriptText) : void 0;
    const alreadyConsented = scriptHash !== void 0 && scriptHash === options.consentedScriptHash;
    const allowScript = alreadyConsented || options.allowScript === true && !options.unattended;
    if (scriptHash !== void 0 && !allowScript) {
      return {
        ok: false,
        id,
        needsScriptConsent: true,
        ...scriptName ? { scriptName } : {},
        ...scriptText !== void 0 ? { scriptText: scriptTextForUi(scriptText) } : {},
        ...uninstallScriptName ? { uninstallScriptName } : {},
        ...uninstallScriptText !== void 0 ? { uninstallScriptText: scriptTextForUi(uninstallScriptText) } : {}
      };
    }
    const packages = files.includes("setup.json") ? await pendingPackages(staging, pack.name, void 0, { includeOptional: true }) : [];
    const requiredPending = packages.some((item) => !item.optional);
    const askForPackages = options.unattended ? requiredPending : options.packages === void 0;
    if (packages.length && askForPackages) {
      return {
        ok: false,
        id,
        needsDependencyConsent: true,
        packages: packages.map((item) => ({
          stepId: item.stepId,
          title: item.title,
          command: item.command.display,
          ...item.optional ? { optional: true } : {},
          ...item.neededBy ? { neededBy: item.neededBy } : {}
        }))
      };
    }
    const sourceFile = path12.join(staging, "pack.ts");
    const compiledFile = path12.join(staging, "pack.js");
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
    await fsp5.mkdir(path12.dirname(destination), { recursive: true });
    const dataDir = path12.join(destination, "data");
    const keptData = path12.join(toolpacksDir, `.data-${packId}-${randomUUID2()}`);
    const keep = existsSync6(dataDir) && !files.includes("data");
    if (keep) await fsp5.rename(dataDir, keptData);
    try {
      await fsp5.rm(destination, { recursive: true, force: true });
      await fsp5.cp(staging, destination, { recursive: true, force: true });
    } finally {
      if (keep) {
        await fsp5.mkdir(destination, { recursive: true });
        await fsp5.rename(keptData, dataDir);
      }
    }
    const meta = {
      description: pack.description,
      enabled: existing.enabled !== false,
      hubId: pack.id,
      version: pack.version
    };
    await fsp5.writeFile(path12.join(destination, "meta.json"), `${JSON.stringify(meta, null, 2)}
`, "utf8");
    if (packages.length) {
      send({ id, percent: 70, state: "installing" });
      await installSetupPackages(destination, pack.name, void 0, options.unattended ? [] : options.packages ?? []);
    }
    if (scriptName) {
      send({ id, percent: 85, state: "installing" });
      const result = await runPackInstallScript(destination, scriptName, { unifyHome: options.unifyHome });
      if (!result.ok && !files.includes("setup.json")) throw new Error(result.error ?? "The install script failed.");
    }
    const installed = {
      id: pack.id,
      name: pack.name,
      description: pack.description,
      ...pack.icon ? { icon: pack.icon } : {},
      version: pack.version,
      source: "hub",
      tools: [...pack.tools],
      installedAt: Date.now(),
      updatedAt: pack.updatedAt,
      ...scriptHash ? { scriptHash } : {}
    };
    options.onInstalled?.(installed);
    const setup = await readPackSetup(destination, packId, pack.name);
    send({ id, percent: 100, state: "done" });
    return { ok: true, id, pack: installed, setup };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send({ id, percent: 100, state: "error", error: message });
    return { ok: false, id, error: message };
  } finally {
    await fsp5.rm(staging, { recursive: true, force: true }).catch(() => void 0);
  }
}

// src/engine/hub/updates.ts
import { existsSync as existsSync7 } from "node:fs";
import * as path13 from "node:path";
function folderFor(toolpacksDir, hubId) {
  try {
    return path13.join(toolpacksDir, toolpackIdFor(hubId));
  } catch {
    return void 0;
  }
}
function findHubUpdates(hubPacks, installed, toolpacksDir) {
  const updates = [];
  for (const hubPack of hubPacks) {
    const record = installed[hubPack.id];
    if (!record) continue;
    const folder = folderFor(toolpacksDir, hubPack.id);
    if (!folder || !existsSync7(folder)) continue;
    const installedUpdatedAt = record.updatedAt ?? record.installedAt;
    const newer = hubPack.updatedAt > installedUpdatedAt;
    if (!newer && hubPack.version === record.version) continue;
    const installedTools = new Set(record.tools ?? []);
    const hubTools = new Set(hubPack.tools ?? []);
    updates.push({
      id: hubPack.id,
      name: hubPack.name,
      ...hubPack.icon ? { icon: hubPack.icon } : {},
      fromVersion: record.version,
      toVersion: hubPack.version,
      installedUpdatedAt,
      updatedAt: hubPack.updatedAt,
      addedTools: [...hubTools].filter((tool) => !installedTools.has(tool)),
      removedTools: [...installedTools].filter((tool) => !hubTools.has(tool))
    });
  }
  return updates.sort((first, second) => first.name.localeCompare(second.name));
}

// src/engine/hub/index.ts
function createHubRegistry() {
  return new GithubHubRegistry();
}

// src/engine/unify/requests/hub.ts
async function handleHubRequest(message, reply, paths, context, registry = createHubRegistry()) {
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
    if (!id) {
      send({ type: "hubInstallProgress", id, percent: 100, state: "error", error: "Choose a pack first." });
      send({ type: "hubInstallResult", ok: false, id, error: "Choose a pack first." });
      return true;
    }
    const result = await installAndLoad(registry, paths, context, send, {
      id,
      allowScript: message.allowScript === true,
      ...Array.isArray(message.packages) ? { packages: message.packages.filter((item) => typeof item === "string") } : {}
    });
    send({ type: "hubInstallResult", ...result });
    if (result.ok) reply(await checkToolpackUpdates(registry, paths, context, reply, { autoUpdate: false }));
    return true;
  }
  if (message.type === "hubCheckUpdates") {
    send(await checkToolpackUpdates(registry, paths, context, reply, { autoUpdate: message.auto === true }));
    return true;
  }
  if (message.type === "hubPublish") {
    let auth;
    try {
      auth = context.getGithubAuth ? await context.getGithubAuth() : void 0;
    } catch {
      auth = void 0;
    }
    const result = await registry.publish(auth, {
      toolpacksDir: paths.toolpacksDir,
      pickOption: context.pickOption,
      confirm: context.confirm
    });
    send({ type: "hubPublishResult", ...result });
    return true;
  }
  return false;
}
async function installAndLoad(registry, paths, context, send, request) {
  const installed = await installHubPack({
    registry,
    ...request,
    toolpacksDir: paths.toolpacksDir,
    unifyHome: paths.unifyHome,
    consentedScriptHash: installedHubPacks(paths)[request.id]?.scriptHash,
    reply: send,
    onInstalled: (pack) => recordHubInstall(paths, pack)
  });
  if (!installed.ok) return installed;
  const toolpackId = toolpackIdFor(installed.id);
  let result = installed;
  try {
    await context.installToolpack?.(path14.join(paths.toolpacksDir, toolpackId, "pack.ts"));
    clearInstallError(paths.toolpacksDir, toolpackId);
  } catch (error) {
    const text2 = error instanceof Error ? error.message : String(error);
    setInstallError(paths.toolpacksDir, toolpackId, text2);
    result = { ...installed, ok: false, error: text2 };
  }
  context.refreshToolpacks?.();
  return result;
}
var checkRunning;
function checkToolpackUpdates(registry, paths, context, reply, options) {
  if (checkRunning) return checkRunning;
  checkRunning = (async () => {
    try {
      const hub = await registry.state();
      if (hub.error && !hub.packs.length) throw new Error(hub.error);
      const found = findHubUpdates(hub.packs, installedHubPacks(paths), paths.toolpacksDir);
      if (!options.autoUpdate || !getUnifyFeature("toolpacks.autoUpdate")) {
        return { type: "toolpackUpdates", updates: found, checkedAt: Date.now() };
      }
      const updates = [];
      const autoUpdated = [];
      for (const update of found) {
        const result = await installAndLoad(registry, paths, context, reply, { id: update.id, unattended: true });
        if (result.ok) {
          autoUpdated.push({ id: update.id, name: update.name, version: update.toVersion });
        } else if (result.needsScriptConsent) {
          updates.push({ ...update, needsConsent: true, consentReason: "script" });
        } else if (result.needsDependencyConsent) {
          updates.push({ ...update, needsConsent: true, consentReason: "programs" });
        } else {
          updates.push(update);
        }
      }
      return {
        type: "toolpackUpdates",
        updates,
        ...autoUpdated.length ? { autoUpdated } : {},
        checkedAt: Date.now()
      };
    } catch (error) {
      return {
        type: "toolpackUpdates",
        updates: [],
        checkedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  })();
  const running = checkRunning;
  void running.finally(() => {
    if (checkRunning === running) checkRunning = void 0;
  });
  return running;
}

// src/engine/unify/requests/index.ts
var announcedWorkspace;
function announceWorkspace(context, reply, force = false) {
  if (!context.workspaceRoot) return;
  if (announcedWorkspace === context.workspaceRoot && !force) return;
  announcedWorkspace = context.workspaceRoot;
  reply({ type: "workspaceState", root: path15.resolve(context.workspaceRoot), name: path15.basename(context.workspaceRoot) });
}
function stringField(message, key) {
  const value = message[key];
  return typeof value === "string" ? value : "";
}
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
function packDirectory(paths, id) {
  if (!id.trim() || id !== path15.basename(id) || id === "." || id === "..") throw new Error("Unknown toolpack.");
  return path15.join(paths.toolpacksDir, id);
}
async function packDisplayName(paths, packId) {
  const installed = installedHubPacks(paths);
  if (installed[packId]?.name) return installed[packId].name;
  try {
    const meta = JSON.parse(await fsp6.readFile(path15.join(paths.toolpacksDir, packId, "meta.json"), "utf8"));
    if (typeof meta.hubId === "string" && installed[meta.hubId]?.name) return installed[meta.hubId].name;
  } catch {
  }
  return titleFromId(packId);
}
var knowledgeTypes = /* @__PURE__ */ new Set([
  "knowledgeList",
  "readKnowledge",
  "saveKnowledge",
  "removeKnowledge",
  "setKnowledgeAudience",
  "importSkillFolder",
  "undoKnowledgeChange",
  "openKnowledge"
]);
function projectContext(message, context) {
  const project = typeof message.project === "string" ? message.project.trim() : "";
  if (!project || !path15.isAbsolute(project)) return context;
  try {
    if (!fs8.statSync(project).isDirectory()) return context;
  } catch {
    return context;
  }
  return { ...context, workspaceRoot: project };
}
function isFilesType(type) {
  return type === "listDir" || type === "readFile" || type === "writeFile" || type === "findFiles" || type === "createEntry" || type === "renameEntry" || type === "deleteEntry" || type === "copyEntry" || type === "importEntries";
}
async function handleFilesRequest(message, type, send, reply, context) {
  setActiveUnifyReply(reply);
  watchWorkspace([context.workspaceRoot, ...context.workspaceRoots ?? []], reply);
  announceWorkspace(context, reply, type === "listDir" && !stringField(message, "path"));
  try {
    if (type === "listDir") {
      const relative5 = stringField(message, "path");
      send({ type: "dirListing", path: relative5, entries: listWorkspaceDirectory(context.workspaceRoot, relative5) });
      return true;
    }
    if (type === "readFile") {
      const relative5 = stringField(message, "path");
      send({ type: "fileContent", file: readWorkspaceFile(context.workspaceRoot, relative5) });
      return true;
    }
    if (type === "writeFile") {
      const relative5 = stringField(message, "path");
      const content = stringField(message, "content");
      const version2 = stringField(message, "version");
      const result = writeWorkspaceFile(context.workspaceRoot, relative5, content, version2);
      if (result.ok) send({ type: "fileSaved", path: relative5, version: result.version });
      else send({ type: "fileConflict", current: result.conflict });
      return true;
    }
    if (type === "createEntry") {
      const kind = message.kind === "dir" ? "dir" : "file";
      send({ type: "entryDone", path: createWorkspaceEntry(context.workspaceRoot, stringField(message, "path"), kind) });
      return true;
    }
    if (type === "renameEntry") {
      send({ type: "entryDone", path: renameWorkspaceEntry(context.workspaceRoot, stringField(message, "from"), stringField(message, "to")) });
      return true;
    }
    if (type === "copyEntry") {
      send({ type: "entryDone", path: copyWorkspaceEntry(context.workspaceRoot, stringField(message, "from"), stringField(message, "toFolder")) });
      return true;
    }
    if (type === "importEntries") {
      const sources = Array.isArray(message.sources) ? message.sources.filter((item) => typeof item === "string") : [];
      const paths = importWorkspaceEntries(context.workspaceRoot, sources, stringField(message, "toFolder"));
      send({ type: "entryDone", path: paths[0] ?? "", paths });
      return true;
    }
    if (type === "deleteEntry") {
      const relative5 = stringField(message, "path");
      deleteWorkspaceEntry(context.workspaceRoot, relative5);
      send({ type: "entryDone", path: relative5 });
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
    return handleFilesRequest(message, type, send, reply, projectContext(message, context));
  }
  const outerContext = context;
  if (knowledgeTypes.has(type)) {
    const context2 = projectContext(message, outerContext);
    const paths2 = requestPaths(context2);
    const knowledgeState = async (items) => ({
      type: "knowledgeState",
      ...paths2.workspaceRoot ? { project: paths2.workspaceRoot } : {},
      items: items ?? await listKnowledge(context2, paths2)
    });
    if (type === "knowledgeList") {
      try {
        send(await knowledgeState());
      } catch (error) {
        send({ type: "knowledgeError", message: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (type === "readKnowledge") {
      try {
        const id = stringField(message, "id");
        const file = typeof message.file === "string" ? message.file : void 0;
        const result = await readKnowledge(context2, paths2, id, file);
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
        const saved = await saveKnowledge(context2, paths2, item, content, file);
        send({ type: "knowledgeSaved", item: saved });
        reply(await knowledgeState());
      } catch (error) {
        send({ type: "knowledgeError", message: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (type === "removeKnowledge") {
      try {
        const id = stringField(message, "id");
        await removeKnowledge(context2, paths2, id);
        send({ type: "knowledgeRemoved", id });
        reply(await knowledgeState());
      } catch (error) {
        send({ type: "knowledgeError", message: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (type === "setKnowledgeAudience") {
      try {
        const audiences = Array.isArray(message.audiences) ? message.audiences : [];
        setKnowledgeAudiences(paths2, stringField(message, "id"), audiences);
        send(await knowledgeState());
      } catch (error) {
        send({ type: "knowledgeError", message: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (type === "importSkillFolder") {
      try {
        const scope = message.scope === "project" ? "project" : "global";
        const files = Array.isArray(message.files) ? message.files : [];
        const item = await importSkillFolder(context2, paths2, scope, stringField(message, "name"), files);
        send({ type: "knowledgeSaved", item });
      } catch (error) {
        send({ type: "knowledgeError", message: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (type === "undoKnowledgeChange") {
      try {
        send(await knowledgeState(await undoKnowledgeChange(context2, paths2, stringField(message, "id"))));
      } catch (error) {
        send({ type: "knowledgeError", message: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (type === "openKnowledge") {
      try {
        await openKnowledge(paths2, stringField(message, "id"), typeof message.file === "string" ? message.file : void 0);
      } catch {
      }
      return true;
    }
    return false;
  }
  if (type === "reinstallToolpack") return handleToolpackInstallRequest(message, paths, context);
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
  if (type === "toolpackSetup") {
    const id = stringField(message, "id");
    try {
      const packDir = packDirectory(paths, id);
      const setup = await readPackSetup(packDir, id, await packDisplayName(paths, id));
      send({ type: "toolpackSetupState", setup });
    } catch (error) {
      send({ type: "toolpackSetupError", id, message: errorText(error) });
    }
    return true;
  }
  if (type === "toolpackSetupList") {
    try {
      let entries = [];
      try {
        entries = await fsp6.readdir(paths.toolpacksDir, { withFileTypes: true });
      } catch {
      }
      const packs = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        try {
          const setup = await readPackSetup(
            path15.join(paths.toolpacksDir, entry.name),
            entry.name,
            await packDisplayName(paths, entry.name)
          );
          if (setup && setup.pending > 0) packs.push(setup);
        } catch {
        }
      }
      send({ type: "toolpackSetupList", packs });
    } catch (error) {
      send({ type: "toolpackSetupError", id: "", message: errorText(error) });
    }
    return true;
  }
  if (type === "toolpackSetupAction") {
    const id = stringField(message, "id");
    const action = stringField(message, "action");
    try {
      const packDir = packDirectory(paths, id);
      if (action === "markDone" || action === "markTodo") {
        const stepId = stringField(message, "stepId");
        if (!stepId) throw new Error("Choose a setup step first.");
        await setPackSetupStepDone(packDir, stepId, action === "markDone");
      } else if (action === "open") {
        const stepId = stringField(message, "stepId");
        const setup2 = await readPackSetup(packDir, id, await packDisplayName(paths, id));
        const step = setup2?.steps.find((item) => item.id === stepId);
        if (!step?.open) throw new Error("This setup step has nothing to open.");
        await openSetupTarget(step.open, context.openExternal, packDir);
      } else if (action === "install") {
        const stepId = stringField(message, "stepId");
        if (!stepId) throw new Error("Choose a setup step first.");
        await installSetupPackages(packDir, await packDisplayName(paths, id), stepId);
      } else if (action === "rerunScript") {
        await rerunPackSetupScript(packDir, {
          packName: await packDisplayName(paths, id),
          unifyHome: paths.unifyHome
        });
      } else if (action !== "recheck") {
        throw new Error(`Unknown setup action "${action}".`);
      }
      const setup = await readPackSetup(packDir, id, await packDisplayName(paths, id));
      send({ type: "toolpackSetupState", setup });
    } catch (error) {
      send({ type: "toolpackSetupError", id, message: errorText(error) });
    }
    return true;
  }
  if (type === "setModelEnabled") {
    try {
      setModelEnabled(paths, stringField(message, "modelId"), message.enabled === true);
      context.refreshModelState?.();
    } catch {
    }
    return true;
  }
  if (type === "openProviderUsage") {
    send(openProviderUsage(paths, stringField(message, "accountId"), {
      refreshUsageState: context.refreshUsageState,
      openExternal: context.openExternal
    }));
    return true;
  }
  if (type === "renameAccount" || type === "setAccountDefaultModel" || type === "setProviderDefaultModel" || type === "signOutAccount") {
    try {
      if (type === "renameAccount") {
        send(renameAccount(paths, stringField(message, "accountId"), stringField(message, "label")));
      } else if (type === "setAccountDefaultModel") {
        send(setAccountDefaultModel(paths, stringField(message, "accountId"), stringField(message, "modelId")));
      } else if (type === "setProviderDefaultModel") {
        send(setProviderDefaultModel(paths, stringField(message, "provider"), stringField(message, "modelId")));
      } else {
        send(await signOutAccount(paths, stringField(message, "accountId"), context.removeAccount));
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
  if (type === "hubBrowse" || type === "hubInstall" || type === "hubPublish" || type === "hubCheckUpdates") {
    return handleHubRequest(message, send, paths, context, context.hubRegistry);
  }
  return false;
}
export {
  disposeUnifyRequestWatchers,
  handleUnifyRequest
};
