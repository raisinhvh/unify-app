/**
 * Small command-line helpers for local engines: argument splitting, env parsing and masked command display.
 * Pure node-free string code.
 */

const MASK = '••••';

/**
 * Shell-style split. Understands "double" and 'single' quotes. Backslashes stay literal,
 * so Windows paths like C:\models\a.gguf survive unchanged.
 */
export function splitArgs(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | undefined;
  for (const char of text) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inToken = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += char;
    inToken = true;
  }
  if (inToken) tokens.push(current);
  return tokens;
}

/** Parses `NAME=value` lines. Blank lines and lines starting with # are skipped. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const name = line.slice(0, equals).trim();
    if (!name) continue;
    env[name] = line.slice(equals + 1).trim();
  }
  return env;
}

/** Quotes one token when it contains whitespace or quotes. */
function quoteToken(token: string): string {
  if (token === '') return '""';
  if (!/[\s"']/.test(token)) return token;
  return `"${token.replace(/"/g, '\\"')}"`;
}

/** A printable command line with the API key replaced by dots. */
export function maskedCommand(command: string, args: string[], apiKey: string): string {
  const parts = [command, ...args].map(part => {
    const hidden = apiKey ? part.split(apiKey).join(MASK) : part;
    return quoteToken(hidden);
  });
  return parts.join(' ');
}
