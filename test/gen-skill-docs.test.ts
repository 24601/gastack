import { describe, test, expect } from 'bun:test';
import { COMMAND_DESCRIPTIONS } from '../browse/src/commands';
import { SNAPSHOT_FLAGS } from '../browse/src/snapshot';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

describe('gen-skill-docs', () => {
  test('generated SKILL.md contains all command categories', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    const categories = new Set(Object.values(COMMAND_DESCRIPTIONS).map(d => d.category));
    for (const cat of categories) {
      expect(content).toContain(`### ${cat}`);
    }
  });

  test('generated SKILL.md contains all commands', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    for (const [cmd, meta] of Object.entries(COMMAND_DESCRIPTIONS)) {
      const display = meta.usage || cmd;
      expect(content).toContain(display);
    }
  });

  test('command table is sorted alphabetically within categories', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    // Extract command names from the Navigation section as a test
    const navSection = content.match(/### Navigation\n\|.*\n\|.*\n([\s\S]*?)(?=\n###|\n## )/);
    expect(navSection).not.toBeNull();
    const rows = navSection![1].trim().split('\n');
    const commands = rows.map(r => {
      const match = r.match(/\| `(\w+)/);
      return match ? match[1] : '';
    }).filter(Boolean);
    const sorted = [...commands].sort();
    expect(commands).toEqual(sorted);
  });

  test('generated header is present in SKILL.md', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(content).toContain('AUTO-GENERATED from SKILL.md.tmpl');
    expect(content).toContain('Regenerate: bun run gen:skill-docs');
  });

  test('generated header is present in browse/SKILL.md', () => {
    const content = fs.readFileSync(path.join(ROOT, 'browse', 'SKILL.md'), 'utf-8');
    expect(content).toContain('AUTO-GENERATED from SKILL.md.tmpl');
  });

  test('snapshot flags section contains all flags', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    for (const flag of SNAPSHOT_FLAGS) {
      expect(content).toContain(flag.short);
      expect(content).toContain(flag.description);
    }
  });

  // Dynamic template discovery — matches the generator's findTemplates() behavior.
  // New skills automatically get test coverage without updating a static list.
  const ALL_SKILLS = (() => {
    const skills: Array<{ dir: string; name: string }> = [];
    // Root template
    if (fs.existsSync(path.join(ROOT, 'SKILL.md.tmpl'))) {
      skills.push({ dir: '.', name: 'root gstack' });
    }
    // Subdirectory templates
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (fs.existsSync(path.join(ROOT, entry.name, 'SKILL.md.tmpl'))) {
        skills.push({ dir: entry.name, name: entry.name });
      }
    }
    return skills;
  })();

  test('every skill has a SKILL.md.tmpl template', () => {
    for (const skill of ALL_SKILLS) {
      const tmplPath = path.join(ROOT, skill.dir, 'SKILL.md.tmpl');
      expect(fs.existsSync(tmplPath)).toBe(true);
    }
  });

  test('every skill has a generated SKILL.md with auto-generated header', () => {
    for (const skill of ALL_SKILLS) {
      const mdPath = path.join(ROOT, skill.dir, 'SKILL.md');
      expect(fs.existsSync(mdPath)).toBe(true);
      const content = fs.readFileSync(mdPath, 'utf-8');
      expect(content).toContain('AUTO-GENERATED from SKILL.md.tmpl');
      expect(content).toContain('Regenerate: bun run gen:skill-docs');
    }
  });

  test('every generated SKILL.md has valid YAML frontmatter', () => {
    for (const skill of ALL_SKILLS) {
      const content = fs.readFileSync(path.join(ROOT, skill.dir, 'SKILL.md'), 'utf-8');
      expect(content.startsWith('---\n')).toBe(true);
      expect(content).toContain('name:');
      expect(content).toContain('description:');
    }
  });

  test('generated files are fresh (match --dry-run)', () => {
    const result = Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--dry-run'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    // Every skill should be FRESH
    for (const skill of ALL_SKILLS) {
      const file = skill.dir === '.' ? 'SKILL.md' : `${skill.dir}/SKILL.md`;
      expect(output).toContain(`FRESH: ${file}`);
    }
    expect(output).not.toContain('STALE');
  });

  test('no generated SKILL.md contains unresolved placeholders', () => {
    for (const skill of ALL_SKILLS) {
      const content = fs.readFileSync(path.join(ROOT, skill.dir, 'SKILL.md'), 'utf-8');
      const unresolved = content.match(/\{\{[A-Z_]+\}\}/g);
      expect(unresolved).toBeNull();
    }
  });

  test('templates contain placeholders', () => {
    const rootTmpl = fs.readFileSync(path.join(ROOT, 'SKILL.md.tmpl'), 'utf-8');
    expect(rootTmpl).toContain('{{COMMAND_REFERENCE}}');
    expect(rootTmpl).toContain('{{SNAPSHOT_FLAGS}}');
    expect(rootTmpl).toContain('{{PREAMBLE}}');

    const browseTmpl = fs.readFileSync(path.join(ROOT, 'browse', 'SKILL.md.tmpl'), 'utf-8');
    expect(browseTmpl).toContain('{{COMMAND_REFERENCE}}');
    expect(browseTmpl).toContain('{{SNAPSHOT_FLAGS}}');
    expect(browseTmpl).toContain('{{PREAMBLE}}');
  });

  test('generated SKILL.md contains contributor mode check', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(content).toContain('Contributor Mode');
    expect(content).toContain('gstack_contributor');
    expect(content).toContain('contributor-logs');
  });

  test('generated SKILL.md contains session awareness', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(content).toContain('_SESSIONS');
    expect(content).toContain('RECOMMENDATION');
  });

  test('generated SKILL.md contains branch detection', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(content).toContain('_BRANCH');
    expect(content).toContain('git branch --show-current');
  });

  test('generated SKILL.md contains ELI16 simplification rules', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(content).toContain('No raw function names');
    expect(content).toContain('plain English');
  });

  test('generated SKILL.md contains telemetry line', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    expect(content).toContain('skill-usage.jsonl');
    expect(content).toContain('~/.gstack/analytics');
  });

  test('preamble-using skills have correct skill name in telemetry', () => {
    const PREAMBLE_SKILLS = [
      { dir: '.', name: 'gstack' },
      { dir: 'ship', name: 'ship' },
      { dir: 'review', name: 'review' },
      { dir: 'qa', name: 'qa' },
      { dir: 'retro', name: 'retro' },
    ];
    for (const skill of PREAMBLE_SKILLS) {
      const content = fs.readFileSync(path.join(ROOT, skill.dir, 'SKILL.md'), 'utf-8');
      expect(content).toContain(`"skill":"${skill.name}"`);
    }
  });

  test('qa and qa-only templates use QA_METHODOLOGY placeholder', () => {
    const qaTmpl = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md.tmpl'), 'utf-8');
    expect(qaTmpl).toContain('{{QA_METHODOLOGY}}');

    const qaOnlyTmpl = fs.readFileSync(path.join(ROOT, 'qa-only', 'SKILL.md.tmpl'), 'utf-8');
    expect(qaOnlyTmpl).toContain('{{QA_METHODOLOGY}}');
  });

  test('QA_METHODOLOGY appears expanded in both qa and qa-only generated files', () => {
    const qaContent = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');
    const qaOnlyContent = fs.readFileSync(path.join(ROOT, 'qa-only', 'SKILL.md'), 'utf-8');

    // Both should contain the health score rubric
    expect(qaContent).toContain('Health Score Rubric');
    expect(qaOnlyContent).toContain('Health Score Rubric');

    // Both should contain framework guidance
    expect(qaContent).toContain('Framework-Specific Guidance');
    expect(qaOnlyContent).toContain('Framework-Specific Guidance');

    // Both should contain the important rules
    expect(qaContent).toContain('Important Rules');
    expect(qaOnlyContent).toContain('Important Rules');

    // Both should contain the 6 phases
    expect(qaContent).toContain('Phase 1');
    expect(qaOnlyContent).toContain('Phase 1');
    expect(qaContent).toContain('Phase 6');
    expect(qaOnlyContent).toContain('Phase 6');
  });

  test('qa-only has no-fix guardrails', () => {
    const qaOnlyContent = fs.readFileSync(path.join(ROOT, 'qa-only', 'SKILL.md'), 'utf-8');
    expect(qaOnlyContent).toContain('Never fix bugs');
    expect(qaOnlyContent).toContain('NEVER fix anything');
    // Should not have Edit, Glob, or Grep in allowed-tools
    expect(qaOnlyContent).not.toMatch(/allowed-tools:[\s\S]*?Edit/);
    expect(qaOnlyContent).not.toMatch(/allowed-tools:[\s\S]*?Glob/);
    expect(qaOnlyContent).not.toMatch(/allowed-tools:[\s\S]*?Grep/);
  });

  test('qa has fix-loop tools and phases', () => {
    const qaContent = fs.readFileSync(path.join(ROOT, 'qa', 'SKILL.md'), 'utf-8');
    // Should have Edit, Glob, Grep in allowed-tools
    expect(qaContent).toContain('Edit');
    expect(qaContent).toContain('Glob');
    expect(qaContent).toContain('Grep');
    // Should have fix-loop phases
    expect(qaContent).toContain('Phase 7');
    expect(qaContent).toContain('Phase 8');
    expect(qaContent).toContain('Fix Loop');
    expect(qaContent).toContain('Triage');
    expect(qaContent).toContain('WTF');
  });
});

describe('BASE_BRANCH_DETECT resolver', () => {
  // Find a generated SKILL.md that uses the placeholder (ship is guaranteed to)
  const shipContent = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');

  test('resolver output contains PR base detection command', () => {
    expect(shipContent).toContain('gh pr view --json baseRefName');
  });

  test('resolver output contains repo default branch detection command', () => {
    expect(shipContent).toContain('gh repo view --json defaultBranchRef');
  });

  test('resolver output contains fallback to main', () => {
    expect(shipContent).toMatch(/fall\s*back\s+to\s+`main`/i);
  });

  test('resolver output uses "the base branch" phrasing', () => {
    expect(shipContent).toContain('the base branch');
  });
});

/**
 * Quality evals — catch description regressions.
 *
 * These test that generated output is *useful for an AI agent*,
 * not just structurally valid. Each test targets a specific
 * regression we actually shipped and caught in review.
 */
describe('description quality evals', () => {
  // Regression: snapshot flags lost value hints (-d <N>, -s <sel>, -o <path>)
  test('snapshot flags with values include value hints in output', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    for (const flag of SNAPSHOT_FLAGS) {
      if (flag.takesValue) {
        expect(flag.valueHint).toBeDefined();
        expect(content).toContain(`${flag.short} ${flag.valueHint}`);
      }
    }
  });

  // Regression: "is" lost the valid states enum
  test('is command lists valid state values', () => {
    const desc = COMMAND_DESCRIPTIONS['is'].description;
    for (const state of ['visible', 'hidden', 'enabled', 'disabled', 'checked', 'editable', 'focused']) {
      expect(desc).toContain(state);
    }
  });

  // Regression: "press" lost common key examples
  test('press command lists example keys', () => {
    const desc = COMMAND_DESCRIPTIONS['press'].description;
    expect(desc).toContain('Enter');
    expect(desc).toContain('Tab');
    expect(desc).toContain('Escape');
  });

  // Regression: "console" lost --errors filter note
  test('console command describes --errors behavior', () => {
    const desc = COMMAND_DESCRIPTIONS['console'].description;
    expect(desc).toContain('--errors');
  });

  // Regression: snapshot -i lost "@e refs" context
  test('snapshot -i mentions @e refs', () => {
    const flag = SNAPSHOT_FLAGS.find(f => f.short === '-i')!;
    expect(flag.description).toContain('@e');
  });

  // Regression: snapshot -C lost "@c refs" context
  test('snapshot -C mentions @c refs', () => {
    const flag = SNAPSHOT_FLAGS.find(f => f.short === '-C')!;
    expect(flag.description).toContain('@c');
  });

  // Guard: every description must be at least 8 chars (catches empty or stub descriptions)
  test('all command descriptions have meaningful length', () => {
    for (const [cmd, meta] of Object.entries(COMMAND_DESCRIPTIONS)) {
      expect(meta.description.length).toBeGreaterThanOrEqual(8);
    }
  });

  // Guard: snapshot flag descriptions must be at least 10 chars
  test('all snapshot flag descriptions have meaningful length', () => {
    for (const flag of SNAPSHOT_FLAGS) {
      expect(flag.description.length).toBeGreaterThanOrEqual(10);
    }
  });

  // Guard: descriptions must not contain pipe (breaks markdown table cells)
  // Usage strings are backtick-wrapped in the table so pipes there are safe.
  test('no command description contains pipe character', () => {
    for (const [cmd, meta] of Object.entries(COMMAND_DESCRIPTIONS)) {
      expect(meta.description).not.toContain('|');
    }
  });

  // Guard: generated output uses → not ->
  test('generated SKILL.md uses unicode arrows', () => {
    const content = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf-8');
    // Check the Tips section specifically (where we regressed -> from →)
    const tipsSection = content.slice(content.indexOf('## Tips'));
    expect(tipsSection).toContain('→');
    expect(tipsSection).not.toContain('->');
  });
});

describe('REVIEW_DASHBOARD resolver', () => {
  const REVIEW_SKILLS = ['plan-ceo-review', 'plan-eng-review', 'plan-design-review'];

  for (const skill of REVIEW_SKILLS) {
    test(`review dashboard appears in ${skill} generated file`, () => {
      const content = fs.readFileSync(path.join(ROOT, skill, 'SKILL.md'), 'utf-8');
      expect(content).toContain('reviews.jsonl');
      expect(content).toContain('REVIEW READINESS DASHBOARD');
    });
  }

  test('review dashboard appears in ship generated file', () => {
    const content = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    expect(content).toContain('reviews.jsonl');
    expect(content).toContain('REVIEW READINESS DASHBOARD');
  });

  test('resolver output contains key dashboard elements', () => {
    const content = fs.readFileSync(path.join(ROOT, 'plan-ceo-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('VERDICT');
    expect(content).toContain('CLEARED');
    expect(content).toContain('Eng Review');
    expect(content).toContain('7 days');
    expect(content).toContain('Design Review');
    expect(content).toContain('skip_eng_review');
  });
});

// ─── Codex Generation Tests ─────────────────────────────────

describe('Codex generation (--host codex)', () => {
  const AGENTS_DIR = path.join(ROOT, '.agents', 'skills');

  // Dynamic discovery of expected Codex skills: all templates except /codex
  const CODEX_SKILLS = (() => {
    const skills: Array<{ dir: string; codexName: string }> = [];
    if (fs.existsSync(path.join(ROOT, 'SKILL.md.tmpl'))) {
      skills.push({ dir: '.', codexName: 'gstack' });
    }
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.name === 'codex') continue; // /codex is excluded from Codex output
      if (!fs.existsSync(path.join(ROOT, entry.name, 'SKILL.md.tmpl'))) continue;
      const codexName = entry.name.startsWith('gstack-') ? entry.name : `gstack-${entry.name}`;
      skills.push({ dir: entry.name, codexName });
    }
    return skills;
  })();

  test('--host codex generates correct output paths', () => {
    for (const skill of CODEX_SKILLS) {
      const skillMd = path.join(AGENTS_DIR, skill.codexName, 'SKILL.md');
      expect(fs.existsSync(skillMd)).toBe(true);
    }
  });

  test('codexSkillName mapping: root is gstack, others are gstack-{dir}', () => {
    // Root → gstack
    expect(fs.existsSync(path.join(AGENTS_DIR, 'gstack', 'SKILL.md'))).toBe(true);
    // Subdirectories → gstack-{dir}
    expect(fs.existsSync(path.join(AGENTS_DIR, 'gstack-review', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(AGENTS_DIR, 'gstack-ship', 'SKILL.md'))).toBe(true);
    // gstack-upgrade doesn't double-prefix
    expect(fs.existsSync(path.join(AGENTS_DIR, 'gstack-upgrade', 'SKILL.md'))).toBe(true);
    // No double-prefix: gstack-gstack-upgrade must NOT exist
    expect(fs.existsSync(path.join(AGENTS_DIR, 'gstack-gstack-upgrade', 'SKILL.md'))).toBe(false);
  });

  test('Codex frontmatter has ONLY name + description', () => {
    for (const skill of CODEX_SKILLS) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, skill.codexName, 'SKILL.md'), 'utf-8');
      expect(content.startsWith('---\n')).toBe(true);
      const fmEnd = content.indexOf('\n---', 4);
      expect(fmEnd).toBeGreaterThan(0);
      const frontmatter = content.slice(4, fmEnd);
      // Must have name and description
      expect(frontmatter).toContain('name:');
      expect(frontmatter).toContain('description:');
      // Must NOT have allowed-tools, version, or hooks
      expect(frontmatter).not.toContain('allowed-tools:');
      expect(frontmatter).not.toContain('version:');
      expect(frontmatter).not.toContain('hooks:');
    }
  });

  test('no .claude/skills/ in Codex output', () => {
    for (const skill of CODEX_SKILLS) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, skill.codexName, 'SKILL.md'), 'utf-8');
      expect(content).not.toContain('.claude/skills');
    }
  });

  test('no ~/.claude/ paths in Codex output', () => {
    for (const skill of CODEX_SKILLS) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, skill.codexName, 'SKILL.md'), 'utf-8');
      expect(content).not.toContain('~/.claude/');
    }
  });

  test('/codex skill excluded from Codex output', () => {
    expect(fs.existsSync(path.join(AGENTS_DIR, 'gstack-codex', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(AGENTS_DIR, 'gstack-codex'))).toBe(false);
  });

  test('--host codex --dry-run freshness', () => {
    const result = Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'codex', '--dry-run'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    // Every Codex skill should be FRESH
    for (const skill of CODEX_SKILLS) {
      expect(output).toContain(`FRESH: .agents/skills/${skill.codexName}/SKILL.md`);
    }
    expect(output).not.toContain('STALE');
  });

  test('--host agents alias produces same output as --host codex', () => {
    const codexResult = Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'codex', '--dry-run'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const agentsResult = Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', 'agents', '--dry-run'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(codexResult.exitCode).toBe(0);
    expect(agentsResult.exitCode).toBe(0);
    // Both should produce the same output (same FRESH lines)
    expect(codexResult.stdout.toString()).toBe(agentsResult.stdout.toString());
  });

  test('multiline descriptions preserved in Codex output', () => {
    // office-hours has a multiline description — verify it survives the frontmatter transform
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gstack-office-hours', 'SKILL.md'), 'utf-8');
    const fmEnd = content.indexOf('\n---', 4);
    const frontmatter = content.slice(4, fmEnd);
    // Description should span multiple lines (block scalar)
    const descLines = frontmatter.split('\n').filter(l => l.startsWith('  '));
    expect(descLines.length).toBeGreaterThan(1);
    // Verify key phrases survived
    expect(frontmatter).toContain('YC Office Hours');
  });

  test('hook skills have safety prose and no hooks: in frontmatter', () => {
    const HOOK_SKILLS = ['gstack-careful', 'gstack-freeze', 'gstack-guard'];
    for (const skillName of HOOK_SKILLS) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, skillName, 'SKILL.md'), 'utf-8');
      // Must have safety advisory prose
      expect(content).toContain('Safety Advisory');
      // Must NOT have hooks: in frontmatter
      const fmEnd = content.indexOf('\n---', 4);
      const frontmatter = content.slice(4, fmEnd);
      expect(frontmatter).not.toContain('hooks:');
    }
  });

  test('all Codex SKILL.md files have auto-generated header', () => {
    for (const skill of CODEX_SKILLS) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, skill.codexName, 'SKILL.md'), 'utf-8');
      expect(content).toContain('AUTO-GENERATED from SKILL.md.tmpl');
      expect(content).toContain('Regenerate: bun run gen:skill-docs');
    }
  });

  test('Codex preamble uses codex paths', () => {
    // Check a skill that has a preamble (review is a good candidate)
    const content = fs.readFileSync(path.join(AGENTS_DIR, 'gstack-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('~/.codex/skills/gstack');
    expect(content).toContain('.agents/skills/gstack');
  });
});
