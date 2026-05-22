# Checkmate

Checkmate is a local academic paper reviewer for LaTeX manuscripts. Upload a
`.tex` file or a LaTeX project folder and the app streams a multi-agent review
with source-linked comments, actionable line edits, proof checks, and a
Google Docs-style review surface powered by Monaco.

![Checkmate homepage](web/public/screenshots/homepage.png)

## What It Does

- Reviews LaTeX papers with specialized agents for structure, notation,
  rhetoric, scientific rigor, skeptical critique, and math proofs.
- Streams review progress over server-sent events so the UI updates as each
  agent finishes.
- Shows feedback as source-linked comments in a Monaco editor, with a comment
  rail that jumps back to the relevant highlighted text.
- Provides two review modes: a commented paper view and a source-focused view.
- Generates line-level suggestions and JSON Patch replacements with undo
  support for accepted edits.
- Supports single `.tex` uploads and folder uploads with shared macro files.
- Falls back to deterministic mock output when `MOCK_MODE=1` or no OpenAI key is
  configured.

## Project Layout

```text
.
├── server/                 # Express API, review agents, LaTeX parsing utilities
├── web/                    # React + Vite frontend
│   ├── public/screenshots/ # README and static screenshots
│   └── src/                # App UI, Monaco review page, text utilities
├── package.json            # Workspace helper scripts
└── README.md
```

## Requirements

- Node.js 20 or newer
- npm
- An OpenAI API key for live model-backed reviews

The app can also run in mock mode for local UI development without API calls.

## Setup

Install both workspaces:

```bash
npm run install:all
```

Create `server/.env`:

```bash
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-5-mini

# Optional
OPENAI_TIMEOUT_MS=600000
PORT=8787
MOCK_MODE=0
```

For local mock output, set:

```bash
MOCK_MODE=1
```

## Run Locally

Start the API server:

```bash
npm run dev:server
```

Start the web app in another terminal:

```bash
npm run dev:web
```

Open:

```text
http://127.0.0.1:5173/
```

The backend runs at:

```text
http://127.0.0.1:8787/
```

Health check:

```bash
curl http://127.0.0.1:8787/api/health
```

## Production Build

Build the frontend:

```bash
npm --prefix web run build
```

The build is emitted to `web/dist/`. The Vite config uses relative asset paths,
so `web/dist/index.html` can be opened directly from `file://` for quick UI
inspection. Live reviews still need the API server running at
`http://127.0.0.1:8787`.

## Tests

Run the server test suite:

```bash
npm --prefix server test
```

Run frontend tests:

```bash
npm --prefix web test
```

Run lint and build checks:

```bash
npm --prefix web run lint
npm --prefix web run build
```

## Review Pipeline

The frontend posts LaTeX to `POST /api/review`. The server streams events back
to the browser while it prepares the paper, classifies the manuscript, runs the
agents, resolves duplicate findings, and builds actionable suggestions.

```text
Upload .tex or folder
        |
        v
POST /api/review
        |
        +--> Preflight classification
        +--> Structural Integrity
        +--> Notation & Formalism
        +--> Rhetoric & Logic
        +--> Science Review, for ML papers
        +--> Critical Reviewer
        +--> Math Proof Review, for math papers
        |
        v
Monaco review view + comment rail + actionable diffs
```

## Agents

- **Structural Integrity** checks LaTeX health, section ordering, citations, and
  manuscript organization.
- **Notation & Formalism** tracks symbols, definitions, acronyms, and formal
  consistency.
- **Rhetoric & Logic** looks for unclear claims, unsupported transitions, and
  gaps in argumentation.
- **Science Review** focuses on ML/experimental rigor: datasets, baselines,
  metrics, ablations, and evidence.
- **Critical Reviewer** acts as a skeptical reviewer and highlights
  publication-risk issues.
- **Math Proof Review** inspects theorem-like environments and proof sketches
  when the paper is classified as mathematical.

## Frontend Experience

The review page is designed around Monaco instead of a plain textarea:

- Click a comment to reveal and select its source range.
- Click highlighted text to surface the corresponding comment cards.
- Use **Commented** mode for a Google Docs-like paper review.
- Use **Source** mode for a wider source editor without the comment rail.
- Accept actionable suggestions and undo accepted edits from the UI.

## Environment Notes

- The server accepts JSON bodies up to `5mb`.
- Long reviews use `OPENAI_TIMEOUT_MS`; the default is 10 minutes.
- `OPENAI_MODEL` defaults to `gpt-5-mini` when not set.
- `MOCK_MODE=1` is useful for developing the UI without model calls.
- Keep generated `web/dist/` builds out of Git; the repo ignores them.

## Troubleshooting

If the app is blank when opening `web/index.html` directly, use the Vite dev
server instead:

```bash
npm run dev:web
```

Then open `http://127.0.0.1:5173/`.

If you need a static file preview, build first and open `web/dist/index.html`.

If review requests fail from a static file preview, make sure the API server is
running on `127.0.0.1:8787`.
