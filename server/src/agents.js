import OpenAI from "openai";
import { z } from "zod";

const STRUCTURAL_SCHEMA = z.object({
  integrity_report: z
    .array(
      z.object({
        scope: z.enum(["cross-reference", "bibliography", "structure"]),
        location: z.object({
          line: z.number(),
          context: z.string()
        }),
        severity: z.enum(["error", "warning"]),
        message: z.string(),
        fix_suggestion: z.string()
      })
    )
    .default([])
});

const NOTATION_SCHEMA = z.object({
  symbol_analysis: z
    .array(
      z.object({
        symbol: z.string(),
        status: z.enum(["undefined_at_first_use", "inconsistent_casing", "conflict"]),
        location: z.object({
          line: z.number()
        }),
        recommendation: z.string()
      })
    )
    .default([])
});

const RHETORIC_SCHEMA = z.object({
  logic_gaps: z
    .array(
      z.object({
        type: z.enum(["unsupported_claim", "clarity", "logical_fallacy"]),
        excerpt: z.string(),
        explanation: z.string(),
        improvement: z.string()
      })
    )
    .default([])
});

const CRITICAL_SCHEMA = z.object({
  critique: z
    .array(
      z.object({
        weakness: z.string(),
        rebuttal_potential: z.string(),
        severity: z.enum(["high", "medium"])
      })
    )
    .default([])
});

function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const timeoutMs = Number.parseInt(process.env.OPENAI_TIMEOUT_MS || "90000", 10);
  return new OpenAI({ apiKey, timeout: timeoutMs });
}

async function runJsonChat({ system, user, schema, logger }) {
  const client = getClient();
  if (!client || process.env.MOCK_MODE === "1") {
    return mockResponse(schema);
  }

  const messages = [
    { role: "system", content: system },
    { role: "user", content: user }
  ];

  try {
  const content = await callOpenAI(client, messages, logger);
  const parsed = safeParseJson(content);
  return schema.parse(parsed);
} catch (err) {
    // Retry once with a stricter instruction if the first response was invalid.
    const retryMessages = [
      { role: "system", content: system },
      {
        role: "user",
        content:
          user +
          "\n\nYour previous response was invalid JSON. Return ONLY valid JSON that matches the schema."
      }
    ];
    const content = await callOpenAI(client, retryMessages, logger);
    const parsed = safeParseJson(content);
    return schema.parse(parsed);
  }
}

async function callOpenAI(client, messages, logger) {
  const totalChars = messages.reduce((n, m) => n + (m.content?.length || 0), 0);
  const requestLine = `[openai] request model=${
    process.env.OPENAI_MODEL || "gpt-4o"
  } msgs=${messages.length} chars=${totalChars}`;
  console.log(requestLine);
  logger?.(requestLine);
  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o",
    messages,
    response_format: { type: "json_object" },
    temperature: 0.2
  });
  console.log("[openai] response received");
  logger?.("[openai] response received");
  return completion.choices[0]?.message?.content || "{}";
}

function safeParseJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Model response did not contain JSON.");
    }
    const sliced = content.slice(start, end + 1);
    return JSON.parse(sliced);
  }
}

function mockResponse(schema) {
  const shape = schema.safeParse({});
  if (shape.success) return shape.data;
  // Minimal, deterministic mocks per schema name.
  if (schema === STRUCTURAL_SCHEMA) {
    return {
      integrity_report: [
        {
          scope: "structure",
          location: { line: 12, context: "\\section{Results}" },
          severity: "warning",
          message: "Results appear before Methods; IMRaD order may be violated.",
          fix_suggestion: "Move Results section after Methods to align with IMRaD."
        }
      ]
    };
  }
  if (schema === NOTATION_SCHEMA) {
    return {
      symbol_analysis: [
        {
          symbol: "NLP",
          status: "undefined_at_first_use",
          location: { line: 20 },
          recommendation: "Define NLP on first use (e.g., natural language processing)."
        }
      ]
    };
  }
  if (schema === RHETORIC_SCHEMA) {
    return {
      logic_gaps: [
        {
          type: "unsupported_claim",
          excerpt: "It is obvious that our method outperforms baselines.",
          explanation: "No evidence or citations are provided for the claim.",
          improvement: "Cite quantitative results or add a comparison table."
        }
      ]
    };
  }
  return {
    critique: [
      {
        weakness: "Claims of novelty are not substantiated with a clear comparison to prior art.",
        rebuttal_potential: "Add a related work table and ablation demonstrating unique contribution.",
        severity: "high"
      }
    ]
  };
}

