// src/engine/hub/githubRegistry.ts
import { promises as fsp2 } from "node:fs";
import * as path2 from "node:path";

// src/engine/hub/publish.ts
import { promises as fsp } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as vm from "node:vm";

// src/engine/toolpacks/types.ts
var TOOLPACK_SYNC_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/;
var TOOLPACK_NAME = /^[a-z][a-z0-9_]{0,31}$/;

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

// src/engine/hub/scripts.ts
var INSTALL_SCRIPT_NAMES = ["install.js", "install.ps1", "install.sh"];
var UNINSTALL_SCRIPT_NAMES = ["uninstall.js", "uninstall.ps1", "uninstall.sh"];
var PACK_SCRIPT_NAMES = [...INSTALL_SCRIPT_NAMES, ...UNINSTALL_SCRIPT_NAMES];

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
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function titleFromId(id) {
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
function bumpPatch(version) {
  const match = SEMVER_PATTERN.exec(version);
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
  const absolutePath = path.resolve(sourcePath);
  const mod = { exports: {} };
  const localRequire = createRequire(absolutePath);
  const wrapper = `(function (exports, require, module, __filename, __dirname) {
${transformed.code}
})`;
  const runner = vm.runInThisContext(wrapper, { filename: absolutePath, timeout: 1e4 });
  runner(mod.exports, localRequire, mod, absolutePath, path.dirname(absolutePath));
  const exported = mod.exports;
  const candidate = exported && typeof exported === "object" && "default" in exported ? exported.default : void 0;
  if (!candidate || typeof candidate !== "object") {
    throw new Error("The script must `export default` a toolpack object.");
  }
  if (typeof candidate.name !== "string" || !TOOLPACK_NAME.test(candidate.name)) {
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
    if (!isRecord(tool) || typeof tool.name !== "string" || !TOOLPACK_NAME.test(tool.name)) {
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
    if (!isRecord(sync) || !validList(sync.files, 8, (item) => TOOLPACK_SYNC_FILE.test(item))) {
      throw new Error('Toolpack "sync.files" must list up to 8 .json file names in dataDir.');
    }
    if (sync.secrets !== void 0 && !validList(sync.secrets, 64, (item) => item.length > 0 && item.length <= 64)) {
      throw new Error('Toolpack "sync.secrets" must list up to 64 key names.');
    }
  }
  const version = typeof candidate.version === "string" && candidate.version.trim() ? candidate.version.trim() : void 0;
  return {
    name: candidate.name,
    description: candidate.description.trim(),
    ...version ? { version } : {},
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
    const parsed = JSON.parse(await fsp.readFile(path.join(folderPath, "meta.json"), "utf8"));
    if (!isRecord(parsed)) return {};
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
    entries = await fsp.readdir(toolpacksDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const folderPath = path.join(toolpacksDir, entry.name);
    try {
      await fsp.access(path.join(folderPath, "pack.ts"));
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
  const existingPacks = Array.isArray(currentIndex.packs) ? currentIndex.packs.filter(isRecord) : [];
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
  const packTsPath = path.join(candidate.folderPath, "pack.ts");
  let packSource;
  try {
    packSource = await fsp.readFile(packTsPath, "utf8");
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
  const displayName = candidate.meta.name?.trim() || titleFromId(hubId);
  let readmeContent;
  try {
    const existingReadme = await fsp.readFile(path.join(candidate.folderPath, "README.md"), "utf8");
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
      const scriptContent = await fsp.readFile(path.join(candidate.folderPath, scriptName), "utf8");
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
    if (!isRecord(parsedIndex)) throw new Error("index.json is not a JSON object.");
    currentIndex = parsedIndex;
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const existingEntries = Array.isArray(currentIndex.packs) ? currentIndex.packs.filter(isRecord) : [];
  const existing = existingEntries.find((pack) => pack.id === hubId);
  const version = nextPackVersion({
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
    version,
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
  const publishBranch = `publish/${hubId}-${version}`;
  const confirmMessage = `Publish "${hubId}" v${version} to the Toolpack Hub?`;
  const confirmDetail = [
    `Pack: ${hubId}`,
    `Version: ${version}`,
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
    const commitMessage = `Publish ${hubId} ${version}`;
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
      `Publishes toolpack \`${hubId}\` \`v${version}\` (${updatedEntry.tools.length} tools).`,
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
function isRecord2(value) {
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
  if (!isRecord2(parsed) || !Array.isArray(parsed.files)) return [];
  const reserved = /* @__PURE__ */ new Set(["pack.ts", "pack.js", "meta.json", "setup.json", ...PACK_SCRIPT_NAMES]);
  return parsed.files.filter((name) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) && !reserved.has(name.toLowerCase()));
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
    await fsp2.mkdir(destination, { recursive: true });
    const ref = await this.latestCommit();
    const base = `https://raw.githubusercontent.com/${HUB_REPOSITORY}/${ref}/packs/${encodeURIComponent(id)}`;
    const source = await this.fetchText(`${base}/pack.ts`);
    await fsp2.writeFile(path2.join(destination, "pack.ts"), source, "utf8");
    for (const script of PACK_SCRIPT_NAMES) {
      try {
        const content = await this.fetchText(`${base}/${script}`);
        await fsp2.writeFile(path2.join(destination, script), content, "utf8");
      } catch {
      }
    }
    let setupText;
    try {
      setupText = await this.fetchText(`${base}/setup.json`);
    } catch {
    }
    if (setupText === void 0) return;
    await fsp2.writeFile(path2.join(destination, "setup.json"), setupText, "utf8");
    for (const name of setupFileNames(setupText)) {
      const content = await this.fetchText(`${base}/${encodeURIComponent(name)}`);
      await fsp2.writeFile(path2.join(destination, name), content, "utf8");
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
    return releases.filter((release) => isRecord2(release) && text(release.tag_name).startsWith(`${id}@`));
  }
};

// src/engine/hub/types.ts
var PYTHON_DEPENDENCY_ID = "unify:python";

// src/engine/hub/install.ts
import { existsSync as existsSync3, promises as fsp4 } from "node:fs";
import { createHash, randomUUID as randomUUID2 } from "node:crypto";
import * as path5 from "node:path";

// src/engine/hub/ids.ts
var TOOLPACK_NAME2 = /^[a-z][a-z0-9_]{0,31}$/;
function toolpackIdFor(hubId) {
  const sanitized = hubId.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const withLetter = /^[a-z]/.test(sanitized) ? sanitized : `pack_${sanitized}`;
  const id = withLetter.slice(0, 32);
  if (!TOOLPACK_NAME2.test(id)) throw new Error(`Cannot turn Hub id "${hubId}" into a toolpack id.`);
  return id;
}

// src/engine/hub/setup.ts
import { spawn as spawn2 } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync as existsSync2, promises as fsp3 } from "node:fs";
import * as os2 from "node:os";
import * as path4 from "node:path";

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
import { existsSync, lstatSync, readdirSync } from "node:fs";
import * as os from "node:os";
import * as path3 from "node:path";
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
  const powershell = path3.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
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
  return process.platform === "win32" && local ? [path3.join(local, "Microsoft", "WinGet", "Links")] : [];
}
function pythonUserScripts() {
  if (process.platform !== "win32") return [path3.join(os.homedir(), ".local", "bin")];
  const dirs = [];
  const bases = [
    process.env.APPDATA && path3.join(process.env.APPDATA, "Python"),
    process.env.LOCALAPPDATA && path3.join(process.env.LOCALAPPDATA, "Programs", "Python")
  ].filter((item) => !!item);
  for (const base of bases) {
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && /^Python3/i.test(entry.name)) dirs.push(path3.join(base, entry.name, "Scripts"));
      }
    } catch {
    }
  }
  return dirs;
}
function searchDirs() {
  const current = (process.env.PATH ?? process.env.Path ?? "").split(path3.delimiter).filter(Boolean);
  const extra = process.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : [];
  return [.../* @__PURE__ */ new Set([...current, ...windowsSavedPath(), ...wingetLinks(), ...extra, ...pythonUserScripts()])];
}
function programExists(candidate) {
  if (existsSync(candidate)) return true;
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
      const candidate = path3.join(dir, `${name}${ext}`);
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
  return new Promise((resolve4) => {
    let output = "";
    let settled = false;
    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve4({ code, output, ...error ? { error } : {} });
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
    process.env.LOCALAPPDATA && path3.join(process.env.LOCALAPPDATA, "Programs", "Python"),
    process.env.ProgramFiles
  ].filter((item) => !!item);
  const found = [];
  for (const base of bases) {
    try {
      const entries = readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^Python3\d*$/i.test(entry.name)).map((entry) => entry.name).sort().reverse();
      for (const name of entries) {
        const candidate = path3.join(base, name, "python.exe");
        if (existsSync(candidate)) found.push(candidate);
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

// src/engine/hub/setup.ts
var PACK_SCRIPT_TIMEOUT = 6e5;
function emptyStateFile() {
  return { ticks: {} };
}
function stateFileFor(packDir) {
  return path4.join(packDir, "setup-state.json");
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
async function readStateFile(packDir) {
  let text2;
  try {
    text2 = await fsp3.readFile(stateFileFor(packDir), "utf8");
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
  await fsp3.mkdir(packDir, { recursive: true });
  const file = stateFileFor(packDir);
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp3.writeFile(temporary, `${JSON.stringify(state, null, 2)}
`, "utf8");
  await fsp3.rename(temporary, file);
}
async function recordPackScriptResult(packDir, ok, lastLine2) {
  const state = await readStateFile(packDir);
  state.script = { ok, ...lastLine2 ? { lastLine: lastLine2 } : {}, at: Date.now() };
  await writeStateFile(packDir, state);
}
function lastOutputLine(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  return last ? last.slice(0, 500) : void 0;
}
function commandFor(script, packDir, unifyHome) {
  const file = path4.join(packDir, script);
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
    const powershell = path4.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
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
  return new Promise((resolve4) => {
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
      resolve4({ ok, ...lastLine2 ? { lastLine: lastLine2 } : {}, ...error ? { error } : {}, output });
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
  const unifyHome = options.unifyHome || process.env.UNIFY_HOME || path4.join(os2.homedir(), ".unify");
  const result = await runScriptProcess(packDir, script, unifyHome);
  await recordPackScriptResult(packDir, result.ok, result.lastLine).catch((error) => appendLog(`Could not save the install script result for ${packDir}: ${errorMessage(error)}`));
  return result;
}
async function firstExisting(packDir, names) {
  for (const name of names) {
    try {
      await fsp3.access(path4.join(packDir, name));
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
    if (name === "HOME") return os2.homedir();
    const environment = process.env[name];
    return environment !== void 0 ? environment : token;
  });
}
function toPlatformPath(value) {
  return value.replace(/\//g, path4.sep);
}
function isUrl(value) {
  if (path4.isAbsolute(toPlatformPath(value))) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}
function setupPath(value, packDir) {
  const normalized = toPlatformPath(value);
  return path4.isAbsolute(normalized) ? normalized : path4.resolve(packDir, normalized);
}
function displayedPath(value, packDir) {
  const expanded = expandTokens(value, packDir);
  if (isUrl(expanded)) return expanded;
  const normalized = toPlatformPath(expanded);
  return path4.isAbsolute(normalized) ? normalized : expanded;
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
  let text2;
  try {
    text2 = await fsp3.readFile(path4.join(packDir, "setup.json"), "utf8");
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

// src/engine/hub/install.ts
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
  return createHash("sha256").update([scriptName ?? "", scriptText ?? "", uninstallScriptName ?? "", uninstallScriptText ?? ""].join("\0")).digest("hex");
}
function installScriptFor(files) {
  return INSTALL_SCRIPT_NAMES.find((name) => files.includes(name));
}
function uninstallScriptFor(files) {
  return UNINSTALL_SCRIPT_NAMES.find((name) => files.includes(name));
}
async function readExistingMeta(destination) {
  try {
    const parsed = JSON.parse(await fsp4.readFile(path5.join(destination, "meta.json"), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function assertInsideToolpacksDir(toolpacksDir, destination) {
  const relative2 = path5.relative(path5.resolve(toolpacksDir), path5.resolve(destination));
  if (!relative2 || relative2 === ".." || relative2.startsWith(`..${path5.sep}`) || path5.isAbsolute(relative2)) {
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
  const destination = path5.join(toolpacksDir, packId);
  assertInsideToolpacksDir(toolpacksDir, destination);
  const staging = path5.join(toolpacksDir, `.staging-${packId}-${randomUUID2()}`);
  let existing = {};
  try {
    const hub = await registry.state();
    const pack = hub.packs.find((candidate) => candidate.id === id);
    if (!pack) throw new Error(`The Hub has no pack "${id}".`);
    existing = await readExistingMeta(destination);
    assertSameHubPack(existing, packId, pack.id);
    await fsp4.mkdir(staging, { recursive: true });
    send({ id, percent: 5, state: "downloading" });
    await registry.download(id, staging);
    send({ id, percent: 60, state: "installing" });
    let files;
    try {
      files = await fsp4.readdir(staging);
    } catch {
      throw new Error("The download did not write any files.");
    }
    const scriptName = installScriptFor(files);
    const uninstallScriptName = uninstallScriptFor(files);
    const scriptText = scriptName ? await fsp4.readFile(path5.join(staging, scriptName), "utf8") : void 0;
    const uninstallScriptText = uninstallScriptName ? await fsp4.readFile(path5.join(staging, uninstallScriptName), "utf8") : void 0;
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
    const sourceFile = path5.join(staging, "pack.ts");
    const compiledFile = path5.join(staging, "pack.js");
    let source;
    try {
      source = await fsp4.readFile(sourceFile, "utf8");
    } catch {
      throw new Error("The pack has no pack.ts.");
    }
    if (!source.trim()) throw new Error("The pack.ts file is empty.");
    try {
      await fsp4.access(compiledFile);
    } catch {
      await fsp4.writeFile(compiledFile, await compilePack(source), "utf8");
    }
    await fsp4.mkdir(path5.dirname(destination), { recursive: true });
    const dataDir = path5.join(destination, "data");
    const keptData = path5.join(toolpacksDir, `.data-${packId}-${randomUUID2()}`);
    const keep = existsSync3(dataDir) && !files.includes("data");
    if (keep) await fsp4.rename(dataDir, keptData);
    try {
      await fsp4.rm(destination, { recursive: true, force: true });
      await fsp4.cp(staging, destination, { recursive: true, force: true });
    } finally {
      if (keep) {
        await fsp4.mkdir(destination, { recursive: true });
        await fsp4.rename(keptData, dataDir);
      }
    }
    const meta = {
      description: pack.description,
      enabled: existing.enabled !== false,
      hubId: pack.id,
      version: pack.version
    };
    await fsp4.writeFile(path5.join(destination, "meta.json"), `${JSON.stringify(meta, null, 2)}
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
    await fsp4.rm(staging, { recursive: true, force: true }).catch(() => void 0);
  }
}

// src/engine/hub/updates.ts
import { existsSync as existsSync4 } from "node:fs";
import * as path6 from "node:path";
function folderFor(toolpacksDir, hubId) {
  try {
    return path6.join(toolpacksDir, toolpackIdFor(hubId));
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
    if (!folder || !existsSync4(folder)) continue;
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
export {
  GithubHubRegistry,
  HUB_BRANCH,
  HUB_INDEX_URL,
  HUB_PUBLISHERS_URL,
  HUB_REPOSITORY,
  PUBLISH_NOT_APPROVED,
  PUBLISH_SIGNED_OUT,
  PYTHON_DEPENDENCY_ID,
  createHubRegistry,
  findHubUpdates,
  installHubPack,
  nextPackVersion,
  packScriptHash,
  publishAccessError,
  publishHubPack,
  scanPublishFiles,
  toolpackIdFor,
  validateToolpackSource
};
