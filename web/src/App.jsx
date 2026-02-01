import React, { useEffect, useMemo, useRef, useState } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { applyPatch, compare } from "fast-json-patch";
import HomePage from "./components/HomePage.jsx";
import ReviewPage from "./components/ReviewPage.jsx";

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
  const [macroText, setMacroText] = useState("");
  const [macroFileName, setMacroFileName] = useState("");
  const controllerRef = useRef(null);
  const reviewModeRef = useRef("full");
  const firstChunkRef = useRef({});
  const activeAgentsRef = useRef([]);
  const firstNavRef = useRef(false);

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

  const startReview = async ({
    overrideLatex,
    overrideMacroText,
    onFinal,
    preserve,
    onFirst
  } = {}) => {
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
    firstNavRef.current = false;
    setLogs([]);
    setActiveSuggestion(null);
    setIsReviewing(true);

    try {
      const res = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          latex: override ?? latex,
          macroText: overrideMacroText ?? macroText
        }),
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
              {
                const isMl = evt.data.paperType === "ml";
                const isMath = evt.data.paperType === "math";
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
                        science: isMl ? { science_issues: [] } : null,
                        critical: { critique: [] },
                        math: {
                          status: isMath ? "processing" : "idle",
                          summary: "",
                          results: []
                        },
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
              const payloadHasIssues = (() => {
                const payload = evt.data.payload;
                if (!payload || typeof payload !== "object") return false;
                const lists = [
                  payload.integrity_report,
                  payload.symbol_analysis,
                  payload.logic_gaps,
                  payload.critique,
                  payload.science_issues
                ];
                return lists.some((list) => Array.isArray(list) && list.length > 0);
              })();
              if (
                evt.data.status === "completed" ||
                evt.data.detail?.phase === "chunk-complete" ||
                payloadHasIssues
              ) {
                firstChunkRef.current[evt.data.agent] = true;
                if (onFirst && !firstNavRef.current) {
                  firstNavRef.current = true;
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
    const macroFile = list.find((file) => {
      const name = file.name.toLowerCase();
      return name === "macro.tex" || name === "macros.tex";
    });
    const mainFile = list.find((file) => {
      const name = file.name.toLowerCase();
      return name !== "macro.tex" && name !== "macros.tex";
    });
    if (!mainFile) {
      setFileError("No main .tex file found (macro.tex detected only).");
      return null;
    }
    setSelectedFile(mainFile.name);
    const text = await mainFile.text();
    const macroSource = macroFile ? await macroFile.text() : "";
    setMacroText(macroSource);
    setMacroFileName(macroFile ? macroFile.name : "");
    handleLatexChange(text);
    return { text, macroText: macroSource };
  };

  const loadSelectedFile = async (name) => {
    setSelectedFile(name);
    const file = files.find((item) => item.name === name);
    if (!file) return;
    const text = await file.text();
    const lower = file.name.toLowerCase();
    if (lower === "macro.tex" || lower === "macros.tex") return;
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
              macroText={macroText}
              macroFileName={macroFileName}
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
              macroText={macroText}
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
              downloadText={downloadText}
            />
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
