import type { Host } from './types';

export function codexSkillName(skillDir: string): string {
  if (skillDir === '.' || skillDir === '') return 'gstack';
  // Don't double-prefix: gstack-upgrade → gstack-upgrade (not gstack-gstack-upgrade)
  if (skillDir.startsWith('gstack-')) return skillDir;
  return `gstack-${skillDir}`;
}

/**
 * Transform frontmatter for Codex: keep only name + description.
 * Strips allowed-tools, hooks, version, and all other fields.
 * Handles multiline block scalar descriptions (YAML | syntax).
 */
export function transformFrontmatter(content: string, host: Host): string {
  if (host === 'claude') return content;

  // Find frontmatter boundaries
  const fmStart = content.indexOf('---\n');
  if (fmStart !== 0) return content; // frontmatter must be at the start
  const fmEnd = content.indexOf('\n---', fmStart + 4);
  if (fmEnd === -1) return content;

  const frontmatter = content.slice(fmStart + 4, fmEnd);
  const body = content.slice(fmEnd + 4); // includes the leading \n after ---

  // Parse name
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : '';

  // Parse description — handle both simple and block scalar (|) formats
  let description = '';
  const lines = frontmatter.split('\n');
  let inDescription = false;
  const descLines: string[] = [];
  for (const line of lines) {
    if (line.match(/^description:\s*\|?\s*$/)) {
      // Block scalar start: "description: |" or "description:"
      inDescription = true;
      continue;
    }
    if (line.match(/^description:\s*\S/)) {
      // Simple inline: "description: some text"
      description = line.replace(/^description:\s*/, '').trim();
      break;
    }
    if (inDescription) {
      // Block scalar continuation — indented lines (2 spaces) or blank lines
      if (line === '' || line.match(/^\s/)) {
        descLines.push(line.replace(/^  /, ''));
      } else {
        // End of block scalar — hit a non-indented, non-blank line
        break;
      }
    }
  }
  if (descLines.length > 0) {
    description = descLines.join('\n').trim();
  }

  // Re-emit Codex frontmatter (name + description only)
  const indentedDesc = description.split('\n').map(l => `  ${l}`).join('\n');
  const codexFm = `---\nname: ${name}\ndescription: |\n${indentedDesc}\n---`;
  return codexFm + body;
}

/**
 * Extract hook descriptions from frontmatter for inline safety prose.
 * Returns a description of what the hooks do, or null if no hooks.
 */
export function extractHookSafetyProse(tmplContent: string): string | null {
  if (!tmplContent.match(/^hooks:/m)) return null;

  // Parse the hook matchers to build a human-readable safety description
  const matchers: string[] = [];
  const matcherRegex = /matcher:\s*"(\w+)"/g;
  let m;
  while ((m = matcherRegex.exec(tmplContent)) !== null) {
    if (!matchers.includes(m[1])) matchers.push(m[1]);
  }

  if (matchers.length === 0) return null;

  // Build safety prose based on what tools are hooked
  const toolDescriptions: Record<string, string> = {
    Bash: 'check bash commands for destructive operations (rm -rf, DROP TABLE, force-push, git reset --hard, etc.) before execution',
    Edit: 'verify file edits are within the allowed scope boundary before applying',
    Write: 'verify file writes are within the allowed scope boundary before applying',
  };

  const safetyChecks = matchers
    .map(t => toolDescriptions[t] || `check ${t} operations for safety`)
    .join(', and ');

  return `> **Safety Advisory:** This skill includes safety checks that ${safetyChecks}. When using this skill, always pause and verify before executing potentially destructive operations. If uncertain about a command's safety, ask the user for confirmation before proceeding.`;
}
