const SECTION_RE = /\\(section|subsection|subsubsection)\*?\{([^}]*)\}/g;
const COMMENT_RE = /%.*$/gm;

export function splitLines(text) {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

export function extractPreamble(text) {
  const idx = text.indexOf("\\begin{document}");
  if (idx === -1) return text;
  return text.slice(0, idx);
}

export function extractTitle(text) {
  const m = text.match(/\\title\{([\s\S]*?)\}/i);
  if (!m) return "";
  let title = m[1];
  // Strip common LaTeX commands while preserving their content.
  title = title.replace(/\\textbf\{([\s\S]*?)\}/gi, "$1");
  title = title.replace(/\\textit\{([\s\S]*?)\}/gi, "$1");
  title = title.replace(/\\emph\{([\s\S]*?)\}/gi, "$1");
  title = title.replace(/\\underline\{([\s\S]*?)\}/gi, "$1");
  title = title.replace(/\\[a-zA-Z]+\*?\{([\s\S]*?)\}/g, "$1");
  title = title.replace(/\\[a-zA-Z]+\*?/g, "");
  title = title.replace(/\s+/g, " ").trim();
  return title;
}

export function extractMacros(text) {
  const macros = {};
  const newcommandRe = /\\newcommand\*?\\?{\\(\w+)}(?:\[(\d+)])?{([\s\S]*?)}/g;
  let m;
  while ((m = newcommandRe.exec(text)) !== null) {
    macros[`\\${m[1]}`] = m[3];
  }
  const newcommandNoBrace = /\\newcommand\*?\\(\w+)(?:\[(\d+)])?{([\s\S]*?)}/g;
  while ((m = newcommandNoBrace.exec(text)) !== null) {
    macros[`\\${m[1]}`] = m[3];
  }
  const defRe = /\\def\\(\w+)\s*{([\s\S]*?)}/g;
  while ((m = defRe.exec(text)) !== null) {
    macros[`\\${m[1]}`] = m[2];
  }
  return macros;
}

export function extractBody(text) {
  const start = text.indexOf("\\begin{document}");
  if (start === -1) return text;
  const end = text.indexOf("\\end{document}");
  if (end === -1) return text.slice(start);
  return text.slice(start + "\\begin{document}".length, end);
}

export function stripPreamblePreserveLines(text) {
  const start = text.indexOf("\\begin{document}");
  if (start === -1) return text;
  const preamble = text.slice(0, start);
  const preambleLines = preamble.split("\n").length;
  return "\n".repeat(Math.max(0, preambleLines - 1)) + text.slice(start);
}

export function stripReferences(text) {
  let out = text;
  out = out.replace(/\\begin\{thebibliography\}[\s\S]*?\\end\{thebibliography\}/gi, "");
  out = out.replace(/\\bibliography\{[^}]*\}/gi, "");
  out = out.replace(/\\bibliographystyle\{[^}]*\}/gi, "");
  out = out.replace(/\\section\*?\{References\}[\s\S]*?(?=\\section|\\subsection|$)/gi, "");
  out = out.replace(/\\section\*?\{Bibliography\}[\s\S]*?(?=\\section|\\subsection|$)/gi, "");
  return out;
}

export function stripReferencesPreserveLines(text) {
  const replaceWithBlankLines = (match) => {
    const lines = match.split("\n").length;
    return "\n".repeat(Math.max(0, lines - 1));
  };
  let out = text;
  out = out.replace(
    /\\begin\{thebibliography\}[\s\S]*?\\end\{thebibliography\}/gi,
    replaceWithBlankLines
  );
  out = out.replace(/\\bibliography\{[^}]*\}/gi, "");
  out = out.replace(/\\bibliographystyle\{[^}]*\}/gi, "");
  out = out.replace(
    /\\section\*?\{References\}[\s\S]*?(?=\\section|\\subsection|$)/gi,
    replaceWithBlankLines
  );
  out = out.replace(
    /\\section\*?\{Bibliography\}[\s\S]*?(?=\\section|\\subsection|$)/gi,
    replaceWithBlankLines
  );
  return out;
}

