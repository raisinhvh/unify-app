/** The setup summary main sends to the renderer as { type: 'setupStatus' }. */

export interface MissingCredential {
  kind: 'secret';
  provider: string;
  accountId: string;
  label: string;
  reason: string;
}

export interface SetupStatus {
  needsSetup: boolean;
  firstRun: boolean;
  importedAccounts: number;
  importedOAuthAccounts: number;
  importedSettings: number;
  importedWorkspace: boolean;
  missing: MissingCredential[];
  notes: string[];
  dataRoot: string;
  sources: string[];
}

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
