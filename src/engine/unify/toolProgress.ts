import * as fs from 'fs';
import * as path from 'path';
import type { SidebarToolProgress } from '../sidebar/view';

/** Runs shorter than this are not recorded: they never need a bar. */
const MIN_RECORDED_MS = 1_500;
/** Recent runs kept per (project, command). */
const KEEP_RUNS = 5;
/** A fraction must move at least this much before a new progress event is sent. */
const MIN_STEP = 0.01;

/**
 * Optional wrappers before a tool name: `&` (PowerShell), `npx`, `pnpm exec`, `python -m`, `uv run`, and a path such
 * as `./node_modules/.bin/` or `"C:\...\tsc.cmd"`. Patterns are anchored to the start of a segment, so `grep vitest`
 * is not a test run.
 */
const RUNNER_PREFIX = String.raw`^(?:&\s*)?(?:(?:npx|bunx|pnpm\s+exec|yarn|uv\s+run|poetry\s+run|python3?\s+-m|py\s+-m)\s+)?(?:"[^"]*[\\/]|'[^']*[\\/]|[^\s"']*[\\/])?`;

/** Tool invocations (after the runner prefix) that build, install, test, compile or bundle. */
const ELIGIBLE_TOOLS = [
  String.raw`(?:npm|pnpm|yarn|bun)(?:\.cmd)?"?(?:\s+-\S+)*\s+(?:(?:run(?:-script)?\s+)?(?:[\w.-]+:)?(?:build|test|compile|bundle|package|dist)(?::[\w:.-]+)?|install|i|ci|add)`,
  String.raw`tsc(?:\.cmd)?`,
  String.raw`vite\s+build`,
  String.raw`(?:esbuild|webpack|rollup|jest|vitest|mocha|pytest|ninja)`,
  String.raw`make`,
  String.raw`rojo\s+build`,
  String.raw`electron-builder`,
  String.raw`electron-forge\s+(?:make|package)`,
  String.raw`cargo\s+(?:build|test|install|bench|check)`,
  String.raw`go\s+(?:build|test|install)`,
  String.raw`dotnet\s+(?:build|test|publish|restore)`,
  String.raw`(?:gradle|gradlew)(?:\.bat)?`,
  String.raw`(?:mvn|mvnw)(?:\.cmd)?`,
  String.raw`cmake\s+--build`,
  String.raw`(?:msbuild|xcodebuild)`,
  String.raw`pip3?\s+install`,
  String.raw`uv\s+pip\s+install`,
  String.raw`docker\s+(?:build|buildx\s+build|compose\s+build)`,
  String.raw`node\s+(?:--test|\S*test\S*)`,
];
const ELIGIBLE: RegExp[] = ELIGIBLE_TOOLS.map(tool => new RegExp(`${RUNNER_PREFIX}${tool}(?=\\s|["']|$)`, 'i'));

/**
 * True when a shell command builds, installs, tests, compiles or bundles, so the engine shows a progress bar for it.
 * Read-only commands (ls, cat, git status, rg) are never eligible. Each `&&`, `||`, `;`, `|` or line is checked.
 */
export function classifyProgressEligible(command: string): boolean {
  const segments = command.split(/&&|\|\||;|\||\r?\n/);
  return segments.some(segment => {
    const text = segment.trim().replace(/^(?:[A-Za-z_]\w*=\S+\s+)+/, '');
    return text.length > 0 && ELIGIBLE.some(pattern => pattern.test(text));
  });
}

/** The command as history keys it: whitespace collapsed, trailing `2>&1` and `| tail`/`| head` pipes removed. */
export function normalizeCommand(command: string): string {
  let text = command.replace(/\s+/g, ' ').trim();
  text = text.replace(/\s*(?:2>&1\s*)?\|\s*(?:tail|head)\b.*$/i, '');
  text = text.replace(/\s*2>&1\s*$/, '');
  return text.trim();
}

function historyKey(cwd: string, command: string): string {
  const folder = path.resolve(cwd);
  return `${process.platform === 'win32' ? folder.toLowerCase() : folder}\n${normalizeCommand(command)}`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * Durations of successful runs per (project folder, normalized command), kept in a JSON file when a path is given.
 * A missing or corrupt file reads as no history; writes go through a temporary file and rename.
 */
export class ProgressHistory {
  private readonly runs = new Map<string, number[]>();

  constructor(private readonly file?: string) {
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue;
        const durations = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item) && item > 0);
        if (durations.length) this.runs.set(key, durations.slice(-KEEP_RUNS));
      }
    } catch {
      // A missing or corrupt file starts an empty history.
    }
  }

  /** Median of the recent runs of this command in this folder, or undefined without samples. */
  expectedMs(cwd: string, command: string): number | undefined {
    const durations = this.runs.get(historyKey(cwd, command));
    return durations?.length ? median(durations) : undefined;
  }

  /** Records a successful run. Runs under 1.5 s are ignored. */
  record(cwd: string, command: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < MIN_RECORDED_MS) return;
    const key = historyKey(cwd, command);
    const durations = [...(this.runs.get(key) ?? []), Math.round(durationMs)].slice(-KEEP_RUNS);
    this.runs.set(key, durations);
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.runs), null, 2));
      fs.renameSync(temporary, this.file);
    } catch {
      try { fs.rmSync(temporary, { force: true }); } catch { /* Nothing more to clean up. */ }
    }
  }
}

