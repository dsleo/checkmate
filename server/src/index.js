import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import {
  extractPreamble,
  extractSections,
  extractMathEnvs,
  extractDefinitionsSection,
  extractSectionContent,
  extractAbstractResultsDiscussion,
  extractTitle,
  extractMacros,
  minifyLatex,
  stripHeavyMath,
  extractCoreText,
  extractMathArtifacts,
  stripPreamblePreserveLines,
  stripReferencesPreserveLines,
  splitLines,
  getLineContext
} from "./latex.js";
import { buildLinePatch } from "./diff.js";
import {
  runStructural,
  runNotation,
  runRhetoric,
  runCritical,
  runMathProof,
  runScience,
  buildStructuralPrompt,
  buildNotationPrompt,
  buildRhetoricPrompt,
  buildCriticalPrompt,
  buildMathPrompt,
  buildSciencePrompt
} from "./agents.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function mapExcerptToLine(lines, excerpt) {
  if (!excerpt) return 1;
  const needle = excerpt.trim();
  if (!needle) return 1;
  const idx = lines.findIndex((line) => line.includes(needle));
  return idx >= 0 ? idx + 1 : 1;
}

function findBestLineByTokens(lines, excerpt) {
  if (!excerpt) return 1;
  const cleaned = excerpt
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return 1;
  const tokens = cleaned
    .split(" ")
    .filter((t) => t.length >= 4)
    .slice(0, 10);
  if (!tokens.length) return 1;
  let bestScore = 0;
  let bestLine = 1;
  for (let i = 0; i < lines.length; i += 1) {
    const windowText = lines.slice(i, i + 2).join(" ").toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (windowText.includes(token)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = i + 1;
    }
  }
  return bestScore > 0 ? bestLine : 1;
}

function indexToLine(text, index) {
  if (index <= 0) return 1;
  return text.slice(0, index).split("\n").length;
}

function getSectionLine(sections, title, text) {
  const section = sections.find(
    (item) => item.title.toLowerCase() === title.toLowerCase()
  );
  if (!section) return 1;
  return indexToLine(text, section.index);
}

function getSectionBlockLines(sections, title, text) {
  const section = sections.find(
    (item) => item.title.toLowerCase() === title.toLowerCase()
  );
  if (!section) return null;
  const startLine = indexToLine(text, section.index);
  const next = sections.find((item) => item.index > section.index);
  const endDocIndex = text.indexOf("\\end{document}");
  const endDocLine = endDocIndex !== -1 ? indexToLine(text, endDocIndex) : text.split("\n").length;
  const fallbackEnd = Math.max(1, endDocLine - 1);
  const endLine = next
    ? Math.max(1, indexToLine(text, next.index) - 1)
    : fallbackEnd;
  return { startLine, endLine };
}

function buildRhetoricChunks(text, sections) {
  if (!sections.length) {
    return [{ text }];
  }
  const sorted = [...sections].sort((a, b) => a.index - b.index);
  const chunks = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const start = sorted[i].index;
    const end = i + 1 < sorted.length ? sorted[i + 1].index : text.length;
    const chunkText = text.slice(start, end).trim();
    if (chunkText) {
      chunks.push({
        title: sorted[i].title,
        text: chunkText
      });
    }
  }
  const maxChars = 30000;
  const merged = [];
  let buffer = "";
  for (const chunk of chunks) {
    if ((buffer + chunk.text).length > maxChars && buffer) {
      merged.push({ text: buffer });
      buffer = chunk.text;
    } else {
      buffer = buffer ? `${buffer}\n\n${chunk.text}` : chunk.text;
    }
  }
  if (buffer) merged.push({ text: buffer });
  if (merged.length <= 2) return merged;
  const regrouped = [];
  let acc = "";
  for (const item of merged) {
    if ((acc + item.text).length > maxChars * 2 && acc) {
      regrouped.push({ text: acc });
      acc = item.text;
    } else {
      acc = acc ? `${acc}\n\n${item.text}` : item.text;
    }
  }
  if (acc) regrouped.push({ text: acc });
  return regrouped;
}

function buildSubsectionChunks(text) {
  const sections = extractSections(text);
  if (!sections.length) return [{ title: "", text }];
  const subsectionStarts = sections.filter((s) =>
    ["subsection", "subsubsection"].includes(s.level)
  );
  const boundaries = subsectionStarts.length ? subsectionStarts : sections;
  const chunks = [];
  for (let i = 0; i < boundaries.length; i += 1) {
    const current = boundaries[i];
    const next = boundaries.find((s) => s.index > current.index);
    const end = next ? next.index : text.length;
    const chunkText = text.slice(current.index, end).trim();
    if (chunkText) {
      chunks.push({ title: current.title, text: chunkText });
    }
  }
  if (!chunks.length) return [{ title: "", text }];
  const maxChars = 18000;
  const merged = [];
  let buffer = "";
  let bufferTitle = "";
  for (const chunk of chunks) {
    if ((buffer + chunk.text).length > maxChars && buffer) {
      merged.push({ title: bufferTitle, text: buffer });
      buffer = chunk.text;
      bufferTitle = chunk.title;
    } else {
      buffer = buffer ? `${buffer}\n\n${chunk.text}` : chunk.text;
      bufferTitle = bufferTitle || chunk.title;
    }
  }
  if (buffer) merged.push({ title: bufferTitle, text: buffer });
  return merged;
}

