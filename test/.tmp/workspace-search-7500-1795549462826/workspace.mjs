// src/engine/unify/requests/workspace.ts
import { createHash } from "node:crypto";
import * as fs2 from "node:fs";
import * as path3 from "node:path";

// src/engine/unify/settings.ts
import * as os from "os";
import * as path from "path";
function unifyHome() {
  return process.env.UNIFY_HOME || path.join(os.homedir(), ".unify");
}

// src/engine/unify/requests/gitignore.ts
import * as fs from "node:fs";
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
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      this.rules = [];
      this.mtime = -1;
      return;
    }
    if (mtime === this.mtime) return;
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    this.rules = text.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map(compileRule).filter((rule) => !!rule);
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
import * as path2 from "node:path";
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
  if (info.size > MAX_READ_BYTES) throw new Error("Files larger than 2 MB are not shown in the editor.");
  const bytes = fs2.readFileSync(file);
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
function writeWorkspaceFile(root, relativePath, content, version) {
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
    if (version !== current.version) return { ok: false, conflict: current };
  } else if (version) {
    return {
      ok: false,
      conflict: { path: relativePath, content: "", language: languageFor(file), version: "" }
    };
  }
  fs2.mkdirSync(path3.dirname(file), { recursive: true });
  fs2.writeFileSync(file, content, "utf8");
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
  if (kind === "dir") fs2.mkdirSync(file, { recursive: true });
  else {
    fs2.mkdirSync(path3.dirname(file), { recursive: true });
    fs2.writeFileSync(file, "", { encoding: "utf8", flag: "wx" });
  }
  const relative2 = relativeToWorkspace(base, file);
  rememberPath(relative2);
  return relative2;
}
function renameWorkspaceEntry(root, from, to) {
  const base = requireWorkspace(root);
  const source = entryPath(base, from);
  const target = entryPath(base, to);
  if (!statOrUndefined(source)) throw new Error(`No file at ${from}.`);
  if (statOrUndefined(target) && source.toLowerCase() !== target.toLowerCase()) throw new Error(`${relativeToWorkspace(base, target)} already exists.`);
  if ((target + path3.sep).startsWith(source + path3.sep)) throw new Error("A folder cannot move inside itself.");
  fs2.mkdirSync(path3.dirname(target), { recursive: true });
  fs2.renameSync(source, target);
  const relative2 = relativeToWorkspace(base, target);
  rememberPath(relative2);
  return relative2;
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
  fs2.cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
  const relative2 = relativeToWorkspace(base, target);
  rememberPath(relative2);
  return relative2;
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
    fs2.cpSync(resolved, target, { recursive: true, errorOnExist: true, force: false });
    const relative2 = relativeToWorkspace(base, target);
    rememberPath(relative2);
    copied.push(relative2);
  }
  return copied;
}
function deleteWorkspaceEntry(root, relativePath) {
  const base = requireWorkspace(root);
  const file = entryPath(base, relativePath);
  if (!statOrUndefined(file)) throw new Error(`No file at ${relativePath}.`);
  fs2.rmSync(file, { recursive: true, force: true });
}
function findWorkspaceFiles(root, query, limit = 50) {
  const base = requireWorkspace(root);
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const max = Math.min(Math.max(1, Math.trunc(limit) || 50), 500);
  const matches = [];
  let visited = 0;
  const walk = (directory, depth) => {
    if (matches.length >= max * 4 || visited >= MAX_SEARCH_FILES || depth > MAX_SEARCH_DEPTH) return;
    let dirents;
    try {
      dirents = fs2.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirents) {
      if (entry.isSymbolicLink()) continue;
      const full = path3.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      const relative2 = relativeToWorkspace(base, full);
      if (relative2.toLowerCase().includes(needle)) {
        matches.push(relative2);
        rememberPath(relative2);
      }
    }
  };
  walk(base, 0);
  return matches.sort((a, b) => {
    const aName = a.slice(a.lastIndexOf("/") + 1).toLowerCase();
    const bName = b.slice(b.lastIndexOf("/") + 1).toLowerCase();
    const aStarts = aName.startsWith(needle) ? 0 : 1;
    const bStarts = bName.startsWith(needle) ? 0 : 1;
    return aStarts - bStarts || a.length - b.length || a.localeCompare(b);
  }).slice(0, max);
}
var SEARCH_IGNORED = /* @__PURE__ */ new Set([...IGNORED_DIRECTORIES, "out", "coverage", ".unify"]);
var SEARCH_CACHE_MS = 1e4;
var searchCaches = /* @__PURE__ */ new Map();
function modifiedAt(file) {
  try {
    return fs2.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
function searchEntries(root) {
  const cached = searchCaches.get(root);
  const now = Date.now();
  if (cached && now - cached.at < SEARCH_CACHE_MS) return cached.entries;
  const entries = [];
  const ignore = new GitIgnore(root);
  ignore.refresh();
  let visited = 0;
  const walk = (directory, depth) => {
    if (visited >= MAX_SEARCH_FILES || depth > MAX_SEARCH_DEPTH) return;
    let dirents;
    try {
      dirents = fs2.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirents) {
      if (visited >= MAX_SEARCH_FILES) return;
      if (entry.isSymbolicLink()) continue;
      const full = path3.join(directory, entry.name);
      const relative2 = relativeToWorkspace(root, full);
      if (entry.isDirectory()) {
        if (SEARCH_IGNORED.has(entry.name) || ignore.ignores(relative2, true)) continue;
        visited += 1;
        entries.push({ path: `${relative2}/`, kind: "folder", modified: modifiedAt(full) });
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || ignore.ignores(relative2, false)) continue;
      visited += 1;
      entries.push({ path: relative2, kind: "file", modified: modifiedAt(full) });
    }
  };
  walk(root, 0);
  if (searchCaches.size >= 8) searchCaches.clear();
  searchCaches.set(root, { at: now, entries });
  return entries;
}
function isSubsequence(haystack, needle) {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return !needle.length;
}
function searchWorkspaceFiles(root, query, limit = 50) {
  const base = requireWorkspace(root);
  const max = Math.min(Math.max(1, Math.trunc(limit) || 50), 500);
  const entries = searchEntries(base);
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return entries.filter((entry) => entry.kind === "file").sort((a, b) => b.modified - a.modified || a.path.length - b.path.length || a.path.localeCompare(b.path)).slice(0, max).map(({ path: file, kind }) => ({ path: file, kind }));
  }
  const ranked = [];
  for (const entry of entries) {
    const lower = entry.path.toLowerCase();
    const name = lower.replace(/\/$/, "").slice(lower.replace(/\/$/, "").lastIndexOf("/") + 1);
    const tier = name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : lower.includes(needle) ? 2 : isSubsequence(lower, needle) ? 3 : -1;
    if (tier !== -1) ranked.push({ entry, tier });
  }
  return ranked.sort((a, b) => a.tier - b.tier || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path)).slice(0, max).map(({ entry }) => ({ path: entry.path, kind: entry.kind }));
}
var watchers = /* @__PURE__ */ new Map();
var activeReply;
function setActiveUnifyReply(reply) {
  activeReply = reply;
}
function rememberPath(relative2) {
  for (const state of watchers.values()) state.known.add(relative2);
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
function isIgnored(root, relative2, isDirectory) {
  const segments = relative2.split("/").filter(Boolean);
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
  return state.ignore.ignores(relative2, isDirectory);
}
function watchWorkspace(roots, reply) {
  if (reply) activeReply = reply;
  for (const root of normaliseRoots(roots)) {
    if (watchers.has(root)) continue;
    let watcher;
    try {
      watcher = fs2.watch(root, { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename) return;
        const relative2 = filename.toString().replace(/\\/g, "/");
        scheduleChange(root, relative2);
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
function scheduleChange(root, relative2) {
  const state = watchers.get(root);
  if (!state) return;
  const existing = state.timers.get(relative2);
  if (existing) clearTimeout(existing);
  state.timers.set(relative2, setTimeout(() => {
    state.timers.delete(relative2);
    const base = path3.resolve(root);
    const full = path3.resolve(base, ...relative2.split("/"));
    if (full !== base && !full.startsWith(base + path3.sep)) return;
    const info = statOrUndefined(full);
    if (isIgnored(root, relative2, !!info?.isDirectory())) return;
    if (info?.isDirectory()) return;
    const wasKnown = state.known.has(relative2);
    if (!info) {
      state.known.delete(relative2);
      activeReply?.({ type: "fileChanged", root: base, path: relative2, kind: "deleted" });
      return;
    }
    state.known.add(relative2);
    activeReply?.({
      type: "fileChanged",
      root: base,
      path: relative2,
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
export {
  IGNORED_DIRECTORIES,
  contentVersion,
  copyWorkspaceEntry,
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  disposeUnifyRequestWatchers,
  findWorkspaceFiles,
  importWorkspaceEntries,
  languageFor,
  listWorkspaceDirectory,
  readWorkspaceFile,
  renameWorkspaceEntry,
  searchWorkspaceFiles,
  setActiveUnifyReply,
  watchWorkspace,
  writeWorkspaceFile
};
