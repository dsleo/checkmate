import { describe, expect, it } from "vitest";
import {
  buildSubsectionChunks,
  dedupeAcrossAgents,
  findBestLineByTokens
} from "../src/review-utils.js";

describe("buildSubsectionChunks", () => {
  it("splits by subsection when present", () => {
    const text = [
      "\\section{Intro}",
      "Intro text.",
      "\\subsection{Methods}",
      "Method details.",
      "\\subsection{Results}",
      "Result details."
    ].join("\n");
    const chunks = buildSubsectionChunks(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0].title).toBe("Methods");
    expect(chunks[1].title).toBe("Results");
  });
});

describe("dedupeAcrossAgents", () => {
  it("dedupes similar issues across agents", () => {
    const structural = {
      integrity_report: [{ message: "Missing Abstract section." }]
    };
    const notation = { symbol_analysis: [] };
    const rhetoric = {
      logic_gaps: [{ explanation: "Missing abstract section" }]
    };
    const critical = { critique: [{ weakness: "Missing abstract section." }] };
    const result = dedupeAcrossAgents({
      structural,
      notation,
      rhetoric,
      critical,
      science: null
    });
    expect(result.structural.integrity_report.length).toBe(1);
    expect(result.rhetoric.logic_gaps.length).toBe(0);
    expect(result.critical.critique.length).toBe(0);
  });
});

describe("findBestLineByTokens", () => {
  it("finds a line near target tokens", () => {
    const lines = [
      "Introduction text.",
      "We evaluate on real-world datasets with baselines.",
      "More details."
    ];
    const line = findBestLineByTokens(lines, "real-world dataset evaluation");
    expect(line).toBe(2);
  });
});
