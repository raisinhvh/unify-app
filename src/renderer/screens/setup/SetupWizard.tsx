/**
 * Setup wizard (Figma 26a–26f: welcome 306:13868, providers 13928, project 13990, tools 14054, extras 14120,
 * done 14188).
 *
 *   welcome    a big title and "Get started", straight over Home (covered) and the backdrop
 *   steps      a 280px steps panel on the left (a Setup folder with one row per step) slides in; each step is a
 *              560px column: breadcrumb, title, lede, hairline, sections, then a footer with Back and Continue
 *
 * Steps move through the Settings PageStack on the x axis, so Continue slides content left and Back slides it
 * right. The Shell mounts <SetupWizard /> over Home while `shouldShowSetup()` is true and passes Home `covered`.
 */
import { createEffect, createMemo, createSignal, For, onMount, Show, type JSX } from 'solid-js';
import { bridge } from '../../bridge';
import { Button, Icon, TreeFolder, TreeItem } from '../../components';
import { ModelPicker } from '../../components/ModelPicker';
import { LogoMark } from '../../backdrop/Backdrop';
import { createSpring, pressable } from '../../motion';
import type { SidebarProject } from '../../protocol';
import { currentTheme, themeNames } from '../../theme';
import { knownProjects, parentFolder, projectName, relativeAge, selectedProject, selectProject, shortPath } from '../chats/projects';
import { modelOptions } from '../chats/models';
import { AddProviderDialog } from '../providers/AddProviderDialog';
import {
  accountStateLabel,
  addProviderOptions,
  allAccounts,
  connectOAuth,
  providerTitle,
  signIn,
  type AccountView,
  type AddProviderOption,
} from '../providers/adapter';
import { ProviderGlyph } from '../../components/ProviderGlyph';
import { setAddProviderOpen } from '../providers/selection';
import { PageStack } from '../settings/PageStack';
import { ThemeCards } from '../settings/ThemePicker';
import { checkTools, fixTool, markSetupComplete, requestSetupState, setDefaultProject, tools, type ToolStatus } from './adapters';
import {
  fixFailed,
  goToStep,
  hasWorkingAccount,
  missingRequiredTools,
  nextStep,
  previousStep,
  projectChoice,
  reached,
  setDraftProject,
  setExtra,
  setFixFailed,
  setupNeeded,
  setupSteps,
  step,
  stepIndex,
  toolsSettled,
  watchAccounts,
  type SetupStepId,
} from './setupState';
import '../providers/providers.css';
import '../settings/settings.css';
import './setup.css';

/** Whether the wizard should cover the app (first run, or something required broke since). */
export function shouldShowSetup(): boolean {
  return setupNeeded();
}

const stepIds = setupSteps.map(info => info.id);
const stepLabel = (id: SetupStepId): string => setupSteps.find(info => info.id === id)?.label ?? id;

/* Layout pieces */

interface StepFooter {
  /** Muted text left of Continue ("Add a working account to continue"). */
  status?: JSX.Element;
  continueLabel?: string;
  continueDisabled?: boolean;
  onContinue: () => void;
  /** A text button before Continue (Skip on Extras). */
  secondary?: { label: string; onClick: () => void };
}

function StepLayout(props: { id: SetupStepId; title: string; lede: JSX.Element; footer: StepFooter; children: JSX.Element }): JSX.Element {
  return (
    <div class="setup-column">
      <div class="setup-crumb type-caption">
        <span>Setup</span>
        <span aria-hidden="true">/</span>
        <span class="setup-crumb-current">{stepLabel(props.id)}</span>
      </div>
      <h1 class="setup-title type-title">{props.title}</h1>
      <p class="setup-lede">{props.lede}</p>
      <div class="setup-rule" />
      <div class="setup-body">{props.children}</div>
      <footer class="setup-footer">
        <Button variant="text" class="setup-back" onClick={previousStep}>Back</Button>
        <div class="setup-footer-end">
          <Show when={props.footer.status}>
            <span class="setup-footer-status type-caption">{props.footer.status}</span>
          </Show>
          <Show when={props.footer.secondary}>
            <Button variant="text" onClick={() => props.footer.secondary!.onClick()}>{props.footer.secondary!.label}</Button>
          </Show>
          <Button variant="primary" disabled={props.footer.continueDisabled} onClick={() => props.footer.onContinue()}>
            {props.footer.continueLabel ?? 'Continue'}
          </Button>
        </div>
      </footer>
    </div>
  );
}

