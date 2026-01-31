# Academic Paper Reviewer App

Multi-agent LaTeX reviewer with SSE streaming, Monaco diff UI, and JSON Patch workflow.

## Setup

```bash
npm run install:all
```

Create a `.env` in `server/`:

```
OPENAI_API_KEY=your_key
OPENAI_MODEL=gpt-4o
# optional: MOCK_MODE=1
```

## Run

```bash
npm run dev:server
npm run dev:web
```

- Server: http://localhost:8787
- Web: http://localhost:5173

## Notes
- Structural runs first, then Notation, Rhetoric, Critical in parallel.
- Suggestions map to line-level JSON Patch replacements, with undo history.
- If no API key is set, the server returns deterministic mock outputs.

## Architecture (Quick Overview)

**Flow**
- User uploads a `.tex` (or folder) on the Home page → review starts immediately.
- Backend runs four agents in parallel and streams results via SSE.
- Frontend renders the Feedback Summary, Reviewer #2 highlights, and inline actionable diffs.

**Agents**
1) **Structural Integrity** — LaTeX health, IMRaD order, citations.
2) **Notation & Formalism** — symbol tracking, acronym definitions.
3) **Rhetoric & Logic** — clarity, unsupported claims.
4) **Critical Reviewer (Reviewer #2)** — skeptical review, reject‑oriented critique.

**Reviewer #2**
- It is its own dedicated agent (not an aggregation).
- It receives Abstract + Results + Discussion plus server-side heuristics.
- Output is shown in the Reviewer #2 carousel.

**Sequence (ASCII)**
```
Upload (.tex/.folder)
        |
        v
   /api/review (SSE)
        |
        +--> Structural Integrity
        +--> Notation & Formalism
        +--> Rhetoric & Logic
        +--> Critical Reviewer (#2)
        |
        v
Feedback Summary + Inline Fixes + Reviewer #2 Carousel
```
