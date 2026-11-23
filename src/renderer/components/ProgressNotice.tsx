/**
 * The newest long-running task (store progressTasks, from the engine's `progressNotice`) as notice data for the
 * notice row. EngineNotice uses it when there is no engine error.
 *
 *   const progress = useProgressNotice();
 *   progress.notice()    NoticeData | undefined for the newest task
 *   progress.dismiss()   removes that task
 *
 * Running: info tone, a working loader, title + muted message, the determinate bar when percent is known.
 * Done: the same line (same key) morphs in place, loader → check, text retypes, then the task leaves after
 * a few seconds. Error: its own key, so it slides in as a new line in the error tone and stays until dismissed.
 */
import { createEffect, createMemo, onCleanup, type Accessor } from 'solid-js';
import { dismissProgressTask, progressTasks, type ProgressTask } from '../store';
import type { LoaderShape } from './loaders';
import type { NoticeData } from './Notice';

/** How long a finished task stays on screen. */
const doneLingerMs = 4000;

/** Downloads and updates pull; anything else just works. */
function runningLoader(task: ProgressTask): LoaderShape {
  return /updat|download|install|fetch/i.test(task.title) ? 'pull' : 'pixels';
}

function taskNotice(task: ProgressTask): NoticeData {
  if (task.state === 'error') {
    return {
      key: `progress-error:${task.id}`,
      tone: 'error',
      message: task.title,
      detail: task.message,
    };
  }
  if (task.state === 'done') {
    return {
      key: `progress:${task.id}`,
      tone: 'info',
      loader: 'done',
      message: task.title,
      detail: task.message,
      // A task that showed a bar fills it to the end, then the bar fades.
      percent: task.percent === undefined ? undefined : 100,
    };
  }
  return {
    key: `progress:${task.id}`,
    tone: 'info',
    loader: runningLoader(task),
    message: task.title,
    detail: task.message,
    percent: task.percent,
  };
}

export function useProgressNotice(): { notice: Accessor<NoticeData | undefined>; dismiss: () => void } {
  const newest = createMemo(() => {
    const tasks = progressTasks();
    let latest: ProgressTask | undefined;
    for (const task of tasks) {
      if (!latest || task.updatedAt >= latest.updatedAt) latest = task;
    }
    return latest;
  });

  // One timer per finished task, keyed by the update it finished on; a task that runs again cancels it.
  const doneTimers = new Map<string, { updatedAt: number; handle: number }>();
  createEffect(() => {
    const tasks = progressTasks();
    const finished = new Map(tasks.filter(task => task.state === 'done').map(task => [task.id, task]));
    for (const [id, timer] of doneTimers) {
      const task = finished.get(id);
      if (!task || task.updatedAt !== timer.updatedAt) {
        window.clearTimeout(timer.handle);
        doneTimers.delete(id);
      }
    }
    for (const task of finished.values()) {
      if (doneTimers.has(task.id)) continue;
      const handle = window.setTimeout(() => {
        doneTimers.delete(task.id);
        dismissProgressTask(task.id);
      }, doneLingerMs);
      doneTimers.set(task.id, { updatedAt: task.updatedAt, handle });
    }
  });
  onCleanup(() => {
    for (const timer of doneTimers.values()) window.clearTimeout(timer.handle);
    doneTimers.clear();
  });

  const notice = createMemo(() => {
    const task = newest();
    return task ? taskNotice(task) : undefined;
  });

  return {
    notice,
    dismiss: () => {
      const task = newest();
      if (task) dismissProgressTask(task.id);
    },
  };
}
