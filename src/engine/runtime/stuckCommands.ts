/**
 * Watchdog for shell commands that hang without doing any work. The agent runtime runs every command
 * through a per-command runner process, and a tool call that never finishes blocks the agent forever.
 * A command whose whole process tree shows no CPU or IO activity for several minutes is treated as
 * stuck: its child processes are stopped so the runner still exits normally and the runtime settles
 * the job. Commands that are actually being used (dev servers serving requests, watchers polling)
 * keep showing activity and are left alone.
 */
import { execFile } from 'node:child_process';

export interface ProcessSample {
  pid: number;
  ppid: number;
  command: string;
  cpuMs: number;
  ioBytes: number;
}

export interface StuckCommand {
  runnerPid: number;
  command: string;
  idleMs: number;
}

const RUNNER_COMMAND = /dsh-subprocess-local[\\/]lib[\\/]runner\.js/;

/** Runner processes (command line matches /dsh-subprocess-local[\\/]lib[\\/]runner\.js/) that descend from rootPid. */
export function commandRunners(samples: ProcessSample[], rootPid: number): ProcessSample[] {
  const parents = new Map<number, number>();
  for (const sample of samples) parents.set(sample.pid, sample.ppid);
  return samples.filter(sample => {
    if (!RUNNER_COMMAND.test(sample.command)) return false;
    const seen = new Set<number>();
    let pid = sample.ppid;
    while (!seen.has(pid)) {
      if (pid === rootPid) return true;
      seen.add(pid);
      const parent = parents.get(pid);
      if (parent === undefined || parent === pid) return false;
      pid = parent;
    }
    return false;
  });
}

const POWERSHELL_COMMAND = /\s-Command\s+/i;
const BASH_COMMAND = /\s-c\s+/;
const PRELUDE_STATEMENT = /^\s*(?:\[Console\]::OutputEncoding\s*=[^;]*;|\$OutputEncoding\s*=[^;]*;|\$ProgressPreference\s*=[^;]*;)\s*/i;

/** The user-facing command text from a runner command line: the part after the shell's -Command/-c, unquoted, with the leading `[Console]::OutputEncoding…; $OutputEncoding…; $ProgressPreference…;` prelude statements removed; trimmed and capped at 200 chars with "…". */
export function commandLabel(runnerCommandLine: string): string {
  const marker = POWERSHELL_COMMAND.exec(runnerCommandLine) ?? BASH_COMMAND.exec(runnerCommandLine);
  if (!marker) return '';
  let text = runnerCommandLine.slice(marker.index + marker[0].length).trim();

  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const closing = text.lastIndexOf(quote);
    text = closing > 0 ? text.slice(1, closing) : text.slice(1);
  }

  // The runtime prefixes every PowerShell command with encoding and progress settings; they are noise.
  let previous;
  do {
    previous = text;
    text = text.replace(PRELUDE_STATEMENT, '').trimStart();
  } while (text !== previous);

  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** Every sample below the given process, with the depth below it (direct children have depth 1). */
function descendantsWithDepth(samples: ProcessSample[], ancestorPid: number): { sample: ProcessSample; depth: number }[] {
  const parents = new Map<number, number>();
  for (const sample of samples) parents.set(sample.pid, sample.ppid);
  const result: { sample: ProcessSample; depth: number }[] = [];
  for (const sample of samples) {
    let pid = sample.ppid;
    let depth = 1;
    const seen = new Set<number>([sample.pid]);
    while (!seen.has(pid)) {
      if (pid === ancestorPid) {
        result.push({ sample, depth });
        break;
      }
      seen.add(pid);
      const parent = parents.get(pid);
      if (parent === undefined || parent === pid) break;
      pid = parent;
      depth += 1;
    }
  }
  return result;
}

/**
 * Minimum descendant activity rate (averaged over a rolling window up to 1 minute) required to
 * reset the idle clock. Hung processes with keepalive helpers (e.g. `esbuild --service --ping`
 * exchanging ~5.5 KiB/min and ~190–375 ms/min CPU with node) tick slightly on every poll and can
 * briefly spike on short poll intervals due to Windows 15.625 ms CPU tick quantization. Deltas
 * below both floors are treated as idle noise.
 */
