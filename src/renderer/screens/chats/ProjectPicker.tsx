/**
 * The project picker under Home's composer (Figma 10b Home choose project, 306:11820).
 *
 *   Recent projects
 *   ▾ Programs              (parent folder)
 *       Unify          ✓    (selected project)
 *       Tools          2d   (last used)
 *   ▸ Roblox           3    (closed folders show how many projects they hold)
 *   ───────────
 *   ▢ No folder              (chat in its own empty scratch folder)
 *   + Open folder…   Ctrl O
 *
 * Picking a project only changes where Home's next chat starts; it never opens anything.
 * The Knowledge panel reuses it (with `selected` / `onSelect`, and no "No folder" row) to pick whose project
 * rules, skills and memory it shows.
 */
import { createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { bridge } from '../../bridge';
import type { SidebarProject } from '../../protocol';
import { Icon, Popover, TreeFolder, TreeItem } from '../../components';
import { isNoFolder, knownProjects, noFolderProject, parentFolder, projectName, relativeAge, rememberProject, selectedProject, selectProject, type KnownProject } from './projects';

interface ParentGroup {
  name: string;
  projects: KnownProject[];
}

export interface ProjectPickerProps {
  anchor: HTMLElement | undefined;
  open: boolean;
  onClose: () => void;
  /** The checked project; Home's selected project by default. */
  selected?: SidebarProject;
  /** Called with the picked project; Home's selectProject by default. "Open folder…" also adds it to recents. */
  onSelect?: (project: SidebarProject) => void;
  /** Show the "No folder" row (default true). */
  noFolder?: boolean;
  placement?: 'bottom-start' | 'bottom-end';
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
  const current = () => (props.onSelect ? props.selected : selectedProject());
  const selectedParent = () => {
    const project = current();
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

  const choose = (project: SidebarProject) => {
    const picked = { name: project.name, path: project.path };
    if (props.onSelect) props.onSelect(picked);
    else selectProject(picked);
    props.onClose();
  };

  const openFolder = async () => {
    props.onClose();
    if (!props.onSelect) return openProjectFolder();
    const path = await bridge().pickFolder();
    if (!path) return;
    const picked = { name: projectName(path), path };
    rememberProject(picked);
    props.onSelect(picked);
  };

  return (
    <Popover anchor={props.anchor} open={props.open} onClose={props.onClose} placement={props.placement ?? 'bottom-start'} offset={6} class="project-picker">
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
                  const selected = () => current()?.path === project.path;
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
        <Show when={props.noFolder !== false}>
          <TreeItem
            class="project-picker-open"
            leading={<Icon name="chats" class="tree-folder-icon" />}
            label="No folder"
            selected={isNoFolder(current())}
            trailing={isNoFolder(current()) ? <Icon name="check" class="project-picker-check" /> : ''}
            onClick={() => choose(noFolderProject)}
          />
        </Show>
        <TreeItem
          class="project-picker-open"
          leading={<Icon name="plus" class="tree-folder-icon" />}
          label="Open folder…"
          trailing={props.onSelect ? '' : 'Ctrl O'}
          onClick={() => void openFolder()}
        />
      </div>
    </Popover>
  );
}