function SetupSection(props: { title: string; trailing?: JSX.Element; children: JSX.Element }): JSX.Element {
  return (
    <section class="setup-section">
      <div class="setup-section-head">
        <h2 class="type-heading">{props.title}</h2>
        <Show when={props.trailing}>
          <span class="setup-section-trailing type-caption">{props.trailing}</span>
        </Show>
      </div>
      {props.children}
    </section>
  );
}

/** One list row: icon, label (with an optional muted second part), and whatever sits on the right. */
function SetupRow(props: {
  leading?: JSX.Element;
  label: JSX.Element;
  detail?: JSX.Element;
  caption?: JSX.Element;
  children?: JSX.Element;
  onClick?: () => void;
}): JSX.Element {
  const content = (
    <>
      <span class="setup-row-leading">{props.leading}</span>
      <span class="setup-row-text">
        <span class="setup-row-label">
          {props.label}
          <Show when={props.detail}>
            <span class="setup-row-detail">{props.detail}</span>
          </Show>
        </span>
        <Show when={props.caption}>
          <span class="setup-row-caption type-caption">{props.caption}</span>
        </Show>
      </span>
      <span class="setup-row-end">{props.children}</span>
    </>
  );
  return (
    <Show when={props.onClick} fallback={<div class="setup-row">{content}</div>}>
      <button type="button" class="setup-row clickable" ref={element => pressable(element, 0.99)} onClick={() => props.onClick!()}>
        {content}
      </button>
    </Show>
  );
}

function StateMark(props: { label: string; tone?: 'ok' | 'warn' | 'muted' }): JSX.Element {
  return (
    <span class="setup-state type-caption" classList={{ warn: props.tone === 'warn', muted: props.tone === 'muted' }}>
      <Show when={props.tone === 'ok'}>
        <Icon name="check" size={14} class="setup-state-check" />
      </Show>
      {props.label}
    </span>
  );
}

/* Steps panel */

function StepsPanel(): JSX.Element {
  const current = () => stepIndex(step());
  const done = (id: SetupStepId) => stepIndex(id) < current();
  const reachable = (id: SetupStepId) => stepIndex(id) <= reached();
  return (
    <aside class="setup-steps" aria-label="Setup steps">
      <div class="setup-brand">
        <LogoMark size={24} />
        <span class="type-heading">Unify</span>
      </div>
      <TreeFolder label="Setup" icon="folder" trailing={`${current() + 1} of ${stepIds.length}`} open onToggle={() => undefined}>
        <For each={setupSteps}>
          {info => (
            <TreeItem
              leading={
                <Show when={done(info.id)}>
                  <Icon name="check" size={14} />
                </Show>
              }
              label={info.label}
              trailing={info.optional ? 'optional' : undefined}
              selected={step() === info.id}
              tone={reachable(info.id) ? undefined : 'muted'}
              disabled={!reachable(info.id)}
              onClick={() => goToStep(info.id)}
            />
          )}
        </For>
      </TreeFolder>
      <p class="setup-steps-foot type-caption">Settings live in ~/.unify</p>
    </aside>
  );
}

/* 26a Welcome */

function WelcomeStep(): JSX.Element {
  return (
    <div class="setup-welcome">
      <h1 class="setup-welcome-title type-display">The last AI interaction interface you ever install</h1>
      <Button variant="primary" class="setup-welcome-start" onClick={nextStep}>Get started</Button>
    </div>
  );
}

