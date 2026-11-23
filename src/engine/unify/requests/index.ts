/**
 * One dispatcher for the Unify screens' requests. The extension hands every webview message here after the
 * sidebar protocol has had its turn; `false` means "not mine, keep going".
 *
 * Every reply echoes the request's `requestId` when it has one. Messages the screens send without an id
 * (state pushes and simple switches) answer without one, exactly as their adapters expect.
 */
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { Dirent } from 'node:fs';
import {
  listWorkspaceDirectory,
  readWorkspaceFile,
  findWorkspaceFiles,
  writeWorkspaceFile,
  setActiveUnifyReply,
  watchWorkspace,
  disposeUnifyRequestWatchers,
} from './workspace';
import {
  importSkillFolder,
  listKnowledge,
  openKnowledge,
  readKnowledge,
  removeKnowledge,
  saveKnowledge,
  setKnowledgeAudiences,
  undoKnowledgeChange,
} from './knowledge';
import {
  accountsState,
  openProviderUsage,
  renameAccount,
  setAccountDefaultModel,
  setModelEnabled,
  signOutAccount,
} from './providers';
import { installedHubPacks, setToolpackPermission, setToolpackToolEnabled } from './toolpacks';
import { openSetupTarget, readPackSetup, rerunPackSetupScript, setPackSetupStepDone } from '../../hub/setup';
import { appInfoReply, updateInstallUnavailable } from './settings';
import {
  checkTools,
  fixTool,
  getSetupState,
  markSetupComplete,
  setDefaultProject,
} from './setup';
import { handleHubRequest } from './hub';
import { RequestPaths, requestPaths, titleFromId } from './state';
import { Audience, KnowledgeDraft, KnowledgeScope, PackSetupState, SetupSummary, ToolKind, ToolPolicy, UnifyRequestContext, UnifyRequestMessage } from './types';

export { disposeUnifyRequestWatchers } from './workspace';

let announcedWorkspace: string | undefined;

function announceWorkspace(context: UnifyRequestContext, reply: (message: unknown) => void): void {
  if (!context.workspaceRoot) return;
  if (announcedWorkspace === context.workspaceRoot) return;
  announcedWorkspace = context.workspaceRoot;
  reply({ type: 'workspaceState', root: path.resolve(context.workspaceRoot), name: path.basename(context.workspaceRoot) });
}

