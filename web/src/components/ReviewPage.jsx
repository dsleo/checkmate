import { useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";
import { useNavigate } from "react-router-dom";
import { DiffEditor, Editor } from "@monaco-editor/react";
import { findBestSentenceRange, resolveJumpLine } from "../utils/text.js";

function normalizeLatex(text) {
  if (!text) return "";
  return text.replace(/\f/g, "\\");
}

function renderMathInline(text, macros) {
  let normalized = normalizeLatex(text);
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
      return part.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    })
    .join("");
  return html;
}

function getRangeForHint(text, line, hintText, editorRef) {
  const lines = text.split("\n");
  const safeLine = Math.max(1, Math.min(lines.length, line || 1));
  const lineStartIndex = lines.slice(0, safeLine - 1).join("\n").length;
  const range = findBestSentenceRange(text, hintText, lineStartIndex);
  const model = editorRef.current?.getModel();
  if (!model) return null;
  const start = model.getPositionAt(range.start);
  const end = model.getPositionAt(range.end);
  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: Math.max(end.column, start.column + 1)
  };
}

function revealComment(editorRef, text, line, hintText) {
  const editor = editorRef.current;
  const model = editor?.getModel();
  if (!editor || !model) return;
  const resolvedLine = resolveJumpLine(text, line, hintText);
  const range = getRangeForHint(text, resolvedLine, hintText, editorRef);
  if (!range) return;
  const monacoRange = {
    startLineNumber: range.startLineNumber,
    startColumn: range.startColumn,
    endLineNumber: range.endLineNumber,
    endColumn: range.endColumn
  };
  editor.focus();
  editor.setSelection(monacoRange);
  editor.revealRangeInCenter(monacoRange, 1);
}

function rangeContainsPosition(range, position) {
  if (!range || !position) return false;
  if (position.lineNumber < range.startLineNumber) return false;
  if (position.lineNumber > range.endLineNumber) return false;
  if (
    position.lineNumber === range.startLineNumber &&
    position.column < range.startColumn
  ) {
    return false;
  }
  if (
    position.lineNumber === range.endLineNumber &&
    position.column > range.endColumn
  ) {
    return false;
  }
  return true;
}

