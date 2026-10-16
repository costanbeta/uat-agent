# TODOS

## Batch loop over many screens

- **What:** Add a `screens.yaml` input (url + figma node + actions per screen) and loop `/uat-check` over it, one screen at a time.
- **Why:** Figma workflows have 80 to 100 screens; running one screen by hand per call does not scale once detection works.
- **Pros:** whole-workflow coverage in one command; ledger already stores a one-entry screens list, so no format change.
- **Cons:** needs per-screen failure isolation, a loader module, and tests for a malformed file; adds a second input path.
- **Context:** deferred in the eng review (D2) to keep v1 to the single-screen wedge. Design doc: docs/designs/design-uat-agent.md (v1 Behavior Spec, `/uat-check` input). Start at the capture entrypoint and the ledger screen entry.
- **Depends on / blocked by:** the first live success check on a fresh round-1 feature in UAT passing the working bar (Success Criteria in the design doc) (provisional: about 40% recall and about 80% re-check agreement, both estimates, to be tuned by Vijay after the first run).

## Region-crop judging if small-detail recall is low

- **What:** Judge each page in zoomed regions with crops instead of one downscaled full-page screenshot.
- **Why:** a downscaled screenshot can hide 1px borders and small spacing differences, the exact issues in the sheet; the DOM computed styles only partly compensate.
- **Pros:** better recall on border and spacing rows; evidence crops already exist per row.
- **Cons:** more vision calls per screen (cost and time), region-splitting logic, harder to dedupe issues across regions.
- **Context:** medium-confidence finding from the eng review (PF3). Trigger: recall on border and spacing rows is below the bar after the first success check. Start in the `/uat-check` skill prompt and `capture.ts` (crop generation).
- **Depends on / blocked by:** the first success check result, measured on border and spacing rows separately.
