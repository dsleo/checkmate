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
import {
  buildSectionChunks,
  dedupeAcrossAgents,
  dedupeIssues,
  findBestLineByTokens,
  summarizeMath
} from "./review-utils.js";
import { buildLinePatch } from "./diff.js";
import {
  runStructural,
  runNotation,
  runRhetoric,
  runCritical,
  runMathProof,
  runScience,
  runResolveIssues,
  buildStructuralPrompt,
  buildNotationPrompt,
  buildRhetoricPrompt,
  buildCriticalPrompt,
  buildMathPrompt,
  buildSciencePrompt,
  buildResolvePrompt
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

function formatChunkLabel(chunk) {
  if (!chunk?.title) return "";
  const level = chunk.level || "";
  const label =
    level === "section"
      ? "Section"
      : level === "subsection"
        ? "Subsection"
        : level === "subsubsection"
          ? "Subsubsection"
          : "Section";
  return `${label}: ${chunk.title}`;
}


const COMMON_ACRONYMS = new Set([
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
  "NP",
  "P",
  "PSPACE",
  "ROC",
  "AUC",
  "F1",
  "TPU",
  "SQL",
  "JSON",
  "PDF",
  "RAM",
  "CV",
  "IR"
]);

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
  const commonAcronyms = COMMON_ACRONYMS;
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
        improvement: "Provide evidence or empirical results to support the claim."
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
  const macroText = req.body?.macroText || "";
  emitLog(`[review] payload chars=${latex.length}`);
  const coreText = extractCoreText(latex);
  let maskedText = stripReferencesPreserveLines(stripPreamblePreserveLines(latex));
  maskedText = maskedText.replace(/\\label\{[^}]*\}/gi, "");
  maskedText = maskedText.replace(/\\ref\{[^}]*\}/gi, "");
  maskedText = maskedText.replace(/\\cite\{[^}]*\}/gi, "");
  const lines = splitLines(maskedText);
  const preamble = extractPreamble(latex);
  const combinedPreamble = macroText ? `${preamble}\n${macroText}` : preamble;
  const title = extractTitle(latex);
  const macros = extractMacros(combinedPreamble);
  const sections = extractSections(maskedText);
  const sectionTitles = sections.map((s) => s.title);
  const minified = minifyLatex(coreText);
  const stripped = stripHeavyMath(coreText);
  const mathEnvs = extractMathEnvs(coreText);
  const normalizeMathEnv = (env) =>
    env
      .replace(/\\label\{[^}]*\}/gi, "")
      .replace(/\\tag\{[^}]*\}/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const seenMath = new Set();
  const uniqueMathEnvs = [];
  for (const env of mathEnvs) {
    const normalized = normalizeMathEnv(env);
    if (!normalized) continue;
    if (seenMath.has(normalized)) continue;
    seenMath.add(normalized);
    uniqueMathEnvs.push(env);
  }
  const sectionChunks = buildSectionChunks(coreText);
  const notationBatches = [];
  const notationBatchLimit = 24000;
  const notationBatchMax = 160;
  let currentBatch = [];
  let currentChars = 0;
  for (const env of uniqueMathEnvs) {
    if (!env.trim()) continue;
    const nextChars = currentChars + env.length;
    if (
      currentBatch.length &&
      (nextChars > notationBatchLimit || currentBatch.length >= notationBatchMax)
    ) {
      notationBatches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }
    currentBatch.push(env);
    currentChars += env.length;
  }
  if (currentBatch.length) notationBatches.push(currentBatch);
  if (notationBatches.length) {
    emitLog(
      `[input] notation envs total=${mathEnvs.length} unique=${uniqueMathEnvs.length} batches=${notationBatches.length}`
    );
  }
  const definitions = extractDefinitionsSection(coreText);
  const { abstract, results, discussion } = extractAbstractResultsDiscussion(coreText);
  const evidenceSummary = (() => {
    const flags = [];
    if (/\\begin\{(table|longtable|tabular)\}/i.test(coreText)) flags.push("tables present");
    if (/\\begin\{figure\}/i.test(coreText) || /\\includegraphics\{/i.test(coreText))
      flags.push("figures present");
    if (/\b(experiments|evaluation|results|analysis|ablation|baseline)\b/i.test(coreText))
      flags.push("experimental/analysis keywords present");
    if (/\b(dataset|data)\b/i.test(coreText)) flags.push("dataset mentions present");
    return flags.length ? flags.join("; ") : "No obvious evidence markers detected.";
  })();
  const sectionEvidence = sectionChunks.map((chunk) => {
    const flags = [];
    if (/\\begin\{(table|longtable|tabular)\}/i.test(chunk.text)) flags.push("tables");
    if (/\\begin\{figure\}/i.test(chunk.text) || /\\includegraphics\{/i.test(chunk.text))
      flags.push("figures");
    if (/\b(experiments|evaluation|results|analysis|ablation|baseline)\b/i.test(chunk.text))
      flags.push("experiment keywords");
    if (/\b(dataset|data)\b/i.test(chunk.text)) flags.push("data keywords");
    return { title: chunk.title || "Section", flags };
  });
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
  const hasEvidence =
    /\\begin\{(table|figure|longtable|tabular)\}/i.test(coreText) ||
    /\\includegraphics\{/i.test(coreText);
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
    mathEnvs: notationBatches[0] || [],
    definitions,
    preamble: combinedPreamble,
    paperType,
    expectations
  });
    promptCapture.Critical = buildCriticalPrompt({
      abstract,
      results,
      discussion,
      fullText: coreText,
      paperType,
      expectations,
      evidenceSummary
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
        expectations,
        evidenceSummary
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

  const AGENT_TIMEOUT_MS = Number.parseInt(
    process.env.AGENT_TIMEOUT_MS || "120000",
    10
  );

  const partialErrors = {};
  const agents = [
    {
      name: "Structural",
      progress: 25,
      timeoutMs: AGENT_TIMEOUT_MS,
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
      run: async () => {
        if (!notationBatches.length) {
          return runNotation({
            mathEnvs: [],
            definitions,
            preamble: combinedPreamble,
            paperType,
            expectations,
            logger: emitLog
          });
        }
        if (notationBatches.length === 1) {
          return runNotation({
            mathEnvs: notationBatches[0],
            definitions,
            preamble: combinedPreamble,
            paperType,
            expectations,
            logger: emitLog
          });
        }
        promptCapture.Notation = [];
        const merged = [];
        const batches = notationBatches.map((batch, idx) => ({
          batch,
          idx
        }));
        const concurrency = 3;
        let inFlight = 0;
        let cursor = 0;
        const runNext = async () => {
          if (cursor >= batches.length) return;
          const { batch, idx } = batches[cursor];
          cursor += 1;
          inFlight += 1;
          sendEvent(res, "agent-update", {
            agent: "Notation",
            status: "processing",
            progress: 45 + Math.round(((idx + 1) / notationBatches.length) * 5),
            detail: {
              phase: "batch-start",
              message: `Math batch ${idx + 1}/${notationBatches.length}`
            },
            payload: { symbol_analysis: merged }
          });
          promptCapture.Notation[idx] = buildNotationPrompt({
            mathEnvs: batch,
            definitions,
            preamble: combinedPreamble,
            paperType,
            expectations
          });
          let output;
          try {
            const batchTimeoutMs = Math.min(
              240000,
              AGENT_TIMEOUT_MS + Math.round(batch.length * 600)
            );
            output = await withTimeout(
              runNotation({
                mathEnvs: batch,
                definitions,
                preamble: combinedPreamble,
                paperType,
                expectations,
                logger: emitLog
              }),
              `Notation batch ${idx + 1}/${notationBatches.length}`,
              batchTimeoutMs
            );
            merged.push(...(output.symbol_analysis || []));
          } catch (err) {
            partialErrors.Notation = err?.message || "Notation batch failed.";
            emitLog(`[agent] Notation partial: ${partialErrors.Notation}`, {
              level: "error"
            });
          }
          sendEvent(res, "agent-update", {
            agent: "Notation",
            status: "processing",
            progress: 45 + Math.round(((idx + 1) / notationBatches.length) * 5),
            detail: {
              phase: "batch-complete",
              message: `Math batch ${idx + 1}/${notationBatches.length} done`
            },
            payload: { symbol_analysis: merged }
          });
          inFlight -= 1;
          if (cursor < batches.length) {
            await runNext();
          }
        };
        const starters = [];
        while (inFlight < concurrency && cursor < batches.length) {
          starters.push(runNext());
        }
        await Promise.all(starters);
        return { symbol_analysis: merged };
      }
    },
    {
      name: "Rhetoric",
      progress: 75,
      run: async () => {
        const shouldChunk = coreText.length > 42000 || wordCount > 7000;
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

        const chunks = sectionChunks;
        emitLog(
          `[agent] Rhetoric sections=${sectionChunks.length} headings=${sections.length} chunks=${chunks.length}`
        );
        const merged = [];
        const prior = [];
        promptCapture.Rhetoric = [];
        for (let i = 0; i < chunks.length; i += 1) {
          const chunk = chunks[i];
          const label = formatChunkLabel(chunk);
          sendEvent(res, "agent-update", {
            agent: "Rhetoric",
            status: "processing",
            progress: 50 + Math.round(((i + 1) / chunks.length) * 35),
            detail: {
              phase: "chunk-start",
              chunkIndex: i + 1,
              chunkTotal: chunks.length,
              sectionTitle: chunk.title || "",
              message: label || "Processing section"
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
          emitLog(
            `[agent] Rhetoric ${i + 1}/${chunks.length}${label ? ` • ${label}` : ""}`
          );
          let output;
          try {
            const chunkTimeoutMs = Math.min(
              240000,
              AGENT_TIMEOUT_MS + Math.ceil(chunk.text.length / 8000) * 15000
            );
            output = await withTimeout(
              runRhetoric({
                text: chunk.text,
                paperType,
                expectations,
                priorIssues: prior.slice(-5),
                chunkTitle: chunk.title,
                logger: emitLog
              }),
              `Rhetoric chunk ${i + 1}/${chunks.length}`,
              chunkTimeoutMs
            );
          } catch (err) {
            partialErrors.Rhetoric = err?.message || "Rhetoric chunk failed.";
            emitLog(`[agent] Rhetoric partial: ${partialErrors.Rhetoric}`, {
              level: "error"
            });
            break;
          }
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
              message: label ? `${label} done` : "Section done"
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
              const shouldChunk = coreText.length > 42000 || wordCount > 7000;
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

              const chunks = sectionChunks;
              emitLog(
                `[agent] Science sections=${sectionChunks.length} headings=${sections.length} chunks=${chunks.length}`
              );
              const merged = [];
              const staged = [];
              const prior = [];
              promptCapture.Science = [];
              for (let i = 0; i < chunks.length; i += 1) {
                const chunk = chunks[i];
                const label = formatChunkLabel(chunk);
                sendEvent(res, "agent-update", {
                  agent: "Science",
                  status: "processing",
                  progress: 60 + Math.round(((i + 1) / chunks.length) * 30),
                  detail: {
                    phase: "chunk-start",
                    chunkIndex: i + 1,
                    chunkTotal: chunks.length,
                    sectionTitle: chunk.title || "",
                    message: label || "Processing section"
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
                  chunkTitle: chunk.title,
                  evidenceSummary
                })
              );
                emitLog(
                  `[agent] Science ${i + 1}/${chunks.length}${label ? ` • ${label}` : ""}`
                );
                let output;
                try {
                  const chunkTimeoutMs = Math.min(
                    240000,
                    AGENT_TIMEOUT_MS + Math.ceil(chunk.text.length / 8000) * 15000
                  );
                  output = await withTimeout(
                    runScience({
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
                    evidenceSummary,
                    logger: emitLog
                  }),
                    `Science chunk ${i + 1}/${chunks.length}`,
                    chunkTimeoutMs
                  );
                } catch (err) {
                  partialErrors.Science = err?.message || "Science chunk failed.";
                  emitLog(`[agent] Science partial: ${partialErrors.Science}`, {
                    level: "error"
                  });
                  break;
                }
                const safeCategories = new Set(["metrics", "baselines", "reproducibility"]);
                const safeIssues = (output.science_issues || []).filter((issue) =>
                  safeCategories.has(issue.category)
                );
                merged.push(...safeIssues);
                (output.science_issues || []).forEach((issue, idx) => {
                  staged.push({
                    id: `science-${i}-${idx}`,
                    sectionIndex: i,
                    text: issue.message,
                    excerpt: issue.excerpt,
                    issue
                  });
                });
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
                    message: label ? `${label} done` : "Section done"
                  },
                  payload: { science_issues: merged }
                });
              }
              if (chunks.length > 1 && staged.length) {
                promptCapture.ScienceResolution = buildResolvePrompt({
                  issues: staged,
                  sectionTitles,
                  paperType,
                  expectations,
                  agent: "Science",
                  evidenceSummary,
                  sectionEvidence
                });
                try {
                  const resolution = await withTimeout(
                    runResolveIssues({
                    issues: staged,
                    sectionTitles,
                    paperType,
                    expectations,
                    agent: "Science",
                    evidenceSummary,
                    sectionEvidence,
                    logger: emitLog
                  }),
                    "Science resolve"
                  );
                  const keep = new Set(resolution.keep_ids || []);
                  const filtered = staged
                    .filter((item) => keep.has(item.id))
                    .map((item) => item.issue);
                  return { science_issues: filtered };
                } catch (err) {
                  partialErrors.Science =
                    err?.message || "Science resolve failed.";
                  emitLog(`[agent] Science resolve failed: ${partialErrors.Science}`, {
                    level: "error"
                  });
                  return { science_issues: merged };
                }
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
        const shouldChunk = coreText.length > 42000 || wordCount > 7000;
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

        const chunks = sectionChunks;
        emitLog(
          `[agent] Critical sections=${sectionChunks.length} headings=${sections.length} chunks=${chunks.length}`
        );
        const merged = [];
        const staged = [];
        const prior = [];
        promptCapture.Critical = [];
        for (let i = 0; i < chunks.length; i += 1) {
          const chunk = chunks[i];
          const label = formatChunkLabel(chunk);
          sendEvent(res, "agent-update", {
            agent: "Critical",
            status: "processing",
            progress: 70 + Math.round(((i + 1) / chunks.length) * 25),
            detail: {
              phase: "chunk-start",
              chunkIndex: i + 1,
              chunkTotal: chunks.length,
              sectionTitle: chunk.title || "",
              message: label || "Processing section"
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
          emitLog(
            `[agent] Critical ${i + 1}/${chunks.length}${label ? ` • ${label}` : ""}`
          );
          let output;
          try {
            const chunkTimeoutMs = Math.min(
              240000,
              AGENT_TIMEOUT_MS + Math.ceil(chunk.text.length / 8000) * 15000
            );
            output = await withTimeout(
              runCritical({
                abstract,
                results,
                discussion,
            fullText: chunk.text,
            paperType,
            expectations,
            priorIssues: prior.slice(-5),
            chunkTitle: chunk.title,
            evidenceSummary,
            logger: emitLog
            }),
              `Critical chunk ${i + 1}/${chunks.length}`,
              chunkTimeoutMs
            );
          } catch (err) {
            partialErrors.Critical = err?.message || "Critical chunk failed.";
            emitLog(`[agent] Critical partial: ${partialErrors.Critical}`, {
              level: "error"
            });
            break;
          }
          const safeIssues = (output.critique || []).filter((issue) => {
            const text = `${issue.weakness || ""} ${issue.excerpt || ""}`.toLowerCase();
            const risky =
              /missing|not provided|absent|lacks|no results|no discussion|no experiments|no evaluation|no dataset|no data|no table|no figure|insufficient evidence|unsupported/i.test(
                text
              );
            return !risky;
          });
          merged.push(...safeIssues);
          (output.critique || []).forEach((issue, idx) => {
            staged.push({
              id: `critical-${i}-${idx}`,
              sectionIndex: i,
              text: issue.weakness,
              excerpt: issue.excerpt,
              issue
            });
          });
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
              message: label ? `${label} done` : "Section done"
            },
            payload: { critique: merged }
          });
        }
        if (chunks.length > 1 && staged.length) {
          promptCapture.CriticalResolution = buildResolvePrompt({
            issues: staged,
            sectionTitles,
            paperType,
            expectations,
            agent: "Reviewer #2",
            evidenceSummary,
            sectionEvidence
          });
          try {
            const resolution = await withTimeout(
              runResolveIssues({
              issues: staged,
              sectionTitles,
              paperType,
              expectations,
              agent: "Reviewer #2",
              evidenceSummary,
              sectionEvidence,
              logger: emitLog
            }),
              "Critical resolve"
            );
            const keep = new Set(resolution.keep_ids || []);
            const filtered = staged
              .filter((item) => keep.has(item.id))
              .map((item) => item.issue);
            return { critique: filtered };
          } catch (err) {
            partialErrors.Critical =
              err?.message || "Critical resolve failed.";
            emitLog(`[agent] Critical resolve failed: ${partialErrors.Critical}`, {
              level: "error"
            });
            return { critique: merged };
          }
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

  const withTimeout = (promise, label, timeoutMs = AGENT_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error(`${label} timed out after ${timeoutMs}ms`);
        emitLog(`[agent] ${err.message}`, { level: "error" });
        reject(err);
      }, timeoutMs);
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
      const initialMessage =
        agent.name === "Structural" || agent.name === "Notation"
          ? "Analyzing full paper"
          : "Preparing sections";
      sendEvent(res, "agent-update", {
        agent: agent.name,
        status: "processing",
        progress: 8,
        detail: { phase: "llm-call", message: initialMessage }
      });
      emitLog(
        `[agent] ${agent.name} input chars=${
          agent.name === "Structural"
            ? stripped.length
            : agent.name === "Notation"
              ? mathEnvs.join("\n").length
              : agent.name === "Rhetoric"
                ? coreText.length
                : coreText.length
        }`
      );
      const startAt = Date.now();
      const output = agent.timeoutMs
        ? await withTimeout(agent.run(), agent.name, agent.timeoutMs)
        : await agent.run();
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

  if (paperType !== "math" && notation?.symbol_analysis?.length) {
    notation.symbol_analysis = notation.symbol_analysis.filter(
      (item) => !COMMON_ACRONYMS.has(item.symbol)
    );
  }

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
  let criticalWithLines = {
    ...critical,
    critique: (critical.critique || []).map((item) =>
      attachLine(item, item.excerpt || item.weakness)
    )
  };
  if (hasEvidence) {
    const missingResultsRe =
      /missing.*(results|discussion|experiments|evaluation|dataset|data|tables?|figures?)|results.*discussion.*missing/i;
    criticalWithLines = {
      ...criticalWithLines,
      critique: criticalWithLines.critique.filter(
        (item) => !missingResultsRe.test(item.weakness || "")
      )
    };
  }
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
