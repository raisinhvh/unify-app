/**
 * Builds Unify and publishes a release to GitHub in one go.
 *
 *   npm run release -- V1.1
 *   npm run release -- V1.1 --notes "What changed"   (otherwise notes come from the commit log)
 *   npm run release -- V1.1 --skip-tests
 *   npm run release -- V1.1 --dry-run                (build only; no commit, push or release)
 *
 * Versions are written VX.Y. Electron and the updater need semver, so VX.Y is
 * stored in package.json as X.Y.0; the git tag and release are named VX.Y.
 *
 * Steps: check git/gh, set the version, run the tests, build the engine and
 * renderer, package the Windows installer and portable exe, commit everything
 * in the working tree, tag, push to `main` of the repository in package.json
 * (created on GitHub if missing), and create the GitHub release with the
 * installer, portable exe, blockmap and latest.yml (the updater reads that).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const dryRun = flag('--dry-run');
const skipTests = flag('--skip-tests');
const notesArg = option('--notes');

function fail(message) {
  console.error(`\nrelease: ${message}`);
  process.exit(1);
}

function step(message) {
  console.log(`\n== ${message}`);
}

/** Runs a command with inherited output; exits on failure unless `allowFail`. */
function run(command, commandArgs, { allowFail = false, capture = false, shell = false } = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    shell,
  });
  if (result.error) fail(`could not start ${command}: ${result.error.message}`);
  if (result.status !== 0 && !allowFail) {
    if (capture) process.stderr.write(result.stderr ?? '');
    fail(`${command} ${commandArgs.join(' ')} exited with ${result.status}`);
  }
  return { ok: result.status === 0, out: (result.stdout ?? '').trim() };
}
const git = (...a) => run('git', a, { capture: true });
const npm = (...a) => run('npm', a, { shell: process.platform === 'win32' });

// ---- version ---------------------------------------------------------------

const versionArg = args.find(arg => !arg.startsWith('--') && arg !== notesArg);
const match = /^[vV]?(\d+)\.(\d+)$/.exec(versionArg ?? '');
if (!match) fail('give the version as VX.Y, for example: npm run release -- V1.1');
const [major, minor] = [Number(match[1]), Number(match[2])];
const tag = `V${major}.${minor}`;
const semver = `${major}.${minor}.0`;

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const repoMatch = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(pkg.repository?.url ?? '');
if (!repoMatch) fail('package.json repository.url must point at a GitHub repository.');
const repo = `${repoMatch[1]}/${repoMatch[2]}`;
const remoteUrl = `https://github.com/${repo}.git`;

console.log(`Unify ${tag} (package version ${semver}) -> ${repo}${dryRun ? ' [dry run]' : ''}`);

// ---- preflight -------------------------------------------------------------

step('Checking git and GitHub');
if (!run('git', ['--version'], { capture: true, allowFail: true }).ok) fail('git is not installed.');
if (!dryRun && !run('gh', ['auth', 'status'], { capture: true, allowFail: true }).ok) {
  fail('the GitHub CLI is missing or signed out. Install it and run `gh auth login`.');
}
const branch = git('rev-parse', '--abbrev-ref', 'HEAD').out;
if (branch === 'HEAD') fail('check out a branch first (HEAD is detached).');
if (git('tag', '--list', tag).out) fail(`tag ${tag} already exists locally.`);

const repoExists = !dryRun && run('gh', ['repo', 'view', repo, '--json', 'name'], { capture: true, allowFail: true }).ok;
if (repoExists) {
  if (run('gh', ['release', 'view', tag, '-R', repo], { capture: true, allowFail: true }).ok) {
    fail(`release ${tag} already exists on ${repo}.`);
  }
  const latest = run('gh', ['api', `repos/${repo}/releases/latest`, '--jq', '.tag_name'], { capture: true, allowFail: true });
  const previous = /^[vV]?(\d+)\.(\d+)/.exec(latest.ok ? latest.out : '');
  if (previous && (Number(previous[1]) > major || (Number(previous[1]) === major && Number(previous[2]) >= minor))) {
    fail(`${tag} is not newer than the latest release ${latest.out}.`);
  }
}
const origin = run('git', ['remote', 'get-url', 'origin'], { capture: true, allowFail: true });
if (origin.ok && !origin.out.toLowerCase().includes(repo.toLowerCase())) {
  fail(`remote "origin" is ${origin.out}, not ${repo}. Fix the remote or package.json first.`);
}

