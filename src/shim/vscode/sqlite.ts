/**
 * A tiny read-only SQLite table reader.
 *
 * Electron 31 runs Node 20, which predates node:sqlite, and native sqlite
 * bindings would need a compiler on every platform. Unify only reads two
 * known tables in VS Code's state.vscdb files, so parsing the b-tree pages
 * ourselves is enough and keeps the installer free of native modules.
 */
import { readFileSync } from 'node:fs';

export interface SqliteRow {
  key: string;
  value: Buffer;
}

function readVarint(buffer: Buffer, offset: number, limit: number): { value: number; length: number } {
  let value = 0;
  for (let index = 0; index < 9; index += 1) {
    if (offset + index >= limit) throw new Error('sqlite varint runs past the page');
    const byte = buffer[offset + index];
    if (index === 8) {
      value = value * 256 + byte;
      return { value, length: 9 };
    }
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, length: index + 1 };
  }
  throw new Error('sqlite varint is too long');
}

function serialSize(serialType: number): number {
  switch (serialType) {
    case 0:
    case 8:
    case 9:
      return 0;
    case 1:
      return 1;
    case 2:
      return 2;
    case 3:
      return 3;
    case 4:
      return 4;
    case 5:
      return 6;
    case 6:
    case 7:
      return 8;
    default:
      return serialType >= 12 ? Math.floor((serialType - 12) / 2) : 0;
  }
}

interface RecordValue {
  type: number;
  bytes: Buffer;
}

function decodeRecord(payload: Buffer): RecordValue[] {
  const headerLength = readVarint(payload, 0, payload.length);
  let headerOffset = headerLength.length;
  const headerEnd = headerLength.value;
  const serials: number[] = [];
  while (headerOffset < headerEnd) {
    const serial = readVarint(payload, headerOffset, headerEnd);
    serials.push(serial.value);
    headerOffset += serial.length;
  }
  const values: RecordValue[] = [];
  let dataOffset = headerEnd;
  for (const serialType of serials) {
    const size = serialSize(serialType);
    values.push({ type: serialType, bytes: payload.subarray(dataOffset, dataOffset + size) });
    dataOffset += size;
  }
  return values;
}

function valueText(value: RecordValue | undefined): string {
  if (!value) return '';
  return value.bytes.toString('utf8');
}

export class SqliteTableReader {
  private readonly buffer: Buffer;
  private readonly pageSize: number;
  private readonly usableSize: number;

  public constructor(path: string) {
    this.buffer = readFileSync(path);
    if (this.buffer.length < 100 || this.buffer.toString('latin1', 0, 16) !== 'SQLite format 3\u0000') {
      throw new Error('Not a SQLite database');
    }
    const declared = this.buffer.readUInt16BE(16);
    this.pageSize = declared === 1 ? 65536 : declared;
    this.usableSize = this.pageSize - this.buffer[20];
    if (this.pageSize < 512 || this.pageSize > 65536) throw new Error('Unsupported SQLite page size');
  }

  /** Reads a table's rows without needing indexes or a query planner. */
  public rows(tableName: string): SqliteRow[] {
    const root = this.findRootPage(tableName);
    if (root === undefined) return [];
    const rows: SqliteRow[] = [];
    const visited = new Set<number>();
    this.walkTable(root, visited, rows, 0);
    return rows;
  }

  private findRootPage(tableName: string): number | undefined {
    const rows: SqliteRow[] = [];
    this.walkTable(1, new Set(), rows, 0);
    for (const row of rows) {
      const values = decodeRecord(row.value);
      if (valueText(values[0]) === 'table' && valueText(values[1]) === tableName) {
        return Number(readSigned(values[3]?.bytes));
      }
    }
    return undefined;
  }

  private pageOffset(pageNumber: number): number {
    return (pageNumber - 1) * this.pageSize;
  }

