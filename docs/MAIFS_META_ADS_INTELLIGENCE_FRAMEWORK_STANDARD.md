# Meta Ads Intelligence Framework Standard (MAIFS)

**Status:** Permanent Constitutional Governance Standard — v1.0
**Document Type:** Governance Standard. MAIFS is NOT Framework 1 and is NOT a Meta Ads Framework of any kind — it is the governance layer standing above the entire Meta Ads Framework Series.
**Series Governed:** Meta Ads Intelligence Framework Series (Series 2)
**Relationship to Everything Frozen Before It:** The Enterprise Architecture Baseline (`CORE_FRAMEWORK_ARCHITECTURE.md`, §0–§60), the Enterprise Intelligence Framework Standard (`ENTERPRISE_INTELLIGENCE_FRAMEWORK_STANDARD.md`, EIFS.1–EIFS.17), and the Generic Enterprise Intelligence Framework Series (`ENTERPRISE_INTELLIGENCE_FRAMEWORK_SERIES.md`, Frameworks 1–10, `F1.x`–`F10.x`) all remain **permanently frozen and immutable**. MAIFS references each of them only by its existing `§`, `EIFS.x`, or `F#.x` number and never restates, reinterprets, redefines, renumbers, or reorganizes any of them.
**Nature:** MAIFS governs **how** a Meta Ads Framework is envisioned, scoped, designed, named, numbered, versioned, extended, documented, validated, and frozen. It never defines **what** a Meta Ads Framework contains — no Meta Ads concept, Campaign, Ad Set, Ad, Creative, Audience, KPI, metric, algorithm, AI logic, runtime behavior, or implementation detail appears in this document.
**Relationship to EIFS:** EIFS remains the global Framework governance standard, applicable to every Series. MAIFS *specializes* EIFS for Series 2 only, adding Series-2-scoped detail without overriding or contradicting any EIFS rule.
**Numbering Convention:** Sections in this document use the prefix `MAIFS.x`, distinct from the Architecture's `§` scheme, EIFS's `EIFS.x` scheme, every Generic Framework's `F#.x` scheme, and every future Meta Ads Framework's own `MF#.x` scheme.

---

## MAIFS.1 Vision

MAIFS exists so that Meta Ads domain knowledge can grow indefinitely across many Meta Ads Frameworks — written at different times, potentially by different authors or tools — without ever requiring an earlier Framework to be rewritten, without duplicating a concept the Architecture or a Generic Framework already defines, and without ever leaving ambiguous which document is the authority for a given term, rule, or number. MAIFS's vision is a Meta Ads Framework Series that is internally consistent by construction, permanently traceable to its generic and architectural foundations, and safe to extend forever through addition alone.

---

## MAIFS.2 Purpose & Scope

MAIFS is the permanent constitutional governance standard for the Meta Ads Intelligence Framework Series. It defines the standards, constraints, governance rules, evolution rules, validation rules, quality standards, documentation standards, and structural conventions every Meta Ads Framework must follow. It never defines a Meta Ads Framework's content — no concept, KPI, objective, or domain object is named or defined here.

---

## MAIFS.3 Governance Principles

The following principles bind every Meta Ads Framework. Principles 1–4 are carried forward by reference from the Architecture; principles 5–6 are carried forward from EIFS; principles 7–8 are new to MAIFS.

1. **Generic Identity Principle** (§26/§27) — a Meta Ads Framework may specialize a generic structural position or concept for the Meta Ads domain, but may never permanently bind Meta-specific meaning back into the Architecture or a Generic Framework.
2. **External Mapping Mechanism** (§26.3) — carried forward unchanged; a Meta Ads Framework's specializations do not alter how or where functional identity is ultimately assigned to an Architecture position.
3. **Unconstrained Cardinality** (§26.4) — carried forward unchanged.
4. **Purely Additive Evolution** — carried forward unchanged; established across the Architecture (§22–§60) and the Generic Framework Series (`F1.5`–`F10.10`).
5. **Separation of Concerns** (EIFS.13, extended) — the Architecture defines structural positions; the Generic Framework Series defines abstract, domain-free concepts; the Meta Ads Framework Series defines domain-specific specialization and content. No layer performs another layer's role.
6. **One-Directional Dependency** (EIFS.14, extended by MAIFS.18) — carried forward and extended to include MAIFS and Series 2 as the final links in the chain.
7. **Genericity Preservation** (new; formalized in MAIFS.19) — specialization of a generic concept is always permitted; redefinition of a generic concept is never permitted.
8. **Domain Authority Principle** (new) — the Meta Ads Framework Series is the sole permitted location, across the entire document lineage, where Meta Ads domain content may exist. The Architecture, EIFS, and every Generic Framework remain domain-free permanently, regardless of anything the Meta Ads Framework Series ever contains.