/* 26b Providers */

function accountTone(account: AccountView): 'ok' | 'warn' | 'muted' {
  if (account.status === 'connected') return 'ok';
  if (account.status === 'loading') return 'muted';
  return 'warn';
}

function addAccount(option: AddProviderOption): void {
  if (option.method === 'oauth') connectOAuth(option);
  else setAddProviderOpen(true);
}

function ProvidersStep(): JSX.Element {
  const accounts = () => allAccounts();
  const working = () => accounts().filter(account => account.status === 'connected').length;
  return (
    <StepLayout
      id="providers"
      title="Connect a provider"
      lede="Unify needs at least one working account. Provider CLIs you are already signed in to are picked up automatically."
      footer={{
        status: hasWorkingAccount() ? undefined : 'Add a working account to continue',
        continueDisabled: !hasWorkingAccount(),
        onContinue: nextStep,
      }}
    >
      <SetupSection title="Your accounts" trailing={working() ? <StateMark label={`${working()} working`} tone="ok" /> : undefined}>
        <For each={accounts()} fallback={<p class="setup-empty type-caption">No accounts yet. Add one below.</p>}>
          {account => (
            <SetupRow
              leading={<ProviderGlyph provider={account.provider} size={16} />}
              label={providerTitle(account.provider)}
              detail={account.label}
            >
              <StateMark label={accountStateLabel(account)} tone={accountTone(account)} />
              <Show when={account.status === 'signedOut' || account.status === 'error'}>
                <Button variant="text" onClick={() => signIn(account)}>Sign in</Button>
              </Show>
            </SetupRow>
          )}
        </For>
      </SetupSection>
      <SetupSection title="Add another account">
        <For each={addProviderOptions}>
          {option => (
            <SetupRow leading={<ProviderGlyph provider={option.provider} size={16} />} label={option.title} onClick={() => addAccount(option)}>
              <span class="setup-row-hint type-caption">{option.hint}</span>
              <Icon name="chevronRight" size={14} class="setup-row-chevron" />
            </SetupRow>
          )}
        </For>
      </SetupSection>
      <Show when={modelOptions().length > 0}>
        <SetupSection title="Default model">
          <SetupRow label="New chats start with" caption="Change it per chat from the composer.">
            <ModelPicker variant="regular" placeholder="Choose a model" placement="bottom-end" title="Default model" />
          </SetupRow>
        </SetupSection>
      </Show>
    </StepLayout>
  );
}

/* 26c Project folder */

interface ProjectFolderGroup {
  parent: string;
  projects: SidebarProject[];
}