export async function runStructural({
  preamble,
  sections,
  fullText,
  strippedText,
  paperType,
  expectations,
  logger
}) {
  const system = "You are the Structural Integrity Agent. Output ONLY JSON.";
  const user = `Paper type: ${paperType}\nExpectations: ${expectations}\n\nPreamble:\n${preamble}\n\nSection headers:\n${sections
    .map((s) => `- ${s.level}: ${s.title}`)
    .join("\n")}\n\nFull text (math stripped):\n${strippedText}\n\nCheck cross-references (\\ref/\\cite/\\cref), bibliography, and IMRaD structure. Return JSON with fix_suggestion for each issue.`;
  return runJsonChat({ system, user, schema: STRUCTURAL_SCHEMA, logger });
}

export async function runNotation({
  mathEnvs,
  definitions,
  preamble,
  paperType,
  expectations,
  logger
}) {
  const system = "You are the Notation & Formalism Agent. Output ONLY JSON.";
  const user = `Paper type: ${paperType}\nExpectations: ${expectations}\n\nPreamble:\n${preamble}\n\nDefinitions/Notation section:\n${definitions}\n\nMath environments:\n${mathEnvs.join("\n\n---\n\n")}\n\nFind undefined symbols, casing inconsistencies, and conflicts.`;
  return runJsonChat({ system, user, schema: NOTATION_SCHEMA, logger });
}

export async function runRhetoric({ text, paperType, expectations, logger }) {
  const system = "You are the Rhetoric & Logic Agent. Output ONLY JSON.";
  const user = `Paper type: ${paperType}\nExpectations: ${expectations}\n\nText (sliding window approx):\n${text}\n\nIdentify unsupported claims, clarity issues, or logical fallacies. Provide improvement.`;
  return runJsonChat({ system, user, schema: RHETORIC_SCHEMA, logger });
}

export async function runCritical({
  abstract,
  results,
  discussion,
  paperType,
  expectations,
  logger
}) {
  const system = `You are Reviewer #2 — a highly skeptical, senior academic reviewer for a top-tier journal.\nYou are pedantic, rigorous, and unimpressed by grand claims.\nYour goal is to find every reason to reject this paper. Do not offer praise. Do not be polite.\nIdentify hand-wavy logic, insufficient data, over-generalized conclusions, and methodological flaws.\nEvidence Gap: If the author says "it is clear", demand proof.\nNovelty Check: If the author claims a "novel" approach, question if it is merely a trivial variation.\nThe "So What?" Factor: Question the significance of the results.\nAtheistic Stance: Do not assume the authors are right. Assume they are biased toward their own hypothesis.\nOutput ONLY JSON.`;
  const user = `Paper type: ${paperType}\nExpectations: ${expectations}\n\nAbstract:\n${abstract}\n\nResults:\n${results}\n\nDiscussion:\n${discussion}\n\nReturn critique items with weakness, rebuttal_potential, severity.`;
  return runJsonChat({ system, user, schema: CRITICAL_SCHEMA, logger });
}

export {
  STRUCTURAL_SCHEMA,
  NOTATION_SCHEMA,
  RHETORIC_SCHEMA,
  CRITICAL_SCHEMA
};

export async function runMathProof({
  artifact,
  context,
  paperType,
  expectations,
  logger
}) {
  const system =
    "You are a Math Proof Reviewer. Verify whether the proof for the given artifact is complete and logically sound. Output ONLY JSON.";
  const user = `Paper type: ${paperType}\nExpectations: ${expectations}\n\nArtifact type: ${artifact.type}\nStatement:\n${artifact.statement}\n\nContext (around statement + proof if present):\n${context}\n\nReturn JSON with fields: artifact_type, verdict (complete|incomplete|missing|unclear), issues (array), recommendation.`;
  const schema = z.object({
    artifact_type: z.string(),
    verdict: z.enum(["complete", "incomplete", "missing", "unclear"]),
    issues: z.array(z.string()),
    recommendation: z.string()
  });
  return runJsonChat({ system, user, schema, logger });
}
