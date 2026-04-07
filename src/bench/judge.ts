import { spawnSync } from "child_process";
import { writeFileSync } from "fs";
import type { QualityTask } from "./quality-tasks.js";
import type { CorrectnessScore } from "./metrics.js";
import { parseResult } from "./metrics.js";

/**
 * Build the blinded judge prompt. Must NOT reveal which arm produced the answer.
 */
export function buildJudgePrompt(task: QualityTask, answer: string): string {
  const mustContain = task.rubric.mustContain.map((f) => `- ${f}`).join("\n");
  const redFlags = task.rubric.mustNotHallucinate.length > 0
    ? task.rubric.mustNotHallucinate.map((f) => `- ${f}`).join("\n")
    : "(none)";

  return `You are grading an AI assistant's answer to a question about a codebase.

QUESTION:
${task.prompt}

ANSWER KEY (facts a correct answer must contain):
${mustContain}

RED FLAGS (answer must NOT contain any of these):
${redFlags}

ANSWER GIVEN:
${answer}

Score each dimension 1-5 (1 = poor, 5 = excellent):
- coverage:    fraction of answer-key facts the answer hits
- accuracy:    fraction of claims in the answer that are factually correct
- specificity: cites real file paths / function names where relevant
- overall:     single 1-5 verdict weighing the three

Return strict JSON only, no prose:
{"coverage": N, "accuracy": N, "specificity": N, "overall": N, "justification": "one sentence"}`;
}

/**
 * Parse the judge's raw reply into a CorrectnessScore. Returns null on any
 * malformation — the caller decides whether to retry.
 */
export function parseJudgeResponse(raw: string): CorrectnessScore | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;

  const requiredNumFields = ["coverage", "accuracy", "specificity", "overall"] as const;
  for (const k of requiredNumFields) {
    const v = p[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 5) return null;
  }
  if (typeof p.justification !== "string") return null;

  return {
    coverage: p.coverage as number,
    accuracy: p.accuracy as number,
    specificity: p.specificity as number,
    overall: p.overall as number,
    justification: p.justification,
  };
}

/**
 * Invoke `claude -p` with the judge prompt and parse the reply.
 * Retries once on parse failure with an explicit "JSON only" hint.
 * Returns null if both attempts fail.
 */
export function runJudge(
  claudePath: string,
  cwd: string,
  task: QualityTask,
  answer: string,
  timeoutMs = 60_000,
): CorrectnessScore | null {
  const prompt = buildJudgePrompt(task, answer);
  const first = invokeClaudeJson(claudePath, cwd, prompt, timeoutMs);
  if (first !== null) {
    const parsed1 = parseJudgeResponse(first);
    if (parsed1) return parsed1;
  }

  const retryPrompt =
    "Your previous response was not valid JSON. Return ONLY the JSON object, no prose, no code fences.\n\n" +
    prompt;
  const second = invokeClaudeJson(claudePath, cwd, retryPrompt, timeoutMs);
  if (second === null) return null;
  return parseJudgeResponse(second);
}

function invokeClaudeJson(claudePath: string, cwd: string, prompt: string, timeoutMs: number): string | null {
  const isWindows = process.platform === "win32";
  const result = spawnSync(
    claudePath,
    ["-p", prompt, "--output-format", "json", "--max-turns", "1"],
    { cwd, stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, encoding: "utf-8", shell: isWindows },
  );
  if (result.status !== 0) return null;
  const stdout = result.stdout?.trim() || "";
  if (!stdout) return null;
  try {
    const parsed = JSON.parse(stdout);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).result === "string"
    ) {
      return (parsed as Record<string, unknown>).result as string;
    }
  } catch { /* fall through */ }
  return stdout;
}

/**
 * Judge a single transcript file. Extracts the final answer, runs the judge,
 * writes a .judge.json file next to the transcript.
 * Returns the score or null if unscored.
 */
export function judgeTranscript(
  claudePath: string,
  cwd: string,
  task: QualityTask,
  transcriptPath: string,
): CorrectnessScore | null {
  const metrics = parseResult(transcriptPath);
  if (!metrics.finalAnswer) {
    writeFileSync(
      transcriptPath + ".judge.json",
      JSON.stringify({ unscored: true, reason: "empty answer" }),
    );
    return null;
  }
  const score = runJudge(claudePath, cwd, task, metrics.finalAnswer);
  if (!score) {
    writeFileSync(
      transcriptPath + ".judge.json",
      JSON.stringify({ unscored: true, reason: "judge parse failure" }),
    );
    return null;
  }
  writeFileSync(transcriptPath + ".judge.json", JSON.stringify(score, null, 2));
  return score;
}
