# Shell Injection Prevention — Adapter Arg Construction

## Overview

Verify that all adapter CLI calls use array args (no shell interpolation).
Task titles and user input must never be interpolated into shell strings.

## Tasks

### 1. Test `$(whoami)` in task description

Queue a task with description `$(whoami)` and verify the literal string is
preserved in the event log without shell expansion.

**Acceptance criteria:**
- Task description stored as literal `$(whoami)`
- No process spawned by the dollar-paren expression
- Event log contains the exact string

### 2. Test `; rm -rf /` in adapter command args

Pass `; rm -rf /` as an adapter argument value and verify array-arg construction
prevents shell interpretation.

**Acceptance criteria:**
- Adapter receives the literal string `; rm -rf /`
- No shell metacharacters are interpreted
- Bun.spawn args array contains the raw value

### 3. Test backtick injection in review branch name

Use `` `cat /etc/passwd` `` as a branch name argument and verify it is
passed through as a literal string.

**Acceptance criteria:**
- Branch name preserved as literal backtick expression
- claude -p args array contains the raw value
- No command substitution occurs