export function stripAuthorBlocks(text) {
  return text.replace(/\\author\{[\s\S]*?\}/gi, "");
}

export function extractCoreText(text) {
  let out = extractBody(text);
  out = stripReferences(out);
  out = out.replace(/\\maketitle/gi, "");
  out = out.replace(/\\thanks\{[\s\S]*?\}/gi, "");
  out = out.replace(/\\label\{[^}]*\}/gi, "");
  out = out.replace(/\\ref\{[^}]*\}/gi, "");
  out = out.replace(/\\cite\{[^}]*\}/gi, "");
  return out;
}

export function extractMathArtifacts(text) {
  const envs = ["theorem", "lemma", "proposition", "corollary", "claim"];
  const artifacts = [];
  for (const env of envs) {
    const re = new RegExp(
      `\\\\begin\\{${env}\\}([\\s\\S]*?)\\\\end\\{${env}\\}`,
      "gi"
    );
    let match;
    while ((match = re.exec(text)) !== null) {
      let statement = match[1].trim();
      statement = statement.replace(/\\label\{[^}]*\}/gi, "").trim();
      artifacts.push({
        type: env,
        statement,
        index: match.index
      });
    }
  }
  return artifacts.sort((a, b) => a.index - b.index);
}

export function extractSections(text) {
  const sections = [];
  let match;
  while ((match = SECTION_RE.exec(text)) !== null) {
    sections.push({
      level: match[1],
      title: match[2],
      index: match.index
    });
  }
  return sections;
}

export function minifyLatex(text) {
  // Remove comments and collapse long tables to placeholders.
  let out = text.replace(COMMENT_RE, "");
  out = out.replace(/\\begin\{(table|longtable|tabular)\}[\s\S]*?\\end\{\1\}/g, "\\begin{$1}...\\end{$1}");
  return out.replace(/\n{3,}/g, "\n\n");
}

export function extractMathEnvs(text) {
  const math = [];
  const inline = /\$(.+?)\$/g;
  const display = /\\\[(.+?)\\\]/gs;
  const equation = /\\begin\{(equation\*?|align\*?|gather\*?)\}([\s\S]*?)\\end\{\1\}/g;
  let m;
  while ((m = inline.exec(text)) !== null) math.push(m[1]);
  while ((m = display.exec(text)) !== null) math.push(m[1]);
  while ((m = equation.exec(text)) !== null) math.push(m[2]);
  return math;
}

export function extractDefinitionsSection(text) {
  const re = /\\section\*?\{(Definitions|Notation|Definitions and Notation|Notation and Definitions)\}([\s\S]*?)(?=\\section|\\subsection|\\end\{document\}|$)/i;
  const m = text.match(re);
  return m ? m[2] : "";
}

export function extractAbstractResultsDiscussion(text) {
  const abstract = text.match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/i);
  const results = text.match(/\\section\*?\{Results\}([\s\S]*?)(?=\\section|\\end\{document\}|$)/i);
  const discussion = text.match(/\\section\*?\{Discussion\}([\s\S]*?)(?=\\section|\\end\{document\}|$)/i);
  return {
    abstract: abstract ? abstract[1] : "",
    results: results ? results[1] : "",
    discussion: discussion ? discussion[1] : ""
  };
}

export function stripHeavyMath(text) {
  return text
    .replace(/\\\[(.+?)\\\]/gs, "[MATH]")
    .replace(/\$(.+?)\$/g, "[MATH]")
    .replace(/\\begin\{(equation\*?|align\*?|gather\*?)\}[\s\S]*?\\end\{\1\}/g, "[MATH]");
}

export function extractRefsSkeleton(text) {
  const preamble = extractPreamble(text);
  const sections = extractSections(text);
  return {
    preamble,
    sections
  };
}

export function getLineContext(lines, lineNumber, radius = 0) {
  const idx = Math.max(0, Math.min(lines.length - 1, lineNumber - 1));
  if (radius === 0) return lines[idx] || "";
  const start = Math.max(0, idx - radius);
  const end = Math.min(lines.length, idx + radius + 1);
  return lines.slice(start, end).join("\n");
}
