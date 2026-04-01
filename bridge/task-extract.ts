/**
 * Task extraction from design doc markdown.
 *
 * Two modes:
 *   - Regex fast-path (deterministic, gate tier): parses `### N. Title` headings
 *   - LLM fallback (periodic tier): sends doc to LLM for extraction
 *
 * The regex path is the default and is used in CI. LLM fallback is reserved
 * for periodic evals where we compare extraction quality.
 */

// --- Types ---

export interface ExtractedTask {
  /** 1-based task number from the heading. */
  number: number;
  /** Raw title text (may contain shell metacharacters — never interpolate). */
  title: string;
  /** Full body text between this heading and the next (or end of section). */
  body: string;
  /** Whether an "Acceptance criteria" subsection was found. */
  hasAcceptanceCriteria: boolean;
}

export interface ExtractionResult {
  /** Extracted tasks (may be empty). */
  tasks: ExtractedTask[];
  /** Whether a `## Tasks` section was found. */
  hasTasksSection: boolean;
  /** Whether a `## Next Steps` section was found. */
  hasNextSteps: boolean;
  /** Extraction method used. */
  method: 'regex' | 'llm';
}

// --- Shell safety ---

/** Characters that are dangerous if interpolated into a shell string. */
const SHELL_METACHARACTERS = /[`$;|&]/;

/** Check if a title contains unescaped shell metacharacters. */
export function containsShellMetacharacters(title: string): boolean {
  return SHELL_METACHARACTERS.test(title);
}

// --- Regex fast-path ---

/**
 * Extract tasks from a design doc using regex parsing.
 *
 * Looks for a `## Tasks` section, then extracts `### N. Title` headings
 * within it. Falls back to scanning the entire doc if no Tasks section exists.
 */
export function extractTasks(markdown: string): ExtractionResult {
  const hasTasksSection = /^## Tasks\b/m.test(markdown);
  const hasNextSteps = /^## Next Steps\b/m.test(markdown);

  // Scope to the Tasks section if it exists
  let searchArea = markdown;
  if (hasTasksSection) {
    const tasksStart = markdown.search(/^## Tasks\b/m);
    // Find the next ## heading (not ###) after Tasks, or end of doc
    const afterTasks = markdown.slice(tasksStart + '## Tasks'.length);
    const nextH2 = afterTasks.search(/^## [^#]/m);
    searchArea = nextH2 === -1
      ? markdown.slice(tasksStart)
      : markdown.slice(tasksStart, tasksStart + '## Tasks'.length + nextH2);
  }

  // Match ### N. Title lines
  const taskPattern = /^### (\d+)\.\s+(.+)$/gm;
  const tasks: ExtractedTask[] = [];
  const matches = [...searchArea.matchAll(taskPattern)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const number = parseInt(match[1], 10);
    const title = match[2].trim();

    // Body extends from after this heading to the next ### or ## heading, or end
    const bodyStart = match.index! + match[0].length;
    const bodyEnd = i < matches.length - 1
      ? matches[i + 1].index!
      : searchArea.length;
    const body = searchArea.slice(bodyStart, bodyEnd).trim();

    const hasAcceptanceCriteria = /\*\*Acceptance criteria[:\*]/i.test(body);

    tasks.push({ number, title, body, hasAcceptanceCriteria });
  }

  return {
    tasks,
    hasTasksSection,
    hasNextSteps,
    method: 'regex',
  };
}

// --- Target branch detection ---

/**
 * Patterns that indicate a target/base branch in a design document.
 *
 * Matches lines like:
 *   - "Target branch: feat/auth-refactor"
 *   - "**Base branch:** `develop`"
 *   - "Branch: feature/new-api"
 *
 * Only matches plausible branch names (alphanumeric + /-_.).
 */
const TARGET_BRANCH_PATTERNS: RegExp[] = [
  /(?:target|base|feature)\s*branch\s*\**\s*[:=]\s*\**\s*`?([a-zA-Z0-9._/-]+)`?/i,
  /branch\s*(?:from|off)\s*[:=]?\s*`?([a-zA-Z0-9._/-]+)`?/i,
  /merge\s*(?:into|to)\s*[:=]?\s*`?([a-zA-Z0-9._/-]+)`?/i,
];

/** Branches that don't count as "target branch" overrides (they're the default). */
const DEFAULT_BRANCHES = new Set(['main', 'master']);

/**
 * Detect a target branch from design document markdown.
 *
 * Scans the document for target/base branch indicators. Returns null if
 * no target branch is specified or if the target is main/master (the default).
 *
 * This enables the bridge to pass --base-branch to gt sling so polecats
 * branch from the correct base, preventing merge conflicts when work
 * targets a feature branch.
 */
export function detectTargetBranch(markdown: string): string | null {
  for (const pattern of TARGET_BRANCH_PATTERNS) {
    const match = markdown.match(pattern);
    if (match) {
      const branch = match[1].trim();
      if (!DEFAULT_BRANCHES.has(branch)) {
        return branch;
      }
    }
  }
  return null;
}
