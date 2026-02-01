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
        improvement: z.string(),
        location: z.object({
          line: z.number()
        })
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
        severity: z.enum(["high", "medium"]),
        excerpt: z.string(),
        location: z.object({
          line: z.number()
        })
      })
    )
    .default([])
});

const SCIENCE_SCHEMA = z.object({
  science_issues: z
    .array(
      z.object({
        category: z.enum([
          "experimental_design",
          "data",
          "baselines",
          "metrics",
          "ablation",
          "reproducibility",
          "analysis",
          "claims_vs_evidence"
        ]),
        severity: z.enum(["high", "medium", "low"]),
        message: z.string(),
        evidence: z.string(),
        recommendation: z.string(),
        excerpt: z.string(),
        location: z.object({
          line: z.number()
        })
      })
    )
    .default([])
});

const RESOLVE_SCHEMA = z.object({
  keep_ids: z.array(z.string()).default([])
});

const RESPONSE_SCHEMAS = {
  Structural: {
    type: "object",
    additionalProperties: false,
    properties: {
      integrity_report: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            scope: {
              type: "string",
              enum: ["cross-reference", "bibliography", "structure"]
            },
            location: {
              type: "object",
              additionalProperties: false,
              properties: {
                line: { type: "number" },
                context: { type: "string" }
              },
              required: ["line", "context"]
            },
            severity: { type: "string", enum: ["error", "warning"] },
            message: { type: "string" },
            fix_suggestion: { type: "string" }
          },
          required: ["scope", "location", "severity", "message", "fix_suggestion"]
        }
      }
    },
    required: ["integrity_report"]
  },
  Notation: {
    type: "object",
    additionalProperties: false,
    properties: {
      symbol_analysis: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            symbol: { type: "string" },
            status: {
              type: "string",
              enum: ["undefined_at_first_use", "inconsistent_casing", "conflict"]
            },
            location: {
              type: "object",
              additionalProperties: false,
              properties: { line: { type: "number" } },
              required: ["line"]
            },
            recommendation: { type: "string" }
          },
          required: ["symbol", "status", "location", "recommendation"]
        }
      }
    },
    required: ["symbol_analysis"]
  },
  Rhetoric: {
    type: "object",
    additionalProperties: false,
    properties: {
      logic_gaps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: { type: "string", enum: ["unsupported_claim", "clarity", "logical_fallacy"] },
            excerpt: { type: "string" },
            explanation: { type: "string" },
            improvement: { type: "string" },
            location: {
              type: "object",
              additionalProperties: false,
              properties: { line: { type: "number" } },
              required: ["line"]
            }
          },
          required: ["type", "excerpt", "explanation", "improvement", "location"]
        }
      }
    },
    required: ["logic_gaps"]
  },
  Critical: {
    type: "object",
    additionalProperties: false,
    properties: {
      critique: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            weakness: { type: "string" },
            rebuttal_potential: { type: "string" },
            severity: { type: "string", enum: ["high", "medium"] },
            excerpt: { type: "string" },
            location: {
              type: "object",
              additionalProperties: false,
              properties: { line: { type: "number" } },
              required: ["line"]
            }
          },
          required: ["weakness", "rebuttal_potential", "severity", "excerpt", "location"]
        }
      }
    },
    required: ["critique"]
  },
  Science: {
    type: "object",
    additionalProperties: false,
    properties: {
      science_issues: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            category: {
              type: "string",
              enum: [
                "experimental_design",
                "data",
                "baselines",
                "metrics",
                "ablation",
                "reproducibility",
                "analysis",
                "claims_vs_evidence"
              ]
            },
            severity: { type: "string", enum: ["high", "medium", "low"] },
            message: { type: "string" },
            evidence: { type: "string" },
            recommendation: { type: "string" },
            excerpt: { type: "string" },
            location: {
              type: "object",
              additionalProperties: false,
              properties: { line: { type: "number" } },
              required: ["line"]
            }
          },
          required: [
            "category",
            "severity",
            "message",
            "evidence",
            "recommendation",
            "excerpt",
            "location"
          ]
        }
      }
    },
    required: ["science_issues"]
  },
  ResolveIssues: {
    type: "object",
    additionalProperties: false,
    properties: {
      keep_ids: { type: "array", items: { type: "string" } }
    },
    required: ["keep_ids"]
  },
  Math: {
    type: "object",
    additionalProperties: false,
    properties: {
      artifact_type: { type: "string" },
      verdict: { type: "string", enum: ["complete", "incomplete", "missing", "unclear"] },
      issues: { type: "array", items: { type: "string" } },
      recommendation: { type: "string" }
    },
    required: ["artifact_type", "verdict", "issues", "recommendation"]
  }
};