export default function ReviewPage({
  latex,
  results,
  progress,
  status,
  isReviewing,
  math,
  macros,
  prompts,
  macroText,
  reviewCompleteAt,
  suggestions,
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
  logs,
  downloadText
}) {
  const navigate = useNavigate();
  const downloadRef = useRef(null);
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const decorationIdsRef = useRef([]);
  const commentRangesRef = useRef([]);
  const commentCardRefs = useRef(new Map());
  const [agentFilter, setAgentFilter] = useState("All");
  const [expandedRebuttals, setExpandedRebuttals] = useState(new Set());
  const [openGroups, setOpenGroups] = useState(new Set());
  const [activeCommentId, setActiveCommentId] = useState(null);
  const [relatedCommentIds, setRelatedCommentIds] = useState(new Set());
  const [editorReady, setEditorReady] = useState(false);
  const [reviewViewMode, setReviewViewMode] = useState("comments");
  const hasInitOpenRef = useRef(false);
  const prevFilterRef = useRef(agentFilter);
  const proofCarouselRef = useRef(null);
  const [showToast, setShowToast] = useState(false);
  const hasScience = Boolean(status.Science || results?.payload?.science);
  const showScience = Boolean(status.Science && status.Science.status !== "idle");
  const showProofReview =
    Boolean(math?.status) && math.status !== "idle" && math.status !== "skipped";
  const agentList = hasScience
    ? ["Structural", "Notation", "Rhetoric", "Science", "Critical"]
    : ["Structural", "Notation", "Rhetoric", "Critical"];
  const commentItems = useMemo(() => {
    const items = [];
    Object.entries(summaryItems || {}).forEach(([group, groupItems]) => {
      groupItems.forEach((item, idx) => {
        const actionable = suggestions.find(
          (s) => s.actionable !== false && s.agent === item.agent && s.line === item.line
        );
        items.push({
          id: `${item.agent}-${group}-${item.line}-${idx}`,
          group,
          agent: item.agent,
          severity: item.severity,
          text: item.text,
          line: item.line,
          excerpt: item.excerpt || item.text,
          actionable
        });
      });
    });
    (science || []).forEach((item, idx) => {
      items.push({
        id: `Science-${item.location?.line || 1}-${idx}`,
        group: item.category || "Science",
        agent: "Science",
        severity: item.severity || "medium",
        text: item.message,
        line: item.location?.line || 1,
        excerpt: item.excerpt || item.message
      });
    });
    (math?.results || []).forEach((item, idx) => {
      const severity = item.verdict === "complete" ? "low" : "high";
      items.push({
        id: `Proof-${idx}`,
        group: "Proof Review",
        agent: "Proof",
        severity,
        text: `${item.type || "Proof"}: ${item.verdict}`,
        line: 0,
        excerpt: item.statement || ""
      });
    });
    return items;
  }, [summaryItems, suggestions, science, math?.results]);

  const revealReviewItem = (item) => {
    setActiveCommentId(item.id);
    setRelatedCommentIds(new Set([item.id]));
    revealComment(editorRef, latex, item.line, item.excerpt || item.text);
  };

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editorReady || !editor || !monaco) return;
    const ranges = [];
    const decorations = commentItems
      .map((item) => {
        const resolvedLine = resolveJumpLine(latex, item.line, item.excerpt || item.text);
        const range = getRangeForHint(latex, resolvedLine, item.excerpt || item.text, editorRef);
        if (!range) return null;
        ranges.push({ item, range });
        const isActive = item.id === activeCommentId;
        return {
          range: new monaco.Range(
            range.startLineNumber,
            range.startColumn,
            range.endLineNumber,
            range.endColumn
          ),
          options: {
            className: `review-anchor review-anchor-${item.severity || "medium"} ${
              isActive ? "review-anchor-active" : ""
            }`,
            hoverMessage: { value: `**${item.agent}**: ${item.text}` },
            overviewRuler: {
              color:
                item.severity === "high"
                  ? "#b3462f"
                  : item.severity === "medium"
                    ? "#c79243"
                    : "#6f8f63",
              position: monaco.editor.OverviewRulerLane.Right
            }
          }
        };
      })
      .filter(Boolean);
    commentRangesRef.current = ranges;
    decorationIdsRef.current = editor.deltaDecorations(
      decorationIdsRef.current,
      decorations
    );
  }, [commentItems, latex, activeCommentId, editorReady]);

  const activateCommentsAtPosition = (position) => {
    const matching = commentRangesRef.current.filter(({ range }) =>
      rangeContainsPosition(range, position)
    );
    if (!matching.length) return;
    const ids = new Set(matching.map(({ item }) => item.id));
    const first = matching[0].item;
    setRelatedCommentIds(ids);
    setActiveCommentId(first.id);
    commentCardRefs.current.get(first.id)?.scrollIntoView({
      behavior: "smooth",
      block: "nearest"
    });
  };

  useEffect(() => {
    if (!reviewCompleteAt) return;
    setShowToast(true);
    const timer = setTimeout(() => setShowToast(false), 2500);
    return () => clearTimeout(timer);
  }, [reviewCompleteAt]);

  useEffect(() => {
    if (agentFilter === "All") {
      const next = new Set(Object.keys(summaryItems || {}));
      setOpenGroups((prev) => {
        const merged = new Set(prev);
        next.forEach((key) => merged.add(key));
        return merged;
      });
      hasInitOpenRef.current = true;
      prevFilterRef.current = agentFilter;
      return;
    }
    if (prevFilterRef.current !== agentFilter) {
      const next = new Set();
      Object.entries(summaryItems || {}).forEach(([group, items]) => {
        const hasAny = items.some((item) =>
          agentFilter === "All" ? true : item.agent === agentFilter
        );
        if (hasAny) next.add(group);
      });
      setOpenGroups(next);
    }
    prevFilterRef.current = agentFilter;
  }, [agentFilter, summaryItems]);

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

  if (!results) {
    return (
      <div className="app">
        <header className="hero">
          <div>
            <p className="eyebrow">Review Results</p>
            <h1>{isReviewing ? "Review results are streaming in." : "No review results yet."}</h1>
            <p className="lead">
              {isReviewing
                ? "We are still processing your paper. This page will populate as each agent finishes."
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
              const pending =
                name !== "All" &&
                isReviewing &&
                !done &&
                (name === "Reviewer #2"
                  ? status.Critical?.status
                  : status[name]?.status);
              const detail =
                name === "Reviewer #2"
                  ? status.Critical?.detail?.message
                  : status[name]?.detail?.message;
              return (
                <button
                  key={name}
                  className={`summary-count ${agentFilter === name ? "active" : ""} ${
                    done && adjusted === 0 && name !== "All" ? "complete" : ""
                  } ${
                    pending ? "pending" : ""
                  }`}
                  onClick={() => setAgentFilter(name)}
                  type="button"
                  title={detail || ""}
                >
                  <span className="tag">{name}</span>
                  {name !== "All" && (
                    <span>{adjusted === 1 ? "1 issue" : `${adjusted} issues`}</span>
                  )}
                  {pending && <span className="summary-status">• {detail || "Processing"}</span>}
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
                <details
                  key={group}
                  className="summary-group"
                  open={openGroups.has(group)}
                  onToggle={(event) => {
                    setOpenGroups((prev) => {
                      const next = new Set(prev);
                      const target = event.currentTarget;
                      if (target && target.open) next.add(group);
                      else next.delete(group);
                      return next;
                    });
                  }}
                >
                  <summary className="summary-group-title">{group}</summary>
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
                              (s) =>
                                s.actionable !== false &&
                                s.agent === item.agent &&
                                s.line === item.line
                            );
                            const isActive =
                              actionable && activeSummaryFixId === actionable.id;
                            return (
                              <li key={`${group}-${severity}-${idx}`} className="summary-line">
                                <span className="summary-text">{item.text}</span>
                                <button
                                  className="summary-jump"
                                  onClick={() => {
                                    revealComment(
                                      editorRef,
                                      latex,
                                      item.line,
                                      item.excerpt || item.text
                                    );
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
                </details>
              );
            })}
          </div>
        ) : (
          <p className="muted">No issues detected.</p>
        )}
      </section>

      {showScience && results?.payload?.science?.science_issues && (
        <section className="panel">
          <h2>Science Review</h2>
          {status?.Science?.status === "processing" && (
            <div className="science-status-pill">
              <span className="pill-label">Science agent</span>
              <span className="pill-detail">
                {status.Science?.detail?.message || "Processing"}
              </span>
              <span className="dots">...</span>
            </div>
          )}
          {science.length === 0 ? (
            <p className="muted">No issues detected.</p>
          ) : (
            <div className="science-list">
              {Object.entries(
                science.reduce((acc, item) => {
                  const key = item.category || "other";
                  if (!acc[key]) acc[key] = [];
                  acc[key].push(item);
                  return acc;
                }, {})
              ).map(([category, items]) => (
                <details key={category} className="science-group" open>
                  <summary className="summary-group-title">
                    {category.replace(/_/g, " ")}
                  </summary>
                  {["high", "medium", "low"].map((severity) => {
                    const bucket = items.filter((item) => item.severity === severity);
                    if (!bucket.length) return null;
                    return (
                      <div
                        key={`${category}-${severity}`}
                        className={`summary-severity-block ${severity}`}
                      >
                        <span className="summary-severity-corner">
                          {severity.toUpperCase()}
                        </span>
                        <ul className="summary-severity-list">
                          {bucket.map((item, idx) => (
                            <li key={`${category}-${severity}-${idx}`} className="summary-line">
                              <span className="summary-text">{item.message}</span>
                              {item.excerpt && (
                                <button
                                  className="summary-jump"
                                  onClick={() =>
                                    revealComment(
                                      editorRef,
                                      latex,
                                      item.location?.line || 0,
                                      item.excerpt || item.message
                                    )
                                  }
                                  title="Jump to text"
                                  aria-label="Jump to text"
                                >
                                  🔍
                                </button>
                              )}
                              {item.evidence && (
                                <div className="summary-inline-detail">{item.evidence}</div>
                              )}
                              {item.recommendation && (
                                <div className="summary-inline-detail">
                                  <span>Recommendation:</span> {item.recommendation}
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </details>
              ))}
            </div>
          )}
        </section>
      )}

      {showProofReview && (
        <section className="panel">
          <h2>Proof Review</h2>
          {math.status === "processing" && (
            <div className="science-status-pill">
              <span className="pill-label">Proof review</span>
              <span className="pill-detail">
                {`Processing ${math.completed || 0}/${math.total || 0}`}
              </span>
              <span className="dots">...</span>
            </div>
          )}
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
                    revealComment(editorRef, latex, 0, item.statement || "");
                  }}
                  title="Jump to text"
                  aria-label="Jump to text"
                >
                  🔍
                </button>
                {item.issues?.length > 0 && (
                  <div className="proof-issues">
                    {item.issues.map((issue, i) => (
                      <p key={`issue-${i}`}>{issue}</p>
                    ))}
                  </div>
                )}
                {item.recommendation && (
                  <p className="proof-recommendation">{item.recommendation}</p>
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
              {macroText && <span className="status-pill success">Macros loaded</span>}
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
          <div className="review-view-toggle" aria-label="Review view mode">
            <button
              type="button"
              className={reviewViewMode === "comments" ? "active" : ""}
              onClick={() => setReviewViewMode("comments")}
            >
              Commented
            </button>
            <button
              type="button"
              className={reviewViewMode === "source" ? "active" : ""}
              onClick={() => setReviewViewMode("source")}
            >
              Source
            </button>
          </div>
          <div
            className={`review-workbench ${
              reviewViewMode === "source" ? "source-mode" : ""
            }`}
          >
            <div className="source-editor-shell">
              <Editor
                height={reviewViewMode === "source" ? "720px" : "640px"}
                language="latex"
                value={latex}
                onChange={(value) => handleLatexChange(value || "")}
                onMount={(editor, monaco) => {
                  editorRef.current = editor;
                  monacoRef.current = monaco;
                  editor.onMouseDown((event) => {
                    if (event.target?.position) {
                      activateCommentsAtPosition(event.target.position);
                    }
                  });
                  setEditorReady(true);
                }}
                options={{
                  wordWrap: "on",
                  minimap: { enabled: false },
                  fontSize: 14,
                  lineHeight: 22,
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  renderLineHighlight: "all",
                  padding: { top: 16, bottom: 16 },
                  overviewRulerBorder: false
                }}
              />
            </div>
            {reviewViewMode === "comments" && (
              <aside className="comment-rail" aria-label="Review comments">
                <div className="comment-rail-header">
                  <span>Comments</span>
                  <span>{commentItems.length}</span>
                </div>
                {commentItems.length ? (
                  <div className="comment-list">
                    {commentItems.map((item) => (
                      <button
                        key={item.id}
                        ref={(node) => {
                          if (node) commentCardRefs.current.set(item.id, node);
                          else commentCardRefs.current.delete(item.id);
                        }}
                        type="button"
                        className={`comment-card ${item.severity || "medium"} ${
                          activeCommentId === item.id ? "active" : ""
                        } ${
                          relatedCommentIds.has(item.id) ? "related" : ""
                        }`}
                        onClick={() => revealReviewItem(item)}
                      >
                        <span className="comment-meta">
                          <span>{item.agent}</span>
                          <span>{item.line ? `Line ${item.line}` : item.group}</span>
                        </span>
                        <span className="comment-text">{item.text}</span>
                        {item.actionable && (
                          <span
                            className="comment-fix"
                            onClick={(event) => {
                              event.stopPropagation();
                              setActiveCommentId(item.id);
                              openSuggestion(item.actionable);
                            }}
                          >
                            Open fix
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="muted">No anchored comments yet.</p>
                )}
              </aside>
            )}
          </div>
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
    </div>
  );
}
