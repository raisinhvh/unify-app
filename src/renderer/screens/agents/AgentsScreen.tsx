/**
 * Agents route: everything about how agents run.
 *
 *   panel   General, then the Subagents folder (one row per profile) and a new-subagent button
 *   pages   General (explorer, helper models, how subagents run), one profile, or a new profile
 *
 * Laid out like Providers: the side panel at --panel-width, the page column beside it. Pages spring between
 * each other with the Settings PageStack; switching between two profiles swaps the profile page in place.
 */
import type { JSX } from 'solid-js';
import { PageStack } from '../settings/PageStack';
import { AgentsPanel } from './AgentsPanel';
import { GeneralPage } from './GeneralPage';
import { NewProfilePage, ProfilePage } from './ProfilePage';
import { selection } from './selection';
import '../settings/settings.css';
import './agents.css';

type PageKey = 'general' | 'profile' | 'new';

const pages: readonly PageKey[] = ['general', 'profile', 'new'];

function renderPage(key: PageKey): JSX.Element {
  const page = key === 'general' ? <GeneralPage /> : key === 'profile' ? <ProfilePage /> : <NewProfilePage />;
  return <div class="agents-column">{page}</div>;
}

export { AgentsPanel } from './AgentsPanel';

export function AgentsScreen(): JSX.Element {
  return (
    <div class="agents-screen">
      <div class="agents-screen-panel">
        <AgentsPanel />
      </div>
      <PageStack
        class="agents-main"
        pageClass="agents-page"
        active={selection().kind}
        pages={pages}
        axis="y"
        distance={24}
        render={renderPage}
      />
    </div>
  );
}
