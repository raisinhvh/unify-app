/** Returns only the editor context that changed within the current session. */
export function editorContextDiff(previous: string | undefined, current: string): string {
  if (!current || previous === current) return '';
  if (!previous) return current;
  const lines = (text: string): string[] => text.split('\n');
  const before = lines(previous);
  const after = lines(current);
  const open = (items: string[]): string | undefined => items.find(line => line.startsWith('Open files: '));
  const cursor = (items: string[]): string | undefined => items.find(line => line.startsWith('Cursor: '));
  const withoutDynamic = (items: string[]): string[] => items.filter(line => !line.startsWith('Open files: ') && !line.startsWith('Cursor: '));
  // Other context (including multiline selections) cannot safely be split into independent updates.
  if (withoutDynamic(before).join('\n') !== withoutDynamic(after).join('\n')) return current;
  const oldOpen = open(before);
  const newOpen = open(after);
  if ((oldOpen === undefined) !== (newOpen === undefined)) return current;
  const changes: string[] = [];
  if (oldOpen !== newOpen && oldOpen !== undefined && newOpen !== undefined) {
    const parse = (line: string): string[] => {
      const value = line.slice('Open files: '.length);
      return value === '(none)' ? [] : value.split(', ');
    };
    const oldFiles = parse(oldOpen);
    const newFiles = parse(newOpen);
    const opened = newFiles.filter(file => !oldFiles.includes(file));
    const closed = oldFiles.filter(file => !newFiles.includes(file));
    if (opened.length) changes.push(`Opened files: ${opened.join(', ')}`);
    if (closed.length) changes.push(`Closed files: ${closed.join(', ')}`);
  }
  if (cursor(before) !== cursor(after)) {
    const newCursor = cursor(after);
    if (!newCursor) return current;
    changes.push(newCursor);
  }
  return changes.join('\n');
}
