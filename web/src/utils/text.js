export function stripLatexInline(text) {
  if (!text) return "";
  return text
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*])?\{([^}]*)\}/g, " $1 ")
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*])?/g, " ")
    .replace(/\\\[[\s\S]*?\\\]/g, " ")
    .replace(/\$[^$]*\$/g, " ")
    .replace(/[{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function tokenize(text) {
  return stripLatexInline(text)
    .split(" ")
    .filter((t) => t.length >= 3);
}

export function findLineFromExcerpt(text, excerpt) {
  if (!excerpt) return 1;
  const needle = excerpt.trim();
  if (!needle) return 1;
  const idx = text.indexOf(needle);
  if (idx === -1) return 1;
  return text.slice(0, idx).split("\n").length;
}

export function findBestLineByTokens(text, target) {
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

export function resolveJumpLine(text, primaryLine, fallbackText) {
  const fromExact = findLineFromExcerpt(text, fallbackText);
  if (fromExact > 1) return fromExact;
  const fromTokens = findBestLineByTokens(text, fallbackText);
  if (fromTokens > 1) return fromTokens;
  if (primaryLine && primaryLine > 1) return primaryLine;
  return 1;
}

export function findSentenceRange(text, anchorIndex, hintText) {
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
      const hintTokens = tokenize(hintText);
      for (const sentence of sentences) {
        const score = tokenize(sentence).filter((t) => hintTokens.includes(t)).length;
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

function buildBigrams(tokens) {
  const bigrams = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    bigrams.push(`${tokens[i]}_${tokens[i + 1]}`);
  }
  return bigrams;
}

export function findBestSentenceRange(text, hintText, anchorIndex) {
  if (!hintText) {
    return findSentenceRange(text, anchorIndex || 0, "");
  }
  const exactIdx = text.indexOf(hintText);
  if (exactIdx !== -1) {
    return { start: exactIdx, end: exactIdx + hintText.length };
  }

  const sentences = [];
  const parts = text.split(/(?<=[.!?])\s+|\n\n+/);
  let cursor = 0;
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      cursor += part.length + 1;
      continue;
    }
    const start = text.indexOf(trimmed, cursor);
    const end = start + trimmed.length;
    sentences.push({ text: trimmed, start, end });
    cursor = end;
  }

  const hintTokens = tokenize(hintText);
  const hintSet = new Set(hintTokens);
  const hintBigrams = new Set(buildBigrams(hintTokens));

  let best = sentences[0] || { start: 0, end: Math.min(120, text.length) };
  let bestScore = 0;

  for (const sentence of sentences) {
    const tokens = tokenize(sentence.text);
    if (!tokens.length) continue;
    const tokenSet = new Set(tokens);
    let overlap = 0;
    for (const token of hintSet) {
      if (tokenSet.has(token)) overlap += 1;
    }
    const jaccard =
      overlap / Math.max(1, hintSet.size + tokenSet.size - overlap);
    const bigrams = new Set(buildBigrams(tokens));
    let bigramOverlap = 0;
    for (const bigram of hintBigrams) {
      if (bigrams.has(bigram)) bigramOverlap += 1;
    }
    const bigramScore =
      bigramOverlap / Math.max(1, hintBigrams.size + bigrams.size - bigramOverlap);

    const score = overlap * 0.6 + jaccard * 0.2 + bigramScore * 0.2;
    if (score > bestScore) {
      bestScore = score;
      best = sentence;
    }
  }

  if (anchorIndex && bestScore < 0.15) {
    return findSentenceRange(text, anchorIndex, hintText);
  }

  return { start: best.start, end: best.end };
}
