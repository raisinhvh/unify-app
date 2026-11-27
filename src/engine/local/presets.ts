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

const POLYSTRATA_DEFAULTS: LocalValues = {
  servedModel: 'inkling-2-mini',
  maxContext: 32768,
  attnRequant: 'q5_k',
  loopBf16: true,
  tailSkip: 4,
  ramExpertsMib: -1,
  vramReserveMib: 512,
  threads: 12,
  gpu: 0,
};

export const BUILTIN_PRESETS: LocalPreset[] = [
  builtin(
    'polystrata-inkling-iq3xxs',
    'Inkling 2 Mini IQ3_XXS (fastest)',
    'PolyStrata with the IQ3_XXS quant of Inkling 2 Mini.',
    'polystrata',
    { ...POLYSTRATA_DEFAULTS },
    '~115 tok/s, recommended',
  ),
  builtin(
    'polystrata-inkling-q3kxl',
    'Inkling 2 Mini Q3_K_XL (quality)',
    'PolyStrata with the Q3_K_XL quant of Inkling 2 Mini.',
    'polystrata',
    { ...POLYSTRATA_DEFAULTS },
    '~99 tok/s',
  ),
  builtin(
    'polystrata-inkling-q2kxl',
    'Inkling 2 Mini Q2_K_XL (speed)',
    'PolyStrata with the Q2_K_XL quant of Inkling 2 Mini and a window of 2.',
    'polystrata',
    { ...POLYSTRATA_DEFAULTS, window: 2 },
    '~124 tok/s, window 2',
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
  builtin(
    'llama-inkling-2-mini',
    'Inkling 2 Mini (llama.cpp)',
    'Tuned llama-server settings for Inkling 2 Mini.',
    'llama-cpp',
    {
      jinja: true,
      fit: 'off',
      flashAttn: 'on',
      cacheTypeK: 'q8_0',
      cacheTypeV: 'q8_0',
      ubatch: 256,
      parallel: 1,
      temp: 1,
      topP: 1,
      topK: 0,
      minP: 0,
      alias: 'inkling-2-mini',
      ctx: 32768,
    },
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