const MIN_ACTIVE_CPU_MS_PER_MIN = 1_000; // ~1.7% of one CPU core
const MIN_ACTIVE_IO_BYTES_PER_MIN = 32_768; // 32 KiB/min
const ACTIVITY_WINDOW_MS = 60_000;

interface ActivityPoint {
  at: number;
  cpuMs: number;
  ioBytes: number;
}

interface RunnerActivity {
  history: ActivityPoint[];
  since: number;
  reported: boolean;
}

function isMeaningfulActivity(deltaCpu: number, deltaIo: number, elapsedMs: number): boolean {
  if (elapsedMs <= 0) return deltaCpu > 0 || deltaIo > 0;
  return (
    deltaCpu * 60_000 >= MIN_ACTIVE_CPU_MS_PER_MIN * elapsedMs ||
    deltaIo * 60_000 >= MIN_ACTIVE_IO_BYTES_PER_MIN * elapsedMs
  );
}

export class StuckCommandTracker {
  private readonly runners = new Map<number, RunnerActivity>();

  /**
   * Feed one snapshot. Activity of a runner = sum of cpuMs and ioBytes over the runner's descendants
   * (NOT the runner itself; the runner's own pipe IO would mask a hung child). A runner is idle while
   * both its CPU and IO rates over the recent rolling window stay below the keepalive noise floor.
   * Returns runners idle >= idleMs that were not reported before (each runner reported once; forget
   * runners that disappeared). A runner with no descendants yet is not reported.
   */
  update(samples: ProcessSample[], rootPid: number, idleMs: number, now: number): StuckCommand[] {
    const runners = commandRunners(samples, rootPid);
    const alive = new Set(runners.map(runner => runner.pid));
    for (const pid of [...this.runners.keys()]) {
      if (!alive.has(pid)) this.runners.delete(pid);
    }

    const windowMs = Math.min(Math.max(idleMs, 0), ACTIVITY_WINDOW_MS);
    const stuck: StuckCommand[] = [];
    for (const runner of runners) {
      const descendants = descendantsWithDepth(samples, runner.pid);
      if (descendants.length === 0) {
        this.runners.delete(runner.pid);
        continue;
      }
      let cpuMs = 0;
      let ioBytes = 0;
      for (const entry of descendants) {
        cpuMs += entry.sample.cpuMs || 0;
        ioBytes += entry.sample.ioBytes || 0;
      }
      const point: ActivityPoint = { at: now, cpuMs, ioBytes };
      const state = this.runners.get(runner.pid);
      if (!state) {
        this.runners.set(runner.pid, { history: [point], since: now, reported: false });
        continue;
      }
      const previous = state.history[state.history.length - 1];
      // A drop in cumulative counters means a child process exited, so the command tree changed state.
      if (cpuMs < previous.cpuMs || ioBytes < previous.ioBytes) {
        state.history = [point];
        state.since = now;
        continue;
      }
      state.history.push(point);
      const cutoff = now - windowMs;
      while (state.history.length > 2 && state.history[1].at <= cutoff) {
        state.history.shift();
      }
      const anchor = state.history[0];
      if (isMeaningfulActivity(cpuMs - anchor.cpuMs, ioBytes - anchor.ioBytes, now - anchor.at)) {
        state.history = [point];
        state.since = now;
        continue;
      }
      const idleMsNow = now - state.since;
      if (!state.reported && idleMsNow >= idleMs) {
        state.reported = true;
        stuck.push({ runnerPid: runner.pid, command: commandLabel(runner.command), idleMs: idleMsNow });
      }
    }
    return stuck;
  }
}

const SAMPLE_TIMEOUT_MS = 20_000;
const WINDOWS_SAMPLE_SCRIPT = [
  "@(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine,",
  "@{Name='Cpu100ns';Expression={[long]$_.KernelModeTime + [long]$_.UserModeTime}},",
  "@{Name='IoBytes';Expression={[long]$_.ReadTransferCount + [long]$_.WriteTransferCount}})",
  '| ConvertTo-Json -Compress',
].join(' ');

