/**
 * Rows shared by the Agents pages, built as Settings rows (catalog.ts `SettingRow`, kind 'custom') so
 * <SettingRows> draws them in the same file-tree as every other setting: a row with sub-settings is a folder and
 * its children hang off ├ / └ elbows.
 *
 *   agentRow({ key, label, description, parent, control })          one row with any control
 *   modelChoiceRows({ key, label, choice, onSave, … })                the model (the one ModelPicker), then Effort
 *                                                                    and Speed under it when the model offers them
 *
 * Rows are built once; everything that changes (captions, the choice) is read through accessors and getters.
 */
import { type JSX } from 'solid-js';
import { ModelPicker, Select, type SelectOption } from '../../components';
import { viewState } from '../../store';
import { effortOptions, speedOptions } from '../chats/models';
import type { SettingRow } from '../settings/catalog';

export type ModelChoice = typeof viewState.nameModel;

export interface AgentRowSpec {
  key: string;
  label: string;
  /** Caption under the label; pass a getter on the spec object to make it reactive. */
  description: string;
  parent?: string;
  shown?: () => boolean;
  labelFor?: string;
  control: () => JSX.Element;
}

/** One custom row in the Settings tree. Getters on `spec` (a changing caption) stay live. */
export function agentRow(spec: AgentRowSpec): SettingRow {
  return {
    key: spec.key,
    section: 'agents',
    kind: 'custom',
    get label() {
      return spec.label;
    },
    get description() {
      return spec.description;
    },
    parent: spec.parent,
    shown: spec.shown,
    labelFor: spec.labelFor,
    control: spec.control,
    read: () => '',
    write: () => {},
  };
}

/** The model's display name (the engine stores names, the mock ids), or what was stored when it is gone. */
export function modelName(model: string): string {
  return viewState.models.find(item => item.id === model || item.name === model)?.name ?? model;
}

/** Effort choices for a model ('' = the model's default), or none when it has no efforts. */
export function modelEfforts(modelId: string | undefined): SelectOption[] {
  return modelId ? effortOptions(modelId) : [];
}

/** Speed choices for a model ('' = the model's default), or none when it has no speeds. */
export function modelSpeeds(modelId: string | undefined): SelectOption[] {
  const speeds = modelId ? speedOptions(modelId) : [];
  return speeds.length ? [{ value: '', label: 'Default' }, ...speeds] : [];
}

/** A new model keeps the effort and speed only when it offers them too (the engine rejects the rest). */
export function withModel<Choice extends { model?: string; effort?: string; speed?: string }>(choice: Choice, model: string): Choice {
  const efforts = modelEfforts(model);
  const speeds = modelSpeeds(model);
  return {
    ...choice,
    model: model || undefined,
    effort: choice.effort && efforts.some(option => option.value === choice.effort) ? choice.effort : undefined,
    speed: choice.speed && speeds.some(option => option.value === choice.speed) ? choice.speed : undefined,
  };
}

/** Effort and Speed rows under `parent`, each shown only when the model offers a choice. */
export function effortSpeedRows(spec: {
  parent: string;
  model: () => string | undefined;
  effort: () => string | undefined;
  speed: () => string | undefined;
  onEffort: (effort: string | undefined) => void;
  onSpeed: (speed: string | undefined) => void;
}): SettingRow[] {
  const efforts = () => modelEfforts(spec.model());
  const speeds = () => modelSpeeds(spec.model());
  return [
    agentRow({
      key: `${spec.parent}/effort`,
      label: 'Effort',
      description: 'How hard the model thinks before it answers.',
      parent: spec.parent,
      shown: () => efforts().length > 0,
      control: () => (
        <Select
          value={spec.effort() ?? ''}
          options={efforts()}
          placement="bottom-end"
          title="Effort"
          onChange={value => spec.onEffort(value || undefined)}
        />
      ),
    }),
    agentRow({
      key: `${spec.parent}/speed`,
      label: 'Speed',
      description: 'Faster answers can cost more.',
      parent: spec.parent,
      shown: () => speeds().length > 0,
      control: () => (
        <Select
          value={spec.speed() ?? ''}
          options={speeds()}
          placement="bottom-end"
          title="Speed"
          onChange={value => spec.onSpeed(value || undefined)}
        />
      ),
    }),
  ];
}

/** One helper model setting: the model, then its effort and speed. Saves the whole choice on every change. */
export function modelChoiceRows(spec: {
  key: string;
  label: string;
  /** Caption while a model is picked, and while none is. */
  caption: string;
  emptyCaption: string;
  choice: () => ModelChoice | undefined;
  onSave: (next: ModelChoice) => void;
  /** Adds a first row that clears the model (shown on the line while nothing is picked). */
  noneLabel?: string;
  parent?: string;
  shown?: () => boolean;
}): SettingRow[] {
  const choice = (): NonNullable<ModelChoice> => spec.choice() ?? {};
  const model = () => choice().model;
  return [
    agentRow({
      key: spec.key,
      label: spec.label,
      get description() {
        return model() ? spec.caption : spec.emptyCaption;
      },
      parent: spec.parent,
      shown: spec.shown,
      control: () => (
        <ModelPicker
          variant="regular"
          smartAuto={false}
          placement="bottom-end"
          value={model() ?? ''}
          noneLabel={spec.noneLabel}
          placeholder="Choose a model"
          title={spec.label}
          onChange={next => spec.onSave(withModel(choice(), next))}
        />
      ),
    }),
    ...effortSpeedRows({
      parent: spec.key,
      model,
      effort: () => choice().effort,
      speed: () => choice().speed,
      onEffort: effort => spec.onSave({ ...choice(), effort }),
      onSpeed: speed => spec.onSave({ ...choice(), speed }),
    }),
  ];
}
