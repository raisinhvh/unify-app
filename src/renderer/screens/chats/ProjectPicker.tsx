/**
 * The project picker under Home's composer (Figma 10b Home choose project, 306:11820).
 *
 *   Recent projects
 *   ▾ Programs              (parent folder)
 *       DSH            ✓    (selected project)
 *       Unify          2d   (last used)
 *   ▸ Roblox           3    (closed folders show how many projects they hold)
 *   ───────────
 *   + Open folder…   Ctrl O
 *
 * Picking a project only changes where Home's next chat starts; it never opens anything.
 */
import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { bridge } from '../../bridge';
import { Icon, Popover, TreeFolder, TreeItem } from '../../components';
import { knownProjects, parentFolder, projectName, relativeAge, selectedProject, selectProject, type KnownProject } from './projects';

interface ParentGroup {
  name: string;
  projects: KnownProject[];
}

export interface ProjectPickerProps {
  anchor: HTMLElement | undefined;
  open: boolean;
  onClose: () => void;
}

/** Asks the host for a folder and makes it the selected project. Also bound to Ctrl+O on Home. */
export async function openProjectFolder(): Promise<void> {
  const path = await bridge().pickFolder();
  if (!path) return;
  selectProject({ name: projectName(path), path });
}

export function ProjectPicker(props: ProjectPickerProps): JSX.Element {
  const groups = createMemo<ParentGroup[]>(() => {
    const byParent = new Map<string, ParentGroup>();
    for (const project of knownProjects()) {
      const name = parentFolder(project.path) || project.path;
      let group = byParent.get(name);
      if (!group) {
        group = { name, projects: [] };
        byParent.set(name, group);
      }
      group.projects.push(project);
    }
    return [...byParent.values()];
  });

  // Folders start closed, except the one holding the selected project.
  const [openFolders, setOpenFolders] = createSignal<string[]>([]);
  const [closedByUser, setClosedByUser] = createSignal<string[]>([]);
  const selectedParent = () => {
    const project = selectedProject();
    return project ? parentFolder(project.path) || project.path : '';
  };
  const isOpen = (name: string) => openFolders().includes(name) || (name === selectedParent() && !closedByUser().includes(name));

  const toggleFolder = (name: string, open: boolean) => {
    if (open) {
      setOpenFolders(current => [...current, name]);
      setClosedByUser(current => current.filter(item => item !== name));
    } else {
      setOpenFolders(current => current.filter(item => item !== name));
      setClosedByUser(current => [...current, name]);
    }
  };

  const choose = (project: KnownProject) => {
    selectProject({ name: project.name, path: project.path });
    props.onClose();
  };

  const openFolder = () => {
    props.onClose();
    void openProjectFolder();
  };

  return (
    <Popover anchor={props.anchor} open={props.open} onClose={props.onClose} placement="bottom-start" offset={6} class="project-picker">
      <div class="project-picker-body">
        <div class="project-picker-caption type-caption">Recent projects</div>
        <Show when={groups().length === 0}>
          <div class="project-picker-empty type-caption">No projects yet</div>
        </Show>
        <For each={groups()}>
          {group => (
            <TreeFolder
              icon="folder"
              label={group.name}
              trailing={isOpen(group.name) ? '' : String(group.projects.length)}
              open={isOpen(group.name)}
              onToggle={open => toggleFolder(group.name, open)}
            >
              <For each={group.projects}>
                {project => {
                  const selected = () => selectedProject()?.path === project.path;
                  return (
                    <TreeItem
                      leading={<Icon name="folder" class="tree-folder-icon" />}
                      label={project.name}
                      selected={selected()}
                      trailing={selected() ? <Icon name="check" class="project-picker-check" /> : relativeAge(project.usedAt)}
                      onClick={() => choose(project)}
                    />
                  );
                }}
              </For>
            </TreeFolder>
          )}
        </For>
        <div class="menu-separator" />
        <TreeItem
          class="project-picker-open"
          leading={<Icon name="plus" class="tree-folder-icon" />}
          label="Open folder…"
          trailing="Ctrl O"
          onClick={openFolder}
        />
      </div>
    </Popover>
  );
}
