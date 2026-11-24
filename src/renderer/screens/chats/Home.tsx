/**
 * Home (Figma 10 Home 306:1556, 10b choose project 306:11820): the bottom layer of the window.
 *
 * It holds the backdrop logo, the display title, a composer that starts a new chat, the prompts scheduled from
 * Home (ScheduleBar with no chatId), and the project chip
 * that picks which folder that chat starts in. Panes and screens are drawn over it; the shell marks it
 * `inert` while something covers it, so it never takes focus from behind.
 *
 * Sending from Home: `newSession` (with the picked project) then `sendPrompt`, exactly as DSH's "new chat,
 * then type" flow. When the engine reports the new active session, it opens in a pane.
 */
import { createSignal, onCleanup, onMount, type JSX } from 'solid-js';
import { Backdrop } from '../../backdrop/Backdrop';
import { post } from '../../bridge';
import { Button } from '../../components';
import { createSpring } from '../../motion';
import type { SidebarImage } from '../../protocol';
import { onHostMessage, rememberSentImages, viewState } from '../../store';
import { openChat } from '../../shell/layout';
import { Composer } from './Composer';
import { openProjectFolder, ProjectPicker } from './ProjectPicker';
import { ScheduleBar } from './ScheduleBar';
import { isNoFolder, newSessionTarget, parentFolder, selectedProject } from './projects';
import './home.css';

/** Waits for the session just asked for with `newSession`, then opens it in a pane. */
export function openNextNewSession(images: SidebarImage[] = []): void {
  const known = new Set(viewState.sessions.map(session => session.id));
  const stop = onHostMessage(message => {
    if (message.type !== 'sessionState') return;
    const sessionId = message.activeSessionId;
    if (!sessionId || known.has(sessionId)) return;
    stop();
    window.clearTimeout(giveUp);
    if (images.length) rememberSentImages(sessionId, images);
    openChat(sessionId);
  });
  const giveUp = window.setTimeout(stop, 15000);
}

export function Home(props: { covered: boolean }): JSX.Element {
  const [chip, setChip] = createSignal<HTMLButtonElement>();
  const [pickerOpen, setPickerOpen] = createSignal(false);
  // While panes cover Home only the backdrop logo may show through the gutters, so the title and
  // composer fade away (Control token; a plain fade, so reduced motion keeps it too).
  const columnOpacity = createSpring(() => (props.covered ? 0 : 1), 'control', { fadeOnly: true });
  // One chevron that turns over (Indicator token) instead of swapping chevron/chevronUp icons.
  const chevronRotation = createSpring(() => (pickerOpen() ? 180 : 0), 'indicator', { precision: 100 });

  const projectLabel = () => {
    const project = selectedProject();
    if (!project) return 'Choose project';
    const parent = parentFolder(project.path);
    return parent ? `${parent} / ${project.name}` : project.name;
  };

  const placeholder = () => {
    const project = selectedProject();
    if (isNoFolder(project)) return 'Ask anything';
    return project ? `Ask anything in ${project.name}, @ to mention a file` : 'Ask anything, @ to mention a file';
  };

  const start = (prompt: string, images: SidebarImage[]) => {
    // `/shutdown` only arms the shutdown; it needs no chat.
    if (/^\s*\/shutdown\s*$/i.test(prompt)) {
      post({ type: 'sendPrompt', prompt, images: [] });
      return;
    }
    openNextNewSession(images);
    post({ type: 'newSession', ...newSessionTarget(selectedProject()) });
    post({ type: 'sendPrompt', prompt, images });
  };

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (props.covered) return;
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        void openProjectFolder();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => window.removeEventListener('keydown', onKeyDown));
    // Dev screenshots (tools/shot.mjs "home?open=picker") open the picker without a click.
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('open') === 'picker') {
      window.setTimeout(() => setPickerOpen(true), 300);
    }
  });

  return (
    <div class="home" inert={props.covered}>
      <Backdrop />
      <div
        class="home-column"
        style={{ opacity: columnOpacity(), visibility: columnOpacity() < 0.01 ? 'hidden' : 'visible' }}
      >
        <h1 class="home-title type-display">Unify</h1>
        <Composer class="home-composer" placeholder={placeholder()} onSubmit={start} autofocus={!props.covered} />
        <ScheduleBar />
        <div class="home-project">
          <Button
            ref={setChip}
            class="home-project-chip"
            classList={{ open: pickerOpen() }}
            style={{ '--chip-chevron-rotate': `${chevronRotation()}deg` }}
            icon="folder"
            trailingIcon="chevron"
            aria-haspopup="dialog"
            aria-expanded={pickerOpen()}
            onClick={() => setPickerOpen(!pickerOpen())}
          >
            {projectLabel()}
          </Button>
        </div>
      </div>
      <ProjectPicker anchor={chip()} open={pickerOpen()} onClose={() => setPickerOpen(false)} />
    </div>
  );
}
