/**
 * Pack setup checklists (engine/hub/types.ts › Pack setup): what a pack's install script did and what the user
 * still has to do in the companion app. Keyed by installed toolpack id.
 *
 *   setupFor(id)                       the pack's PackSetupState, once the engine sent it
 *   requestSetup(id)                   asks for one pack's checklist (toolpackSetup → toolpackSetupState)
 *   requestSetupList()                 asks for every pack with pending steps (→ toolpackSetupList)
 *   runSetupAction(id, action, step?)  markDone / markTodo / recheck / open / rerunScript / install
 *   setupInstalling(id)                the step whose package is installing, if any
 *   applySetup(setup)                  a checklist from elsewhere (a Hub install result)
 *
 * Ticking a manual step shows at once; the engine's reply replaces it. Replies to an action clear its busy flag;
 * `toolpackSetupError` keeps its message on the pack until the next action.
 */
import { createSignal } from 'solid-js';
import { post } from '../../bridge';
import type { PackSetupState, PackSetupStepStatus, SidebarWebviewMessage } from '../../protocol';
import { onHostMessage } from '../../store';

export type SetupAction = 'markDone' | 'markTodo' | 'recheck' | 'open' | 'rerunScript' | 'install';

/** UI -> engine (engine/unify/requests/types.ts › ToolpackSetupRequest). */
type SetupRequest =
  | { type: 'toolpackSetup'; requestId: string; id: string }
  | { type: 'toolpackSetupList'; requestId: string }
  | { type: 'toolpackSetupAction'; requestId: string; id: string; action: SetupAction; stepId?: string };

/** Engine -> UI. */
type SetupReply =
  | { type: 'toolpackSetupState'; requestId?: string; setup: PackSetupState | null }
  | { type: 'toolpackSetupList'; requestId?: string; packs: PackSetupState[] }
  | { type: 'toolpackSetupError'; requestId?: string; id: string; message: string };

const [setups, setSetups] = createSignal<Record<string, PackSetupState>>({});
const [errors, setErrors] = createSignal<Record<string, string>>({});
/** The long action in flight per pack ('recheck', 'rerunScript' or 'install'), for the footer buttons. */
const [busy, setBusy] = createSignal<Record<string, SetupAction>>({});
/** The step whose package is installing, per pack. */
const [installing, setInstalling] = createSignal<Record<string, string>>({});

/** Which pack each request was about, so a `setup: null` reply (no checklist) can clear the right entry. */
const requestPacks = new Map<string, string>();
let nextRequest = 1;

/** A request without its requestId (send adds it); distributes over the union. */
type UnsentRequest = SetupRequest extends infer Request ? (Request extends SetupRequest ? Omit<Request, 'requestId'> : never) : never;

function send(request: UnsentRequest, packId?: string): void {
  const requestId = `setup-${nextRequest}`;
  nextRequest += 1;
  if (packId) requestPacks.set(requestId, packId);
  post({ ...request, requestId } as unknown as SidebarWebviewMessage);
}

function withEntry<T>(record: Record<string, T>, id: string, value: T | undefined): Record<string, T> {
  const next = { ...record };
  if (value === undefined) delete next[id];
  else next[id] = value;
  return next;
}

export function setupFor(id: string | undefined): PackSetupState | undefined {
  return id ? setups()[id] : undefined;
}

export function setupError(id: string): string | undefined {
  return errors()[id];
}

export function setupBusy(id: string): SetupAction | undefined {
  return busy()[id];
}

export function setupInstalling(id: string): string | undefined {
  return installing()[id];
}

function clearBusy(id: string): void {
  setBusy(current => withEntry(current, id, undefined));
  setInstalling(current => withEntry(current, id, undefined));
}

/** Steps still to do on a pack, 0 when it has no checklist. */
export function pendingSetup(id: string): number {
  return setups()[id]?.pending ?? 0;
}

export function applySetup(setup: PackSetupState): void {
  setSetups(current => withEntry(current, setup.id, setup));
}

export function requestSetup(id: string): void {
  send({ type: 'toolpackSetup', id }, id);
}

export function requestSetupList(): void {
  send({ type: 'toolpackSetupList' });
}

export function runSetupAction(id: string, action: SetupAction, stepId?: string): void {
  setErrors(current => withEntry(current, id, undefined));
  if (action === 'markDone' || action === 'markTodo') {
    // Optimistic tick; the engine's state replaces it.
    setSetups(current => {
      const setup = current[id];
      if (!setup) return current;
      const status: PackSetupStepStatus = action === 'markDone' ? 'done' : 'todo';
      const steps = setup.steps.map(step => (step.id === stepId ? { ...step, status } : step));
      const pending = steps.filter(step => step.status !== 'done').length;
      return withEntry(current, id, { ...setup, steps, pending });
    });
  }
  if (action === 'recheck' || action === 'rerunScript' || action === 'install') setBusy(current => withEntry(current, id, action));
  if (action === 'install') setInstalling(current => withEntry(current, id, stepId));
  send({ type: 'toolpackSetupAction', id, action, ...(stepId ? { stepId } : {}) }, id);
}

const setupReplyTypes = new Set<string>(['toolpackSetupState', 'toolpackSetupList', 'toolpackSetupError']);

onHostMessage(message => {
  const reply = message as unknown as SetupReply;
  if (!setupReplyTypes.has(reply.type)) return;
  const askedAbout = reply.requestId ? requestPacks.get(reply.requestId) : undefined;
  if (reply.requestId) requestPacks.delete(reply.requestId);
  if (reply.type === 'toolpackSetupList') {
    setSetups(current => {
      const next = { ...current };
      for (const setup of reply.packs) next[setup.id] = setup;
      return next;
    });
    return;
  }
  if (reply.type === 'toolpackSetupError') {
    setErrors(current => withEntry(current, reply.id, reply.message));
    clearBusy(reply.id);
    return;
  }
  const id = reply.setup?.id ?? askedAbout;
  if (!id) return;
  setSetups(current => withEntry(current, id, reply.setup ?? undefined));
  clearBusy(id);
});