function normalizeIssueText(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSimilarity(a, b) {
  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  if (!aTokens.size || !bTokens.size) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(aTokens.size, bTokens.size);
}

function dedupeByText(items, getText) {
  const seen = [];
  const result = [];
  for (const item of items) {
    const raw = getText(item);
    const normalized = normalizeIssueText(raw);
    if (!normalized) continue;
    const isDuplicate = seen.some(
      (prev) =>
        prev === normalized ||
        normalized.includes(prev) ||
        prev.includes(normalized) ||
        tokenSimilarity(prev, normalized) > 0.82
    );
    if (isDuplicate) continue;
    seen.push(normalized);
    result.push(item);
  }
  return result;
}

function dedupeAcrossAgents({ structural, notation, rhetoric, critical, science }) {
  const seen = [];
  const isDuplicate = (text) => {
    const normalized = normalizeIssueText(text);
    if (!normalized) return true;
    const dup = seen.some(
      (prev) =>
        prev === normalized ||
        normalized.includes(prev) ||
        prev.includes(normalized) ||
        tokenSimilarity(prev, normalized) > 0.82
    );
    if (!dup) seen.push(normalized);
    return dup;
  };

  const structuralClean = dedupeByText(structural.integrity_report || [], (i) => i.message);
  const notationClean = dedupeByText(
    notation.symbol_analysis || [],
    (i) => `${i.symbol} ${i.recommendation}`
  );
  const rhetoricClean = dedupeByText(rhetoric.logic_gaps || [], (i) => i.explanation);
  const criticalClean = dedupeByText(critical.critique || [], (i) => i.weakness);
  const scienceClean = dedupeByText(
    science?.science_issues || [],
    (i) => `${i.category} ${i.message}`
  );

  const structuralFiltered = structuralClean.filter((i) => !isDuplicate(i.message));
  const notationFiltered = notationClean.filter(
    (i) => !isDuplicate(`${i.symbol} ${i.recommendation}`)
  );
  const rhetoricFiltered = rhetoricClean.filter((i) => !isDuplicate(i.explanation));
  const criticalFiltered = criticalClean.filter((i) => !isDuplicate(i.weakness));
  const scienceFiltered = scienceClean.filter(
    (i) => !isDuplicate(`${i.category} ${i.message}`)
  );

  return {
    structural: { ...structural, integrity_report: structuralFiltered },
    notation: { ...notation, symbol_analysis: notationFiltered },
    rhetoric: { ...rhetoric, logic_gaps: rhetoricFiltered },
    critical: { ...critical, critique: criticalFiltered },
    science: science ? { ...science, science_issues: scienceFiltered } : science
  };
}

function applyHeuristics({
  structural,
  notation,
  rhetoric,
  critical,
  sections,
  text,
  definitions,
  mathEnvs,
  paperType
}) {
  const extraSuggestions = [];
  const acronymExpansions = {
    NLP: "natural language processing",
    AI: "artificial intelligence",
    ML: "machine learning",
    CNN: "convolutional neural network",
    RNN: "recurrent neural network",
    LLM: "large language model"
  };
  const commonAcronyms = new Set([
    "AI",
    "ML",
    "NLP",
    "CNN",
    "RNN",
    "LLM",
    "API",
    "HTTP",
    "URL",
    "CPU",
    "GPU",
    "SVM",
    "PCA",
    "ROC",
    "AUC",
    "F1",
    "TPU",
    "SQL",
    "JSON",
    "PDF",
    "RAM",
    "NLP",
    "CV",
    "IR"
  ]);
  const textLines = text.split("\n");
  const resolvedPaperType = paperType || detectPaperType(text, sections);

  const addedAcronym = new Set();
  const addAcronymSuggestion = (acronym, lineNumber) => {
    const expansion = acronymExpansions[acronym];
    if (!expansion) return;
    const key = `${acronym}-${lineNumber}`;
    if (addedAcronym.has(key)) return;
    const originalLine = getLineContext(textLines, lineNumber, 0);
    const updatedLine = originalLine.replace(
      new RegExp(`\\b${acronym}\\b`),
      `${acronym} (${expansion})`
    );
    if (updatedLine === originalLine) return;
    extraSuggestions.push({
      agent: "Notation",
      line: lineNumber,
      suggestion: updatedLine,
      reason: `Define ${acronym} on first use.`,
      kind: "replace",
      actionable: true
    });
    addedAcronym.add(key);
  };
  const sectionOrder = [
    ["abstract"],
    ["introduction"],
    ["related work", "background"],
    ["methods", "method", "materials and methods", "methodology"],
    ["results"],
    ["discussion"],
    ["conclusion", "conclusions"]
  ];

  const normalizedSections = sections.map((s) => ({
    ...s,
    key: s.title.toLowerCase()
  }));

  const orderedMatches = sectionOrder.map((group) =>
    normalizedSections.find((s) => group.includes(s.key))
  );

  // Detect first out-of-order section relative to expected ordering.
  let lastIndex = -1;
  for (let i = 0; i < orderedMatches.length; i += 1) {
    const section = orderedMatches[i];
    if (!section) continue;
    if (section.index < lastIndex) {
      const anchor = orderedMatches
        .slice(0, i)
        .reverse()
        .find((s) => s !== undefined);
      const moveBlock = getSectionBlockLines(sections, section.title, text);
      const anchorBlock = anchor ? getSectionBlockLines(sections, anchor.title, text) : null;
      structural.integrity_report.push({
        scope: "structure",
        location: {
          line: getSectionLine(sections, section.title, text),
          context: `\\\\section{${section.title}}`
        },
        severity: "warning",
        message: `${section.title} appears before ${anchor?.title || "earlier sections"}; standard order may be violated.`,
        fix_suggestion: ""
      });
      if (moveBlock && anchorBlock) {
        extraSuggestions.push({
          agent: "Structural",
          line: moveBlock.startLine,
          suggestion: `Move ${section.title} section after ${anchor.title}.`,
          reason: "Standard section ordering improves readability and conforms to IMRaD-like structure.",
          kind: "move-block",
          actionable: true,
          move: {
            fromStart: moveBlock.startLine,
            fromEnd: moveBlock.endLine,
            toAfterLine: anchorBlock.endLine
          }
        });
      }
      break;
    }
    lastIndex = Math.max(lastIndex, section.index);
  }

  if ((structural.integrity_report || []).length === 0) {
    const titles = sections.map((s) => s.title.toLowerCase());
    const resultsIndex = titles.indexOf("results");
    const methodsIndex = titles.findIndex((t) =>
      ["methods", "method", "materials and methods"].includes(t)
    );
    if (resultsIndex !== -1 && methodsIndex !== -1 && resultsIndex < methodsIndex) {
      const resultsBlock = getSectionBlockLines(sections, "Results", text);
      const methodsBlock = getSectionBlockLines(sections, "Methods", text);
      structural.integrity_report.push({
        scope: "structure",
        location: {
          line: getSectionLine(sections, "Results", text),
          context: "\\\\section{Results}"
        },
        severity: "warning",
        message: "Results appear before Methods; IMRaD order may be violated.",
        fix_suggestion: ""
      });
      if (resultsBlock && methodsBlock) {
        extraSuggestions.push({
          agent: "Structural",
          line: resultsBlock.startLine,
          suggestion: "Move Results section after Methods section.",
          reason: "IMRaD order typically places Methods before Results.",
          kind: "move-block",
          actionable: true,
          move: {
            fromStart: resultsBlock.startLine,
            fromEnd: resultsBlock.endLine,
            toAfterLine: methodsBlock.endLine
          }
        });
      }
    }
  }

  if ((notation.symbol_analysis || []).length === 0) {
    const acronyms = Array.from(
      new Set((text.match(/\b[A-Z]{2,}\b/g) || []).filter((t) => t !== "MATH"))
    );
    for (const acronym of acronyms) {
      if (resolvedPaperType !== "math" && commonAcronyms.has(acronym)) continue;
      if (!definitions || !definitions.includes(acronym)) {
        const lineNumber = mapExcerptToLine(textLines, acronym);
        notation.symbol_analysis.push({
          symbol: acronym,
          status: "undefined_at_first_use",
          location: { line: lineNumber },
          recommendation: `Define ${acronym} on first use.`
        });
        addAcronymSuggestion(acronym, lineNumber);
        break;
      }
    }
  }

  for (const item of notation.symbol_analysis || []) {
    if (resolvedPaperType !== "math" && commonAcronyms.has(item.symbol)) continue;
    if (item.status === "undefined_at_first_use" && item.location?.line) {
      addAcronymSuggestion(item.symbol, item.location.line);
    }
  }

  if ((rhetoric.logic_gaps || []).length === 0) {
    const match = text.match(/\b(it is obvious|it is clear|clearly|obvious)\b/i);
    if (match) {
      rhetoric.logic_gaps.push({
        type: "unsupported_claim",
        excerpt: match[0],
        explanation: "Claim relies on rhetorical emphasis rather than evidence.",
        improvement: "Provide evidence, citations, or empirical results to support the claim."
      });
    }
  }

  if ((critical.critique || []).length === 0) {
    if (
      text.match(/\\section\{Results\}/i) &&
      !text.match(/\\section\{Discussion\}/i)
    ) {
      critical.critique.push({
        weakness: "Results are presented without a Discussion section to interpret significance.",
        rebuttal_potential: "Add a Discussion section that contextualizes results and limitations.",
        severity: "high"
      });
    }
  }

  const textLineCount = textLines.filter((line) => line.trim().length > 0).length;
  const hasAbstract = /\\begin\{abstract\}/i.test(text);
  const hasIntro = /\\section\{Introduction\}/i.test(text);
  const hasResults = /\\section\{Results\}/i.test(text);
  const hasMethods = /\\section\{Methods\}/i.test(text);
  const hasDiscussion = /\\section\{Discussion\}/i.test(text);
  const hasConclusion = /\\section\{Conclusion\}/i.test(text);
  const hasCitations = /\\cite\{[^}]+\}/.test(text);
  const hasExperiments =
    /\\section\{Experiments\}/i.test(text) || /\\section\{Evaluation\}/i.test(text);
  const hasDatasets =
    /\\section\{Dataset\}/i.test(text) || /\\section\{Datasets\}/i.test(text);
  const hasAppendix = /\\appendix/i.test(text);
  const hasMath = (mathEnvs || []).length > 0 || /\$[^$]+\$/.test(text);

  if (!hasAbstract) {
    critical.critique.push({
      weakness: "Missing abstract; the paper is not formatted for academic submission.",
      rebuttal_potential: "Add a concise abstract summarizing the problem, method, and results.",
      severity: "high"
    });
  }
  if (!hasIntro) {
    critical.critique.push({
      weakness: "Missing Introduction; the paper provides no motivation or framing.",
      rebuttal_potential: "Add an Introduction that states the problem, contributions, and context.",
      severity: "high"
    });
  }
  if (resolvedPaperType !== "math" && !hasDiscussion && hasResults) {
    critical.critique.push({
      weakness: "No Discussion section; results are not interpreted or contextualized.",
      rebuttal_potential: "Add a Discussion section that interprets findings and limitations.",
      severity: "high"
    });
  }
  if (resolvedPaperType !== "math" && !hasConclusion) {
    critical.critique.push({
      weakness: "Missing Conclusion; the paper lacks a closing summary and future work.",
      rebuttal_potential: "Add a Conclusion that summarizes contributions and limitations.",
      severity: "high"
    });
  }
  if (hasMethods) {
    const methodsBlock = getSectionBlockLines(sections, "Methods", text);
    if (methodsBlock) {
      const methodsLen = Math.max(0, methodsBlock.endLine - methodsBlock.startLine + 1);
      if (methodsLen < 4) {
        critical.critique.push({
          weakness: "Methods section is too short to support reproducibility.",
          rebuttal_potential: "Expand Methods with datasets, baselines, and evaluation details.",
          severity: "high"
        });
      }
    }
  }
  if (textLineCount < 12) {
    critical.critique.push({
      weakness: "Document is far too short to constitute a paper.",
      rebuttal_potential: "Expand into full sections with evidence, experiments, and analysis.",
      severity: "high"
    });
  }

  const lower = text.toLowerCase();

  if (resolvedPaperType === "ml" || resolvedPaperType === "cs") {
    if (!hasExperiments && !hasResults) {
      critical.critique.push({
        weakness: "Empirical framing without experiments or results.",
        rebuttal_potential: "Add an Experiments or Results section with quantitative evaluation.",
        severity: "high"
      });
    }
    if (!hasDatasets && lower.includes("dataset") === false) {
      critical.critique.push({
        weakness: "Empirical paper lacks dataset description.",
        rebuttal_potential: "Add a Dataset(s) section describing data sources and splits.",
        severity: "high"
      });
    }
  }

  if (resolvedPaperType === "math") {
    const hasProof = lower.includes("proof");
    const hasTheorem = lower.includes("theorem") || lower.includes("lemma");
    if (hasMath && !hasTheorem) {
      critical.critique.push({
        weakness: "Mathematical content presented without formal statements (theorems/lemmas).",
        rebuttal_potential: "Introduce formal statements and clearly structured proofs.",
        severity: "high"
      });
    }
    if (!hasProof && hasMath) {
      critical.critique.push({
        weakness: "No proofs provided for mathematical claims.",
        rebuttal_potential: "Add proofs or cite established results with appropriate references.",
        severity: "high"
      });
    }
  }

  if (resolvedPaperType === "cs") {
    if (!hasExperiments && !hasResults) {
      critical.critique.push({
        weakness: "Systems paper lacks performance evaluation.",
        rebuttal_potential: "Add benchmarks with latency/throughput and system configuration.",
        severity: "high"
      });
    }
    if (!hasAppendix && !lower.includes("implementation")) {
      critical.critique.push({
        weakness: "System implementation details are missing.",
        rebuttal_potential: "Include implementation details or an appendix with configuration.",
        severity: "medium"
      });
    }
  }

  // Equation sanity: math without definitions/notation section.
  if (resolvedPaperType !== "math" && hasMath && !definitions && !lower.includes("notation")) {
    critical.critique.push({
      weakness: "Equations are presented without a notation/definitions section.",
      rebuttal_potential: "Add a Notation/Definitions section to define symbols.",
      severity: "high"
    });
  }

  // De-duplicate critiques by normalized weakness text.
  const seenCritiques = new Set();
  critical.critique = (critical.critique || []).filter((item) => {
    const lowerWeakness = item.weakness.toLowerCase();
    let key = lowerWeakness.replace(/[^a-z0-9]+/g, " ").trim();
    if (lowerWeakness.includes("discussion") && lowerWeakness.includes("results")) {
      key = "missing discussion for results";
    }
    if (seenCritiques.has(key)) return false;
    seenCritiques.add(key);
    return true;
  });

  return extraSuggestions;
}

