/**
 * STUB SCREENS. Placeholders for routes that are not built yet; each says which Figma frame to build from.
 * Replace one by writing screens/<route>/<Name>Screen.tsx and pointing its entry in screens/index.ts at it
 * (see screens/README.md). Delete the entry here once it is gone.
 */
import type { JSX } from 'solid-js';
import type { RouteId } from '../router';
import './stubs.css';

interface StubInfo {
  title: string;
  description: string;
}

const stubInfo: Record<Exclude<RouteId, 'chats'>, StubInfo> = {
  files: { title: 'Files', description: 'Project files and diffs. Not built yet.' },
  knowledge: { title: 'Knowledge', description: 'Instructions, memory and rules. Not built yet.' },
  toolpacks: { title: 'Toolpacks', description: 'Installed toolpacks and their tools. Not built yet.' },
  hub: { title: 'Hub', description: 'Browse and install toolpacks. Not built yet.' },
  providers: { title: 'Providers', description: 'Accounts, models and usage. Not built yet.' },
  settings: { title: 'Settings', description: 'Appearance, features and accessibility. Not built yet.' },
  setup: { title: 'Setup', description: 'First-run setup. Not built yet.' },
};

export function StubScreen(props: { route: Exclude<RouteId, 'chats'> }): JSX.Element {
  return (
    <div class="stub-screen" data-stub={props.route}>
      <h2 class="type-title">{stubInfo[props.route].title}</h2>
      <p class="type-body">{stubInfo[props.route].description}</p>
    </div>
  );
}