function stringField(message: UnifyRequestMessage, key: string): string {
  const value = message[key];
  return typeof value === 'string' ? value : '';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The folder of one installed toolpack; refuses ids that would escape the toolpacks folder. */
function packDirectory(paths: RequestPaths, id: string): string {
  if (!id.trim() || id !== path.basename(id) || id === '.' || id === '..') throw new Error('Unknown toolpack.');
  return path.join(paths.toolpacksDir, id);
}

/** The display name of an installed pack, from the Hub install records or the pack's `meta.json`. */
async function packDisplayName(paths: RequestPaths, packId: string): Promise<string> {
  const installed = installedHubPacks(paths);
  if (installed[packId]?.name) return installed[packId].name;
  try {
    const meta = JSON.parse(await fsp.readFile(path.join(paths.toolpacksDir, packId, 'meta.json'), 'utf8')) as { hubId?: unknown };
    if (typeof meta.hubId === 'string' && installed[meta.hubId]?.name) return installed[meta.hubId].name;
  } catch {
    // Local packs have no meta.json; the folder name is the fallback.
  }
  return titleFromId(packId);
}

function isFilesType(type: string): boolean {
  return type === 'listDir' || type === 'readFile' || type === 'writeFile' || type === 'findFiles';
}

/**
 * Answers one Unify screen request. `context.workspaceRoot` is the open folder; tests may also pass `unifyHome`,
 * `unifyRoot` and `version` to point the stores at a temporary folder.
 */
export async function handleUnifyRequest(
  message: UnifyRequestMessage,
  reply: (message: unknown) => void,
  context: UnifyRequestContext,
): Promise<boolean> {
  if (!message || typeof message.type !== 'string') return false;
  const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
  const send = (payload: unknown): void => {
    if (requestId && payload && typeof payload === 'object') reply({ ...(payload as object), requestId });
    else reply(payload);
  };
  const paths = requestPaths(context);
  const type = message.type;

  /* Files ------------------------------------------------------------------------------------------------- */

  if (isFilesType(type)) {
    setActiveUnifyReply(reply);
    watchWorkspace([context.workspaceRoot, ...(context.workspaceRoots ?? [])], reply);
    announceWorkspace(context, reply);
    try {
      if (type === 'listDir') {
        const relative = stringField(message, 'path');
        send({ type: 'dirListing', path: relative, entries: listWorkspaceDirectory(context.workspaceRoot, relative) });
        return true;
      }
      if (type === 'readFile') {
        const relative = stringField(message, 'path');
        send({ type: 'fileContent', file: readWorkspaceFile(context.workspaceRoot, relative) });
        return true;
      }
      if (type === 'writeFile') {
        const relative = stringField(message, 'path');
        const content = stringField(message, 'content');
        const version = stringField(message, 'version');
        const result = writeWorkspaceFile(context.workspaceRoot, relative, content, version);
        if (result.ok) send({ type: 'fileSaved', path: relative, version: result.version });
        else send({ type: 'fileConflict', current: result.conflict });
        return true;
      }
      const query = stringField(message, 'query');
      const limit = typeof message.limit === 'number' ? message.limit : undefined;
      send({ type: 'fileMatches', query, paths: findWorkspaceFiles(context.workspaceRoot, query, limit) });
      return true;
    } catch (error) {
      send({ type: 'filesError', message: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }

  /* Knowledge --------------------------------------------------------------------------------------------- */

  if (type === 'knowledgeList') {
    try {
      send({ type: 'knowledgeState', items: await listKnowledge(context, paths) });
    } catch (error) {
      send({ type: 'knowledgeError', message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (type === 'readKnowledge') {
    try {
      const id = stringField(message, 'id');
      const file = typeof message.file === 'string' ? message.file : undefined;
      const result = await readKnowledge(context, paths, id, file);
      send({ type: 'knowledgeContent', id, ...(result.file ? { file: result.file } : {}), content: result.content });
    } catch (error) {
      send({ type: 'knowledgeError', message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (type === 'saveKnowledge') {
    try {
      const item = message.item as KnowledgeDraft;
      const content = stringField(message, 'content');
      const file = typeof message.file === 'string' ? message.file : undefined;
      const saved = await saveKnowledge(context, paths, item, content, file);
      send({ type: 'knowledgeSaved', item: saved });
    } catch (error) {
      send({ type: 'knowledgeError', message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (type === 'removeKnowledge') {
    try {
      const id = stringField(message, 'id');
      await removeKnowledge(context, paths, id);
      send({ type: 'knowledgeRemoved', id });
    } catch (error) {
      send({ type: 'knowledgeError', message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (type === 'setKnowledgeAudience') {
    try {
      const audiences = Array.isArray(message.audiences) ? message.audiences as Audience[] : [];
      setKnowledgeAudiences(paths, stringField(message, 'id'), audiences);
      send({ type: 'knowledgeState', items: await listKnowledge(context, paths) });
    } catch (error) {
      send({ type: 'knowledgeError', message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (type === 'importSkillFolder') {
    try {
      const scope: KnowledgeScope = message.scope === 'project' ? 'project' : 'global';
      const files = Array.isArray(message.files) ? message.files as { path: string; content: string; encoding?: 'utf8' | 'base64' }[] : [];
      const item = await importSkillFolder(context, paths, scope, stringField(message, 'name'), files);
      send({ type: 'knowledgeSaved', item });
    } catch (error) {
      send({ type: 'knowledgeError', message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (type === 'undoKnowledgeChange') {
    try {
      send({ type: 'knowledgeState', items: await undoKnowledgeChange(context, paths, stringField(message, 'id')) });
    } catch (error) {
      send({ type: 'knowledgeError', message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }
  if (type === 'openKnowledge') {
    try {
      await openKnowledge(paths, stringField(message, 'id'), typeof message.file === 'string' ? message.file : undefined);
    } catch {
      // Opening a file has no reply; a stale item simply does nothing.
    }
    return true;
  }

  /* Toolpacks --------------------------------------------------------------------------------------------- */

  if (type === 'toolpackToolEnabled') {
    try {
      setToolpackToolEnabled(paths, stringField(message, 'id'), stringField(message, 'tool'), message.enabled === true);
    } catch {
      // The next toolpacksState from the extension is the truth.
    }
    return true;
  }
  if (type === 'toolpackPermission') {
    try {
      setToolpackPermission(paths, stringField(message, 'id'), message.group as ToolKind, message.policy as ToolPolicy);
    } catch {
      // The next toolpacksState from the extension is the truth.
    }
    return true;
  }
  if (type === 'toolpackSetup') {
    const id = stringField(message, 'id');
    try {
      const packDir = packDirectory(paths, id);
      const setup = await readPackSetup(packDir, id, await packDisplayName(paths, id));
      send({ type: 'toolpackSetupState', setup });
    } catch (error) {
      send({ type: 'toolpackSetupError', id, message: errorText(error) });
    }
    return true;
  }
  if (type === 'toolpackSetupList') {
    try {
      let entries: Dirent[] = [];
      try {
        entries = await fsp.readdir(paths.toolpacksDir, { withFileTypes: true });
      } catch {
        // No installed packs yet.
      }
      const packs: PackSetupState[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        try {
          const setup = await readPackSetup(
            path.join(paths.toolpacksDir, entry.name),
            entry.name,
            await packDisplayName(paths, entry.name),
          );
          if (setup && setup.pending > 0) packs.push(setup);
        } catch {
          // A malformed setup.json is reported when the user opens that pack's checklist.
        }
      }
      send({ type: 'toolpackSetupList', packs });
    } catch (error) {
      send({ type: 'toolpackSetupError', id: '', message: errorText(error) });
    }
    return true;
  }
  if (type === 'toolpackSetupAction') {
    const id = stringField(message, 'id');
    const action = stringField(message, 'action');
    try {
      const packDir = packDirectory(paths, id);
      if (action === 'markDone' || action === 'markTodo') {
        const stepId = stringField(message, 'stepId');
        if (!stepId) throw new Error('Choose a setup step first.');
        await setPackSetupStepDone(packDir, stepId, action === 'markDone');
      } else if (action === 'open') {
        const stepId = stringField(message, 'stepId');
        const setup = await readPackSetup(packDir, id, await packDisplayName(paths, id));
        const step = setup?.steps.find(item => item.id === stepId);
        if (!step?.open) throw new Error('This setup step has nothing to open.');
        await openSetupTarget(step.open, context.openExternal, packDir);
      } else if (action === 'rerunScript') {
        await rerunPackSetupScript(packDir, {
          packName: await packDisplayName(paths, id),
          unifyHome: paths.unifyHome,
        });
      } else if (action !== 'recheck') {
        throw new Error(`Unknown setup action "${action}".`);
      }
      const setup = await readPackSetup(packDir, id, await packDisplayName(paths, id));
      send({ type: 'toolpackSetupState', setup });
    } catch (error) {
      send({ type: 'toolpackSetupError', id, message: errorText(error) });
    }
    return true;
  }

  /* Providers --------------------------------------------------------------------------------------------- */

  if (type === 'setModelEnabled') {
    try {
      setModelEnabled(paths, stringField(message, 'modelId'), message.enabled === true);
      context.refreshModelState?.();
    } catch {
      // The next modelState from the extension is the truth.
    }
    return true;
  }
  if (type === 'openProviderUsage') {
    send(openProviderUsage(paths, stringField(message, 'accountId'), {
      refreshUsageState: context.refreshUsageState,
      openExternal: context.openExternal,
    }));
    return true;
  }
  if (type === 'renameAccount' || type === 'setAccountDefaultModel' || type === 'signOutAccount') {
    try {
      if (type === 'renameAccount') {
        send(renameAccount(paths, stringField(message, 'accountId'), stringField(message, 'label')));
      } else if (type === 'setAccountDefaultModel') {
        send(setAccountDefaultModel(paths, stringField(message, 'accountId'), stringField(message, 'modelId')));
      } else {
        const accountId = stringField(message, 'accountId');
        send(await signOutAccount(paths, accountId));
        context.refreshUsageState?.(accountId);
      }
    } catch {
      send(accountsState(paths));
    }
    return true;
  }

  /* Settings ---------------------------------------------------------------------------------------------- */

  if (type === 'getAppInfo') {
    send(appInfoReply(paths, context.version));
    return true;
  }
  if (type === 'installUpdate') {
    send(updateInstallUnavailable(paths, context.version));
    return true;
  }

  /* Setup ------------------------------------------------------------------------------------------------- */

  if (type === 'checkTools') {
    send({ type: 'toolsState', tools: await checkTools(paths) });
    return true;
  }
  if (type === 'fixTool') {
    const id = stringField(message, 'id');
    try {
      send({ type: 'toolsState', tools: await fixTool(paths, id) });
    } catch (error) {
      const tools = await checkTools(paths);
      send({
        type: 'toolsState',
        tools: tools.map(tool => tool.id === id
          ? { ...tool, state: 'error', error: error instanceof Error ? error.message : String(error) }
          : tool),
      });
    }
    return true;
  }
  if (type === 'getSetupState') {
    send(getSetupState(paths));
    return true;
  }
  if (type === 'setupComplete') {
    send(markSetupComplete(paths, message.summary as SetupSummary | undefined));
    return true;
  }
  if (type === 'setDefaultProject') {
    try {
      send(setDefaultProject(paths, message.project as { name?: unknown; path?: unknown } | undefined));
    } catch {
      send(getSetupState(paths));
    }
    return true;
  }

  /* Hub --------------------------------------------------------------------------------------------------- */

  if (type === 'hubBrowse' || type === 'hubInstall' || type === 'hubPublish') {
    return handleHubRequest(message, send, paths, context, context.hubRegistry);
  }

  return false;
}
