/** Provider names, brand colours and account groups, copied from DSH media/sidebar.js (lines ~95-107). */

export const providerNames: Record<string, string> = {
  'codex-cli': 'ChatGPT (Codex)',
  'claude-cli': 'Claude Code',
  'cursor-acp': 'Cursor',
  'deepseek-official': 'DeepSeek',
  openrouter: 'OpenRouter',
  'opencode-go': 'OpenCode Go',
  mistral: 'Mistral',
  'self-hosted': 'Self-hosted',
  gemini: 'Gemini',
  xai: 'xAI',
  groq: 'Groq',
};

export const providerColors: Record<string, string> = {
  'claude-cli': '#D97757',
  'codex-cli': '#10A37F',
  'cursor-acp': '#8B8B8B',
  'deepseek-official': '#4D6BFE',
  openrouter: '#6467F2',
  'opencode-go': '#E8E8E8',
  mistral: '#FA520F',
  'self-hosted': '#9AA0A6',
};

export const providerColor = (provider: string): string => providerColors[provider] || '#9C7BD8';

/** Order the usage summary walks accounts in (DSH accountGroups). */
export const accountGroupOrder = [
  'codex-cli',
  'claude-cli',
  'cursor-acp',
  'deepseek-official',
  'openrouter',
  'opencode-go',
  'mistral',
  'self-hosted',
];
