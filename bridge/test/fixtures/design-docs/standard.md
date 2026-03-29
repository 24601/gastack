# Bridge Review Automation — Standard Design Doc

## Overview

Implement the review automation pipeline for the bridge orchestrator. This connects
`/review` and `/cso` skill outputs to the quality policy decision tree.

## Tasks

### 1. Wire review-suite adapter command

Add a `review-suite` command to the GstackAdapter that runs `/review` and `/cso`
in parallel via `Promise.all`. Parse both outputs for grades and findings.

**Acceptance criteria:**
- Both skills run concurrently (not sequential)
- Grade parsing handles A+ through F with +/- modifiers
- Findings are extracted with severity levels (CRITICAL, MAJOR, MINOR)
- Timeout applies per-skill (not combined)

### 2. Implement quality policy evaluation

Create the `evaluate()` function in `quality.ts` that maps review results to
gate decisions using the configurable policy.

**Acceptance criteria:**
- Security gate: CRITICAL/MAJOR → BLOCKED, MINOR → WARN, none → PASS
- Correctness gate: grade below minimum → BLOCKED, at/above → PASS
- NOT_RUN review → BLOCKED (configurable)
- Combined verdict: BLOCKED if any gate BLOCKED, WARN if any WARN, else PASS

### 3. Add quality adapter to orchestrator

Register `QualityAdapter` with the orchestrator and wire it into the REVIEW stage.
The adapter receives review-suite results and returns the quality report.

**Acceptance criteria:**
- Adapter registered at construction time
- REVIEW stage queues a quality evaluation task
- Task result contains the full `QualityReport`
- BLOCKED verdict prevents advancing to REFINE

## Next Steps

- [ ] Integrate with approval flow for BLOCKED results
- [ ] Add design review gate (Phase B2)
- [ ] Add test coverage gate (Phase B3)