function ProjectStep(): JSX.Element {
  const [closed, setClosed] = createSignal<string[]>([]);
  const [picked, setPicked] = createSignal<SidebarProject[]>([]);
  const groups = createMemo<ProjectFolderGroup[]>(() => {
    const byParent = new Map<string, SidebarProject[]>();
    const known = knownProjects();
    const all: SidebarProject[] = [...picked().filter(project => !known.some(item => item.path === project.path)), ...known];
    for (const project of all) {
      const parent = parentFolder(project.path) || 'Folders';
      byParent.set(parent, [...(byParent.get(parent) ?? []), project]);
    }
    return [...byParent.entries()].map(([parent, projects]) => ({ parent, projects }));
  });
  const usedAt = (path: string) => knownProjects().find(project => project.path === path)?.usedAt;
  const browse = async () => {
    const path = await bridge().pickFolder();
    if (!path) return;
    const project = { name: projectName(path), path };
    setPicked(list => [project, ...list.filter(item => item.path !== path)]);
    setClosed(list => list.filter(parent => parent !== (parentFolder(path) || 'Folders')));
    setDraftProject(project);
  };
  const confirm = () => {
    const project = projectChoice();
    if (!project) return;
    selectProject(project);
    setDefaultProject(project);
    nextStep();
  };
  return (
    <StepLayout
      id="project"
      title="Pick a project folder"
      lede="Agents work inside this folder. You can switch projects any time from Chats."
      footer={{
        status: projectChoice() ? shortPath(projectChoice()!.path) : 'Choose a folder to continue',
        continueDisabled: !projectChoice(),
        onContinue: confirm,
      }}
    >
      <SetupSection title="Recent folders" trailing={<Button variant="text" icon="folder" onClick={() => void browse()}>Browse…</Button>}>
        <Show when={groups().length > 0} fallback={<p class="setup-empty type-caption">No folders yet. Browse to pick one.</p>}>
          <div class="setup-tree">
            <For each={groups()}>
              {group => (
                <TreeFolder
                  label={group.parent}
                  icon="folder"
                  trailing={`${group.projects.length}`}
                  open={!closed().includes(group.parent)}
                  onToggle={open => setClosed(list => (open ? list.filter(item => item !== group.parent) : [...list, group.parent]))}
                >
                  <For each={group.projects}>
                    {project => (
                      <TreeItem
                        leading={
                          <Show when={projectChoice()?.path === project.path}>
                            <Icon name="check" size={14} />
                          </Show>
                        }
                        label={project.name}
                        trailing={relativeAge(usedAt(project.path)) || undefined}
                        selected={projectChoice()?.path === project.path}
                        title={project.path}
                        onClick={() => setDraftProject(project)}
                      />
                    )}
                  </For>
                </TreeFolder>
              )}
            </For>
          </div>
        </Show>
      </SetupSection>
    </StepLayout>
  );
}

/* 26d Tools */

function toolMark(tool: ToolStatus): { label: string; tone: 'ok' | 'warn' | 'muted' } {
  switch (tool.state) {
    case 'found':
      return { label: tool.version ? `Found ${tool.version}` : 'Found', tone: 'ok' };
    case 'missing':
      return { label: 'Missing', tone: 'warn' };
    case 'fixing':
      return { label: 'Installing…', tone: 'muted' };
    case 'error':
      return { label: 'Install failed', tone: 'warn' };
    default:
      return { label: 'Checking…', tone: 'muted' };
  }
}

function ToolsStep(): JSX.Element {
  onMount(checkTools);
  // Once a fix has failed, the user may continue without the tool (and fix it later).
  createEffect(() => {
    if (tools().some(tool => tool.state === 'error')) setFixFailed(true);
  });
  const missing = () => missingRequiredTools();
  const blocked = () => missing().length > 0 && !fixFailed();
  const status = () => {
    if (!toolsSettled()) return 'Checking your tools';
    if (missing().length === 0) return 'Everything is installed';
    return `Install ${missing().join(' and ')} to continue`;
  };
  return (
    <StepLayout
      id="tools"
      title="Check your tools"
      lede="Unify runs agents through these command-line tools. Anything missing can be installed from here."
      footer={{
        status: status(),
        continueLabel: missing().length > 0 && fixFailed() ? 'Continue anyway' : 'Continue',
        continueDisabled: blocked() || !toolsSettled(),
        onContinue: nextStep,
      }}
    >
      <SetupSection
        title="Command-line tools"
        trailing={<Button variant="text" icon="refresh" disabled={!toolsSettled()} onClick={checkTools}>Check again</Button>}
      >
        <For each={tools()}>
          {tool => (
            <SetupRow
              label={<span class="type-mono">{tool.id}</span>}
              caption={tool.state === 'error' && tool.error ? tool.error : tool.description}
            >
              <StateMark label={toolMark(tool).label} tone={toolMark(tool).tone} />
              <Show when={tool.state === 'missing' || tool.state === 'error'}>
                <Button variant="text" onClick={() => fixTool(tool.id)}>{tool.state === 'error' ? 'Try again' : 'Install'}</Button>
              </Show>
            </SetupRow>
          )}
        </For>
      </SetupSection>
    </StepLayout>
  );
}