// ---- version, tests, build -------------------------------------------------

step(`Setting version ${semver}`);
npm('version', semver, '--no-git-tag-version', '--allow-same-version');

if (skipTests) {
  step('Skipping tests (--skip-tests)');
} else {
  step('Running tests');
  npm('test');
}

step('Building engine, main and preload');
npm('run', 'build');
step('Building renderer');
npm('run', 'build:renderer');

step('Packaging the Windows installer');
rmSync('release', { recursive: true, force: true });
const setupName = `Unify-Setup-${tag}.exe`;
const portableName = `Unify-${tag}-Portable.exe`;
run(process.execPath, [
  join('node_modules', 'electron-builder', 'cli.js'),
  '--win',
  '--publish', 'never',
  `-c.nsis.artifactName=Unify-Setup-${tag}.\${ext}`,
  `-c.portable.artifactName=Unify-${tag}-Portable.\${ext}`,
]);
const assets = [setupName, `${setupName}.blockmap`, portableName, 'latest.yml'].map(name => join('release', name));
for (const asset of assets) if (!existsSync(asset)) fail(`expected build output ${asset} is missing.`);
console.log(assets.map(asset => `  ${asset}`).join('\n'));

if (dryRun) {
  console.log('\nDry run finished: nothing was committed, pushed or released.');
  process.exit(0);
}

// ---- commit, tag, push -----------------------------------------------------

step('Committing');
const previousTag = run('git', ['describe', '--tags', '--abbrev=0', '--match', 'V*'], { capture: true, allowFail: true });
git('add', '-A');
if (git('diff', '--cached', '--name-only').out) {
  git('commit', '-m', `Release Unify ${tag}`);
  console.log(`  committed as "Release Unify ${tag}"`);
} else {
  console.log('  nothing to commit');
}
git('tag', '-a', tag, '-m', `Unify ${tag}`);

step(`Pushing to ${repo}`);
if (!repoExists) {
  console.log(`  creating public repository ${repo}`);
  run('gh', ['repo', 'create', repo, '--public', '--description', pkg.description ?? 'Unify']);
}
if (!origin.ok) git('remote', 'add', 'origin', remoteUrl);
run('git', ['push', 'origin', `HEAD:refs/heads/main`]);
run('git', ['push', 'origin', `refs/tags/${tag}`]);

// ---- release ---------------------------------------------------------------

step(`Creating release ${tag}`);
let changes = notesArg;
if (!changes && previousTag.ok) {
  changes = git('log', `${previousTag.out}..${tag}`, '--pretty=format:- %s', '--no-merges').out;
}
const notes = [
  changes ? `## Changes\n\n${changes}` : `First release of Unify, a native desktop app for AI agents.`,
  '## Install (Windows)',
  `Download **${setupName}** and run it. \`${portableName}\` runs without installing.`,
  'The app is not code-signed yet, so Windows SmartScreen may warn: choose **More info → Run anyway**.',
  'Installed copies update themselves from this page.',
].join('\n\n');
const notesDir = mkdtempSync(join(tmpdir(), 'unify-release-'));
const notesFile = join(notesDir, 'notes.md');
writeFileSync(notesFile, `${notes}\n`);
run('gh', ['release', 'create', tag, ...assets, '-R', repo, '--title', `Unify ${tag}`, '--notes-file', notesFile, '--latest', '--verify-tag']);
rmSync(notesDir, { recursive: true, force: true });

console.log(`\nPublished https://github.com/${repo}/releases/tag/${tag}`);
