/**
 * Parses `cursor-agent models` output into model options.
 *
 *   parseCursorModelList(output)   [{ value: 'gpt-5.2', name: 'GPT-5.2' }, ...] in the CLI's order, deduped
 *
 * The CLI prints a heading, then one "slug - Name" line per model; the default is marked "(default)". Names can
 * carry zero-width characters and doubled spaces, which are cleaned out.
 */

export interface CursorModelOption {
  value: string;
  name: string;
}

const modelLine = /^([A-Za-z0-9][A-Za-z0-9._:/@[\]=,+-]{0,119})\s+-\s+(.+)$/;
const invisible = /[​-‍⁠﻿]/g;
const ansi = /\u001B\[[0-9;]*[A-Za-z]/g;

export function parseCursorModelList(output: string): CursorModelOption[] {
  const seen = new Set<string>();
  const options: CursorModelOption[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(ansi, '').replace(invisible, '').trim();
    const match = modelLine.exec(line);
    if (!match) continue;
    const value = match[1];
    const name = match[2].replace(/\s*\((current|default)\)\s*/gi, ' ').replace(/\s+/g, ' ').trim();
    if (!name || seen.has(value)) continue;
    seen.add(value);
    options.push({ value, name });
  }
  return options;
}
