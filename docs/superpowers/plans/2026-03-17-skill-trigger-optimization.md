# Skill Trigger Optimization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize trigger descriptions for all installed OpenClaw skills using the skill-creator workflow.

**Architecture:** Inventory all skills under `~/.openclaw/skills/`, snapshot current SKILL.md frontmatter, then iterate through each skill to improve the description field with an automated loop when available. Ensure results are written back to each skill’s SKILL.md frontmatter and logged.

**Tech Stack:** PowerShell, Python via `uv`, OpenClaw skill-creator assets (scripts/), markdown edits.

---

### Task 1: Inventory and snapshot

**Files:**
- Read: `C:\Users\34438\.openclaw\skills\*\SKILL.md`
- Create: `C:\Users\34438\.openclaw\workspace\skill-trigger-optimization\inventory.json`
- Create: `C:\Users\34438\.openclaw\workspace\skill-trigger-optimization\snapshots\<skill>\SKILL.md`

- [ ] **Step 1: List skill directories**

Run:
```
Get-ChildItem "C:\Users\34438\.openclaw\skills" -Directory | Select-Object Name
```
Expected: list of skill folder names.

- [ ] **Step 2: Snapshot current SKILL.md files**

Run:
```
New-Item -ItemType Directory -Path "C:\Users\34438\.openclaw\workspace\skill-trigger-optimization\snapshots" -Force | Out-Null
```
Then copy each `SKILL.md` into its snapshot folder.

- [ ] **Step 3: Build inventory.json**

Create a JSON array with entries:
```
{
  "name": "skill-folder",
  "path": "C:\\Users\\34438\\.openclaw\\skills\\skill-folder",
  "skill_md": "...\\SKILL.md",
  "description": "<current description>"
}
```

- [ ] **Step 4: Commit checkpoint**

Run:
```
git add docs/superpowers/plans/2026-03-17-skill-trigger-optimization.md
```
If in a repo, commit after build verification.

---

### Task 2: Verify skill-creator tooling availability

**Files:**
- Read: `C:\Users\34438\.openclaw\skills\skill-creator\scripts\` (if exists)
- Read: `C:\Users\34438\.openclaw\skills\skill-creator\references\` (if exists)

- [ ] **Step 1: Confirm run_loop.py and eval scripts exist**

Run:
```
Get-ChildItem "C:\Users\34438\.openclaw\skills\skill-creator\scripts" -Filter "*.py"
```
Expected: `run_loop.py`, `run_eval.py`, `aggregate_benchmark.py` or similar.

- [ ] **Step 2: Decide path**

If scripts exist: use automated loop per skill-creator instructions.
If scripts are missing: use manual description optimization with heuristics (see Task 4).

---

### Task 3: Automated description optimization loop (preferred)

**Files:**
- Modify: `C:\Users\34438\.openclaw\skills\<skill>\SKILL.md`
- Create: `C:\Users\34438\.openclaw\workspace\skill-trigger-optimization\<skill>\trigger_eval.json`
- Create: `C:\Users\34438\.openclaw\workspace\skill-trigger-optimization\<skill>\run_log.txt`

- [ ] **Step 1: Generate trigger eval set**

Create 16-20 queries (8-10 should-trigger, 8-10 should-not-trigger) per skill and save as JSON:
```
[
  {"query": "...", "should_trigger": true},
  {"query": "...", "should_trigger": false}
]
```

- [ ] **Step 2: Run description optimization loop**

Run (example):
```
uv run python -m scripts.run_loop --eval-set <path> --skill-path <skill-path> --model openai-codex/gpt-5.2-codex --max-iterations 5 --verbose
```
Capture output to `run_log.txt`.

- [ ] **Step 3: Apply best_description**

Update the SKILL.md frontmatter `description` with `best_description`.

- [ ] **Step 4: Record changes**

Update `inventory.json` with new description and a `score` field if available.

---

### Task 4: Manual description optimization (fallback)

**Files:**
- Modify: `C:\Users\34438\.openclaw\skills\<skill>\SKILL.md`
- Create: `C:\Users\34438\.openclaw\workspace\skill-trigger-optimization\<skill>\manual_notes.md`

- [ ] **Step 1: Draft improved description**

Rewrite the description with explicit trigger phrases and contexts. Ensure it is pushy and includes common user phrasings.

- [ ] **Step 2: Update SKILL.md frontmatter**

Replace the `description` value while preserving name and formatting.

- [ ] **Step 3: Log**

Write before/after into `manual_notes.md` and update `inventory.json`.

---

### Task 5: Validation and summary

**Files:**
- Create: `C:\Users\34438\.openclaw\workspace\skill-trigger-optimization\summary.md`

- [ ] **Step 1: Validate frontmatter**

Verify each SKILL.md starts with YAML frontmatter containing `name` and `description`.

- [ ] **Step 2: Build summary**

Write a summary with counts of skills updated and any failures.

- [ ] **Step 3: Final build check (if required by repo policy)**

Run:
```
npm run build
```
Expected: success.

- [ ] **Step 4: Commit**

Commit all changes after build success.

---

## Notes
- Use PowerShell only.
- Use `uv run python` for Python scripts.
- No emoji in outputs or docs.
- Do not overwrite SKILL.md structure beyond frontmatter description.