function detectPaperType(text, sections) {
  const lower = text.toLowerCase();
  const score = { math: 0, cs: 0, ml: 0 };
  const bump = (key, words) => {
    for (const word of words) {
      if (lower.includes(word)) score[key] += 1;
    }
  };
  bump("math", ["theorem", "lemma", "proof", "corollary", "proposition", "definition"]);
  bump("ml", [
    "neural",
    "training",
    "loss",
    "gradient",
    "dataset",
    "benchmark",
    "accuracy",
    "precision",
    "recall",
    "f1",
    "auc"
  ]);
  bump("cs", ["system", "architecture", "latency", "throughput", "deployment"]);

  const secTitles = sections.map((s) => s.title.toLowerCase());
  if (secTitles.some((t) => t.includes("proof"))) score.math += 2;
  if (secTitles.some((t) => t.includes("experiments") || t.includes("evaluation")))
    score.ml += 2;
  if (secTitles.some((t) => t.includes("implementation"))) score.cs += 1;

  let best = "cs";
  let bestScore = -1;
  for (const [key, value] of Object.entries(score)) {
    if (value > bestScore) {
      bestScore = value;
      best = key;
    }
  }
  return best;
}

function getPaperExpectations(paperType) {
  if (paperType === "math") {
    return "Mathematics paper: formal definitions, theorems/lemmas, proofs. Conclusion/discussion optional. Avoid requiring datasets/experiments. Ignore author/bibliography sections.";
  }
  if (paperType === "ml") {
    return "Machine Learning paper: experiments/results, dataset descriptions, baselines, evaluation metrics. Discussion/conclusion expected. Ignore author/bibliography sections.";
  }
  return "Computer Science paper: clear problem framing, methodology, evaluation or analysis; discussion/conclusion often expected depending on venue. Ignore author/bibliography sections.";
}

