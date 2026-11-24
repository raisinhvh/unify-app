// src/engine/hub/setup.ts
import { spawn as spawn2 } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync as existsSync2, promises as fsp } from "node:fs";
import * as os2 from "node:os";
import * as path2 from "node:path";
import { pathToFileURL } from "node:url";

// src/shim/vscode/host.ts
import { appendFileSync, mkdirSync } from "node:fs";

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
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
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
  return process.platform === "win32" && local ? [path.join(local, "Microsoft", "WinGet", "Links")] : [];
}
function pythonUserScripts() {
  if (process.platform !== "win32") return [path.join(os.homedir(), ".local", "bin")];
  const dirs = [];
  const bases = [
    process.env.APPDATA && path.join(process.env.APPDATA, "Python"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Python")
  ].filter((item) => !!item);
  for (const base of bases) {
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && /^Python3/i.test(entry.name)) dirs.push(path.join(base, entry.name, "Scripts"));
      }
    } catch {
    }
  }
  return dirs;
}
function searchDirs() {
  const current = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean);
  const extra = process.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : [];
  return [.../* @__PURE__ */ new Set([...current, ...windowsSavedPath(), ...wingetLinks(), ...extra, ...pythonUserScripts()])];
}
function findCommand(name) {
  if (!name || /[\\/]/.test(name)) return void 0;
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const hasExtension = process.platform === "win32" && extensions.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()));
  for (const dir of searchDirs()) {
    for (const ext of hasExtension ? [""] : extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (existsSync(candidate)) return candidate;
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
  return new Promise((resolve2) => {
    let output = "";
    let settled = false;
    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve2({ code, output, ...error ? { error } : {} });
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
function findPython() {
  const candidates = process.platform === "win32" ? [{ name: "py", prefix: ["-3"] }, { name: "python", prefix: [] }] : [{ name: "python3", prefix: [] }, { name: "python", prefix: [] }];
  for (const candidate of candidates) {
    const found = findCommand(candidate.name);
    if (found && !/WindowsApps/i.test(found)) return { command: found, prefix: candidate.prefix };
  }
  return void 0;
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
  return path2.join(packDir, "setup-state.json");
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
async function readStateFile(packDir) {
  let text;
  try {
    text = await fsp.readFile(stateFileFor(packDir), "utf8");
  } catch {
    return emptyStateFile();
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
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
  await fsp.mkdir(packDir, { recursive: true });
  const file = stateFileFor(packDir);
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(state, null, 2)}
`, "utf8");
  await fsp.rename(temporary, file);
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
function commandFor(script, packDir, unifyHome) {
  const file = path2.join(packDir, script);
  const env = {
    ...process.env,
    UNIFY_PACK_DIR: packDir,
    UNIFY_HOME: unifyHome
  };
  if (script.endsWith(".js")) {
    env.ELECTRON_RUN_AS_NODE = "1";
    return { command: process.execPath, args: [file], env };
  }
  if (script.endsWith(".ps1")) {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const powershell = path2.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return { command: powershell, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], env };
  }
  if (script.endsWith(".sh")) {
    return { command: "bash", args: [file], env };
  }
  return void 0;
}
function runScriptProcess(packDir, script, unifyHome) {
  const kind = UNINSTALL_SCRIPT_NAMES.includes(script) ? "uninstall" : "install";
  const invocation = commandFor(script, packDir, unifyHome);
  if (!invocation) {
    return Promise.resolve({ ok: false, lastLine: `Unsupported ${kind} script "${script}".`, error: `Unsupported ${kind} script "${script}".`, output: "" });
  }
  return new Promise((resolve2) => {
    const child = spawn2(invocation.command, invocation.args, {
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
      resolve2({ ok, ...lastLine2 ? { lastLine: lastLine2 } : {}, ...error ? { error } : {}, output });
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
  const unifyHome = options.unifyHome || process.env.UNIFY_HOME || path2.join(os2.homedir(), ".unify");
  const result = await runScriptProcess(packDir, script, unifyHome);
  await recordPackScriptResult(packDir, result.ok, result.lastLine).catch((error) => appendLog(`Could not save the install script result for ${packDir}: ${errorMessage(error)}`));
  return result;
}
async function firstExisting(packDir, names) {
  for (const name of names) {
    try {
      await fsp.access(path2.join(packDir, name));
      return name;
    } catch {
    }
  }
  return void 0;
}
function findInstallScript(packDir) {
  return firstExisting(packDir, INSTALL_SCRIPT_NAMES);
}
function findUninstallScript(packDir) {
  return firstExisting(packDir, UNINSTALL_SCRIPT_NAMES);
}
async function runPackUninstallScript(packDir, options = {}) {
  const script = await findUninstallScript(packDir);
  if (!script) return void 0;
  const name = options.packName ?? path2.basename(packDir);
  const unifyHome = options.unifyHome || process.env.UNIFY_HOME || path2.join(os2.homedir(), ".unify");
  const id = `pack-uninstall-${randomUUID()}`;
  const title = `Removing ${name}`;
  postToRenderer({ type: "progressNotice", id, title, message: `Running ${script}`, state: "running" });
  const result = await runScriptProcess(packDir, script, unifyHome);
  appendLog(`${name} ${script} -> ${result.ok ? "ok" : "failed"}${result.lastLine ? `: ${result.lastLine}` : ""}`);
  postToRenderer({
    type: "progressNotice",
    id,
    title,
    ...result.lastLine ? { message: result.lastLine } : {},
    state: result.ok ? "done" : "error"
  });
  return result;
}
function expandTokens(value, packDir) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (token, name) => {
    if (name === "PACK") return packDir;
    if (name === "HOME") return os2.homedir();
    const environment = process.env[name];
    return environment !== void 0 ? environment : token;
  });
}
function toPlatformPath(value) {
  return value.replace(/\//g, path2.sep);
}
function isUrl(value) {
  if (path2.isAbsolute(toPlatformPath(value))) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}
function setupPath(value, packDir) {
  const normalized = toPlatformPath(value);
  return path2.isAbsolute(normalized) ? normalized : path2.resolve(packDir, normalized);
}
function displayedPath(value, packDir) {
  const expanded = expandTokens(value, packDir);
  if (isUrl(expanded)) return expanded;
  const normalized = toPlatformPath(expanded);
  return path2.isAbsolute(normalized) ? normalized : expanded;
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
    if (paths.some((item) => existsSync2(item))) return { passed: true };
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
  let text;
  try {
    text = await fsp.readFile(path2.join(packDir, "setup.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Could not read setup.json in "${name}": ${errorMessage(error)}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`The setup.json in "${name}" is not valid JSON: ${errorMessage(error)}`);
  }
  return parseDefinition(raw, name);
}
function onThisPlatform(step) {
  return !step.platforms || step.platforms.includes(process.platform);
}
async function pendingPackages(packDir, name, stepId) {
  const definition = await readDefinition(packDir, name);
  if (!definition) return [];
  const pending = [];
  for (const step of definition.steps) {
    if (!onThisPlatform(step)) continue;
    if (stepId ? step.id !== stepId : step.optional) continue;
    const command = packageCommandFor(step.install);
    if (!command) continue;
    if (checkStep(step, packDir)?.passed) continue;
    pending.push({ stepId: step.id, title: step.title, command });
  }
  return pending;
}
async function installSetupPackages(packDir, name, stepId) {
  const pending = await pendingPackages(packDir, name, stepId);
  if (stepId && !pending.length) {
    const definition = await readDefinition(packDir, name);
    const step = definition?.steps.find((item) => item.id === stepId);
    if (!step || !packageCommandFor(step.install)) throw new Error("This setup step has nothing to install on this computer.");
    return;
  }
  for (const item of pending) {
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
  const name = options.packName ?? path2.basename(packDir);
  const script = await findInstallScript(packDir);
  const packages = await pendingPackages(packDir, name);
  if (!script && !packages.length) {
    if ((await readPackSetup(packDir, path2.basename(packDir), name))?.canRerunScript) return;
    throw new Error(`The pack "${name}" has no install script to run.`);
  }
  await installSetupPackages(packDir, name);
  if (script) await runScriptWithNotice(packDir, script, name, options.unifyHome);
}
async function runScriptWithNotice(packDir, script, name, unifyHome) {
  const options = { unifyHome };
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
  await new Promise((resolve2, reject) => {
    const child = spawn2(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve2();
    });
  });
}
export {
  INSTALL_SCRIPT_NAMES,
  PACK_SCRIPT_NAMES,
  PACK_SCRIPT_TIMEOUT,
  UNINSTALL_SCRIPT_NAMES,
  findInstallScript,
  findUninstallScript,
  installSetupPackages,
  openSetupTarget,
  pendingPackages,
  readPackSetup,
  recordPackScriptResult,
  rerunPackSetupScript,
  runPackInstallScript,
  runPackUninstallScript,
  setPackSetupStepDone
};
