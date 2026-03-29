# /review — Catching a Race Condition

Real session transcript showing `/review` finding a subtle race condition in a PR and auto-fixing it.

---

**You:** /review

**Claude:** Reviewing changes on branch `feature/async-export`...

```
git diff main...HEAD --stat
 src/export/worker.ts    | 47 ++++++++++++++++++++
 src/export/queue.ts     | 31 +++++++++++++
 src/api/routes.ts       |  8 ++++
 test/export.test.ts     | 62 ++++++++++++++++++++++++++
 4 files changed, 148 insertions(+)
```

**Analyzing 4 files, 148 lines added...**

### Review Findings

**CRITICAL — Race condition in export queue (src/export/queue.ts:18-24)**

```typescript
async processNext() {
  const job = this.queue.shift();     // Line 18: dequeues
  if (!job) return;
  this.processing = true;             // Line 20: sets flag
  await this.worker.process(job);     // Line 21: async work
  this.processing = false;            // Line 22: clears flag
  this.processNext();                 // Line 23: recurse
}
```

Two calls to `processNext()` can interleave. If `enqueue()` is called while `process(job)` is awaiting, the second `enqueue` sees `processing = true` and skips, but after the first job completes and calls `processNext()` recursively, the queue may have already been drained by a concurrent call. Jobs can be processed twice or dropped.

**[AUTO-FIX]** Adding a mutex guard:

```typescript
async processNext() {
  if (this.processing) return;        // guard against re-entry
  const job = this.queue.shift();
  if (!job) return;
  this.processing = true;
  try {
    await this.worker.process(job);
  } finally {
    this.processing = false;
    if (this.queue.length > 0) {
      this.processNext();             // drain remaining
    }
  }
}
```

Committed: `fix: prevent race condition in export queue processing`

**MINOR — Missing error handling in worker (src/export/worker.ts:32)**

If `exportToPdf()` throws, the job is lost with no retry. Consider wrapping in try/catch with a dead-letter queue or retry counter. **[ASK]** Want me to add retry logic (max 3 attempts with exponential backoff)?

**You:** Yes, add retry.

**Claude:** Added retry logic with 3 attempts and exponential backoff (1s, 2s, 4s). Failed jobs after 3 attempts are logged and moved to a `failedJobs` array for manual inspection.

Committed: `feat: add retry logic to export worker (3 attempts, exponential backoff)`

### Grade: B+ → A (after fixes)

| Category | Score |
|----------|-------|
| Correctness | A (after race condition fix) |
| Error handling | A (after retry addition) |
| Test coverage | A (export tests cover happy path + failure) |
| Security | A (no user input in export path) |

**2 issues found, 2 fixed. Ready to ship.**

---

*The race condition would have passed all tests — the test suite runs sequentially. It would only manifest in production under concurrent export requests. `/review` caught it by static analysis of the async control flow, not by running the code.*