function summarizeMath(results, total) {
  const counts = { complete: 0, incomplete: 0, missing: 0, unclear: 0 };
  for (const r of results) {
    counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  }
  return `Proof review: ${counts.complete} complete, ${counts.incomplete} incomplete, ${counts.missing} missing, ${counts.unclear} unclear (of ${total}).`;
}

function dedupeIssues(issues) {
  const seen = new Set();
  return issues.filter((issue) => {
    const key = issue.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}


function isActionableLineEdit(text) {
  if (!text) return false;
  if (text.length > 240) return false;
  const lower = text.toLowerCase();
  if (
    lower.startsWith("provide ") ||
    lower.startsWith("add ") ||
    lower.startsWith("include ") ||
    lower.startsWith("cite ") ||
    lower.startsWith("clarify ") ||
    lower.startsWith("expand ")
  ) {
    return false;
  }
  return true;
}

function consolidateSuggestions({ structural, rhetoric, lines }) {
  const suggestions = [];

  for (const item of structural.integrity_report || []) {
    if (item.fix_suggestion && item.location?.line) {
      suggestions.push({
        agent: "Structural",
        line: item.location.line,
        suggestion: item.fix_suggestion,
        reason: item.message,
        actionable: true
      });
    }
  }

  for (const item of rhetoric.logic_gaps || []) {
    const line = mapExcerptToLine(lines, item.excerpt);
    if (item.improvement) {
      const actionable = isActionableLineEdit(item.improvement);
      suggestions.push({
        agent: "Rhetoric",
        line,
        suggestion: item.improvement,
        reason: item.explanation,
        actionable
      });
    }
  }

  // Priority: Rhetoric over Structural if line conflicts.
  const byLine = new Map();
  for (const item of suggestions) {
    if (!byLine.has(item.line)) {
      byLine.set(item.line, item);
      continue;
    }
    const existing = byLine.get(item.line);
    if (existing.agent === "Structural" && item.agent === "Rhetoric") {
      byLine.set(item.line, item);
    }
  }

  return Array.from(byLine.values());
}

function withSuggestionIds(items) {
  return items.map((item) => ({
    ...item,
    id:
      item.id ||
      `${item.agent}-${item.kind || "replace"}-${item.line}-${(
        item.suggestion || item.reason || ""
      ).slice(0, 40)}`
  }));
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/review", async (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  res.flushHeaders();

  const emitLog = (message, meta = {}) => {
    sendEvent(res, "log", {
      message,
      ts: new Date().toISOString(),
      ...meta
    });
    console.log(message);
  };

  emitLog("[review] request received");

  const latex = req.body?.latex || "";
  emitLog(`[review] payload chars=${latex.length}`);
  const coreText = extractCoreText(latex);
  let maskedText = stripReferencesPreserveLines(stripPreamblePreserveLines(latex));
  maskedText = maskedText.replace(/\\label\{[^}]*\}/gi, "");
  maskedText = maskedText.replace(/\\ref\{[^}]*\}/gi, "");
  maskedText = maskedText.replace(/\\cite\{[^}]*\}/gi, "");
  const lines = splitLines(maskedText);
  const preamble = extractPreamble(latex);
  const title = extractTitle(latex);
  const macros = extractMacros(preamble);
  const sections = extractSections(maskedText);
  const sectionsCore = extractSections(coreText);
  const minified = minifyLatex(coreText);
  const stripped = stripHeavyMath(coreText);
  const mathEnvs = extractMathEnvs(coreText);
  const notationEnvs = [];
  let notationBudget = 18000;
  const maxEnvs = 120;
  for (const env of mathEnvs) {
    if (notationBudget <= 0 || notationEnvs.length >= maxEnvs) break;
    const slice = env.length > notationBudget ? env.slice(0, notationBudget) : env;
    if (!slice.trim()) continue;
    notationEnvs.push(slice);
    notationBudget -= slice.length;
  }
  if (notationEnvs.length !== mathEnvs.length) {
    emitLog(
      `[input] notation envs capped ${notationEnvs.length}/${mathEnvs.length} chars=${18000 - notationBudget}`
    );
  }
  const definitions = extractDefinitionsSection(coreText);
  const { abstract, results, discussion } = extractAbstractResultsDiscussion(coreText);
  const methodsSection = extractSectionContent(coreText, [
    "Methods",
    "Method",
    "Methodology",
    "Approach"
  ]);
  const experimentsSection = extractSectionContent(coreText, [
    "Experiments",
    "Evaluation",
    "Experimental Setup",
    "Experimental Results"
  ]);
  const datasetsSection = extractSectionContent(coreText, ["Dataset", "Datasets", "Data"]);
  const paperType = detectPaperType(coreText, sections);
  const expectations = getPaperExpectations(paperType);
  const artifacts = paperType === "math" ? extractMathArtifacts(coreText) : [];
  const wordCount = coreText.split(/\s+/).filter(Boolean).length;
  emitLog(
    `[input] lines=${lines.length} sections=${sections.length} math_envs=${mathEnvs.length} artifacts=${artifacts.length} word_count=${wordCount}`
  );
  emitLog(`[input] title="${title || "Untitled"}" macros=${Object.keys(macros).length}`);

  sendEvent(res, "preflight", {
    paperType,
    sections: sections.length,
    artifacts: artifacts.length,
    wordCount,
    title
  });
  emitLog(
    `[preflight] type=${paperType} sections=${sections.length} artifacts=${artifacts.length} words=${wordCount}`
  );

  const startMathReview = async () => {
    if (paperType !== "math" || artifacts.length === 0) {
      return { status: "skipped" };
    }

    const PARALLEL = 3;
    const queue = artifacts.slice();
    const total = queue.length;
    let completed = 0;
    const mathResults = [];
    emitLog("[math] started");
    sendEvent(res, "math-update", {
      status: "processing",
      completed: 0,
      total,
      summary: summarizeMath([], total),
      results: []
    });
    emitLog(`[math] queue start total=${total} parallel=${PARALLEL}`);

    const buildContext = (artifact) => {
      const lines = coreText.split("\n");
      const idx = lines.findIndex((line) =>
        line.includes(artifact.statement.slice(0, 12))
      );
      const start = Math.max(0, idx - 6);
      const end = Math.min(lines.length, idx + 20);
      return lines.slice(start, end).join("\n");
    };

    const runNext = async () => {
      const artifact = queue.shift();
      if (!artifact) return;
      const context = buildContext(artifact);
      emitLog(
        `[math] reviewing ${artifact.type} ${completed + 1}/${total} ctx_lines=${context.split("\n").length}`
      );
      const startAt = Date.now();
      const result = await runMathProof({
        artifact,
        context,
        paperType,
        expectations,
        logger: emitLog
      });
      const elapsed = Date.now() - startAt;
      emitLog(`[math] ${artifact.type} completed in ${elapsed}ms`);
      const cleanedIssues = dedupeIssues(result.issues || []).slice(0, 3);
      mathResults.push({
        ...result,
        issues: cleanedIssues,
        statement: artifact.statement,
        type: artifact.type
      });
      completed += 1;
      const summary = summarizeMath(mathResults, total);
      sendEvent(res, "math-update", {
        status: "processing",
        completed,
        total,
        summary,
        results: [mathResults[mathResults.length - 1]]
      });
      emitLog(`[math] ${completed}/${total} ${artifact.type}`);
      await runNext();
    };

    const runners = Array.from({ length: Math.min(PARALLEL, total) }, () => runNext());
    await Promise.all(runners);

    sendEvent(res, "math-final", {
      status: "completed",
      completed,
      total,
      summary: summarizeMath(mathResults, total),
      results: mathResults
    });
    emitLog("[math] completed");
    return { status: "completed" };
  };

  const mathPromise = startMathReview();

  const promptCapture = {
    Structural: null,
    Notation: null,
    Rhetoric: [],
    Critical: null,
    Science: null,
    Math: null
  };

  promptCapture.Structural = buildStructuralPrompt({
    preamble: minified,
    sections,
    strippedText: stripped,
    paperType,
    expectations
  });
  promptCapture.Notation = buildNotationPrompt({
    mathEnvs: notationEnvs,
    definitions,
    preamble,
    paperType,
    expectations
  });
  promptCapture.Critical = buildCriticalPrompt({
    abstract,
    results,
    discussion,
    fullText: coreText,
    paperType,
    expectations
  });
  if (paperType === "ml") {
    promptCapture.Science = buildSciencePrompt({
      abstract,
      methods: methodsSection,
      experiments: experimentsSection,
      datasets: datasetsSection,
      results,
      fullText: coreText,
      paperType,
      expectations
    });
  }
  promptCapture.Math =
    paperType === "math"
      ? buildMathPrompt({
          artifact: { type: "theorem", statement: "<statement>" },
          context: "<local context>",
          paperType,
          expectations
        })
      : null;

  const agents = [
    {
      name: "Structural",
      progress: 25,
      run: () =>
        runStructural({
          preamble: minified,
          sections,
          strippedText: stripped,
          paperType,
          expectations,
          logger: emitLog
        })
    },
    {
      name: "Notation",
      progress: 50,
      run: () =>
        runNotation({
          mathEnvs: notationEnvs,
          definitions,
          preamble,
          paperType,
          expectations,
          logger: emitLog
        })
    },
    {
      name: "Rhetoric",
      progress: 75,
      run: async () => {
        const shouldChunk = coreText.length > 18000 || wordCount > 2800;
        if (!shouldChunk) {
          promptCapture.Rhetoric = [
            buildRhetoricPrompt({ text: coreText, paperType, expectations })
          ];
          return runRhetoric({
            text: coreText,
            paperType,
            expectations,
            logger: emitLog
          });
        }

        const chunks = buildSubsectionChunks(coreText);
        emitLog(`[agent] Rhetoric chunked parts=${chunks.length}`);
        const merged = [];
        const prior = [];
        promptCapture.Rhetoric = [];
        for (let i = 0; i < chunks.length; i += 1) {
          const chunk = chunks[i];
          sendEvent(res, "agent-update", {
            agent: "Rhetoric",
            status: "processing",
            progress: 50 + Math.round(((i + 1) / chunks.length) * 35),
            detail: {
              phase: "chunk-start",
              chunkIndex: i + 1,
              chunkTotal: chunks.length,
              sectionTitle: chunk.title || "",
              message: `Chunk ${i + 1}/${chunks.length}${chunk.title ? ` • ${chunk.title}` : ""}`
            },
            payload: { logic_gaps: merged }
          });
          promptCapture.Rhetoric.push(
            buildRhetoricPrompt({
              text: chunk.text,
              paperType,
              expectations,
              priorIssues: prior.slice(-5),
              chunkTitle: chunk.title
            })
          );
          emitLog(`[agent] Rhetoric chunk ${i + 1}/${chunks.length}`);
          const output = await runRhetoric({
            text: chunk.text,
            paperType,
            expectations,
            priorIssues: prior.slice(-5),
            chunkTitle: chunk.title,
            logger: emitLog
          });
          merged.push(...(output.logic_gaps || []));
          output.logic_gaps?.forEach((issue) => {
            if (issue.explanation) prior.push(issue.explanation.slice(0, 160));
          });
          sendEvent(res, "agent-update", {
            agent: "Rhetoric",
            status: "processing",
            progress: 50 + Math.round(((i + 1) / chunks.length) * 35),
            detail: {
              phase: "chunk-complete",
              chunkIndex: i + 1,
              chunkTotal: chunks.length,
              sectionTitle: chunk.title || "",
              message: `Chunk ${i + 1}/${chunks.length} done${chunk.title ? ` • ${chunk.title}` : ""}`
            },
            payload: { logic_gaps: merged }
          });
        }
        return { logic_gaps: merged };
      }
    },
    ...(paperType === "ml"
      ? [
          {
            name: "Science",
            progress: 85,
            run: async () => {
              const shouldChunk = coreText.length > 18000 || wordCount > 2800;
              if (!shouldChunk) {
                promptCapture.Science = buildSciencePrompt({
                  abstract,
                  methods: methodsSection,
                  experiments: experimentsSection,
                  datasets: datasetsSection,
                  results,
                  fullText: coreText,
                  paperType,
                  expectations
                });
                return runScience({
                  abstract,
                  methods: methodsSection,
                  experiments: experimentsSection,
                  datasets: datasetsSection,
                  results,
                  fullText: coreText,
                  paperType,
                  expectations,
                  logger: emitLog
                });
              }

              const chunks = buildSubsectionChunks(coreText);
              emitLog(`[agent] Science chunked parts=${chunks.length}`);
              const merged = [];
              const prior = [];
              promptCapture.Science = [];
              for (let i = 0; i < chunks.length; i += 1) {
                const chunk = chunks[i];
                sendEvent(res, "agent-update", {
                  agent: "Science",
                  status: "processing",
                  progress: 60 + Math.round(((i + 1) / chunks.length) * 30),
                  detail: {
                    phase: "chunk-start",
                    chunkIndex: i + 1,
                    chunkTotal: chunks.length,
                    sectionTitle: chunk.title || "",
                    message: `Chunk ${i + 1}/${chunks.length}${chunk.title ? ` • ${chunk.title}` : ""}`
                  },
                  payload: { science_issues: merged }
                });
                promptCapture.Science.push(
                  buildSciencePrompt({
                    abstract,
                    methods: methodsSection,
                    experiments: experimentsSection,
                    datasets: datasetsSection,
                    results,
                    fullText: chunk.text,
                    paperType,
                    expectations,
                    priorIssues: prior.slice(-5),
                    chunkTitle: chunk.title
                  })
                );
                emitLog(`[agent] Science chunk ${i + 1}/${chunks.length}`);
                const output = await runScience({
                  abstract,
                  methods: methodsSection,
                  experiments: experimentsSection,
                  datasets: datasetsSection,
                  results,
                  fullText: chunk.text,
                  paperType,
                  expectations,
                  priorIssues: prior.slice(-5),
                  chunkTitle: chunk.title,
                  logger: emitLog
                });
                merged.push(...(output.science_issues || []));
                output.science_issues?.forEach((issue) => {
                  if (issue.message) prior.push(issue.message.slice(0, 160));
                });
                sendEvent(res, "agent-update", {
                  agent: "Science",
                  status: "processing",
                  progress: 60 + Math.round(((i + 1) / chunks.length) * 30),
                  detail: {
                    phase: "chunk-complete",
                    chunkIndex: i + 1,
                    chunkTotal: chunks.length,
                    sectionTitle: chunk.title || "",
                    message: `Chunk ${i + 1}/${chunks.length} done${chunk.title ? ` • ${chunk.title}` : ""}`
                  },
                  payload: { science_issues: merged }
                });
              }
              return { science_issues: merged };
            }
          }
        ]
      : []),
    {
      name: "Critical",
      progress: 95,
      run: async () => {
        const shouldChunk = coreText.length > 18000 || wordCount > 2800;
        if (!shouldChunk) {
          return runCritical({
            abstract,
            results,
            discussion,
            fullText: coreText,
            paperType,
            expectations,
            logger: emitLog
          });
        }

        const chunks = buildSubsectionChunks(coreText);
        emitLog(`[agent] Critical chunked parts=${chunks.length}`);
        const merged = [];
        const prior = [];
        promptCapture.Critical = [];
        for (let i = 0; i < chunks.length; i += 1) {
          const chunk = chunks[i];
          sendEvent(res, "agent-update", {
            agent: "Critical",
            status: "processing",
            progress: 70 + Math.round(((i + 1) / chunks.length) * 25),
            detail: {
              phase: "chunk-start",
              chunkIndex: i + 1,
              chunkTotal: chunks.length,
              sectionTitle: chunk.title || "",
              message: `Chunk ${i + 1}/${chunks.length}${chunk.title ? ` • ${chunk.title}` : ""}`
            },
            payload: { critique: merged }
          });
          promptCapture.Critical.push(
            buildCriticalPrompt({
              abstract,
              results,
              discussion,
              fullText: chunk.text,
              paperType,
              expectations,
              priorIssues: prior.slice(-5),
              chunkTitle: chunk.title
            })
          );
          emitLog(`[agent] Critical chunk ${i + 1}/${chunks.length}`);
          const output = await runCritical({
            abstract,
            results,
            discussion,
            fullText: chunk.text,
            paperType,
            expectations,
            priorIssues: prior.slice(-5),
            chunkTitle: chunk.title,
            logger: emitLog
          });
          merged.push(...(output.critique || []));
          output.critique?.forEach((issue) => {
            if (issue.weakness) prior.push(issue.weakness.slice(0, 160));
          });
          sendEvent(res, "agent-update", {
            agent: "Critical",
            status: "processing",
            progress: 70 + Math.round(((i + 1) / chunks.length) * 25),
            detail: {
              phase: "chunk-complete",
              chunkIndex: i + 1,
              chunkTotal: chunks.length,
              sectionTitle: chunk.title || "",
              message: `Chunk ${i + 1}/${chunks.length} done${chunk.title ? ` • ${chunk.title}` : ""}`
            },
            payload: { critique: merged }
          });
        }
        return { critique: merged };
      }
    }
  ];

  for (const agent of agents) {
    sendEvent(res, "agent-update", {
      agent: agent.name,
      status: "processing",
      progress: 5
    });
    emitLog(`[agent] start ${agent.name}`);
  }

  const resultsMap = {};
  const AGENT_TIMEOUT_MS = Number.parseInt(
    process.env.AGENT_TIMEOUT_MS || "90000",
    10
  );

  const withTimeout = (promise, label) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error(`${label} timed out after ${AGENT_TIMEOUT_MS}ms`);
        emitLog(`[agent] ${err.message}`, { level: "error" });
        reject(err);
      }, AGENT_TIMEOUT_MS);
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });

  const defaultOutputs = {
    Structural: { integrity_report: [] },
    Notation: { symbol_analysis: [] },
    Rhetoric: { logic_gaps: [] },
    Critical: { critique: [] },
    Science: { science_issues: [] }
  };
  const agentPromises = agents.map(async (agent) => {
    try {
      sendEvent(res, "agent-update", {
        agent: agent.name,
        status: "processing",
        progress: 8,
        detail: { phase: "llm-call", message: "Calling model" }
      });
      emitLog(
        `[agent] ${agent.name} input chars=${
          agent.name === "Structural"
            ? stripped.length
            : agent.name === "Notation"
              ? mathEnvs.join("\n").length
              : agent.name === "Rhetoric"
                ? coreText.length
                : abstract.length + results.length + discussion.length
        }`
      );
      const startAt = Date.now();
      const output = await withTimeout(agent.run(), agent.name);
      const elapsed = Date.now() - startAt;
      emitLog(`[agent] ${agent.name} completed in ${elapsed}ms`);
      resultsMap[agent.name] = output;
      sendEvent(res, "agent-update", {
        agent: agent.name,
        status: "completed",
        progress: agent.progress,
        payload: output
      });
      emitLog(`[agent] done ${agent.name}`);
      return { agent: agent.name, ok: true };
    } catch (error) {
      resultsMap[agent.name] = defaultOutputs[agent.name];
      sendEvent(res, "agent-update", {
        agent: agent.name,
        status: "error",
        progress: agent.progress,
        error: error?.message || "Agent failed."
      });
      emitLog(
        `[agent] ${agent.name} failed: ${error?.message || "Agent failed."}`,
        { level: "error" }
      );
      return { agent: agent.name, ok: false };
    }
  });

  await Promise.all(agentPromises);

  const structural = resultsMap.Structural;
  const notation = resultsMap.Notation;
  const rhetoric = resultsMap.Rhetoric;
  const critical = resultsMap.Critical;
  const science = resultsMap.Science;

  const attachLine = (item, fallback) => {
    if (item.location?.line && item.location.line > 1) return item;
    const excerpt = item.excerpt || fallback || "";
    let line = mapExcerptToLine(lines, excerpt);
    if (line === 1) {
      line = findBestLineByTokens(lines, excerpt);
    }
    return { ...item, location: { line } };
  };

  const rhetoricWithLines = {
    ...rhetoric,
    logic_gaps: (rhetoric.logic_gaps || []).map((item) =>
      attachLine(item, item.excerpt || item.explanation)
    )
  };
  const criticalWithLines = {
    ...critical,
    critique: (critical.critique || []).map((item) =>
      attachLine(item, item.excerpt || item.weakness)
    )
  };
  const scienceWithLines = science
    ? {
        ...science,
        science_issues: (science.science_issues || []).map((item) =>
          attachLine(item, item.excerpt || item.message)
        )
      }
    : science;

  const deduped = dedupeAcrossAgents({
    structural,
    notation,
    rhetoric: rhetoricWithLines,
    critical: criticalWithLines,
    science: scienceWithLines
  });
  const structuralFinal = deduped.structural;
  const notationFinal = deduped.notation;
  const rhetoricFinal = deduped.rhetoric;
  const criticalFinal = deduped.critical;
  const scienceFinal = deduped.science;

  const heuristicSuggestions = applyHeuristics({
    structural: structuralFinal,
    notation: notationFinal,
    rhetoric: rhetoricFinal,
    critical: criticalFinal,
    sections,
    text: maskedText,
    definitions,
    mathEnvs,
    paperType
  });

  const suggestions = [
    ...consolidateSuggestions({ structural: structuralFinal, rhetoric: rhetoricFinal, lines }),
    ...heuristicSuggestions
  ];
  const suggestionsWithIds = withSuggestionIds(suggestions);
  const actionableSuggestions = suggestionsWithIds.filter(
    (s) => s.actionable !== false
  );
  const patches = actionableSuggestions.map((s) => {
    if (s.kind === "move-block") {
      return {
        op: "move-block",
        id: s.id,
        fromStart: s.move.fromStart,
        fromEnd: s.move.fromEnd,
        toAfterLine: s.move.toAfterLine
      };
    }
    const originalLine = getLineContext(lines, s.line, 0);
    return { ...buildLinePatch(s.line, originalLine, s.suggestion), id: s.id };
  });

  emitLog("[review] sending initial agent payloads");
  sendEvent(res, "final", {
    status: "completed",
    progress: 100,
    payload: {
      title,
      macros,
      structural: structuralFinal,
      notation: notationFinal,
      rhetoric: rhetoricFinal,
      critical: criticalFinal,
      science: paperType === "ml" ? scienceFinal || { science_issues: [] } : null,
      math: {
        status: paperType === "math" ? "processing" : "skipped",
        summary: paperType === "math" ? "Math proof review in progress." : "",
        results: []
      },
      prompts: promptCapture,
      suggestions: suggestionsWithIds,
      patches
    }
  });

  const mathResult = await mathPromise;
  if (mathResult.status === "skipped") {
    emitLog("[review] complete (no math artifacts)");
  } else {
    emitLog("[review] complete");
  }
  res.end();
});

const port = process.env.PORT || 8787;
const host = process.env.HOST || "127.0.0.1";
app.listen(port, host, () => {
  console.log(`Server listening on http://${host}:${port}`);
});