function runProgram(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: SAMPLE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** Kernel + user CPU time in 100 ns units to milliseconds. */
function cpu100nsToMs(value: unknown): number {
  const units = Number(value);
  return Number.isFinite(units) ? units / 10_000 : 0;
}

/** Parse ps cputime `[[dd-]hh:]mm:ss` (fractional seconds allowed) to milliseconds. */
function parseCpuTime(text: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!match) return 0;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return Math.round((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000);
}

async function sampleWindows(): Promise<ProcessSample[]> {
  const output = await runProgram('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SAMPLE_SCRIPT]);
  if (!output.trim()) return [];
  const parsed = JSON.parse(output);
  const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map(row => {
    const item = row as Record<string, unknown>;
    return {
      pid: Number(item.ProcessId),
      ppid: Number(item.ParentProcessId),
      command: item.CommandLine === null || item.CommandLine === undefined ? '' : String(item.CommandLine),
      cpuMs: cpu100nsToMs(item.Cpu100ns),
      ioBytes: Number(item.IoBytes) || 0,
    };
  });
}

async function samplePosix(): Promise<ProcessSample[]> {
  const output = await runProgram('ps', ['-A', '-o', 'pid=,ppid=,time=,args=']);
  const samples: ProcessSample[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(line);
    if (!match) continue;
    samples.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[4] ?? '',
      cpuMs: parseCpuTime(match[3]),
      ioBytes: 0,
    });
  }
  return samples;
}

/** One snapshot of all processes. win32: Get-CimInstance via PowerShell; others: `ps`. Never throws: returns [] on failure. */
export async function sampleProcesses(): Promise<ProcessSample[]> {
  try {
    return process.platform === 'win32' ? await sampleWindows() : await samplePosix();
  } catch {
    return [];
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function taskkill(pid: number): Promise<void> {
  return new Promise(resolve => {
    try {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: SAMPLE_TIMEOUT_MS }, () => resolve());
    } catch {
      resolve();
    }
  });
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // The process already exited, which is what we wanted.
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stop the stuck command but keep the runner alive so the runtime sees the command exit and settles the job: kill each direct child of the runner with its whole tree (win32: `taskkill /PID <pid> /T /F`; others: SIGTERM the descendants deepest-first, then SIGKILL survivors after 2 s). Never throws. */
export async function stopCommand(runnerPid: number, samples: ProcessSample[]): Promise<void> {
  try {
    const directChildren = samples.filter(sample => sample.ppid === runnerPid && sample.pid !== runnerPid);
    if (directChildren.length === 0) return;

    if (process.platform === 'win32') {
      await Promise.all(directChildren.map(child => taskkill(child.pid)));
      return;
    }

    const descendants = descendantsWithDepth(samples, runnerPid)
      .sort((left, right) => right.depth - left.depth);
    for (const entry of descendants) signal(entry.sample.pid, 'SIGTERM');
    await wait(2000);
    for (const entry of descendants) {
      if (isRunning(entry.sample.pid)) signal(entry.sample.pid, 'SIGKILL');
    }
  } catch {
    // Stopping is best effort; the watchdog must never crash the runtime.
  }
}

export interface StuckWatchdogOptions {
  rootPid: () => number | undefined;
  idleMinutes: () => number;
  pollMs?: number;
  sample?: () => Promise<ProcessSample[]>;
  stop?: (runnerPid: number, samples: ProcessSample[]) => Promise<void>;
  onStuck: (command: StuckCommand) => void;
  now?: () => number;
}

/** Polls with an unref'd timer; no overlapping ticks; errors in a tick are swallowed. */
export function startStuckCommandWatchdog(options: StuckWatchdogOptions): { stop(): void; tick(): Promise<void> } {
  const pollMs = options.pollMs ?? 30_000;
  const sample = options.sample ?? sampleProcesses;
  const stopCommandTree = options.stop ?? stopCommand;
  const now = options.now ?? Date.now;
  const tracker = new StuckCommandTracker();
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const rootPid = options.rootPid();
      if (rootPid === undefined) return;
      const idleMinutes = options.idleMinutes();
      if (!(idleMinutes > 0)) return;
      const samples = await sample();
      const stuck = tracker.update(samples, rootPid, idleMinutes * 60_000, now());
      for (const command of stuck) {
        try {
          await stopCommandTree(command.runnerPid, samples);
        } catch {
          // Report it anyway; the command is still stuck even if stopping failed.
        }
        options.onStuck(command);
      }
    } catch {
      // A failed sample or a bad process table should not kill the watchdog.
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => { void tick(); }, pollMs);
  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
    tick,
  };
}
