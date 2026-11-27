/**
 * Built-in presets for local servers. Paths stay empty: the user browses for model files.
 */
import type { LocalEngineDefinition, LocalEngineKind, LocalPreset, LocalValues } from './types';

function builtin(
  id: string,
  label: string,
  description: string,
  engine: LocalEngineKind,
  values: LocalValues,
  note?: string,
): LocalPreset {
  const preset: LocalPreset = { id, label, description, engine, values, builtin: true };
  if (note) preset.note = note;
  return preset;
}

export const BUILTIN_PRESETS: LocalPreset[] = [
  builtin(
    'polystrata-default',
    'PolyStrata — default',
    'PolyStrata with its own defaults for the model and machine.',
    'polystrata',
    {},
  ),
  builtin(
    'llama-gpu-all-layers',
    'GPU — all layers',
    'Offloads every layer to the GPU.',
    'llama-cpp',
    { gpuLayers: 99, flashAttn: 'auto' },
  ),
  builtin(
    'llama-moe-cpu-experts',
    'MoE — experts on CPU',
    'Keeps the experts of the first layers on the CPU to save VRAM.',
    'llama-cpp',
    { gpuLayers: 99, cpuMoe: 20 },
    'Raise n-cpu-moe until it fits in VRAM',
  ),
  builtin(
    'llama-cpu-only',
    'CPU only',
    'Runs entirely on the CPU.',
    'llama-cpp',
    { gpuLayers: 0 },
  ),
  builtin('koboldcpp-default', 'KoboldCpp — default', 'KoboldCpp with default settings.', 'koboldcpp', {}),
  builtin('ollama-default', 'Ollama — default', 'Ollama with default settings.', 'ollama', {}),
  builtin('custom-command', 'Custom command', 'Any command that starts an OpenAI-compatible server.', 'custom', {}),
];

/** The default value of every field that has one. */
export function defaultValues(engine: LocalEngineDefinition): LocalValues {
  const values: LocalValues = {};
  for (const field of engine.fields) {
    if (field.default !== undefined) values[field.id] = field.default;
  }
  return values;
}

/** Engine defaults with the preset's values on top. */
export function presetValues(preset: LocalPreset, engine: LocalEngineDefinition): LocalValues {
  return { ...defaultValues(engine), ...preset.values };
}
