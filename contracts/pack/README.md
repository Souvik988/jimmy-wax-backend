# Backend contract pack (generated from the backend repo; deterministic - re-running with no source change produces no diff)

- openapi.yaml: source of truth (v1.6.0, 238 operations)
- api-index.md: every operation with auth, permission and MFA (generated)
- blocks.schema.json: field-level JSON Schemas for all Studio blocks, the page/tokens/navigation/chrome documents and per-slot image requirements `x-slot` (generated)
- doc-schemas.json: design system / token overrides / navigation / chrome JSON Schemas (generated from the backend validators)
- entity-schemas.json: content-library entities - care guides, stories, journal, testimonials, FAQ groups, announcements (generated)
- 03_BACKEND_CONTRACT.md, 02_EXPERIENCE_STUDIO_SPEC.md, 01_REFERENCE_ANALYSIS_BAKALOO.md, 05_CLIENT_INTEGRATION_SPEC.md, INTEGRATION_GUIDE.md, CHANGELOG.md

Regenerate with `pnpm contract:pack "<destination>"` in the backend (never edit these files by hand in a consuming project).
