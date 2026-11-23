/**
 * One dispatcher for the Unify screens' requests. The extension hands every webview message here after the
 * sidebar protocol has had its turn; `false` means "not mine, keep going".
 *
 * Every reply echoes the request's `requestId` when it has one. Messages the screens send without an id
 * (state pushes and simple switches) answer without one, exactly as their adapters expect.
 */
import * as path from 'node:path';
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
import { setToolpackPermission, setToolpackToolEnabled } from './toolpacks';
import { appInfoReply, updateChecked, updateInstallUnavailable } from './settings';
import {
  checkTools,
  fixTool,
  getSetupState,
  markSetupComplete,
  setDefaultProject,
} from './setup';
import { handleHubRequest } from './hub';
import { requestPaths } from './state';
import { Audience, KnowledgeDraft, KnowledgeScope, SetupSummary, ToolKind, ToolPolicy, UnifyRequestContext, UnifyRequestMessage } from './types';

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
  if (type === 'checkForUpdates') {
    send({ type: 'appInfo', info: updateChecked(paths, context.version).info });
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
    return handleHubRequest(message, send, paths, context);
  }

  return false;
}