function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const timeoutMs = Number.parseInt(process.env.OPENAI_TIMEOUT_MS || "600000", 10);
  return new OpenAI({ apiKey, timeout: timeoutMs });
}

function assertStructuredModel(model) {
  const supported = new Set([
    "gpt-4o-2024-08-06",
    "gpt-4o-mini-2024-07-18",
    "gpt-5-mini",
    "gpt-5-mini-2025-08-07"
  ]);
  if (!supported.has(model)) {
    throw new Error(
      `Structured Outputs require a supported model (e.g., gpt-5-mini). Current: ${model}`
    );
  }
}

async function runJsonChat({ system, user, schema, schemaName, logger }) {
  const client = getClient();
  if (!client || process.env.MOCK_MODE === "1") {
    return mockResponse(schema);
  }

  const messages = [
    { role: "system", content: system },
    { role: "user", content: user }
  ];

  try {
    const content = await callOpenAI(client, messages, schemaName, logger);
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
    const content = await callOpenAI(client, retryMessages, schemaName, logger);
    const parsed = safeParseJson(content);
    return schema.parse(parsed);
  }
}

async function callOpenAI(client, messages, schemaName, logger) {
  const model = process.env.OPENAI_MODEL || "gpt-5-mini";
  if (schemaName) assertStructuredModel(model);
  const totalChars = messages.reduce((n, m) => n + (m.content?.length || 0), 0);
  const requestLine = `[openai] request model=${model} msgs=${messages.length} chars=${totalChars}`;
  if (logger) logger(requestLine);
  else console.log(requestLine);
  const completion = await client.chat.completions.create({
    model,
    messages,
    response_format: schemaName
      ? {
          type: "json_schema",
          json_schema: {
            name: `${schemaName}Response`,
            strict: true,
            schema: RESPONSE_SCHEMAS[schemaName]
          }
        }
      : { type: "json_object" },
    ...(model.startsWith("gpt-5") ? {} : { temperature: 0.2 })
  });
  if (logger) logger("[openai] response received");
  else console.log("[openai] response received");
  return completion.choices[0]?.message?.content || "{}";
}

function normalizeSeverity(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const clone = Array.isArray(obj) ? obj.map((item) => normalizeSeverity(item)) : { ...obj };
  if (clone.severity && typeof clone.severity === "string") {
    const lowered = clone.severity.toLowerCase();
    if (["high", "medium", "low"].includes(lowered)) clone.severity = lowered;
  }
  for (const [key, value] of Object.entries(clone)) {
    if (Array.isArray(value)) {
      clone[key] = value.map((item) => normalizeSeverity(item));
    } else if (value && typeof value === "object") {
      clone[key] = normalizeSeverity(value);
    }
  }
  return clone;
}

