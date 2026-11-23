/**
 * The `vscode` module the DSH engine is compiled against inside Unify.
 *
 * This is deliberately a facade over Electron: the engine keeps its VS Code
 * code path, while main supplies paths, secrets, dialogs and the window.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Disposable, EventEmitter } from './events';
import { importVsCodeData, EXTENSION_ID } from './importer';
import {
  appendLog, configureBridge, configureOutput, configureUi, configureWebview, currentWebviewHtml,
  dispatchWebviewMessage, postSetupStatus, resolveWebviewView, setupStatus,
} from './host';
import { setSetupStatus } from './setup';
import { JsonMemento, configurePaths, configureSecrets, configureSettings, SecretStorageLike, ShimPaths, workspaceStatePath } from './state';
import { configureWorkspace, setWorkspaceTrusted } from './workspace';
import { Uri } from './uri';

export * from './events';
export * from './uri';
export * from './workspace';
export * from './window';
export * from './state';
export * from './host';
export { SqliteTableReader, readVsCodeState } from './sqlite';
export { importVsCodeData, loadImportRecord, markSetupComplete, detectVsCodeUserDir } from './importer';
export type { SetupStatus, MissingCredential } from './importer';

export interface ExtensionPackage {
  id: string;
  extensionUri: Uri;
  extensionPath: string;
  isActive: boolean;
  packageJSON: Record<string, unknown>;
}

export interface ExtensionContext {
  subscriptions: { dispose(): void }[];
  extensionPath: string;
  extensionUri: Uri;
  /** The engine reads its own version from `context.extension.packageJSON`. */
  extension: ExtensionPackage;
  globalStorageUri: Uri;
  globalStoragePath: string;
  storageUri: Uri;
  storagePath: string;
  logUri: Uri;
  logPath: string;
  globalState: JsonMemento;
  workspaceState: JsonMemento;
  secrets: SecretStorageLike;
  environmentVariableCollection: unknown;
  asAbsolutePath(relativePath: string): string;
  extensionMode: number;
}

export interface InitializeOptions {
  extensionPath: string;
  stateRoot: string;
  globalStoragePath: string;
  projectPath?: string;
  packageDefaults: Record<string, unknown>;
  secrets: SecretStorageLike;
  logsPath: string;
}

let context: ExtensionContext | undefined;

/** First-run import of VS Code's extension storage, done before activate(). */
export function prepareUnify(options: InitializeOptions): { context: ExtensionContext; setup: ReturnType<typeof setupStatus> } {
  const paths: ShimPaths = {
    extensionPath: options.extensionPath,
    stateRoot: options.stateRoot,
    globalStoragePath: options.globalStoragePath,
    projectPath: options.projectPath,
    mediaPath: join(options.globalStoragePath, 'media'),
  };
  configurePaths(paths);
  configureSecrets(options.secrets);
  configureSettings(join(options.stateRoot, 'settings.json'), options.packageDefaults as never);
  configureOutput({ logFile: join(options.logsPath, 'extension.log') });
  setWorkspaceTrusted(true);
  configureWorkspace({ projectPath: options.projectPath, workspaceMemento: undefined });

  const globalMemento = new JsonMemento(join(options.stateRoot, 'state.json'));
  // The project-specific memento is selected before the import so workspace
  // state and the engine read the same file.
  const projectMemento = new JsonMemento(workspaceStatePath(options.projectPath));
  const imported = importVsCodeData({ paths, globalMemento, workspaceMemento: projectMemento, projectPath: options.projectPath });
  setSetupStatus(imported.setup);

  const extensionUri = Uri.file(options.extensionPath);
  context = {
    subscriptions: [],
    extensionPath: options.extensionPath,
    extensionUri,
    extension: {
      id: EXTENSION_ID,
      extensionUri,
      extensionPath: options.extensionPath,
      isActive: true,
      packageJSON: readExtensionManifest(options.extensionPath),
    },
    globalStorageUri: Uri.file(options.globalStoragePath),
    globalStoragePath: options.globalStoragePath,
    storageUri: Uri.file(join(options.stateRoot, 'storage')),
    storagePath: join(options.stateRoot, 'storage'),
    logUri: Uri.file(options.logsPath),
    logPath: options.logsPath,
    globalState: globalMemento,
    workspaceState: projectMemento,
    secrets: options.secrets,
    environmentVariableCollection: {},
    asAbsolutePath: (relativePath: string) => join(options.extensionPath, relativePath),
    extensionMode: 1,
  };
  appendLog(`Unify initialized (${EXTENSION_ID}); state=${options.stateRoot} project=${options.projectPath ?? 'none'} imported=${imported.record.globalState}`);
  return { context, setup: imported.setup };
}

/**
 * Reads the app's package.json for `context.extension.packageJSON`. The engine
 * only needs `version`, but the whole manifest is exposed as in VS Code; a
 * broken manifest must not stop startup.
 */
function readExtensionManifest(extensionPath: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(extensionPath, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch (error) {
    appendLog(`could not read extension package.json: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

export function extensionContext(): ExtensionContext {
  if (!context) throw new Error('Unify shim was used before prepareUnify()');
  return context;
}

/**
 * Wires the engine's sidebar to the renderer. Called by main once the window
 * and its HTTP asset host exist.
 */
export async function bootWebview(options: {
  post(message: unknown): void;
  requestUi?(request: unknown): Promise<unknown>;
  cspSource: string;
  asWebviewUri(uri: Uri): Uri;
}): Promise<string | undefined> {
  configureBridge({ post: options.post, requestUi: options.requestUi as never });
  configureWebview({ cspSource: options.cspSource, asWebviewUri: options.asWebviewUri });
  const resolved = await resolveWebviewView('dsh.sidebar');
  postSetupStatus();
  return resolved?.html;
}

export function receiveRendererMessage(message: unknown): boolean {
  return dispatchWebviewMessage(message);
}

export function rendererHtml(): string {
  return currentWebviewHtml();
}

export function shimSetupStatus() {
  return setupStatus();
}

export function setUiAdapter(adapter: Parameters<typeof configureUi>[0]): void {
  configureUi(adapter);
}

export { commandsApi as commands } from './window';
export { configureBridge, configureUi, configureWebview, postToRenderer };

