/**
 * Files route (Figma 20 · Files + Editor 306:1623).
 *
 * Exports the two halves separately so the Shell can put FilesPanel in its side-panel slot (like ChatsPanel)
 * and FilesEditor in the content card, which is how Figma draws it. `FilesScreen` is the composite for the
 * content card alone: panel on the left, editor filling the rest.
 */
import type { JSX } from 'solid-js';
import { FilesEditor } from './FilesEditor';
import { FilesPanel } from './FilesPanel';
import './files.css';

export { FilesEditor } from './FilesEditor';
export { FilesPanel } from './FilesPanel';

export function FilesScreen(): JSX.Element {
  return (
    <div class="files-screen">
      <div class="files-screen-panel">
        <FilesPanel />
      </div>
      <FilesEditor />
    </div>
  );
}
