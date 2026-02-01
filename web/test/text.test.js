import { describe, expect, it } from "vitest";
import {
  findBestLineByTokens,
  findLineFromExcerpt,
  findSentenceRange,
  resolveJumpLine
} from "../src/utils/text.js";

describe("findLineFromExcerpt", () => {
  it("finds the line for an exact excerpt", () => {
    const text = ["Line one", "Line two with keyword", "Line three"].join("\n");
    expect(findLineFromExcerpt(text, "keyword")).toBe(2);
  });
});

describe("findBestLineByTokens", () => {
  it("finds best line when excerpt is paraphrased", () => {
    const text = [
      "Intro section.",
      "We evaluate on real-world datasets and baselines.",
      "More details."
    ].join("\n");
    expect(findBestLineByTokens(text, "real world dataset evaluation")).toBe(2);
  });
});

describe("resolveJumpLine", () => {
  it("falls back to best line when no exact match", () => {
    const text = [
      "Intro section.",
      "We evaluate on real-world datasets and baselines.",
      "More details."
    ].join("\n");
    expect(resolveJumpLine(text, 1, "real world dataset evaluation")).toBe(2);
  });
});

describe("findSentenceRange", () => {
  it("returns range within the paragraph", () => {
    const text = "Sentence one. Sentence two about models. Sentence three.";
    const range = findSentenceRange(text, text.indexOf("models"), "models");
    const selected = text.slice(range.start, range.end);
    expect(selected).toContain("Sentence two about models.");
  });
});