  private walkTable(pageNumber: number, visited: Set<number>, rows: SqliteRow[], depth: number): void {
    if (depth > 64 || pageNumber <= 0 || visited.has(pageNumber)) return;
    visited.add(pageNumber);
    const start = this.pageOffset(pageNumber);
    if (start + 8 > this.buffer.length) return;
    const type = this.buffer[start];
    if (type !== 0x0d && type !== 0x05) return;
    const cellCount = this.buffer.readUInt16BE(start + 3);
    const headerSize = type === 0x05 ? 12 : 8;
    const pointerStart = start + headerSize;
    if (pointerStart + cellCount * 2 > this.buffer.length) return;

    if (type === 0x05) {
      for (let index = 0; index < cellCount; index += 1) {
        const pointer = this.buffer.readUInt16BE(pointerStart + index * 2);
        const cell = start + pointer;
        if (cell + 4 > this.buffer.length) continue;
        const child = this.buffer.readUInt32BE(cell);
        this.walkTable(child, visited, rows, depth + 1);
      }
      const rightMost = this.buffer.readUInt32BE(start + 8);
      this.walkTable(rightMost, visited, rows, depth + 1);
      return;
    }

    for (let index = 0; index < cellCount; index += 1) {
      const pointer = this.buffer.readUInt16BE(pointerStart + index * 2);
      const cell = start + pointer;
      try {
        const payloadSize = readVarint(this.buffer, cell, start + this.pageSize);
        const rowId = readVarint(this.buffer, cell + payloadSize.length, start + this.pageSize);
        const payloadStart = cell + payloadSize.length + rowId.length;
        const payload = this.readPayload(payloadStart, payloadSize.value);
        const values = decodeRecord(payload);
        rows.push({ key: valueText(values[0]), value: values[1]?.bytes ?? Buffer.alloc(0) });
      } catch {
        // A malformed row should not hide the rows around it.
      }
    }
  }

  private readPayload(offset: number, size: number): Buffer {
    const pageEnd = Math.floor(offset / this.pageSize) * this.pageSize + this.pageSize;
    const maxLocal = this.usableSize - 35;
    if (size <= maxLocal) return this.buffer.subarray(offset, offset + size);

    const minimum = Math.floor(((this.usableSize - 12) * 32) / 255) - 23;
    const candidate = minimum + ((size - minimum) % (this.usableSize - 4));
    const localSize = candidate <= maxLocal ? candidate : minimum;
    const parts: Buffer[] = [this.buffer.subarray(offset, Math.min(offset + localSize, pageEnd))];
    let remaining = size - localSize;
    let page = this.buffer.readUInt32BE(offset + localSize);
    while (remaining > 0 && page > 0) {
      const start = this.pageOffset(page);
      if (start + 4 > this.buffer.length) break;
      const take = Math.min(remaining, this.usableSize - 4);
      parts.push(this.buffer.subarray(start + 4, start + 4 + take));
      remaining -= take;
      page = this.buffer.readUInt32BE(start);
    }
    return Buffer.concat(parts);
  }
}

function readSigned(bytes: Buffer | undefined): number {
  if (!bytes || bytes.length === 0) return 0;
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  const bits = BigInt(bytes.length * 8);
  if (bytes[0] & 0x80) value -= 1n << bits;
  return Number(value);
}

export interface StateDatabase {
  globalState?: unknown;
  workspaceState?: unknown;
  /** Secret keys VS Code stored (values are encrypted and cannot be decrypted). */
  secretKeys: string[];
}

/** Reads the extension's rows from a VS Code state.vscdb file. */
export function readVsCodeState(path: string, extensionId: string): StateDatabase {
  const reader = new SqliteTableReader(path);
  const result: StateDatabase = { secretKeys: [] };
  for (const row of reader.rows('ItemTable')) {
    if (row.key === extensionId) {
      try {
        result.globalState = JSON.parse(row.value.toString('utf8'));
      } catch {
        // Keep it missing so the caller can report the import failure.
      }
      continue;
    }
    if (row.key.startsWith('secret://')) {
      result.secretKeys.push(row.key);
    }
  }
  return result;
}