---

## MAIFS.4 Meta Ads Framework Definition

A **Meta Ads Framework** is a documentation unit within the Meta Ads Intelligence Framework Series (Series 2) that:

- belongs to Series 2, never to Series 1 (the Generic Enterprise Intelligence Framework Series) or to the Architecture;
- consumes the Enterprise Architecture Baseline (§0–§60), EIFS, and/or the Generic Framework Series (Frameworks 1–10) strictly by reference;
- may specialize a generic concept for the Meta Ads domain (per MAIFS.19) but never redefines a generic concept;
- is assigned a unique ordinal position within Series 2 (Meta Framework 1, Meta Framework 2, …) and a unique descriptive name;
- is not itself required to be domain-agnostic — unlike a Generic Framework, a Meta Ads Framework is expected and intended to contain Meta Ads domain content, since that is the entire purpose of Series 2.

---

## MAIFS.5 Architecture Consumption Rule

A Meta Ads Framework may reference an Architecture section only by its existing `§` number. It must never restate, reinterpret, redefine, rename, renumber, or reorganize any Architecture section. The Architecture Baseline (§0–§60) is permanently frozen and immutable with respect to every Meta Ads Framework, without exception.

---

## MAIFS.6 Generic Framework Consumption Rule

A Meta Ads Framework may reference any Generic Framework (Frameworks 1–10) only by that Framework's existing `F#.x` number. It must never restate, reinterpret, redefine, rename, renumber, or reorganize any Generic Framework's content. A Meta Ads Framework specializing a generic concept must cite the generic concept's own section rather than paraphrase it.

---

## MAIFS.7 Inter-Meta-Framework Relationship Rule

A Meta Ads Framework may reference any earlier Meta Ads Framework in Series 2 only by that Framework's existing name and numbering scheme (e.g., "`MF1.3`"). A Meta Ads Framework must never restate, reinterpret, redefine, rename, renumber, or reorganize any earlier Meta Ads Framework's content. A later Meta Ads Framework builds upon an earlier one only by reference.

---

## MAIFS.8 Meta Framework Lifecycle Policy

Every Meta Ads Framework passes through the following structural sequence, and no other:

```
Proposed → Approved → Generated → Validated → Frozen
```

A Meta Ads Framework is not part of the MAIFS-compliant series until it has passed through every stage, in this order. This is a structural sequence describing document lifecycle only — it is not a runtime workflow, execution pipeline, or processing order for any Meta Ads Framework's own content. Every Meta Ads Framework must comply with MAIFS *before* its own Proposal stage begins, not merely before its Generation stage.

---

## MAIFS.9 Naming Convention

- Series 2 has a fixed name: "Meta Ads Intelligence Framework Series."
- Each Meta Ads Framework has both an ordinal position (Meta Framework 1, Meta Framework 2, …) and a unique descriptive name (e.g., "Domain Vocabulary Framework," "Campaign Framework").
- No Meta Ads Framework may share a name with any Generic Framework (Frameworks 1–10), any Architecture section, or with EIFS or MAIFS themselves.
- No Meta Ads Framework may be named "MAIFS" or use the "MAIFS" prefix for itself — that name is permanently reserved for this governance standard alone.

---

## MAIFS.10 Numbering Convention

Each Meta Ads Framework document defines its own internal section-numbering scheme, using the prefix `MF#.x` (e.g., Meta Framework 1 uses `MF1.x`, Meta Framework 2 uses `MF2.x`), guaranteed distinct from:

- the Architecture's `§` scheme,
- EIFS's `EIFS.x` scheme,
- every Generic Framework's `F#.x` scheme (`F1.x`–`F10.x`),
- this standard's own `MAIFS.x` scheme.

A Meta Ads Framework's internal numbering, once frozen, may never be renumbered or reordered.

---

## MAIFS.11 Versioning Principle

A frozen Meta Ads Framework may be amended only through a Revision, never through direct edit. This mirrors EIFS.7's Revision mechanism, applied here to Series 2.

---

## MAIFS.12 Extension Principle

A Meta Ads Framework may be extended only additively: a later Meta Ads Framework may add new concepts, new relationships, or new specializations of a generic concept. A later Meta Ads Framework may never remove, rename, reinterpret, or constrain a concept already fixed by an earlier Meta Ads Framework, a Generic Framework, EIFS, or the Architecture.

---

## MAIFS.13 Backward Compatibility Rule

No Meta Ads Framework, once frozen, may be broken by a later Meta Ads Framework, by MAIFS itself, or by any future Revision to either. A Revision to MAIFS may add new governance rules but may never remove or contradict a rule an already-frozen Meta Ads Framework was validated against.

---

## MAIFS.14 Validation Policy

Every Meta Ads Framework's own validation section must confirm, at minimum:

- every citation to the Architecture, EIFS, or a Generic Framework is by section number only, never restated;
- every specialization of a generic concept correctly cites the generic concept's own section (MAIFS.19);
- no earlier Architecture, EIFS, Generic Framework, or Meta Ads Framework content was modified;
- the Meta Ads Framework's own internal numbering is unique and does not collide with `§`, `EIFS.x`, `F#.x`, `MAIFS.x`, or any other Meta Ads Framework's `MF#.x` prefix;
- the Framework complies with the Quality Standards (MAIFS.15) and Documentation Standards (MAIFS.16) below.

Unlike a Generic Framework's validation (EIFS.10), a Meta Ads Framework's validation does **not** require confirming the absence of domain content — domain content is the expected, intended substance of a Meta Ads Framework. It does still require confirming the absence of runtime behavior, executable code, API definitions, database schemas, and AI model implementation, per MAIFS.4's scope boundary.

---

## MAIFS.15 Quality Standards

Every Meta Ads Framework must meet the following quality bar:

1. **Technical precision.** Every concept definition must be precise and enterprise-grade, never simplified for a beginner audience.
2. **Self-sufficiency.** A concept's core definition must be understandable without requiring the reader to consult external documentation, though official and alternative naming should be cited for traceability.
3. **No merging, no omission.** No two distinct concepts may be merged into one entry for brevity, and no concept within a Framework's declared coverage scope may be silently skipped.
4. **Explicit relationships.** Every relationship between concepts must be stated explicitly and directionally — never implied.
5. **Self-contained metrics.** Any KPI or metric named in a Meta Ads Framework must be fully defined (formula, inputs, interpretation) within that Framework at the point it is introduced, never assumed from outside knowledge.
6. **Internal consistency.** A term defined once within a Meta Ads Framework must be used identically everywhere else it appears in that Framework and in every later Framework that cites it.

---

## MAIFS.16 Documentation Standards

Every Meta Ads Framework must use the following structural formats, so that documentation shape is a Series-wide standard rather than a per-Framework choice:

**Concept entries** (any domain object, mechanism, or named term) must include, at minimum: Official Name, Alternative Names, Definition, Business Purpose, Meta Optimization Purpose (where applicable), Inputs, Outputs, Dependencies, Relationships, Common Mistakes, and Professional Notes.

**Objective entries** (any Meta advertising objective) must include, at minimum: Official Goal, Meta Optimization Logic, Business Goal, AI Interpretation, Supported Conversion Locations, Supported Optimization Events, Expected User Intent, Success Signals, Failure Signals, Primary KPIs, and Secondary KPIs.

**Register.** Every Meta Ads Framework is written as enterprise technical documentation for an expert audience (performance marketing expert, data scientist, AI engineer, marketing analyst) — never as a tutorial, course, or beginner-oriented explanation.

**Relationship maps**, where used, must be explicit and directional (e.g., "Campaign → contains → Ad Set"), never left implicit in prose alone.

