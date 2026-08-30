# Baseline Governance

## Baseline roles

- Product/requirement baseline records confirmed behavior, scope, non-goals, and acceptance evidence.
- Architecture/runtime baseline records canonical owners, contracts, persistence boundaries, dependency direction, compatibility, and retirement.

## Alignment

A confirmed baseline error is a Design Defect and must be corrected before implementation alignment. A deviation from a correct baseline is Implementation Drift and should return to the simplest stable baseline path.

## Check protocol

Before non-trivial changes, read the relevant requirement and runtime baselines, compare scope and contracts, and report `aligned`, `Design Defect`, `Implementation Drift`, `missing-authority`, or `needs-clarification`.

## Architecture review dimensions

1. ownership integrity
2. module boundaries
3. contract changes
4. cascade proliferation
5. dependency direction
6. retirement completeness
7. entropy flow

Baseline snapshots are evidence, not independent authority. Changes to this governance file require explicit user review.
