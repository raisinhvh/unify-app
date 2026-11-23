/**
 * Setup wizard state (Figma 26a–26f). Module-level so the wizard can unmount and come back where it was.
 *
 * Required (spec): one working provider account, a project folder, the CLI tools check. Everything else is
 * optional and skippable. `setupNeeded()` is what the Shell reads to decide whether the wizard covers Home.
 */
import { createSignal } from 'solid-js';
import { readPersisted, writePersisted } from '../../persist';
import type { SidebarAccount, SidebarProject } from '../../protocol';
import { onHostMessage, viewState } from '../../store';
import { knownProjects, selectedProject } from '../chats/projects';
import { setupComplete, tools } from './adapters';

export type SetupStepId = 'welcome' | 'providers' | 'project' | 'tools' | 'extras' | 'done';

export interface SetupStepInfo {
  id: SetupStepId;
  label: string;
  optional?: boolean;
}

export const setupSteps: SetupStepInfo[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'providers', label: 'Providers' },
  { id: 'project', label: 'Project folder' },
  { id: 'tools', label: 'Tools' },
  { id: 'extras', label: 'Extras', optional: true },
  { id: 'done', label: 'Done' },
];

const stepIds = setupSteps.map(step => step.id);

function validStep(value: unknown): SetupStepId {
  return stepIds.includes(value as SetupStepId) ? (value as SetupStepId) : 'welcome';
}

const [step, setStepSignal] = createSignal<SetupStepId>(validStep(readPersisted('setupStep', 'welcome')));
/** Furthest step reached; steps up to it can be clicked in the steps panel. */
const [reached, setReachedSignal] = createSignal<number>(Math.max(0, stepIds.indexOf(validStep(readPersisted('setupReached', 'welcome')))));
export { step, reached };

export const stepIndex = (id: SetupStepId): number => stepIds.indexOf(id);

export function goToStep(id: SetupStepId): void {
  setStepSignal(id);
  writePersisted('setupStep', id);
  if (stepIndex(id) > reached()) {
    setReachedSignal(stepIndex(id));
    writePersisted('setupReached', id);
  }
}

export function nextStep(): void {
  const index = stepIndex(step());
  if (index < stepIds.length - 1) goToStep(stepIds[index + 1]);
}

export function previousStep(): void {
  const index = stepIndex(step());
  if (index > 0) goToStep(stepIds[index - 1]);
}

/* Accounts */

let accountsSeen = false;
const [accountsLoaded, setAccountsLoaded] = createSignal(false);

/** Call once the store is connected: marks when the engine has sent the account list at least once. */
export function watchAccounts(): void {
  if (accountsSeen) return;
  accountsSeen = true;
  onHostMessage(message => {
    if (message.type === 'accountsState') setAccountsLoaded(true);
  });
}

export function accountSignedOut(account: SidebarAccount): boolean {
  const usage = viewState.usage[account.id];
  return usage?.status === 'error' && usage.fix === 'signin';
}

export function workingAccounts(): SidebarAccount[] {
  return (viewState.accounts ?? []).filter(account => !accountSignedOut(account));
}

export function hasWorkingAccount(): boolean {
  return workingAccounts().length > 0 || !!viewState.cursor?.connected;
}

/* Project folder (draft until Continue) */

const [draftProject, setDraftProject] = createSignal<SidebarProject | undefined>();
export { setDraftProject };

export function projectChoice(): SidebarProject | undefined {
  return draftProject() ?? selectedProject() ?? knownProjects()[0];
}

/* Tools */

export function missingRequiredTools(): string[] {
  return tools()
    .filter(tool => tool.required && (tool.state === 'missing' || tool.state === 'error'))
    .map(tool => tool.id);
}

export function toolsSettled(): boolean {
  return tools().every(tool => tool.state !== 'checking' && tool.state !== 'fixing');
}

/** A fix failed at least once this session: the user may continue without the tool. */
const [fixFailed, setFixFailed] = createSignal(false);
export { fixFailed, setFixFailed };

/* Extras */

export type ExtraId = 'theme';
export type ExtraChoice = 'pending' | 'skipped' | 'busy' | 'done' | 'error';

const [extras, setExtras] = createSignal<Record<ExtraId, ExtraChoice>>({
  theme: 'pending',
  ...readPersisted<Partial<Record<ExtraId, ExtraChoice>>>('setupExtras', {}),
});
export { extras };

export function setExtra(id: ExtraId, choice: ExtraChoice): void {
  const next = { ...extras(), [id]: choice };
  setExtras(next);
  writePersisted('setupExtras', next);
}

/* Whether the wizard should show */

/** The first required step that is not met, or undefined when all are. */
export function firstUnmetStep(): SetupStepId | undefined {
  if (accountsLoaded() && !hasWorkingAccount()) return 'providers';
  if (!selectedProject()) return 'project';
  if (missingRequiredTools().length > 0 && !fixFailed()) return 'tools';
  return undefined;
}

/**
 * True when the wizard should cover the app: setup was never finished, or something required broke since
 * (every account signed out, the project forgotten, a required tool missing).
 */
export function setupNeeded(): boolean {
  return !setupComplete() || firstUnmetStep() !== undefined;
}
