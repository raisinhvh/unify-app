/**
 * Model / effort / speed options for the composer pickers. Same rules as DSH renderPicker
 * (media/sidebar.js ~127-169): enabled models only, Smart Auto first when ready, effort "Default" + the
 * model's effortOptions, speeds hidden when the model has none.
 */
import type { SelectOption } from '../../components';
import { post } from '../../bridge';
import { providerNames } from '../../store/providers';
import { viewState } from '../../store';

export const smartAutoId = 'Smart Auto';

export function smartAutoReady(): boolean {
  const available = (id: string | undefined) => viewState.models.some(item => item.id === id && item.enabled !== false);
  return !!viewState.features.smartAuto && available(viewState.deciderModel.model) && viewState.smartAutoRanks.some(rank => available(rank.model));
}

export function modelOptions(): SelectOption[] {
  const options: SelectOption[] = [];
  if (smartAutoReady()) options.push({ value: smartAutoId, label: smartAutoId, hint: 'Picks per message' });
  for (const model of viewState.models.filter(item => item.enabled !== false)) {
    options.push({ value: model.id, label: model.name, group: providerNames[model.provider] || model.provider });
  }
  return options;
}

/** The model the picker shows: Smart Auto, the selected model, or the first enabled one. */
export function selectedModelValue(): string | undefined {
  if (smartAutoReady() && viewState.selectedModelId === smartAutoId) return smartAutoId;
  const models = viewState.models.filter(item => item.enabled !== false);
  return (models.find(item => item.id === viewState.selectedModelId) || models[0])?.id;
}

export function selectedModelLabel(): string {
  const value = selectedModelValue();
  if (value === smartAutoId) return smartAutoId;
  return viewState.models.find(item => item.id === value)?.name || 'Choose model';
}

function findModel(modelId: string | undefined) {
  return viewState.models.find(item => item.id === modelId);
}

/** Effort choices for `modelId` (the selected model when omitted). */
export function effortOptions(modelId: string | undefined = viewState.selectedModelId): SelectOption[] {
  const efforts = findModel(modelId)?.effortOptions || [];
  if (!efforts.length) return [];
  return [{ value: '', label: 'Default' }, ...efforts.map(value => ({ value, label: value }))];
}

/** Speed choices for `modelId` (the selected model when omitted). */
export function speedOptions(modelId: string | undefined = viewState.selectedModelId): SelectOption[] {
  return (findModel(modelId)?.speedOptions || []).map(speed => ({ value: speed.label, label: speed.label }));
}

export function selectModel(modelId: string, chatId?: string): void {
  post({ type: 'selectModel', modelId, chatId });
}

export function selectEffort(value: string, chatId?: string): void {
  post({ type: 'selectEffort', value, chatId });
}

export function selectSpeed(value: string, chatId?: string): void {
  post({ type: 'selectSpeed', value, chatId });
}
