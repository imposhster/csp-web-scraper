# Developer Documentation

Full documentation for handoff, reimplementation, and consumer integration. This folder is intentionally kept in-repo so it stays versioned with the code.

## Reading order by audience

### "I need to integrate with this" (consumer developer)

1. **[ARTIFACT-SCHEMAS.md](ARTIFACT-SCHEMAS.md)** — exact shape of both zip artifacts and their `manifest.json`. The consumer contract.
2. Top-level [README.md](../README.md) "Integrating into cpt-csp" section — drop-in scripts.
3. **[DATA-SOURCES.md](DATA-SOURCES.md)** — background on where the content comes from (helpful for sanity-checking upstream changes).

### "I need to operate this" (on-call, CI operator)

1. **[CI-PIPELINE.md](CI-PIPELINE.md)** — workflow walkthrough, release replacement, failure modes.
2. **[ARCHITECTURE.md](ARCHITECTURE.md)** — state directories, what each stage is responsible for, invariants.
3. Top-level [README.md](../README.md) — env var reference, local run instructions.

### "I need to port this to Java / Kotlin" (reimplementer)

1. **[ARCHITECTURE.md](ARCHITECTURE.md)** — understand the system shape first.
2. **[DATA-SOURCES.md](DATA-SOURCES.md)** — every upstream dependency and how we interact with it.
3. **[PARSING.md](PARSING.md)** — the actual business logic you must preserve.
4. **[ARTIFACT-SCHEMAS.md](ARTIFACT-SCHEMAS.md)** — the output contract (non-negotiable).
5. **[REIMPLEMENTATION.md](REIMPLEMENTATION.md)** — Kotlin/Java-specific guidance: libraries, algorithm translations, porting gotchas, test strategy, migration plan.
6. **[DECISIONS.md](DECISIONS.md)** — why the current code makes the choices it does; informs your own choices.

### "I need to extend this" (feature developer)

1. **[DECISIONS.md](DECISIONS.md)** — check whether your proposed change contradicts a prior decision.
2. **[ARCHITECTURE.md](ARCHITECTURE.md)** — know the component boundaries.
3. **[ARTIFACT-SCHEMAS.md](ARTIFACT-SCHEMAS.md)** — know what the consumer contract allows you to change safely (additive) vs. unsafely (field renames, layout changes).

## Document index

| Document | Purpose | Length |
|----------|---------|--------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System overview, pipeline stages, component responsibilities, state model, failure modes, invariants | ~200 lines |
| [DATA-SOURCES.md](DATA-SOURCES.md) | Every upstream Microsoft URL, response shape, status code semantics, rate limit assumptions | ~180 lines |
| [PARSING.md](PARSING.md) | Algorithms for TOC walk, slug normalization, Policy filter, DDF URL discovery, zip extraction | ~200 lines |
| [ARTIFACT-SCHEMAS.md](ARTIFACT-SCHEMAS.md) | JSON schemas for both manifests + zip layouts + state files | ~240 lines |
| [CI-PIPELINE.md](CI-PIPELINE.md) | Workflow walkthrough, release management, observability | ~150 lines |
| [REIMPLEMENTATION.md](REIMPLEMENTATION.md) | Java/Kotlin port guide with library recommendations and algorithm translations | ~320 lines |
| [DECISIONS.md](DECISIONS.md) | ADR log: context + decision + consequences for each significant design choice | ~220 lines |

## Conventions

- **File paths** in these docs are relative to the repo root unless absolute.
- **Code blocks** are representative, not always exact copies of the current source. When in doubt, read the script.
- **"Consumer"** means any project pulling the published zip artifacts — currently `cpt-csp-ui`.
- **"Upstream"** means Microsoft Learn and the Microsoft download CDN.

## Contributing to these docs

If you change behavior that's documented here, update the doc in the same PR. The docs are meant to be trustworthy — better stale in one place than contradictory across multiple.

Documents live in `/docs`, Markdown, UTF-8, LF line endings.
