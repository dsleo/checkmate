import { diff_match_patch } from "diff-match-patch";

export function buildDiff(from, to) {
  const dmp = new diff_match_patch();
  const diffs = dmp.diff_main(from, to);
  dmp.diff_cleanupSemantic(diffs);
  return dmp.diff_toDelta(diffs);
}

export function buildLinePatch(lineNumber, originalLine, suggestion) {
  return {
    op: "replace",
    path: `/lines/${lineNumber - 1}`,
    value: suggestion,
    meta: {
      line: lineNumber,
      original: originalLine,
      delta: buildDiff(originalLine, suggestion)
    }
  };
}
