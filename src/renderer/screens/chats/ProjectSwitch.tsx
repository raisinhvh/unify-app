/**
 * Which project folder a side panel shows (Files, Knowledge): a full-width row with the project's name and a
 * dimmer short path; clicking opens the recent-projects picker (with "Open folder…").
 *
 *   <ProjectSwitch path={root()} onSelect={setProject} />
 */
import { createSignal, Show, type JSX } from 'solid-js';
import { Icon } from '../../components';
import type { SidebarProject } from '../../protocol';
import { ProjectPicker } from './ProjectPicker';
import { projectName, shortPath } from './projects';
import './projectSwitch.css';

export interface ProjectSwitchProps {
  /** The folder shown; undefined when no project is open. */
  path: string | undefined;
  /** Display name; the folder's own name by default. */
  name?: string;
  onSelect: (project: SidebarProject) => void;
  class?: string;
}

export function ProjectSwitch(props: ProjectSwitchProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [anchor, setAnchor] = createSignal<HTMLButtonElement>();
  const name = () => props.name ?? (props.path ? projectName(props.path) : 'No project open');
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        class={`project-switch${props.class ? ' ' + props.class : ''}`}
        classList={{ open: open() }}
        title={props.path ? `${props.path}\nClick to switch project` : 'Pick a project folder'}
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <Icon name="folder" size={14} />
        <span class="project-switch-name">{name()}</span>
        <Show when={props.path}>
          <span class="project-switch-path type-caption">{shortPath(props.path!)}</span>
        </Show>
        <Icon name="chevron" size={14} class="project-switch-chevron" />
      </button>
      <ProjectPicker
        anchor={anchor()}
        open={open()}
        onClose={() => setOpen(false)}
        selected={props.path ? { name: name(), path: props.path } : undefined}
        onSelect={props.onSelect}
        noFolder={false}
      />
    </>
  );
}
