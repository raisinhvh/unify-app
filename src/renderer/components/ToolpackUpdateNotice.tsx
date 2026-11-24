/**
 * The toolpack-updates line in the notice row (EngineNotice shows it after engine errors and progress tasks).
 *
 *   "Blender and Imaging have updates"   Review (the first pack's Hub detail) · Update (installs them, one by one)
 *   "Updating Blender…"                   while the notice's Update runs, with the install percent
 *   "Updated Blender to 1.3"              what auto-update installed by itself (`toolpacks.autoUpdate`)
 *
 * Dismiss hides the updates line until the list of updates (ids and versions) changes.
 */
import { createSignal, type Accessor } from 'solid-js';
import {
  autoUpdated,
  dismissAutoUpdated,
  installs,
  reviewUpdate,
  toolpackUpdates,
  updateAll,
  updateQueue,
} from '../screens/hub/hubAdapter';
import type { NoticeData } from './Notice';

/** "Blender", "Blender and Imaging", "Blender, Imaging and 2 more". */
function namesText(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

export function useToolpackUpdateNotice(): { notice: Accessor<NoticeData | undefined>; dismiss: () => void } {
  const [dismissedKey, setDismissedKey] = createSignal<string>();
  const updatesKey = () => toolpackUpdates().map(update => `${update.id}@${update.toVersion}`).join(',');

  const notice = (): NoticeData | undefined => {
    const updating = updateQueue()[0];
    if (updating) {
      const update = toolpackUpdates().find(item => item.id === updating);
      const progress = installs()[updating];
      return {
        message: `Updating ${update?.name ?? updating}…`,
        tone: 'info',
        key: 'toolpack-updates',
        loader: 'pull',
        ...(progress && progress.state !== 'error' ? { percent: progress.percent } : {}),
      };
    }
    const updates = toolpackUpdates();
    if (updates.length && dismissedKey() !== updatesKey()) {
      const names = updates.map(update => update.name);
      return {
        message: `${namesText(names)} ${updates.length === 1 ? 'has an update' : 'have updates'}`,
        tone: 'info',
        key: 'toolpack-updates',
        secondaryAction: { label: 'Review', run: () => reviewUpdate(updates[0].id) },
        action: { label: 'Update', run: () => updateAll(updates.map(update => update.id)) },
      };
    }
    const done = autoUpdated();
    if (done.length) {
      return {
        message: done.length === 1 ? `Updated ${done[0].name} to ${done[0].version}` : `Updated ${done.length} toolpacks`,
        tone: 'info',
        key: 'toolpack-auto-updated',
      };
    }
    return undefined;
  };

  const dismiss = () => {
    if (toolpackUpdates().length && dismissedKey() !== updatesKey() && !updateQueue().length) setDismissedKey(updatesKey());
    else dismissAutoUpdated();
  };

  return { notice, dismiss };
}