/* 26e Extras */

function ExtrasStep(): JSX.Element {
  return (
    <StepLayout
      id="extras"
      title="Make it yours"
      lede="Optional. Pick a theme now, or change it any time in Settings."
      footer={{
        secondary: {
          label: 'Skip',
          onClick: () => {
            setExtra('theme', 'skipped');
            nextStep();
          },
        },
        onContinue: () => {
          setExtra('theme', 'done');
          nextStep();
        },
      }}
    >
      <SetupSection title="Theme" trailing={themeNames[currentTheme()]}>
        <div class="setup-theme-cards">
          <ThemeCards />
        </div>
      </SetupSection>
    </StepLayout>
  );
}

/* 26f Done */

function DoneStep(): JSX.Element {
  const working = () => allAccounts().filter(account => account.status === 'connected');
  const foundTools = () => tools().filter(tool => tool.state === 'found').map(tool => tool.id);
  const finish = () => {
    const project = projectChoice() ?? selectedProject();
    markSetupComplete({
      accounts: working().map(account => account.id),
      project,
      tools: foundTools(),
      theme: currentTheme(),
    });
  };
  return (
    <StepLayout
      id="done"
      title="You're set"
      lede="This is what Unify will use. Everything here can be changed later in Settings."
      footer={{ continueLabel: 'Open Unify', onContinue: finish }}
    >
      <SetupSection title="Summary">
        <SetupRow label="Providers">
          <span class="setup-value">
            {working().length ? working().map(account => `${providerTitle(account.provider)} ${account.label}`).join(', ') : 'None yet'}
          </span>
        </SetupRow>
        <SetupRow label="Project">
          <span class="setup-value">
            {projectChoice()?.name ?? 'None'}
            <Show when={projectChoice()}>
              <span class="setup-value-muted">{shortPath(projectChoice()!.path)}</span>
            </Show>
          </span>
        </SetupRow>
        <SetupRow label="Tools">
          <span class="setup-value">
            {missingRequiredTools().length ? `${missingRequiredTools().join(', ')} still missing` : 'All found'}
          </span>
        </SetupRow>
        <SetupRow label="Theme">
          <span class="setup-value">{themeNames[currentTheme()]}</span>
        </SetupRow>
      </SetupSection>
    </StepLayout>
  );
}

function StepPage(props: { id: SetupStepId }): JSX.Element {
  switch (props.id) {
    case 'welcome':
      return <WelcomeStep />;
    case 'providers':
      return <ProvidersStep />;
    case 'project':
      return <ProjectStep />;
    case 'tools':
      return <ToolsStep />;
    case 'extras':
      return <ExtrasStep />;
    case 'done':
      return <DoneStep />;
  }
}

/* The wizard */

export function SetupWizard(): JSX.Element {
  onMount(() => {
    watchAccounts();
    requestSetupState(project => {
      if (!selectedProject()) selectProject(project);
    });
  });
  // The steps panel slides in from the left once Welcome is left behind, and back out on return.
  const panel = createSpring(() => (step() === 'welcome' ? 0 : 1), 'sheet', { precision: 100 });
  const panelOpacity = createSpring(() => (step() === 'welcome' ? 0 : 1), 'panel', { fadeOnly: true });
  return (
    <div class="setup-wizard" classList={{ 'on-welcome': step() === 'welcome' }}>
      <div
        class="setup-steps-slot"
        style={{
          transform: `translate3d(${(panel() - 1) * 280}px, 0, 0)`,
          opacity: Math.max(0, Math.min(1, panelOpacity())),
        }}
        inert={step() === 'welcome'}
      >
        <StepsPanel />
      </div>
      <PageStack
        class="setup-pages"
        pageClass="setup-page"
        active={step()}
        pages={stepIds}
        axis="x"
        distance={32}
        render={id => <StepPage id={id} />}
      />
      <AddProviderDialog />
    </div>
  );
}