---

## MAIFS.17 Cross-Reference Policy

Citation direction is fixed and one-directional:

```
Architecture (§) → EIFS (EIFS.x) → Generic Frameworks (F#.x) → Meta Ads Frameworks (MF#.x)
```

A citation to the Architecture always uses `§`. A citation to EIFS always uses `EIFS.x`. A citation to a Generic Framework always uses that Framework's own `F#.x` prefix. A citation to a Meta Ads Framework always uses that Framework's own `MF#.x` prefix. A citation to this standard always uses `MAIFS.x`. No document may adopt another document's numbering prefix as its own.

---

## MAIFS.18 Dependency Rule

Dependency flows strictly one way:

```
Architecture Baseline → EIFS → Generic Framework Series (F1–F10) → MAIFS → Meta Ads Framework Series (MF1, MF2, …)
```

A document at any point in this chain may reference something earlier in the chain. Nothing earlier in the chain may ever reference, depend on, or be altered by something later in it. In particular, the Architecture, EIFS, and Frameworks 1–10 never reference MAIFS or any Meta Ads Framework.

---

## MAIFS.19 Genericity Preservation Rule

A Meta Ads Framework may **specialize** a generic concept already defined in Frameworks 1–10 — asserting that a Meta Ads domain object is a kind of, or instance of, a generic concept's type (e.g., "a Campaign is a domain object that may possess a Decision, `F4.5`, once approved"). A Meta Ads Framework may never **redefine** a generic concept — it may not alter, narrow, widen, rename, or contradict what `F1.2`, `F2.4`, `F3.5`, `F4.5`, `F5.5`, `F6.4`, `F7.4`, `F8.4`, or `F9.4` already establish. Specialization is additive and directional (generic → specific); it never flows back to modify the generic definition.

---

## MAIFS.20 Change Management Policy

Every Meta Ads Framework, and every Revision to MAIFS or to a Meta Ads Framework, follows the same three-stage process already established by EIFS.16:

1. **Proposal** — states objective, rationale, deliverables, scope, out-of-scope, relationships, governance principles, validation strategy, and completion criteria, without generating any content.
2. **Approval** — the proposal is explicitly confirmed, refined, or rejected before any content is generated.
3. **Generation** — the approved proposal is produced as frozen content, followed by its own validation checklist.

No content may be generated without first completing stages 1 and 2.

---

## MAIFS.21 MAIFS Validation Checklist

MAIFS has been checked to confirm it contains:

- [x] No Meta Ads concepts, Campaign, Ad Set, Ads, Creative, Audience, or any other domain content
- [x] No KPIs, Metrics, Algorithms, or AI logic
- [x] No Runtime, APIs, Databases, or Implementation detail
- [x] No Business Logic
- [x] No modification, reinterpretation, renumbering, or reorganization of the Architecture Baseline (§0–§60), EIFS, or any Generic Framework (F1–F10)
- [x] Every citation uses the correct prefix (`§`, `EIFS.x`, `F#.x`)
- [x] Vision, Scope, Principles, Naming, Numbering, Versioning, Dependencies, Validation, Quality Standards, Documentation Standards, Lifecycle, and Change Management are each covered by an explicit, standalone rule
- [x] The Genericity Preservation Rule (MAIFS.19) correctly distinguishes specialization from redefinition
- [x] The "MAIFS" name is reserved exclusively for this governance standard, never for a Meta Ads Framework
- [x] The Architecture Baseline, EIFS, and Frameworks 1–10 remain read-only and content-identical

---

## MAIFS Closing Statement

**The Meta Ads Intelligence Framework Standard (MAIFS) is now complete and frozen as v1.0.** It becomes the mandatory governing standard for every Meta Ads Framework in Series 2. Any future change to MAIFS itself proceeds only through the Revision mechanism described in MAIFS.11, applied reflexively to this standard. The Enterprise Architecture Baseline (§0–§60), EIFS, and the Generic Enterprise Intelligence Framework Series (Frameworks 1–10) remain frozen, immutable, and untouched by this document. **MAIFS is the governance layer standing above every Meta Ads Framework — it is not Framework 1 and will never be counted as one.** Meta Framework 1 has not been started.