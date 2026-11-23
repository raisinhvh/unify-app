/**
 * Rows shared by the Agents pages. They use the Settings row look (settings.css `.setting-row`): label and a
 * muted caption on the left, the control on the right, a hairline underneath. Child rows hang off a guide line.
 *
 *   <AgentRow label="Name" caption="…" depth={1}>{control}</AgentRow>
 *   <ModelChoiceRows label="Name model" choice={viewState.nameModel} onSave={…} noneLabel="Same as the chat" />
 *       the model (the one ModelPicker), then Effort and Speed as child rows when the model offers them
 */
import { Show, type JSX } from 'solid-js';
import { ModelPicker, Select, type SelectOption } from '../../components';
import { Collapse } from '../../motion';
import { viewState } from '../../store';
import { effortOptions, speedOptions } from '../chats/models';

export type ModelChoice = typeof viewState.nameModel;

export function AgentRow(props: {
  label: JSX.Element;
  caption?: JSX.Element;
  depth?: number;
  class?: string;
  children?: JSX.Element;
}): JSX.Element {
  const depth = () => props.depth ?? 0;
  return (
    <div
      class={props.class ? `setting-row ag-row ${props.class}` : 'setting-row ag-row'}
      classList={{ child: depth() > 0 }}
      style={{ '--depth': depth() }}
    >
      <div class="setting-row-text">
        <div class="setting-row-label">{props.label}</div>
        <Show when={props.caption}>
          <div class="setting-row-description type-caption">{props.caption}</div>
        </Show>
      </div>
      <div class="setting-row-control">{props.children}</div>
    </div>
  );
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

export function EffortSpeedRows(props: {
  model: string | undefined;
  effort: string | undefined;
  speed: string | undefined;
  depth: number;
  onEffort: (effort: string | undefined) => void;
  onSpeed: (speed: string | undefined) => void;
}): JSX.Element {
  const efforts = () => modelEfforts(props.model);
  const speeds = () => modelSpeeds(props.model);
  return (
    <>
      <Collapse open={efforts().length > 0}>
        <AgentRow label="Effort" caption="How hard the model thinks before it answers." depth={props.depth}>
          <Select
            value={props.effort ?? ''}
            options={efforts()}
            placement="bottom-end"
            title="Effort"
            onChange={value => props.onEffort(value || undefined)}
          />
        </AgentRow>
      </Collapse>
      <Collapse open={speeds().length > 0}>
        <AgentRow label="Speed" caption="Faster answers can cost more." depth={props.depth}>
          <Select
            value={props.speed ?? ''}
            options={speeds()}
            placement="bottom-end"
            title="Speed"
            onChange={value => props.onSpeed(value || undefined)}
          />
        </AgentRow>
      </Collapse>
    </>
  );
}

/** One helper model setting: the model, then its effort and speed. Saves the whole choice on every change. */
export function ModelChoiceRows(props: {
  label: string;
  /** Caption while a model is picked, and while none is. */
  caption: string;
  emptyCaption: string;
  choice: ModelChoice;
  onSave: (next: ModelChoice) => void;
  /** Adds a first row that clears the model (shown on the line while nothing is picked). */
  noneLabel?: string;
  depth?: number;
}): JSX.Element {
  const depth = () => props.depth ?? 0;
  const model = () => props.choice.model;
  return (
    <>
      <AgentRow label={props.label} caption={model() ? props.caption : props.emptyCaption} depth={depth()}>
        <ModelPicker
          variant="regular"
          smartAuto={false}
          placement="bottom-end"
          value={model() ?? ''}
          noneLabel={props.noneLabel}
          placeholder="Choose a model"
          title={props.label}
          onChange={next => props.onSave(withModel(props.choice, next))}
        />
      </AgentRow>
      <EffortSpeedRows
        model={model()}
        effort={props.choice.effort}
        speed={props.choice.speed}
        depth={depth() + 1}
        onEffort={effort => props.onSave({ ...props.choice, effort })}
        onSpeed={speed => props.onSave({ ...props.choice, speed })}
      />
    </>
  );
}
