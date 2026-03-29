# Event Log Corruption Repair

## Overview

Add heuristic JSON repair for truncated event log lines. When a process is killed
mid-write, the last line may be incomplete JSON. Instead of silently dropping it,
attempt structural repair.

## Tasks

### 1. Detect truncation vs garbage

Classify malformed lines as either truncation (starts like valid JSON but is
incomplete) or garbage (binary data, concurrent writer corruption). Only attempt
repair on truncation.

**Acceptance criteria:**
- Lines starting with `{` and containing printable ASCII are classified as truncation
- Lines with control characters (0x00-0x08, 0x0E-0x1F) are garbage
- Classification is tested against both patterns

### 2. Implement structural JSON repair

Close unclosed strings, arrays, and objects based on a stack-tracking parser.
Add `null` placeholders for missing values after `:` or `,`.

**Acceptance criteria:**
- Unclosed `{` gets matching `}`
- Unclosed `[` gets matching `]`
- Unclosed string gets closing `"`
- Trailing `:` or `,` gets `null` placeholder
- Repaired result passes `JSON.parse()` validation
