import { spawn } from "node:child_process";
import type { DriverOptions, LlmDriver, LlmRequest, LlmResult } from "./driver.js";
import { MutationSchema } from "./schema.js";

export const DEFAULT_CLI_COMMAND = "opencode";
export const DEFAULT_CLI_ARGS = ["run"];
export const DEFAULT_CLI_TIMEOUT_MS = 120_000;

export class CliAgentSubprocessDriver implements LlmDriver {
  public readonly name = "cli";
  private readonly command: string;
  private readonly args: string[];
  private readonly timeoutMs: number;

  constructor(options: DriverOptions = {}) {
    this.command = options.cliCommand || DEFAULT_CLI_COMMAND;
    this.args = options.cliArgs || DEFAULT_CLI_ARGS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  }

  public async complete(request: LlmRequest): Promise<LlmResult> {
    const timeout = request.timeoutMs ?? this.timeoutMs;
    return this.executeWithRetry(request.prompt, timeout, 0);
  }

  private async executeWithRetry(
    prompt: string,
    timeoutMs: number,
    retryCount: number,
    parseErrorFeedback?: string
  ): Promise<LlmResult> {
    const effectivePrompt = parseErrorFeedback
      ? `${prompt}\n\n[NOTICE: Your previous output failed schema validation: ${parseErrorFeedback}. Fix the errors and return ONLY a valid JSON object matching the schema.]`
      : prompt;

    const runResult = await this.runProcess(effectivePrompt, timeoutMs);

    if (runResult.timedOut) {
      return {
        mutations: [],
        error: `CLI process timed out after ${timeoutMs}ms and was killed`,
        skipped: true,
      };
    }

    if (runResult.exitCode !== 0) {
      const errOut = (runResult.stderr || runResult.stdout).trim();
      return {
        mutations: [],
        error: `CLI process exited with non-zero code ${runResult.exitCode}: ${errOut}`,
        skipped: true,
      };
    }

    // Try extracting balanced JSON objects and validate against schema
    const candidates = this.extractBalancedJsonObjects(runResult.stdout);
    if (candidates.length === 0) {
      if (retryCount === 0) {
        return this.executeWithRetry(
          prompt,
          timeoutMs,
          retryCount + 1,
          "No balanced JSON object found in output"
        );
      }
      return {
        mutations: [],
        error: "Failed to extract balanced JSON object from CLI output after retry",
        skipped: true,
      };
    }

    let lastError = "";
    for (const candidate of candidates) {
      try {
        const parsedJson = JSON.parse(candidate);
        const validated = MutationSchema.parse(parsedJson);
        return {
          mutations: validated.mutations,
          rawText: runResult.stdout,
        };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    if (retryCount === 0) {
      return this.executeWithRetry(
        prompt,
        timeoutMs,
        retryCount + 1,
        lastError || "Invalid schema"
      );
    }
    return {
      mutations: [],
      error: `Schema validation failed after retry: ${lastError}`,
      skipped: true,
    };
  }

  /**
   * Spawns the CLI child process, writes prompt to stdin, and enforces timeout.
   * Kills whole process tree on timeout.
   */
  private runProcess(
    prompt: string,
    timeoutMs: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
    return new Promise((resolve) => {
      const isWindows = process.platform === "win32";
      const child = spawn(this.command, this.args, {
        detached: !isWindows, // On POSIX, detach to create new process group
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode, timedOut });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        this.killProcessTree(child.pid, isWindows);
        finish(null);
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (err) => {
        stderr += err.message;
        finish(1);
      });

      child.on("close", (code) => {
        finish(code);
      });

      // Attach error listener to avoid crashing on EPIPE if process exits prematurely
      child.stdin.on("error", () => {});
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  private killProcessTree(pid: number | undefined, isWindows: boolean): void {
    if (!pid) return;
    try {
      if (isWindows) {
        spawn("taskkill", ["/pid", pid.toString(), "/T", "/F"], { stdio: "ignore" });
      } else {
        // POSIX: kill process group
        process.kill(-pid, "SIGKILL");
      }
    } catch {
      // Process might have already exited
    }
  }

  /**
   * Scans stdout for balanced `{...}` JSON blocks.
   */
  public extractBalancedJsonObjects(text: string): string[] {
    const results: string[] = [];
    let i = 0;

    while (i < text.length) {
      const start = text.indexOf("{", i);
      if (start === -1) break;

      let depth = 0;
      let inString = false;
      let escape = false;
      let matchedEnd = -1;

      for (let j = start; j < text.length; j++) {
        const char = text[j];

        if (escape) {
          escape = false;
          continue;
        }

        if (char === "\\") {
          escape = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (char === "{") {
            depth++;
          } else if (char === "}") {
            depth--;
            if (depth === 0) {
              matchedEnd = j;
              break;
            }
          }
        }
      }

      if (matchedEnd !== -1) {
        results.push(text.substring(start, matchedEnd + 1));
        i = matchedEnd + 1;
      } else {
        // Unbalanced brace, advance past start
        i = start + 1;
      }
    }

    return results;
  }

  public extractBalancedJsonObject(text: string): string | null {
    const all = this.extractBalancedJsonObjects(text);
    return all.length > 0 ? all[0] : null;
  }
}
