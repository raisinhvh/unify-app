/** The setup summary main sends to the renderer as { type: 'setupStatus' }. */
import type { SetupStatus } from './importer';

let status: SetupStatus | undefined;

export function setSetupStatus(next: SetupStatus): void {
  status = next;
}

export function setupStatusSnapshot(): SetupStatus {
  return status ?? {
    needsSetup: false,
    firstRun: true,
    importedAccounts: 0,
    importedOAuthAccounts: 0,
    importedSettings: 0,
    importedWorkspace: false,
    missing: [],
    notes: [],
    dataRoot: '',
    sources: [],
  };
}
