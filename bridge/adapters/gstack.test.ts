/**
 * Tests for the gstack adapter — claude -p review execution.
 *
 * Unit tests cover:
 *   - parseGrade: letter grade extraction from review output
 *   - parseFindings: structured finding extraction
 *   - parseReviewOutput: combined parsing
 *   - GstackAdapter: command routing, error handling
 */

import { describe, test, expect } from 'bun:test';
import {
  parseGrade,
  parseFindings,
  parseReviewOutput,
  GstackAdapter,
  ClaudeError,
} from './gstack.js';

// --- parseGrade tests ---

describe('parseGrade', () => {
  test('extracts simple letter grade', () => {
    expect(parseGrade('Grade: B')).toBe('B');
  });

  test('extracts grade with plus/minus', () => {
    expect(parseGrade('Grade: A-')).toBe('A-');
    expect(parseGrade('Grade: B+')).toBe('B+');
  });

  test('extracts grade with equals sign', () => {
    expect(parseGrade('Rating = C')).toBe('C');
  });

  test('extracts grade case-insensitively', () => {
    expect(parseGrade('grade: a')).toBe('A');
    expect(parseGrade('GRADE: F')).toBe('F');
  });

  test('extracts grade from multiline text', () => {
    const text = `## Review Summary

Some description here.

**Grade: A**

### Details
More content...`;
    expect(parseGrade(text)).toBe('A');
  });

  test('returns null when no grade found', () => {
    expect(parseGrade('No grade here')).toBeNull();
    expect(parseGrade('')).toBeNull();
  });

  test('handles Score variant', () => {
    expect(parseGrade('Score: B-')).toBe('B-');
  });
});

// --- parseFindings tests ---

describe('parseFindings', () => {
  test('extracts CRITICAL findings', () => {
    const text = '**CRITICAL**: SQL injection in user input handler';
    const findings = parseFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('CRITICAL');
    expect(findings[0].description).toBe('SQL injection in user input handler');
  });

  test('extracts MAJOR findings', () => {
    const text = '**MAJOR** — Missing error handling in API route';
    const findings = parseFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('MAJOR');
    expect(findings[0].description).toBe('Missing error handling in API route');
  });

  test('extracts MINOR findings', () => {
    const text = '*MINOR* - Inconsistent naming convention';
    const findings = parseFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('MINOR');
  });

  test('extracts multiple findings', () => {
    const text = `
**CRITICAL**: Auth bypass in middleware
**MAJOR** — No rate limiting
**MINOR** - Missing JSDoc comment
**CRITICAL**: XSS in template rendering
    `;
    const findings = parseFindings(text);
    expect(findings).toHaveLength(4);
    expect(findings[0].severity).toBe('CRITICAL');
    expect(findings[1].severity).toBe('MAJOR');
    expect(findings[2].severity).toBe('MINOR');
    expect(findings[3].severity).toBe('CRITICAL');
  });

  test('returns empty array when no findings', () => {
    expect(parseFindings('All looks good!')).toEqual([]);
    expect(parseFindings('')).toEqual([]);
  });
});

// --- parseReviewOutput tests ---

describe('parseReviewOutput', () => {
  test('parses complete review output', () => {
    const text = `## Code Review

Grade: B+

**CRITICAL**: Unvalidated user input in handler
**MINOR** - Consider using const instead of let

Overall, good implementation with one security concern.`;

    const result = parseReviewOutput(text);
    expect(result.grade).toBe('B+');
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].severity).toBe('CRITICAL');
    expect(result.findings[1].severity).toBe('MINOR');
    expect(result.raw).toBe(text);
  });

  test('handles output with no grade or findings', () => {
    const text = 'Everything looks great, no issues found.';
    const result = parseReviewOutput(text);
    expect(result.grade).toBeNull();
    expect(result.findings).toEqual([]);
    expect(result.raw).toBe(text);
  });
});

// --- GstackAdapter tests ---

describe('GstackAdapter', () => {
  test('adapter name is gstack', () => {
    const adapter = new GstackAdapter({ cwd: '/tmp' });
    expect(adapter.name).toBe('gstack');
  });

  test('unknown command throws', async () => {
    const adapter = new GstackAdapter({ cwd: '/tmp' });
    await expect(adapter.execute('nonexistent')).rejects.toThrow(
      'Unknown gstack command',
    );
  });

  test('raw command requires prompt arg', async () => {
    const adapter = new GstackAdapter({ cwd: '/tmp' });
    await expect(adapter.execute('raw', {})).rejects.toThrow(
      'gstack raw command requires args.prompt',
    );
  });

  test('raw command requires non-empty prompt', async () => {
    const adapter = new GstackAdapter({ cwd: '/tmp' });
    await expect(adapter.execute('raw', { prompt: '' })).rejects.toThrow(
      'gstack raw command requires args.prompt',
    );
  });
});
