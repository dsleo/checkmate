import React, { useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";
import { BrowserRouter, Routes, Route, useNavigate } from "react-router-dom";
import { DiffEditor } from "@monaco-editor/react";
import { applyPatch, compare } from "fast-json-patch";

const DEFAULT_LATEX = `\\documentclass{article}
\\begin{document}
\\section{Results}
It is obvious that our method outperforms baselines.
\\section{Methods}
We evaluate on NLP datasets.
\\end{document}`;

function parseSSEChunk(chunk) {
  const events = [];
  const parts = chunk.split("\n\n");
  for (const part of parts) {
    if (!part.trim()) continue;
    const lines = part.split("\n");
    let event = "message";
    let data = "";
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.replace("event:", "").trim();
      if (line.startsWith("data:")) data += line.replace("data:", "").trim();
    }
    if (data) {
      try {
        events.push({ event, data: JSON.parse(data) });
      } catch {
        events.push({ event, data: {} });
      }
    }
  }
  return events;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function moveBlockLines(lines, fromStart, fromEnd, toAfterLine) {
  const start = Math.max(0, fromStart - 1);
  const end = Math.min(lines.length - 1, fromEnd - 1);
  if (start > end) return [...lines];
  const block = lines.slice(start, end + 1);
  const remaining = [...lines.slice(0, start), ...lines.slice(end + 1)];
  const blockLen = block.length;
  let insertAfter = Math.max(0, toAfterLine - 1);
  if (start <= insertAfter) {
    insertAfter = Math.max(0, insertAfter - blockLen);
  }
  const insertIndex = Math.min(remaining.length, insertAfter + 1);
  const next = [...remaining];
  next.splice(insertIndex, 0, ...block);
  return next;
}

function normalizeLatex(text) {
  if (!text) return "";
  return text.replace(/\f/g, "\\");
}

function renderMathInline(text, macros) {
  let normalized = normalizeLatex(text);
  // Convert common math environments to $$...$$
  normalized = normalized.replace(/\\begin\{equation\*?\}([\s\S]*?)\\end\{equation\*?\}/gi, (_, body) => `$$${body}$$`);
  normalized = normalized.replace(/\\begin\{align\*?\}([\s\S]*?)\\end\{align\*?\}/gi, (_, body) => `$$${body}$$`);
  normalized = normalized.replace(/\\begin\{gather\*?\}([\s\S]*?)\\end\{gather\*?\}/gi, (_, body) => `$$${body}$$`);
  normalized = normalized.replace(/\\\[/g, "$$").replace(/\\\]/g, "$$");
  normalized = normalized.replace(/\\\(/g, "$").replace(/\\\)/g, "$");

  const parts = normalized.split(/(\$\$[\s\S]+?\$\$|\$[^$]+\$)/g);
  const html = parts
    .map((part) => {
      if (!part) return "";
      const isDisplay = part.startsWith("$$") && part.endsWith("$$");
      const isInline = part.startsWith("$") && part.endsWith("$");
      if (isDisplay || isInline) {
        const content = part.replace(/^\$\$?|\$\$?$/g, "");
        try {
          return katex.renderToString(content, {
            throwOnError: false,
            displayMode: isDisplay,
            macros
          });
        } catch {
          return part;
        }
      }
      return part
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    })
    .join("");
  return html;
}

function findLineFromExcerpt(text, excerpt) {
  if (!excerpt) return 1;
  const needle = excerpt.trim();
  if (!needle) return 1;
  const idx = text.indexOf(needle);
  if (idx === -1) return 1;
  return text.slice(0, idx).split("\n").length;
}

function stripLatexInline(text) {
  if (!text) return "";
  return text
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*])?(?:\{[^}]*\})?/g, " ")
    .replace(/\\\[[\s\S]*?\\\]/g, " ")
    .replace(/\$[^$]*\$/g, " ")
    .replace(/[{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokenize(text) {
  return stripLatexInline(text)
    .split(" ")
    .filter((t) => t.length >= 3);
}

function findBestLineByTokens(text, target) {
  const targetTokens = tokenize(target);
  if (!targetTokens.length) return 1;
  const targetSet = new Set(targetTokens);

  const lines = text.split("\n");
  let bestScore = 0;
  let bestLine = 1;
  const window = 4;
  for (let i = 0; i < lines.length; i += 1) {
    const windowText = lines.slice(i, i + window).join(" ");
    const windowTokens = tokenize(windowText);
    if (!windowTokens.length) continue;
    const windowSet = new Set(windowTokens);
    let overlap = 0;
    for (const token of targetSet) {
      if (windowSet.has(token)) overlap += 1;
    }
    const jaccard =
      overlap / Math.max(1, targetSet.size + windowSet.size - overlap);
    const score = overlap * 0.7 + jaccard * 0.3;
    if (score > bestScore) {
      bestScore = score;
      bestLine = i + 1;
    }
  }
  return bestScore > 0 ? bestLine : 1;
}

function resolveJumpLine(text, primaryLine, fallbackText) {
  if (primaryLine && primaryLine > 1) return primaryLine;
  const fromExact = findLineFromExcerpt(text, fallbackText);
  if (fromExact > 1) return fromExact;
  return findBestLineByTokens(text, fallbackText);
}

function findSentenceRange(text, anchorIndex, hintText) {
  const safeIndex = Math.max(0, Math.min(text.length - 1, anchorIndex));
  const left = Math.max(
    0,
    Math.max(
      text.lastIndexOf(". ", safeIndex),
      text.lastIndexOf("? ", safeIndex),
      text.lastIndexOf("! ", safeIndex),
      text.lastIndexOf("\n\n", safeIndex)
    )
  );
  const rightCandidates = [
    text.indexOf(". ", safeIndex),
    text.indexOf("? ", safeIndex),
    text.indexOf("! ", safeIndex),
    text.indexOf("\n\n", safeIndex)
  ].filter((idx) => idx !== -1);
  const right = rightCandidates.length ? Math.min(...rightCandidates) : text.length;
  let start = left === 0 ? 0 : left + 1;
  let end = Math.min(text.length, right + 1);

  if (hintText) {
    const paragraphStart = text.lastIndexOf("\n\n", safeIndex);
    const paragraphEnd = text.indexOf("\n\n", safeIndex);
    const pStart = paragraphStart === -1 ? 0 : paragraphStart + 2;
    const pEnd = paragraphEnd === -1 ? text.length : paragraphEnd;
    const paragraph = text.slice(pStart, pEnd);
    const sentences = paragraph
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (sentences.length) {
      let best = sentences[0];
      let bestScore = 0;
      for (const sentence of sentences) {
        const score = tokenize(sentence).filter((t) =>
          tokenize(hintText).includes(t)
        ).length;
        if (score > bestScore) {
          bestScore = score;
          best = sentence;
        }
      }
      const sentenceIndex = paragraph.indexOf(best);
      if (sentenceIndex !== -1) {
        start = pStart + sentenceIndex;
        end = start + best.length;
      }
    }
  }
  return { start, end };
}

function jumpToLine(textAreaRef, text, line, hintText) {
  const lines = text.split("\n");
  const safeLine = Math.max(1, Math.min(lines.length, line || 1));
  const lineStartIndex = lines.slice(0, safeLine - 1).join("\n").length;
  const range = findSentenceRange(text, lineStartIndex, hintText);

  if (textAreaRef.current) {
    textAreaRef.current.focus();
    textAreaRef.current.setSelectionRange(range.start, range.end);
    textAreaRef.current.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
  }
}

function HomePage({
  latex,
  fileError,
  files,
  selectedFile,
  isReviewing,
  progress,
  status,
  preflight,
  logs,
  math,
  setPreflight,
  handleLatexChange,
  handleFileSelection,
  loadSelectedFile,
  startReview
}) {
  const navigate = useNavigate();
  const fileInputRef = useRef(null);
  const dirInputRef = useRef(null);
  const [hasStarted, setHasStarted] = useState(false);
  const handleSelectionAndReview = async (fileList) => {
    const text = await handleFileSelection(fileList);
    if (!text) return;
    setHasStarted(true);
    setPreflight(null);
    startReview({
      overrideLatex: text,
      onFirst: () => navigate("/review"),
      onFinal: () => {}
    });
  };
  const agentList =
    preflight?.paperType === "ml"
      ? ["Structural", "Notation", "Rhetoric", "Science", "Critical"]
      : ["Structural", "Notation", "Rhetoric", "Critical"];
  const completedAgents = agentList.filter(
    (name) => status[name]?.status === "completed"
  ).length;

  return (
    <div className="home-shell">
      <div className="home-hero">
        <p className="eyebrow">Academic Reviewer App</p>
        <h1>Stress-test your LaTeX with multi-agent peer review.</h1>
        <p className="lead">
          Upload a LaTeX file, run the review, and receive structured feedback with
          actionable fixes.
        </p>
      </div>

      <div className="home-cta">
        <button
          className="primary"
          type="button"
          onClick={() => fileInputRef.current?.click()}
          onContextMenu={(event) => {
            event.preventDefault();
            dirInputRef.current?.click();
          }}
        >
          Review Your Paper
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".tex"
          onChange={(e) => handleSelectionAndReview(e.target.files)}
          hidden
        />
        <input
          ref={dirInputRef}
          type="file"
          accept=".tex"
          webkitdirectory="true"
          directory="true"
          multiple
          onChange={(e) => handleSelectionAndReview(e.target.files)}
          hidden
        />
        {files.length > 0 && (
          <select
            className="file-select"
            value={selectedFile}
            onChange={(e) => loadSelectedFile(e.target.value)}
          >
            {files.map((file) => (
              <option key={file.name} value={file.name}>
                {file.webkitRelativePath || file.name}
              </option>
            ))}
          </select>
        )}
        {fileError && <p className="error">{fileError}</p>}

        {(isReviewing || hasStarted) && (
          <div className="processing-panel">
            <h3>Processing</h3>
            <p className="muted">
              {completedAgents}/{agentList.length} agents completed
            </p>
            {math?.status === "processing" && (
              <span className="status-pill success">Math agent running</span>
            )}
            {preflight?.paperType && (
              <p className="muted">
                {preflight.paperType === "ml"
                  ? "This looks like a Machine Learning paper."
                  : preflight.paperType === "math"
                    ? "This looks like a Mathematics paper."
                    : "This looks like a Computer Science paper."}
              </p>
            )}
            <div className="progress">
              <div className="progress-bar" style={{ width: `${progress}%` }} />
            </div>
            <div className="status-list">
              {agentList.map((name) => (
                <div key={name} className="status-item">
                  <span>{name}</span>
                  <span>
                    {status[name]?.status === "processing" ? (
                      <span className="status-processing">
                        {status[name]?.detail?.message
                          ? status[name].detail.message
                          : "processing"}{" "}
                        <span className="dots">...</span>
                      </span>
                    ) : status[name]?.status === "completed" ? (
                      "done"
                    ) : (
                      status[name]?.status || "idle"
                    )}
                  </span>
                </div>
              ))}
              {preflight?.paperType === "math" && math?.status && math.status !== "skipped" && (
                <div className="status-item">
                  <span>Proof Review</span>
                  <span>
                    {math.status === "processing" ? (
                      <span className="status-processing">
                        {`processing ${math.completed || 0}/${math.total || 0}`}{" "}
                        <span className="dots">...</span>
                      </span>
                    ) : (
                      math.status || "idle"
                    )}
                  </span>
                </div>
              )}
            </div>
            {status.Structural?.error && (
              <p className="error">Structural error: {status.Structural.error}</p>
            )}
            {logs.length > 0 && (
              <div className="log-panel">
                <div className="log-title">Live log</div>
                <div className="log-body">
                  {logs.map((entry, idx) => (
                    <div key={`${entry.ts}-${idx}`} className="log-line">
                      <span className="log-time">{entry.ts.slice(11, 19)}</span>
                      <span>{entry.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewPage({
  latex,
  textAreaRef,
  results,
  progress,
  status,
  isReviewing,
  math,
  macros,
  prompts,
  reviewCompleteAt,
  suggestions,
  structural,
  notation,
  rhetoric,
  critical,
  science,
  summaryItems,
  activeSuggestion,
  activeSummaryFixId,
  diffReport,
  adjustedCounts,
  openSuggestion,
  clearActiveFix,
  acceptSuggestion,
  startReview,
  handleLatexChange,
  selectedFile,
  undoLast,
  logs
}) {
  const navigate = useNavigate();
  const downloadRef = useRef(null);
  const [agentFilter, setAgentFilter] = useState("All");
  const [expandedRebuttals, setExpandedRebuttals] = useState(new Set());
  const proofCarouselRef = useRef(null);
  const [showToast, setShowToast] = useState(false);
  const agentList =
    results?.payload?.science || status.Science
      ? ["Structural", "Notation", "Rhetoric", "Science", "Critical"]
      : ["Structural", "Notation", "Rhetoric", "Critical"];
  const completedCount = agentList.filter(
    (name) => status[name]?.status === "completed"
  ).length;

  const renderPromptBlock = (label, prompt) => {
    if (!prompt) return null;
    if (Array.isArray(prompt)) {
      if (!prompt.length) return null;
      const combined = prompt
        .map((chunk, idx) => `# Chunk ${idx + 1}\n${chunk.system}\n\n${chunk.user}`)
        .join("\n\n---\n\n");
      return (
        <details className="prompt-block">
          <summary>{label} ({prompt.length} chunks)</summary>
          <div className="prompt-actions">
            <button
              className="prompt-copy"
              type="button"
              onClick={() => navigator.clipboard.writeText(combined)}
            >
              Copy prompt
            </button>
          </div>
          <div className="prompt-chunks">
            {prompt.map((chunk, idx) => (
              <details key={`${label}-${idx}`} className="prompt-sub">
                <summary>Chunk {idx + 1}</summary>
                <pre>{chunk.system}</pre>
                <pre>{chunk.user}</pre>
              </details>
            ))}
          </div>
        </details>
      );
    }
    const combined = `${prompt.system}\n\n${prompt.user}`;
    return (
      <details className="prompt-block">
        <summary>{label}</summary>
        <div className="prompt-actions">
          <button
            className="prompt-copy"
            type="button"
            onClick={() => navigator.clipboard.writeText(combined)}
          >
            Copy prompt
          </button>
        </div>
        <pre>{prompt.system}</pre>
        <pre>{prompt.user}</pre>
      </details>
    );
  };

  useEffect(() => {
    if (!reviewCompleteAt) return;
    setShowToast(true);
    const timer = setTimeout(() => setShowToast(false), 2500);
    return () => clearTimeout(timer);
  }, [reviewCompleteAt]);

  useEffect(() => {
    const onClick = (event) => {
      if (!downloadRef.current) return;
      const details = downloadRef.current;
      if (!details.open) return;
      if (!details.contains(event.target)) {
        details.open = false;
      }
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, []);

  if (!results) {
    return (
      <div className="app">
        <header className="hero">
          <div>
            <p className="eyebrow">Review Results</p>
            <h1>{isReviewing ? "Review in progress..." : "No review results yet."}</h1>
            <p className="lead">
              {isReviewing
                ? "We are still processing your paper. This page will populate as results arrive."
                : "Upload a paper and run a review to see feedback."}
            </p>
          </div>
          <div className="hero-actions">
            <button className="primary" onClick={() => navigate("/")}>
              Go Back
            </button>
          </div>
        </header>
        {isReviewing && (
          <section className="panel">
            <h2>Processing</h2>
            <div className="progress">
              <div className="progress-bar" style={{ width: `${progress}%` }} />
            </div>
            <div className="status-list">
              {agentList.map((name) => (
                <div key={name} className="status-item">
                  <span>{name}</span>
                  <span>
                    {status[name]?.status === "processing" ? (
                      <span className="status-processing">
                        {status[name]?.detail?.message
                          ? status[name].detail.message
                          : "processing"}{" "}
                        <span className="dots">...</span>
                      </span>
                    ) : (
                      status[name]?.status || "idle"
                    )}
                  </span>
                </div>
              ))}
              {results?.payload?.math?.status &&
                results.payload.math.status !== "skipped" && (
                <div className="status-item">
                  <span>Proof Review</span>
                  <span>
                    {math.status === "processing" ? (
                      <span className="status-processing">
                        {`processing ${math.completed || 0}/${math.total || 0}`}{" "}
                        <span className="dots">...</span>
                      </span>
                    ) : (
                      math.status || "idle"
                    )}
                  </span>
                </div>
              )}
            </div>
            {logs.length > 0 && (
              <div className="log-panel">
                <div className="log-title">Live log</div>
                <div className="log-body">
                  {logs.map((entry, idx) => (
                    <div key={`${entry.ts}-${idx}`} className="log-line">
                      <span className="log-time">{entry.ts.slice(11, 19)}</span>
                      <span>{entry.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Review Results</p>
          <h1>Actionable feedback, prioritized for revisions.</h1>
          <p className="lead">
            Review summary, inline diffs, experimental rigor checks, and a Reviewer #2
            stress test — all in one place.
          </p>
          {!isReviewing && <p className="muted">Review complete.</p>}
        </div>
        <div className="hero-actions">
          <button className="ghost" onClick={() => navigate("/")}>Go Back</button>
          <button className="primary" onClick={() => startReview()}>Re-run Review</button>
        </div>
      </header>
      {showToast && <div className="toast">Review complete ✓</div>}

      <section className="panel">
        <h2>First-pass Review</h2>
        <div className="summary-counts">
          {["All", "Structural", "Notation", "Rhetoric", "Reviewer #2"]
            .filter((name) => {
              if (name === "All") {
                const totalIssues = Object.values(adjustedCounts).reduce(
                  (sum, val) => sum + (val || 0),
                  0
                );
                return totalIssues > 0;
              }
              return (adjustedCounts[name] || 0) >= 0;
            })
            .map((name) => {
              const adjusted = adjustedCounts[name] || 0;
              const done =
                name === "Reviewer #2"
                  ? status.Critical?.status === "completed"
                  : status[name]?.status === "completed";
              return (
                <button
                  key={name}
                  className={`summary-count ${agentFilter === name ? "active" : ""} ${
                    done && adjusted === 0 && name !== "All" ? "complete" : ""
                  } ${
                    name !== "All" &&
                    (name === "Reviewer #2"
                      ? status.Critical?.status === "processing"
                      : status[name]?.status === "processing")
                      ? "pending"
                      : ""
                  }`}
                  onClick={() => setAgentFilter(name)}
                  type="button"
                >
                  <span className="tag">{name}</span>
                  {name !== "All" && (
                    <span>{adjusted === 1 ? "1 issue" : `${adjusted} issues`}</span>
                  )}
                </button>
              );
            })}
        </div>
        {Object.values(summaryItems).some((arr) => arr.length > 0) ? (
          <div className="summary-list">
            {Object.entries(summaryItems).map(([group, items]) => {
              const hasAny = items.some((item) =>
                agentFilter === "All" ? true : item.agent === agentFilter
              );
              if (!hasAny) return null;
              return (
                <div key={group} className="summary-group">
                  <p className="summary-group-title">{group}</p>
                  {["high", "medium", "low"].map((severity) => {
                    const bucket = items.filter((item) => {
                      if (item.severity !== severity) return false;
                      if (agentFilter === "All") return true;
                      return item.agent === agentFilter;
                    });
                    if (!bucket.length) return null;
                    return (
                      <div
                        key={`${group}-${severity}`}
                        className={`summary-severity-block ${severity}`}
                      >
                        <span className="summary-severity-corner">
                          {severity.toUpperCase()}
                        </span>
                        <ul className="summary-severity-list">
                          {bucket.map((item, idx) => {
                            const actionable = suggestions.find(
                              (s) => s.agent === item.agent && s.line === item.line
                            );
                            const isActive =
                              actionable && activeSummaryFixId === actionable.id;
                            return (
                              <li key={`${group}-${severity}-${idx}`} className="summary-line">
                                <span className="summary-text">{item.text}</span>
                                <button
                                  className="summary-jump"
                                  onClick={() => {
                                    const targetLine = resolveJumpLine(
                                      latex,
                                      item.line,
                                      item.excerpt || item.text
                                    );
                                    jumpToLine(textAreaRef, latex, targetLine, item.excerpt || item.text);
                                  }}
                                  title="Jump to text"
                                  aria-label="Jump to text"
                                >
                                  🔍
                                </button>
                                {agentFilter === "Reviewer #2" && item.rebuttal && (
                                  <button
                                    className="summary-rebuttal-toggle"
                                    onClick={() =>
                                      setExpandedRebuttals((prev) => {
                                        const next = new Set(prev);
                                        const key = `${group}-${severity}-${idx}`;
                                        if (next.has(key)) next.delete(key);
                                        else next.add(key);
                                        return next;
                                      })
                                    }
                                  >
                                    {expandedRebuttals.has(`${group}-${severity}-${idx}`)
                                      ? "Hide rebuttal"
                                      : "Show rebuttal"}
                                  </button>
                                )}
                                {actionable && (
                                  <button
                                    className="summary-fix"
                                    onClick={() =>
                                      isActive ? clearActiveFix() : openSuggestion(actionable)
                                    }
                                  >
                                    {isActive ? "Hide Fix" : "⚙ Fix"}
                                  </button>
                                )}
                                {agentFilter === "Reviewer #2" &&
                                  item.rebuttal &&
                                  expandedRebuttals.has(`${group}-${severity}-${idx}`) && (
                                    <div className="summary-rebuttal">
                                      {item.rebuttal}
                                    </div>
                                  )}
                                {isActive && activeSuggestion?.id === actionable.id && (
                                  <div className="summary-inline-diff">
                                    <DiffEditor
                                      height="220px"
                                      language="latex"
                                      original={activeSuggestion.original}
                                      modified={
                                        activeSuggestion.kind === "move-block"
                                          ? activeSuggestion.modified
                                          : activeSuggestion.suggestion
                                      }
                                      options={{
                                        readOnly: true,
                                        renderSideBySide: true,
                                        minimap: { enabled: false }
                                      }}
                                    />
                                    <div className="diff-actions">
                                      <button className="primary" onClick={acceptSuggestion}>
                                        Accept Fix
                                      </button>
                                      <button className="ghost" onClick={clearActiveFix}>
                                        Reject
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="muted">No issues detected.</p>
        )}
      </section>

      {results?.payload?.science?.science_issues && (
        <section className="panel">
          <h2>Science Review</h2>
          <p className="muted">Empirical rigor checks for machine learning papers.</p>
          {science.length === 0 ? (
            <p className="muted">No issues detected.</p>
          ) : (
            <div className="science-list">
              {science.map((item, idx) => (
                <div key={`science-${idx}`} className={`science-card ${item.severity}`}>
                  <span className="summary-severity-corner">
                    {item.severity.toUpperCase()}
                  </span>
                  <div className="science-header">
                    <span className="tag">{item.category.replace(/_/g, " ")}</span>
                    {item.excerpt && (
                      <button
                        className="summary-jump"
                        onClick={() =>
                          jumpToLine(
                            textAreaRef,
                            latex,
                            resolveJumpLine(latex, 0, item.excerpt),
                            item.excerpt || item.message
                          )
                        }
                        title="Jump to text"
                        aria-label="Jump to text"
                      >
                        🔍
                      </button>
                    )}
                  </div>
                  <p className="science-message">{item.message}</p>
                  {item.evidence && <p className="science-detail">{item.evidence}</p>}
                  {item.recommendation && (
                    <p className="science-detail">
                      <span>Recommendation:</span> {item.recommendation}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {math?.status && math.status !== "skipped" && math.status !== "idle" && (
        <section className="panel">
          <h2>Proof Review</h2>
          <p className="muted">
            {math.status === "processing"
              ? `Processing (${math.completed || 0}/${math.total || 0})`
              : "Processing complete"}
          </p>
          <div className="proof-summary">
            {(() => {
              const counts = { incomplete: 0, missing: 0, unclear: 0 };
              (math.results || []).forEach((r) => {
                if (r.verdict in counts) counts[r.verdict] += 1;
              });
              const parts = [];
              if (counts.incomplete) parts.push(`incomplete: ${counts.incomplete}`);
              if (counts.missing) parts.push(`missing: ${counts.missing}`);
              if (counts.unclear) parts.push(`unclear: ${counts.unclear}`);
              return parts.length ? `Issues — ${parts.join(", ")}` : "No issues detected.";
            })()}
          </div>
          <div className="proof-carousel" ref={proofCarouselRef}>
            {(math.results || []).map((item, idx) => (
              <div key={`proof-${idx}`} className={`proof-card ${item.verdict}`}>
                <div className="proof-header">
                  <span className="tag">{item.type}</span>
                  <span className="proof-verdict">{item.verdict}</span>
                </div>
                <p
                  className="proof-statement"
                  dangerouslySetInnerHTML={{
                    __html: renderMathInline(item.statement, macros)
                  }}
                />
                <button
                  className="summary-jump"
                  onClick={() => {
                    const lines = latex.split("\n");
                    const match = item.statement.slice(0, 10);
                    const idxLine = lines.findIndex((line) => line.includes(match));
                    const start = Math.max(0, idxLine - 2);
                    const end = Math.min(lines.length, start + 6);
                    const startIndex = lines.slice(0, start).join("\n").length;
                    const endIndex =
                      lines.slice(0, end).join("\n").length + (end < lines.length ? 1 : 0);
                    if (textAreaRef.current) {
                      textAreaRef.current.focus();
                      textAreaRef.current.setSelectionRange(startIndex, endIndex);
                      textAreaRef.current.scrollIntoView({
                        behavior: "smooth",
                        block: "center"
                      });
                    }
                  }}
                  title="Jump to text"
                  aria-label="Jump to text"
                >
                  🔍
                </button>
                {item.issues?.length ? (
                  <ul className="proof-issues">
                    {item.issues.map((issue, i) => (
                      <li
                        key={`issue-${i}`}
                        dangerouslySetInnerHTML={{
                          __html: renderMathInline(issue, macros)
                        }}
                      />
                    ))}
                  </ul>
                ) : null}
                {item.recommendation && (
                  <p
                    className="proof-recommendation"
                    dangerouslySetInnerHTML={{
                      __html: renderMathInline(item.recommendation, macros)
                    }}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="critique-nav">
            <button
              className="ghost tiny"
              onClick={() =>
                proofCarouselRef.current?.scrollBy({ left: -360, behavior: "smooth" })
              }
            >
              ◀
            </button>
            <button
              className="ghost tiny"
              onClick={() =>
                proofCarouselRef.current?.scrollBy({ left: 360, behavior: "smooth" })
              }
            >
              ▶
            </button>
          </div>
        </section>
      )}

      <section className="grid">
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">
              <h2>Review of {results?.payload?.title || selectedFile || "Untitled Paper"}</h2>
              <div className="panel-actions">
                <button className="ghost icon-button" onClick={undoLast} aria-label="Undo">
                  ↶
                </button>
                <details className="download-menu" ref={downloadRef}>
                  <summary className="download-button" aria-label="Download">
                    ⬇︎
                  </summary>
                  <div className="download-panel">
                    <button
                      className="download-option"
                      onClick={() => downloadText(selectedFile || "paper.tex", latex)}
                    >
                      Download .tex
                    </button>
                    <button
                      className="download-option"
                      onClick={() => downloadText("diff-report.txt", diffReport)}
                    >
                      Download diff report
                    </button>
                  </div>
                </details>
              </div>
            </div>
          </div>
          <textarea
            ref={textAreaRef}
            className="latex-input"
            value={latex}
            onChange={(e) => handleLatexChange(e.target.value)}
          />
        </div>
      </section>

      {prompts && Object.keys(prompts).length > 0 && (
        <section className="panel">
          <details className="settings-block">
            <summary>Settings</summary>
            <p className="muted">Prompts used for this review.</p>
            <div className="prompt-list">
              {renderPromptBlock("Structural", prompts.Structural)}
              {renderPromptBlock("Notation", prompts.Notation)}
              {renderPromptBlock("Rhetoric", prompts.Rhetoric)}
              {renderPromptBlock("Science", prompts.Science)}
              {renderPromptBlock("Reviewer #2", prompts.Critical)}
              {renderPromptBlock("Math (per artifact template)", prompts.Math)}
            </div>
          </details>
        </section>
      )}

      {status.Critical?.status === "completed" && null}

    </div>
  );
}

export default function App() {
  const textAreaRef = useRef(null);
  const [latex, setLatex] = useState(DEFAULT_LATEX);
  const [doc, setDoc] = useState({ lines: DEFAULT_LATEX.split("\n") });
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState({});
  const [results, setResults] = useState(null);
  const [activeSuggestion, setActiveSuggestion] = useState(null);
  const [acceptedPatches, setAcceptedPatches] = useState([]);
  const [undoStack, setUndoStack] = useState([]);
  const [acceptedIds, setAcceptedIds] = useState(new Set());
  const [resolvedReports, setResolvedReports] = useState(new Set());
  const [isReviewing, setIsReviewing] = useState(false);
  const [resolvedCounts, setResolvedCounts] = useState({});
  const [activeSummaryFixId, setActiveSummaryFixId] = useState(null);
  const [files, setFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [fileError, setFileError] = useState("");
  const [reviewCompleteAt, setReviewCompleteAt] = useState(0);
  const [preflight, setPreflight] = useState(null);
  const [logs, setLogs] = useState([]);
  const controllerRef = useRef(null);
  const reviewModeRef = useRef("full");
  const firstChunkRef = useRef({});
  const activeAgentsRef = useRef([]);

  const suggestions = (results?.payload?.suggestions || []).filter(
    (item) => !acceptedIds.has(item.id)
  );
  const structuralRaw = results?.payload?.structural?.integrity_report || [];
  const structural = structuralRaw.filter(
    (item) =>
      !resolvedReports.has(`Structural-${item.location?.line || 1}-${item.message}`)
  );
  const notation = results?.payload?.notation?.symbol_analysis || [];
  const rhetoric = results?.payload?.rhetoric?.logic_gaps || [];
  const critical = results?.payload?.critical?.critique || [];
  const science = results?.payload?.science?.science_issues || [];
  const math = results?.payload?.math || { status: "idle", summary: "", results: [] };
  const macros = results?.payload?.macros || {};
  const prompts = results?.payload?.prompts || {};

  const summaryItems = useMemo(() => {
    const items = [];
    for (const item of structural) {
      items.push({
        severity: item.severity === "error" ? "high" : "medium",
        text: item.message,
        agent: "Structural",
        line: item.location?.line || 1
      });
    }
    for (const item of notation) {
      items.push({
        severity: "medium",
        text: `${item.symbol}: ${item.recommendation}`,
        agent: "Notation",
        line: item.location?.line || 1
      });
    }
    for (const item of rhetoric) {
      items.push({
        severity: item.type === "unsupported_claim" ? "high" : "low",
        text: item.explanation,
        agent: "Rhetoric",
        line: item.location?.line || 1,
        excerpt: item.excerpt
      });
    }
    for (const item of critical) {
      items.push({
        severity: item.severity,
        text: item.weakness,
        agent: "Reviewer #2",
        line: item.location?.line || 1,
        excerpt: item.excerpt,
        rebuttal: item.rebuttal_potential
      });
    }
    const order = { high: 0, medium: 1, low: 2 };
    const grouped = {
      "Missing Sections": [],
      "Methodology & Evidence": [],
      "Citations & Context": [],
      "Notation & Definitions": [],
      "Clarity & Logic": [],
      Other: []
    };
    const pushGroup = (item) => {
      const t = item.text.toLowerCase();
      if (
        t.includes("missing") &&
        (t.includes("abstract") ||
          t.includes("introduction") ||
          t.includes("discussion") ||
          t.includes("conclusion"))
      ) {
        grouped["Missing Sections"].push(item);
        return;
      }
      if (
        t.includes("methods") ||
        t.includes("dataset") ||
        t.includes("experiments") ||
        t.includes("results") ||
        t.includes("evaluation") ||
        t.includes("reproducibility")
      ) {
        grouped["Methodology & Evidence"].push(item);
        return;
      }
      if (t.includes("citation") || t.includes("related work") || t.includes("prior work")) {
        grouped["Citations & Context"].push(item);
        return;
      }
      if (t.includes("notation") || t.includes("define") || t.includes("symbol")) {
        grouped["Notation & Definitions"].push(item);
        return;
      }
      if (
        t.includes("clarity") ||
        t.includes("logic") ||
        t.includes("fallacy") ||
        t.includes("obvious") ||
        t.includes("clear")
      ) {
        grouped["Clarity & Logic"].push(item);
        return;
      }
      grouped.Other.push(item);
    };
    items.forEach(pushGroup);
    const sortGroup = (arr) => arr.sort((a, b) => order[a.severity] - order[b.severity]);
    Object.values(grouped).forEach(sortGroup);
    return grouped;
  }, [structural, notation, rhetoric, critical, science]);

  const issueCounts = useMemo(() => {
    return {
      Structural: structural.length,
      Notation: notation.length,
      Rhetoric: rhetoric.length,
      "Reviewer #2": critical.length
    };
  }, [structural, notation, rhetoric, critical]);

  const adjustedCounts = useMemo(() => {
    const next = { ...issueCounts };
    for (const [agent, count] of Object.entries(resolvedCounts)) {
      next[agent] = Math.max(0, (next[agent] || 0) - count);
    }
    return next;
  }, [issueCounts, resolvedCounts]);

  const startReview = async ({ overrideLatex, onFinal, preserve, onFirst } = {}) => {
    const override =
      overrideLatex && typeof overrideLatex === "string" ? overrideLatex : null;
    if (isReviewing) return;
    if (controllerRef.current) controllerRef.current.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    reviewModeRef.current = preserve ? "silent" : "full";
    if (!preserve) {
      setProgress(1);
      setResults(null);
      setStatus({
        Structural: { status: "processing" },
        Notation: { status: "processing" },
        Rhetoric: { status: "processing" },
        Critical: { status: "processing" }
      });
      setResolvedReports(new Set());
    }
    firstChunkRef.current = {};
    activeAgentsRef.current = [];
    setLogs([]);
    setActiveSuggestion(null);
    setIsReviewing(true);

    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latex: override ?? latex }),
        signal: controller.signal
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() || "";
        for (const chunk of chunks) {
          for (const evt of parseSSEChunk(chunk)) {
            if (evt.event === "preflight") {
              setPreflight(evt.data);
              activeAgentsRef.current =
                evt.data.paperType === "ml"
                  ? ["Structural", "Notation", "Rhetoric", "Science", "Critical"]
                  : ["Structural", "Notation", "Rhetoric", "Critical"];
              if (evt.data.paperType === "ml") {
                setStatus((prev) => ({
                  ...prev,
                  Science: { status: "processing" }
                }));
              }
              if (!results) {
                setResults((prev) =>
                  prev || {
                      status: "processing",
                      progress: 0,
                      payload: {
                        title: evt.data.title || "",
                        macros: {},
                        structural: { integrity_report: [] },
                        notation: { symbol_analysis: [] },
                        rhetoric: { logic_gaps: [] },
                        science: { science_issues: [] },
                        critical: { critique: [] },
                        math: { status: "idle", summary: "", results: [] },
                        prompts: {},
                        suggestions: [],
                        patches: []
                      }
                    }
                );
              }
            }
            if (evt.event === "log") {
              const entry = {
                ts: evt.data.ts || new Date().toISOString(),
                message: evt.data.message || ""
              };
              setLogs((prev) => {
                const next = [...prev, entry];
                return next.length > 400 ? next.slice(next.length - 400) : next;
              });
            }
            if (evt.event === "agent-update") {
              if (reviewModeRef.current === "full") {
                setStatus((prev) => ({
                  ...prev,
                  [evt.data.agent]: evt.data
                }));
                setProgress(evt.data.progress || 0);
              } else if (evt.data.status === "completed") {
                setStatus((prev) => ({
                  ...prev,
                  [evt.data.agent]: evt.data
                }));
              }
              if (
                evt.data.status === "completed" ||
                evt.data.detail?.phase === "chunk-complete"
              ) {
                firstChunkRef.current[evt.data.agent] = true;
                const list = activeAgentsRef.current;
                if (
                  onFirst &&
                  list.length > 0 &&
                  list.every((name) => firstChunkRef.current[name])
                ) {
                  onFirst();
                  onFirst = null;
                }
              }
              if (evt.data.payload) {
                setResults((prev) => {
                  const base =
                    prev || {
                      status: "processing",
                      progress: 0,
                      payload: {
                        title: preflight?.title || "",
                        macros: {},
                        structural: { integrity_report: [] },
                        notation: { symbol_analysis: [] },
                        rhetoric: { logic_gaps: [] },
                        science: { science_issues: [] },
                        critical: { critique: [] },
                        math: { status: "idle", summary: "", results: [] },
                        prompts: {},
                        suggestions: [],
                        patches: []
                      }
                    };
                  const agentKey =
                    evt.data.agent === "Structural"
                      ? "structural"
                      : evt.data.agent === "Notation"
                        ? "notation"
                        : evt.data.agent === "Rhetoric"
                          ? "rhetoric"
                          : evt.data.agent === "Science"
                            ? "science"
                          : evt.data.agent === "Critical"
                            ? "critical"
                            : null;
                  if (!agentKey) return base;
                  return {
                    ...base,
                    payload: {
                      ...base.payload,
                      [agentKey]: evt.data.payload
                    }
                  };
                });
              }
            }
            if (evt.event === "final") {
              setResults(evt.data);
              if (reviewModeRef.current === "full") {
                setProgress(evt.data.progress || 100);
              }
              setReviewCompleteAt(Date.now());
              if (onFinal) onFinal();
            }
            if (evt.event === "math-update" || evt.event === "math-final") {
              setResults((prev) => {
                if (!prev) return prev;
                const prevMath = prev.payload?.math || { results: [] };
                const incoming = evt.data;
                const mergedResults =
                  evt.event === "math-update"
                    ? [...(prevMath.results || []), ...(incoming.results || [])]
                    : incoming.results || [];
                return {
                  ...prev,
                  payload: {
                    ...prev.payload,
                    math: {
                      status: incoming.status,
                      summary: incoming.summary,
                      completed: incoming.completed,
                      total: incoming.total,
                      results: mergedResults
                    }
                  }
                };
              });
            }
          }
        }
      }
    } finally {
      setIsReviewing(false);
    }
  };

  const handleLatexChange = (value) => {
    setLatex(value);
    setDoc({ lines: value.split("\n") });
  };

  const handleFileSelection = async (fileList) => {
    const list = Array.from(fileList || []).filter((file) =>
      file.name.toLowerCase().endsWith(".tex")
    );
    if (!list.length) {
      setFileError("No .tex files found in selection.");
      return null;
    }
    setFileError("");
    setFiles(list);
    const first = list[0];
    setSelectedFile(first.name);
    const text = await first.text();
    handleLatexChange(text);
    return text;
  };

  const loadSelectedFile = async (name) => {
    setSelectedFile(name);
    const file = files.find((item) => item.name === name);
    if (!file) return;
    const text = await file.text();
    handleLatexChange(text);
  };

  const clearActiveFix = () => {
    setActiveSuggestion(null);
    setActiveSummaryFixId(null);
  };

  const openSuggestion = (item) => {
    if (acceptedIds.has(item.id)) return;
    if (item.actionable === false) return;
    setActiveSummaryFixId(item.id);
    if (item.kind === "move-block") {
      const modifiedLines = moveBlockLines(
        doc.lines,
        item.move.fromStart,
        item.move.fromEnd,
        item.move.toAfterLine
      );
      setActiveSuggestion({
        ...item,
        original: doc.lines.join("\n"),
        modified: modifiedLines.join("\n")
      });
      return;
    }
    const original = doc.lines[item.line - 1] || "";
    setActiveSuggestion({
      ...item,
      original
    });
  };

  const acceptSuggestion = () => {
    if (!activeSuggestion) return;
    const oldDoc = { lines: [...doc.lines] };

    if (activeSuggestion.kind === "move-block") {
      const moved = moveBlockLines(
        doc.lines,
        activeSuggestion.move.fromStart,
        activeSuggestion.move.fromEnd,
        activeSuggestion.move.toAfterLine
      );
      const nextDoc = { lines: moved };
      const inverse = compare(nextDoc, oldDoc);
      setDoc(nextDoc);
      const nextText = nextDoc.lines.join("\n");
      setLatex(nextText);
      setAcceptedPatches((prev) => [
        ...prev,
        {
          op: "move-block",
          id: activeSuggestion.id,
          fromStart: activeSuggestion.move.fromStart,
          fromEnd: activeSuggestion.move.fromEnd,
          toAfterLine: activeSuggestion.move.toAfterLine
        }
      ]);
      setAcceptedIds((prev) => new Set([...prev, activeSuggestion.id]));
      if (activeSuggestion.agent === "Structural") {
        setResolvedReports((prev) => {
          const next = new Set(prev);
          next.add(
            `Structural-${activeSuggestion.line}-${activeSuggestion.reason || ""}`
          );
          return next;
        });
      }
      setUndoStack((prev) => [...prev, { inverse, id: activeSuggestion.id }]);
      clearActiveFix();
      setResolvedCounts((prev) => ({
        ...prev,
        [activeSuggestion.agent]: (prev[activeSuggestion.agent] || 0) + 1
      }));
      startReview({ overrideLatex: nextText, preserve: true });
      return;
    }

    const patch = [
      {
        op: "replace",
        path: `/lines/${activeSuggestion.line - 1}`,
        value: activeSuggestion.suggestion
      }
    ];
    const nextDoc = applyPatch({ lines: [...doc.lines] }, patch, false, true)
      .newDocument;
    const inverse = compare(nextDoc, oldDoc);

    setDoc(nextDoc);
    const nextText = nextDoc.lines.join("\n");
    setLatex(nextText);
    setAcceptedPatches((prev) => [
      ...prev,
      { ...patch[0], id: activeSuggestion.id }
    ]);
    setAcceptedIds((prev) => new Set([...prev, activeSuggestion.id]));
    if (activeSuggestion.agent === "Structural") {
      setResolvedReports((prev) => {
        const next = new Set(prev);
        next.add(
          `Structural-${activeSuggestion.line}-${activeSuggestion.reason || ""}`
        );
        return next;
      });
    }
    setUndoStack((prev) => [...prev, { inverse, id: activeSuggestion.id }]);
    clearActiveFix();
    setResolvedCounts((prev) => ({
      ...prev,
      [activeSuggestion.agent]: (prev[activeSuggestion.agent] || 0) + 1
    }));
    startReview({ overrideLatex: nextText, preserve: true });
  };

  const undoLast = () => {
    const entry = undoStack[undoStack.length - 1];
    if (!entry) return;
    const nextDoc = applyPatch({ lines: [...doc.lines] }, entry.inverse, false, true)
      .newDocument;
    setDoc(nextDoc);
    setLatex(nextDoc.lines.join("\n"));
    setUndoStack((prev) => prev.slice(0, -1));
    setAcceptedPatches((prev) => prev.slice(0, -1));
    setAcceptedIds((prev) => {
      const next = new Set(prev);
      next.delete(entry.id);
      return next;
    });
    setResolvedCounts((prev) => {
      const next = { ...prev };
      const agents = Object.keys(next);
      if (agents.length) {
        const last = agents[agents.length - 1];
        next[last] = Math.max(0, next[last] - 1);
      }
      return next;
    });
    setResolvedReports((prev) => {
      const next = new Set(prev);
      for (const item of prev) {
        if (item.startsWith("Structural-")) {
          next.delete(item);
          break;
        }
      }
      return next;
    });
  };

  const diffReport = useMemo(() => {
    if (!acceptedPatches.length) return "No accepted patches.";
    return acceptedPatches
      .map((p, idx) => {
        if (p.op === "move-block") {
          return `#${idx + 1} Move lines ${p.fromStart}-${p.fromEnd} after line ${p.toAfterLine}`;
        }
        return `#${idx + 1} Line ${p.path.replace("/lines/", "")}: ${p.value}`;
      })
      .join("\n");
  }, [acceptedPatches]);

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <HomePage
              latex={latex}
              fileError={fileError}
              files={files}
              selectedFile={selectedFile}
              isReviewing={isReviewing}
              progress={progress}
              status={status}
              preflight={preflight}
              logs={logs}
              math={math}
              setPreflight={setPreflight}
              handleLatexChange={handleLatexChange}
              handleFileSelection={handleFileSelection}
              loadSelectedFile={loadSelectedFile}
              startReview={startReview}
            />
          }
        />
        <Route
          path="/review"
          element={
            <ReviewPage
              latex={latex}
              textAreaRef={textAreaRef}
              results={results}
              progress={progress}
              status={status}
              isReviewing={isReviewing}
              reviewCompleteAt={reviewCompleteAt}
              math={math}
              macros={macros}
              prompts={prompts}
              suggestions={suggestions}
              structural={structural}
              notation={notation}
              rhetoric={rhetoric}
              critical={critical}
              science={science}
              summaryItems={summaryItems}
              activeSuggestion={activeSuggestion}
              activeSummaryFixId={activeSummaryFixId}
              diffReport={diffReport}
              adjustedCounts={adjustedCounts}
              openSuggestion={openSuggestion}
              clearActiveFix={clearActiveFix}
              acceptSuggestion={acceptSuggestion}
              startReview={() => startReview()}
              handleLatexChange={handleLatexChange}
              selectedFile={selectedFile}
              undoLast={undoLast}
              logs={logs}
            />
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
