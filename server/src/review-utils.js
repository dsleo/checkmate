import { extractSections } from "./latex.js";

export function buildRhetoricChunks(text, sections) {
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

export function buildSectionChunks(text) {
  const sections = extractSections(text);
  if (!sections.length) return [{ title: "", text }];
  const sectionStarts = sections.filter((s) => s.level === "section");
  const boundaries = sectionStarts.length ? sectionStarts : sections;
  const chunks = [];
  for (let i = 0; i < boundaries.length; i += 1) {
    const current = boundaries[i];
    const next = boundaries.find((s) => s.index > current.index);
    const end = next ? next.index : text.length;
    const chunkText = text.slice(current.index, end).trim();
    if (chunkText) {
      chunks.push({ title: current.title, level: current.level, text: chunkText });
    }
  }
  return chunks.length ? chunks : [{ title: "", text }];
}

export function normalizeIssueText(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenSimilarity(a, b) {
  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  if (!aTokens.size || !bTokens.size) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(aTokens.size, bTokens.size);
}

export function dedupeByText(items, getText) {
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

export function dedupeAcrossAgents({ structural, notation, rhetoric, critical, science }) {
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

export function summarizeMath(results, total) {
  const counts = { complete: 0, incomplete: 0, missing: 0, unclear: 0 };
  for (const r of results) {
    counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  }
  return `Proof review: ${counts.complete} complete, ${counts.incomplete} incomplete, ${counts.missing} missing, ${counts.unclear} unclear (of ${total}).`;
}

export function dedupeIssues(issues) {
  const seen = new Set();
  return issues.filter((issue) => {
    const key = issue.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function findBestLineByTokens(lines, excerpt) {
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
