/**
 * @perfgym/core
 * Universal Gym Engine & Hill-Climbing Coordinator
 */

export interface MetricResult {
  name: string;
  value: number;
  unit: "instructions" | "bytes" | "ms" | "count";
  improved: boolean;
  deltaPercent: number;
}

export interface InvariantResult {
  passed: boolean;
  output: string;
  durationMs: number;
}

export interface LintViolation {
  ruleId: string;
  message: string;
  file: string;
  line: number;
  severity: "error" | "warning";
  penalty: number;
}

export interface StepEvaluation {
  iteration: number;
  invariants: InvariantResult;
  violations: LintViolation[];
  metrics: MetricResult[];
  fitnessScore: number;
  accepted: boolean;
  revertReason?: string;
}

export interface PerfGymConfig {
  version: string;
  target: {
    name: string;
    language: "typescript" | "javascript" | "python" | "go" | "kotlin" | "rust";
    files: string[];
  };
  invariants: {
    command: string;
    timeoutMs?: number;
  };
  rules?: Array<{
    id: string;
    message: string;
    severity: "error" | "warning";
    penalty: number;
    pattern: string;
  }>;
  metrics: Array<{
    name: string;
    command: string;
    goal: "minimize" | "maximize";
    weight: number;
  }>;
}

/**
 * Calculates continuous fitness score:
 * Score = sum(weight * delta_pct) - sum(linter_penalties)
 */
export function calculateFitnessScore(
  metrics: MetricResult[],
  violations: LintViolation[],
  weights: Record<string, number> = {}
): number {
  let perfScore = 0;
  for (const m of metrics) {
    const w = weights[m.name] ?? 1.0;
    perfScore += m.deltaPercent * w;
  }

  const penaltyScore = violations.reduce((acc, v) => acc + v.penalty, 0);
  return perfScore - penaltyScore;
}
