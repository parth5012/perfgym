export interface ComponentBudget {
  name: string;
  selector: string;
  metric: "render_duration_ms" | "wasted_renders" | "phase_count";
  threshold: number;
}

export interface ComponentMetric {
  name: string;
  renderDurationMs: number;
  phase: "mount" | "update";
  wastedRenders: number;
}

export interface ComponentEvaluation {
  name: string;
  passed: boolean;
  value: number;
  threshold: number;
  penalty: number;
}

export function evaluateComponentBudget(
  metric: ComponentMetric,
  budget: ComponentBudget,
): ComponentEvaluation {
  const value =
    budget.metric === "render_duration_ms"
      ? metric.renderDurationMs
      : budget.metric === "wasted_renders"
        ? metric.wastedRenders
        : 1;
  const passed = value <= budget.threshold;
  return { name: budget.name, passed, value, threshold: budget.threshold, penalty: passed ? 0 : 10 };
}