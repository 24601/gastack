/**
 * Test adapters — deterministic replacements for real adapters.
 *
 * RealisticGtAdapter: returns fixture JSON for gt CLI commands.
 * ReviewFixtureAdapter: returns fixture review outputs for quality testing.
 * RecordingAdapter: records all calls for assertion (arg capture).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Adapter } from '../orchestrate.js';
import type { ReviewResult, ReviewSuiteResult } from '../adapters/gstack.js';
import { parseReviewOutput } from '../adapters/gstack.js';

// --- Fixture paths ---

const FIXTURES_DIR = path.join(import.meta.dir, 'fixtures');

// --- RealisticGtAdapter ---

/** Recorded call from an adapter. */
export interface RecordedCall {
  command: string;
  args?: Record<string, unknown>;
  timestamp: number;
}

/**
 * Adapter that returns pre-captured gt CLI outputs from fixtures.
 *
 * Maps commands to fixture files:
 *   - hook       → gt-cli-outputs/hook-response.json
 *   - mol.status → gt-cli-outputs/mol-status.json
 *   - mail.inbox → gt-cli-outputs/mail-inbox.json
 *
 * Unknown commands throw with the command name for assertion.
 */
export class RealisticGtAdapter implements Adapter {
  readonly name = 'gastown';
  private responses: Record<string, string>;
  readonly calls: RecordedCall[] = [];

  constructor(overrides?: Record<string, string>) {
    // Load default fixture responses
    this.responses = {
      hook: readFixtureFile('gt-cli-outputs', 'hook-response.json'),
      'mol.status': readFixtureFile('gt-cli-outputs', 'mol-status.json'),
      'mail.inbox': readFixtureFile('gt-cli-outputs', 'mail-inbox.json'),
      ...overrides,
    };
  }

  async execute(command: string, args?: Record<string, unknown>): Promise<string> {
    this.calls.push({ command, args, timestamp: Date.now() });

    const response = this.responses[command];
    if (response === undefined) {
      throw new Error(`RealisticGtAdapter: no fixture for command "${command}"`);
    }
    return response;
  }

  /** Override a command response at runtime. */
  setResponse(command: string, response: string): void {
    this.responses[command] = response;
  }

  /** Get calls filtered by command name. */
  callsFor(command: string): RecordedCall[] {
    return this.calls.filter((c) => c.command === command);
  }
}

// --- ReviewFixtureAdapter ---

/**
 * Adapter that returns parsed review outputs from fixture files.
 *
 * Maps commands to fixture review-outputs:
 *   - review       → parses the fixture through parseReviewOutput()
 *   - cso          → parses the fixture through parseReviewOutput()
 *   - review-suite → combines review + cso fixtures
 */
export class ReviewFixtureAdapter implements Adapter {
  readonly name = 'gstack';
  private reviewFixture: string;
  private csoFixture: string;
  readonly calls: RecordedCall[] = [];

  constructor(opts: {
    /** Fixture filename for /review output (from review-outputs/). */
    reviewFixture: string;
    /** Fixture filename for /cso output (from review-outputs/). */
    csoFixture?: string;
  }) {
    this.reviewFixture = readFixtureFile('review-outputs', opts.reviewFixture);
    this.csoFixture = opts.csoFixture
      ? readFixtureFile('review-outputs', opts.csoFixture)
      : this.reviewFixture;
  }

  async execute(command: string, args?: Record<string, unknown>): Promise<string> {
    this.calls.push({ command, args, timestamp: Date.now() });

    switch (command) {
      case 'review':
        return JSON.stringify(parseReviewOutput(this.reviewFixture));

      case 'cso':
        return JSON.stringify(parseReviewOutput(this.csoFixture));

      case 'review-suite': {
        const review = parseReviewOutput(this.reviewFixture);
        const cso = parseReviewOutput(this.csoFixture);
        const suite: ReviewSuiteResult = { review, cso };
        return JSON.stringify(suite);
      }

      default:
        throw new Error(`ReviewFixtureAdapter: no handler for command "${command}"`);
    }
  }
}

// --- RecordingAdapter ---

/**
 * Minimal adapter that records all calls and returns configurable responses.
 * Use for verifying arg construction and call sequences.
 *
 * Supports sequential responses via commandSequences: returns responses
 * in order for each call to the same command, then repeats the last one.
 */
export class RecordingAdapter implements Adapter {
  readonly name: string;
  readonly calls: RecordedCall[] = [];
  private defaultResponse: string;
  private commandResponses: Record<string, string>;
  private commandSequences: Record<string, string[]>;
  private sequenceCounters: Record<string, number> = {};

  constructor(name: string, opts?: {
    defaultResponse?: string;
    commandResponses?: Record<string, string>;
    /** Sequential responses: each call to the command returns the next response in order. */
    commandSequences?: Record<string, string[]>;
  }) {
    this.name = name;
    this.defaultResponse = opts?.defaultResponse ?? '{"ok":true}';
    this.commandResponses = opts?.commandResponses ?? {};
    this.commandSequences = opts?.commandSequences ?? {};
  }

  async execute(command: string, args?: Record<string, unknown>): Promise<string> {
    this.calls.push({ command, args, timestamp: Date.now() });

    // Sequential responses take precedence
    const seq = this.commandSequences[command];
    if (seq && seq.length > 0) {
      const idx = this.sequenceCounters[command] ?? 0;
      this.sequenceCounters[command] = idx + 1;
      return seq[Math.min(idx, seq.length - 1)];
    }

    return this.commandResponses[command] ?? this.defaultResponse;
  }

  /** Last call made to this adapter. */
  get lastCall(): RecordedCall | undefined {
    return this.calls[this.calls.length - 1];
  }

  /** All args passed to a specific command across all calls. */
  argsFor(command: string): Array<Record<string, unknown> | undefined> {
    return this.calls
      .filter((c) => c.command === command)
      .map((c) => c.args);
  }

  /** Reset recorded calls. */
  reset(): void {
    this.calls.length = 0;
  }
}

// --- Helpers ---

function readFixtureFile(category: string, name: string): string {
  const filePath = path.join(FIXTURES_DIR, category, name);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Fixture not found: ${category}/${name}`);
  }
  return fs.readFileSync(filePath, 'utf-8');
}