/** Reads the most recent progress in a chunk of live output: "42%", "[3/10]", "Step 3/7", "(3 of 10)", "Building [=>] 120/300". */
export function parseProgress(chunk: string): { fraction: number; label: string } | undefined {
  let best: { index: number; fraction: number; label: string } | undefined;
  const consider = (index: number, fraction: number, label: string): void => {
    if (!best || index >= best.index) best = { index, fraction, label };
  };
  for (const match of chunk.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)) {
    const percent = Number(match[1]);
    if (percent > 100) continue;
    consider(match.index ?? 0, percent / 100, `${Math.round(percent)}%`);
  }
  const counters = [
    /\[\s*(\d+)\s*\/\s*(\d+)\s*\]/g,
    /\(\s*(\d+)\s*\/\s*(\d+)\s*\)/g,
    /\bstep\s+(\d+)\s*(?:\/|of)\s*(\d+)/gi,
    /\(\s*(\d+)\s+of\s+(\d+)\s*\)/gi,
    /\]\s*(\d+)\s*\/\s*(\d+)\b/g,
  ];
  for (const pattern of counters) {
    for (const match of chunk.matchAll(pattern)) {
      const current = Number(match[1]);
      const total = Number(match[2]);
      if (total < 2 || total > 1_000_000 || current > total) continue;
      consider(match.index ?? 0, current / total, `${current}/${total}`);
    }
  }
  return best ? { fraction: best.fraction, label: best.label } : undefined;
}

interface ActiveCall {
  command: string;
  cwd: string;
  startedAt: number;
  expectedMs?: number;
  fraction?: number;
  label?: string;
}

export interface ToolProgressTrackerOptions {
  history: ProgressHistory;
  /** Injected clock (epoch milliseconds). */
  now?: () => number;
}

/** Progress bars for the eligible tool calls of one runtime. Calls are keyed by the tool id the runtime reports. */
export class ToolProgressTracker {
  private readonly active = new Map<string, ActiveCall>();
  private readonly history: ProgressHistory;
  private readonly now: () => number;

  constructor(options: ToolProgressTrackerOptions) {
    this.history = options.history;
    this.now = options.now ?? Date.now;
  }

  /** The call's first progress, or undefined when the command is not eligible for a bar. */
  start(toolId: string, command: string, cwd: string): SidebarToolProgress | undefined {
    // Runtimes re-post a running call (input streaming, state echoes); the first start owns the clock.
    const running = this.active.get(toolId);
    if (running) {
      return {
        startedAt: running.startedAt,
        ...(running.fraction !== undefined ? { fraction: running.fraction } : {}),
        ...(running.expectedMs !== undefined ? { expectedMs: running.expectedMs } : {}),
        ...(running.label ? { label: running.label } : {}),
      };
    }
    if (!classifyProgressEligible(command)) return undefined;
    const startedAt = this.now();
    const expectedMs = this.history.expectedMs(cwd, command);
    this.active.set(toolId, { command, cwd, startedAt, expectedMs });
    return { startedAt, ...(expectedMs !== undefined ? { expectedMs } : {}) };
  }

  /** Updated progress when live output moved the fraction by at least 1%; never backwards. */
  output(toolId: string, chunk: string): SidebarToolProgress | undefined {
    const call = this.active.get(toolId);
    if (!call) return undefined;
    const parsed = parseProgress(chunk);
    if (!parsed) return undefined;
    if (parsed.fraction < (call.fraction ?? 0) + MIN_STEP) return undefined;
    call.fraction = parsed.fraction;
    call.label = parsed.label;
    return {
      startedAt: call.startedAt,
      fraction: parsed.fraction,
      label: parsed.label,
      ...(call.expectedMs !== undefined ? { expectedMs: call.expectedMs } : {}),
    };
  }

  /** Ends the call, recording its duration when it succeeded. */
  end(toolId: string, ok: boolean): void {
    const call = this.active.get(toolId);
    if (!call) return;
    this.active.delete(toolId);
    if (ok) this.history.record(call.cwd, call.command, this.now() - call.startedAt);
  }
}
