/**
 * Knowledge route (Figma 21 · Knowledge 306:2710): rules, skills and memory as one file tree.
 *
 * Exports the two halves separately, like Providers: `KnowledgePanel` for the Shell's side-panel slot and
 * `KnowledgeContent` for the content card. `KnowledgeScreen` is the composite used when the screen owns both.
 */
import type { JSX } from 'solid-js';
import { KnowledgeDocument } from './KnowledgeDocument';
import { KnowledgePanel } from './KnowledgePanel';
import './knowledge.css';

export { KnowledgePanel } from './KnowledgePanel';

/** The right-hand side: the open document with its Details column. Fills its parent. */
export function KnowledgeContent(): JSX.Element {
  return (
    <main class="knowledge-main">
      <KnowledgeDocument />
    </main>
  );
}

export function KnowledgeScreen(): JSX.Element {
  return (
    <div class="knowledge-screen">
      <div class="knowledge-screen-panel">
        <KnowledgePanel />
      </div>
      <KnowledgeContent />
    </div>
  );
}
