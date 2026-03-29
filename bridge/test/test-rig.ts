/**
 * Test rig — creates and tears down isolated test environments.
 *
 * Provides a temporary directory with proper bridge structure (logDir, projectDir)
 * and pre-configured orchestrator instances for test isolation.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Orchestrator, type Adapter, type OrchestratorOptions } from '../orchestrate.js';
import { EventLog } from '../events.js';

// --- Types ---

export interface TestRig {
  /** Root temporary directory for this test. */
  rootDir: string;
  /** Event log directory (rootDir/logs). */
  logDir: string;
  /** Simulated project directory (rootDir/project). */
  projectDir: string;
  /** Path to fixtures directory. */
  fixturesDir: string;
  /** Create a fresh orchestrator with optional adapters. */
  createOrchestrator(adapters?: Record<string, Adapter>): Orchestrator;
  /** Load a fixture event log into the log directory. Returns the log path. */
  loadEventLog(fixtureName: string): string;
  /** Read a fixture file as a string. */
  readFixture(category: string, name: string): string;
  /** Read a fixture file as parsed JSON. */
  readFixtureJson<T = unknown>(category: string, name: string): T;
  /** Clean up all temporary files. */
  cleanup(): void;
}

// --- Fixture paths ---

const FIXTURES_DIR = path.join(import.meta.dir, 'fixtures');

// --- Factory ---

/**
 * Create an isolated test rig with temporary directories.
 *
 * Usage:
 *   const rig = createTestRig();
 *   const orch = rig.createOrchestrator({ myAdapter });
 *   // ... run tests ...
 *   rig.cleanup();
 */
export function createTestRig(): TestRig {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
  const logDir = path.join(rootDir, 'logs');
  const projectDir = path.join(rootDir, 'project');

  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  return {
    rootDir,
    logDir,
    projectDir,
    fixturesDir: FIXTURES_DIR,

    createOrchestrator(adapters?: Record<string, Adapter>): Orchestrator {
      return Orchestrator.create({
        logDir,
        projectDir,
        adapters,
      });
    },

    loadEventLog(fixtureName: string): string {
      const src = path.join(FIXTURES_DIR, 'event-logs', fixtureName);
      if (!fs.existsSync(src)) {
        throw new Error(`Event log fixture not found: ${fixtureName}`);
      }
      const dest = path.join(logDir, fixtureName);
      fs.copyFileSync(src, dest);
      return dest;
    },

    readFixture(category: string, name: string): string {
      const filePath = path.join(FIXTURES_DIR, category, name);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Fixture not found: ${category}/${name}`);
      }
      return fs.readFileSync(filePath, 'utf-8');
    },

    readFixtureJson<T = unknown>(category: string, name: string): T {
      const content = this.readFixture(category, name);
      return JSON.parse(content) as T;
    },

    cleanup(): void {
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}
