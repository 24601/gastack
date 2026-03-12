/**
 * Shared buffers and types — extracted to break circular dependency
 * between server.ts and browser-manager.ts
 */

export interface LogEntry {
  timestamp: number;
  level: string;
  text: string;
}

export interface NetworkEntry {
  timestamp: number;
  method: string;
  url: string;
  status?: number;
  duration?: number;
  size?: number;
}

export const consoleBuffer: LogEntry[] = [];
export const networkBuffer: NetworkEntry[] = [];
const HIGH_WATER_MARK = 50_000;

export function addConsoleEntry(entry: LogEntry) {
  consoleBuffer.push(entry);
  if (consoleBuffer.length === HIGH_WATER_MARK) {
    console.warn(`[browse] Console buffer reached ${HIGH_WATER_MARK} entries`);
  }
}

export function addNetworkEntry(entry: NetworkEntry) {
  networkBuffer.push(entry);
  if (networkBuffer.length === HIGH_WATER_MARK) {
    console.warn(`[browse] Network buffer reached ${HIGH_WATER_MARK} entries`);
  }
}
