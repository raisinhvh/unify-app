import * as vscode from "vscode";
import { AccountRegistry } from "./accountRegistry";
import { accountForModel, normalizeModels, stripModelAccount } from "../sync/configSync";
import { ModelEntry, ResolvedModel } from "./types";

const MODELS_KEY = "unify.models.v1";

/** The settings section holding models. Sync writes the `unify` section. */
function modelSettings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('unify');
}
export const DEFAULT_MODEL: ModelEntry = {
  name: "DeepSeek V4 Flash",
  provider: "deepseek-official",
  backend: "deepseek-v4-flash",
  enabled: true,
};

/** Only entries with the three names a model needs; anything else in the setting is ignored. */
function isModelLike(item: unknown): item is Record<string, unknown> {
  const model = item as Record<string, unknown> | null;
  return !!model && typeof model === 'object' && typeof model.name === 'string' && typeof model.provider === 'string' && typeof model.backend === 'string';
}

/** Friendly model names and their provider/backend routes. */
export class ModelRegistry {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly accounts: AccountRegistry,
  ) {}

  public list(enabledOnly = false): ModelEntry[] {
    const models = this.read();
    return enabledOnly ? models.filter((model) => model.enabled) : models;
  }

  public get(name: string): ModelEntry | undefined {
    return this.read().find((model) => model.name === name);
  }

  public async set(entry: ModelEntry, originalName?: string): Promise<void> {
    const name = entry.name.trim();
    const provider = entry.provider.trim();
    const backend = entry.backend.trim();
    if (!name || !provider || !backend) throw new Error("Model name, provider, and backend are required");
    const normalized = { ...stripModelAccount({ ...entry }), name, provider, backend } as ModelEntry;
    const models = this.read().filter((model) => model.name !== name && model.name !== originalName);
    await modelSettings().update('models', [...models, normalized], vscode.ConfigurationTarget.Global);
  }

  public async remove(name: string): Promise<void> {
    await modelSettings().update('models', this.read().filter((model) => model.name !== name), vscode.ConfigurationTarget.Global);
  }

  public async resolve(name: string): Promise<ResolvedModel> {
    const model = this.get(name);
    if (!model) throw new Error(`Unknown model '${name}'`);
    if (!model.enabled) throw new Error(`Model '${name}' is disabled`);
    const account = accountForModel(this.accounts, model);
    if (!account) throw new Error(`No account for ${model.name} (${model.provider}). Sign in to a provider in Providers.`);
    if (account.provider !== model.provider) {
      throw new Error(`Account '${account.id}' does not belong to provider '${model.provider}'`);
    }
    const secret = await this.accounts.getSecret(account.id);
    if (!secret) throw new Error(`No credential stored for account '${account.id}'`);
    return { model, account, secret };
  }

  /**
   * Copies models saved in extension storage into the `unify.models` setting, which Config Sync carries, then
   * persists the cleaned list (no account fields, no duplicates) once.
   */
  public async migrate(): Promise<void> {
    if (modelSettings().inspect('models')?.globalValue === undefined) {
      const stored = this.context.globalState.get<unknown>(MODELS_KEY, []);
      if (Array.isArray(stored) && stored.length) await modelSettings().update('models', stored, vscode.ConfigurationTarget.Global);
    }
    const configured = modelSettings().inspect<unknown>('models')?.globalValue;
    if (!Array.isArray(configured)) return;
    const cleaned = normalizeModels(configured.filter(isModelLike));
    if (cleaned.changed) await modelSettings().update('models', cleaned.models, vscode.ConfigurationTarget.Global);
  }

  public async pick(): Promise<ModelEntry | undefined> {
    const models = this.list(true);
    const selected = await vscode.window.showQuickPick(models.map((model) => ({
      label: model.name,
      description: model.provider,
      detail: model.backend,
      model,
    })), { placeHolder: "Select a model" });
    return selected?.model;
  }

  private read(): ModelEntry[] {
    const configured = modelSettings().get<unknown>('models');
    if (Array.isArray(configured)) return normalizeModels(configured.filter(isModelLike)).models as unknown as ModelEntry[];
    const value = this.context.globalState.get<unknown>(MODELS_KEY, []);
    if (Array.isArray(value) && value.length) return normalizeModels(value.filter(isModelLike)).models as unknown as ModelEntry[];
    return [DEFAULT_MODEL];
  }
}

export { MODELS_KEY };