function safeParseJson(content) {
  try {
    return normalizeSeverity(JSON.parse(content));
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Model response did not contain JSON.");
    }
    const sliced = content.slice(start, end + 1);
    return normalizeSeverity(JSON.parse(sliced));
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
  if (schema === SCIENCE_SCHEMA) {
    return {
      science_issues: [
        {
          category: "baselines",
          severity: "high",
          message: "Baselines are underspecified, making comparisons unreliable.",
          evidence: "The experiments section lists results without naming baseline models.",
          recommendation: "Specify baseline models and training protocols, and justify their choice.",
          excerpt: "We compare against strong baselines."
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

export function buildStructuralPrompt({
  preamble,
  sections,
  strippedText,
  paperType,
  expectations
}) {
  const system = "You are the Structural Integrity Agent. Output ONLY JSON.";
  const user = `Paper type: ${paperType}\nExpectations: ${expectations}\n\nPreamble:\n${preamble}\n\nSection headers:\n${sections
    .map((s) => `- ${s.level}: ${s.title}`)
    .join("\n")}\n\nFull text (math stripped):\n${strippedText}\n\nCheck cross-references (\\ref/\\cref) and IMRaD/field structure. Ignore citations/bibliography for now. Return JSON with fix_suggestion for each issue.`;
  return { system, user };
}

export async function runStructural({
  preamble,
  sections,
  strippedText,
  paperType,
  expectations,
  logger
}) {
  const { system, user } = buildStructuralPrompt({
    preamble,
    sections,
    strippedText,
    paperType,
    expectations
  });
  return runJsonChat({
    system,
    user,
    schema: STRUCTURAL_SCHEMA,
    schemaName: "Structural",
    logger
  });
}

export function buildNotationPrompt({
  mathEnvs,
  definitions,
  preamble,
  paperType,
  expectations
}) {
  const system = "You are the Notation & Formalism Agent. Output ONLY JSON.";
  const user = `Paper type: ${paperType}\nExpectations: ${expectations}\n\nPreamble (including macro.tex if provided):\n${preamble}\n\nDefinitions/Notation section:\n${definitions}\n\nMath environments (sampled for size):\n${mathEnvs.join("\n\n---\n\n")}\n\nFind undefined symbols, casing inconsistencies, and conflicts. Do not flag common field acronyms (e.g., ML, NLP, AI, GPU, NP) unless in a math paper or if truly ambiguous.`;
  return { system, user };
}

export async function runNotation({
  mathEnvs,
  definitions,
  preamble,
  paperType,
  expectations,
  logger
}) {
  const { system, user } = buildNotationPrompt({
    mathEnvs,
    definitions,
    preamble,
    paperType,
    expectations
  });
  return runJsonChat({
    system,
    user,
    schema: NOTATION_SCHEMA,
    schemaName: "Notation",
    logger
  });
}

export function buildRhetoricPrompt({ text, paperType, expectations, priorIssues, chunkTitle }) {
  const system = "You are the Rhetoric & Logic Agent. Output ONLY JSON.";
  const prior = priorIssues?.length
    ? `\n\nPrior issues (avoid duplicates, maintain consistency):\n- ${priorIssues.join("\n- ")}`
    : "";
  const title = chunkTitle ? `\n\nSection focus: ${chunkTitle}` : "";
  const user = `Paper type: ${paperType}\nExpectations: ${expectations}${title}\n\nText:\n${text}${prior}\n\nIdentify unsupported claims, clarity issues, or logical fallacies. Provide an improvement. Return a short excerpt copied verbatim from the text and a line number. If no issues are found, return an empty list.`;
  return { system, user };
}

export async function runRhetoric({
  text,
  paperType,
  expectations,
  priorIssues,
  chunkTitle,
  logger
}) {
  const { system, user } = buildRhetoricPrompt({
    text,
    paperType,
    expectations,
    priorIssues,
    chunkTitle
  });
  return runJsonChat({
    system,
    user,
    schema: RHETORIC_SCHEMA,
    schemaName: "Rhetoric",
    logger
  });
}

export function buildCriticalPrompt({
  abstract,
  results,
  discussion,
  fullText,
  paperType,
  expectations,
  priorIssues,
  chunkTitle,
  evidenceSummary
}) {
  const system = `You are Reviewer #2 — a highly skeptical, senior academic reviewer for a top-tier journal.\nYou are pedantic, rigorous, and unimpressed by grand claims.\nYour goal is to find every reason to reject this paper. Do not offer praise. Do not be polite.\nIdentify hand-wavy logic, insufficient data, over-generalized conclusions, and methodological flaws.\nEvidence Gap: If the author says "it is clear", demand proof.\nNovelty Check: If the author claims a "novel" approach, question if it is merely a trivial variation.\nThe "So What?" Factor: Question the significance of the results.\nAtheistic Stance: Do not assume the authors are right. Assume they are biased toward their own hypothesis.\nOutput ONLY JSON.`;
  const prior = priorIssues?.length
    ? `\n\nPrior issues (avoid duplicates, maintain consistency):\n- ${priorIssues.join("\n- ")}`
    : "";
  const title = chunkTitle ? `\n\nSection focus: ${chunkTitle}` : "";
  const evidence = evidenceSummary ? `\n\nGlobal evidence summary:\n${evidenceSummary}` : "";
  const user = `Paper type: ${paperType}\nExpectations: ${expectations}${title}\n\nAbstract:\n${abstract}\n\nResults:\n${results}\n\nDiscussion:\n${discussion}\n\nFull paper (core text):\n${fullText}${prior}${evidence}\n\nImportant: Do NOT assume missing Results/Discussion just because those section titles are absent. If tables/figures/analysis appear elsewhere, do not flag "missing results/discussion".\nReturn critique items with weakness, rebuttal_potential, severity, a short excerpt copied verbatim from the text, and a line number.`;
  return { system, user };
}

export async function runCritical({
  abstract,
  results,
  discussion,
  fullText,
  paperType,
  expectations,
  priorIssues,
  chunkTitle,
  logger
}) {
  const { system, user } = buildCriticalPrompt({
    abstract,
    results,
    discussion,
    fullText,
    paperType,
    expectations,
    priorIssues,
    chunkTitle
  });
  return runJsonChat({
    system,
    user,
    schema: CRITICAL_SCHEMA,
    schemaName: "Critical",
    logger
  });
}

export {
  STRUCTURAL_SCHEMA,
  NOTATION_SCHEMA,
  RHETORIC_SCHEMA,
  CRITICAL_SCHEMA,
  SCIENCE_SCHEMA,
  RESOLVE_SCHEMA
};

export function buildMathPrompt({ artifact, context, paperType, expectations }) {
  const system =
    "You are a Math Proof Reviewer. Verify whether the proof for the given artifact is complete and logically sound. Output ONLY JSON.";
  const user = `Paper type: ${paperType}\nExpectations: ${expectations}\n\nArtifact type: ${artifact.type}\nStatement:\n${artifact.statement}\n\nContext (around statement + proof if present):\n${context}\n\nReturn JSON with fields: artifact_type, verdict (complete|incomplete|missing|unclear), issues (array), recommendation.`;
  return { system, user };
}

export async function runMathProof({
  artifact,
  context,
  paperType,
  expectations,
  logger
}) {
  const { system, user } = buildMathPrompt({
    artifact,
    context,
    paperType,
    expectations
  });
  const schema = z.object({
    artifact_type: z.string(),
    verdict: z.enum(["complete", "incomplete", "missing", "unclear"]),
    issues: z.array(z.string()),
    recommendation: z.string()
  });
  return runJsonChat({
    system,
    user,
    schema,
    schemaName: "Math",
    logger
  });
}

export function buildSciencePrompt({
  abstract,
  methods,
  experiments,
  datasets,
  results,
  fullText,
  paperType,
  expectations,
  priorIssues,
  chunkTitle,
  evidenceSummary
}) {
  const system =
    "You are the Experimental Science Agent for Machine Learning papers. Focus on empirical rigor, experimental design, and evidence. Output ONLY JSON.";
  const prior = priorIssues?.length
    ? `\n\nPrior issues (avoid duplicates, maintain consistency):\n- ${priorIssues.join("\n- ")}`
    : "";
  const title = chunkTitle ? `\n\nSection focus: ${chunkTitle}` : "";
  const evidence = evidenceSummary ? `\n\nGlobal evidence summary:\n${evidenceSummary}` : "";
  const user = `Paper type: ${paperType}\nExpectations: ${expectations}${title}\n\nAbstract:\n${abstract}\n\nMethods:\n${methods}\n\nExperiments/Evaluation:\n${experiments}\n\nDatasets:\n${datasets}\n\nResults:\n${results}\n\nFull paper (core text):\n${fullText}${prior}${evidence}\n\nIdentify issues in experimental design, data, baselines, metrics, ablations, reproducibility, analysis, and claims-vs-evidence. For each issue, include: category, severity, message, evidence (quote/summary), recommendation, excerpt copied verbatim from the text, and a line number.`;
  return { system, user };
}

export function buildResolvePrompt({
  issues,
  sectionTitles,
  paperType,
  expectations,
  agent,
  evidenceSummary,
  sectionEvidence
}) {
  const system = `You are a critical editor reconciling ${agent} findings across the full paper.\nDecide which issues remain valid after later sections are considered.\nOutput ONLY JSON.`;
  const evidence = evidenceSummary ? `\n\nGlobal evidence summary:\n${evidenceSummary}` : "";
  const sectionSignals = sectionEvidence?.length
    ? `\n\nSection evidence flags:\n${sectionEvidence
        .map((s, i) => `${i + 1}. ${s.title} — ${s.flags.join(", ") || "none"}`)
        .join("\n")}`
    : "";
  const user = `Paper type: ${paperType}\nExpectations: ${expectations}\n\nSection titles (in order):\n${sectionTitles
    .map((t, i) => `${i + 1}. ${t}`)
    .join("\n")}${evidence}${sectionSignals}\n\nIssues (id | section | text | excerpt):\n${issues
    .map(
      (i) =>
        `${i.id} | ${i.sectionIndex + 1} | ${i.text}${i.excerpt ? ` | ${i.excerpt}` : ""}`
    )
    .join("\n")}\n\nKeep only issues that are still valid after considering later sections. If a later section likely addresses or resolves an issue, drop it. Return keep_ids.`;
  return { system, user };
}

export async function runResolveIssues({
  issues,
  sectionTitles,
  paperType,
  expectations,
  agent,
  logger
}) {
  const { system, user } = buildResolvePrompt({
    issues,
    sectionTitles,
    paperType,
    expectations,
    agent
  });
  return runJsonChat({
    system,
    user,
    schema: RESOLVE_SCHEMA,
    schemaName: "ResolveIssues",
    logger
  });
}

export async function runScience({
  abstract,
  methods,
  experiments,
  datasets,
  results,
  fullText,
  paperType,
  expectations,
  priorIssues,
  chunkTitle,
  logger
}) {
  const { system, user } = buildSciencePrompt({
    abstract,
    methods,
    experiments,
    datasets,
    results,
    fullText,
    paperType,
    expectations,
    priorIssues,
    chunkTitle
  });
  return runJsonChat({
    system,
    user,
    schema: SCIENCE_SCHEMA,
    schemaName: "Science",
    logger
  });
}
