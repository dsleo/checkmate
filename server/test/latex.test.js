import { describe, expect, it } from "vitest";
import {
  extractSectionContent,
  extractTitle,
  stripReferencesPreserveLines
} from "../src/latex.js";

describe("extractTitle", () => {
  it("extracts and strips latex commands", () => {
    const tex = "\\title{\\textbf{My Paper}}\\begin{document}";
    expect(extractTitle(tex)).toBe("My Paper");
  });
});

describe("extractSectionContent", () => {
  it("returns section content for matching title", () => {
    const tex = [
      "\\section{Methods}",
      "We describe the method.",
      "\\section{Results}",
      "Results here."
    ].join("\n");
    const content = extractSectionContent(tex, ["Methods"]);
    expect(content).toContain("We describe the method.");
    expect(content).not.toContain("Results here.");
  });
});

describe("stripReferencesPreserveLines", () => {
  it("preserves line count", () => {
    const tex = [
      "Line1",
      "\\section{References}",
      "RefA",
      "RefB",
      "Line5"
    ].join("\n");
    const stripped = stripReferencesPreserveLines(tex);
    expect(stripped.split("\n").length).toBe(tex.split("\n").length);
  });
});
