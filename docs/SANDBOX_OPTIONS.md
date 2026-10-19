# 🛡️ Sandbox Isolation Options Beyond Docker

Research record for OS-level isolation alternatives to Docker for PerfGym command execution. Complements the **file-mutation sandbox** (ADR-003 / ADR-013 / ADR-014) — this document covers **command/process isolation**, which the current sandbox does not provide.

* **Date**: Fri Oct 16 2026
* **Scope**: grader command execution (Map 3), agent-proposed shell commands (Map 4 MCP / autonomous loop)
* **Constraint**: no Docker daemon dependency (Windows dev machines, CI on GitHub Actions Linux runners)

---

## 1. Current State & Gap

PerfGym's sandbox is **application-level**, not an OS sandbox:

| Layer | Mechanism | Protects against |
|---|---|---|
| Git worktree isolation | throwaway worktree per session | damage to the base tree |
| Glob whitelist + `lstat`/`realpath` checks | `git-worktree-driver.ts` | path traversal, symlink/junction escape |
| Blast-radius scan | `verifyBlastRadius()` gates commit/accept | out-of-scope file mutation |
| Atomic mkdir lock | `coordinator.ts` (runId + pid heartbeat) | concurrent-session corruption |

**Gap**: all of these constrain *file writes*. Commands executed by the fitness pipeline or the autonomous loop (`npm test`, agent-authored scripts) still run with the **full privileges of the user account** — no process, filesystem, or network containment. That requires an OS-level sandbox behind a command-execution seam.

---

## 2. Options Matrix

| # | Option | Isolation level | Windows | Linux / CI | Daemon/VM needed | Maturity |
|---|---|---|---|---|---|---|
| 1 | **MXC** (Windows native process container) | OS process container (`BaseContainer` / `InHostContainer` tiers, `wxc-exec` launcher) | ✅ native (Win11 26300+ / Server 2025) | ❌ | none | new; probe pending |
| 2 | **Node `--permission` model** | per-process capability restriction (`--permission-fs`, `--allow-child-process`, `--allow-worker`) | ✅ | ✅ | none | stable (Node 22.13+ / 23.5+) |
| 3 | **WSL2 + Landlock / bubblewrap (`bwrap`)** | Linux namespaces + seccomp | ⚠️ via WSL2 | ✅ | none | battle-tested |
| 4 | **Windows Sandbox (`.wsb`)** | ephemeral throwaway VM | ✅ (Pro/Enterprise) | ❌ | VM per session | stable, heavyweight |
| 5 | **nsjail / minijail** | Linux namespace jail, fine-grained policy | ❌ | ✅ | none | stable, config-heavy |
| 6 | **gVisor (`runsc`)** | application kernel (syscall interception) | ❌ | ✅ | OCI runtime to launch | mature on Linux |
| 7 | **Cloud microVMs** (E2B, Vercel Sandboxes, Daytona, Modal) | full microVM + snapshot/restore | via API | via API | network + cost | production-grade hosted |
| 8 | **Node wrappers** (`@cdxgen/safer-exec`, `kern`, `@anthropic-ai/sandbox-runtime`) | whatever backend the wrapper picks | backend-dependent | backend-dependent | varies | 3rd-party; fastest integration |

### Notes per option

1. **MXC** — closest to "Docker without Docker" on Windows: OS-enforced process container, no VM boot, no daemon. Two containment tiers (`BaseContainer` stricter than `InHostContainer`). Launch via `wxc-exec`. Newest option; Windows-only.
2. **Node `--permission`** — *not* a container, but a stable, dependency-free capability model: a child Node process can be denied fs writes outside allow-listed paths and denied `child_process`/worker spawning. Resists accidental misuse well; weaker against a determined escape. Baseline tier that works everywhere today.
3. **bubblewrap/Landlock on WSL2 or CI** — the standard Linux sandbox (used by Flatpak, Chrome tooling, most Linux sandboxers): namespace + seccomp confinement, near-zero overhead. Requires a Linux environment (WSL2 distro or the Actions runner).
4. **Windows Sandbox** — strongest practical local Windows isolation (disposable VM), but pays a VM boot per session and needs file mapping for the workspace. Fits one-shot heavyweight runs, not per-command invocation.
5. **nsjail** — nsjail-style config gives per-syscall control; config mistakes fail open-ish (policy complexity is the risk). Linux-only.
6. **gVisor** — excellent syscall filtering but normally launched through a container runtime, which reintroduces the Docker/OCI dependency PerfGym wants to avoid.
7. **Cloud microVMs** — right answer for *hosted* autonomous runs (snapshot, fork, kill at will); wrong answer for local dev (network latency, cost, secrets crossing the boundary).
8. **Wrappers** — `@anthropic-ai/sandbox-runtime` (ASR), `kern`, `@cdxgen/safer-exec` bundle backend selection (WSL, bwrap, MXC, cloud) behind one API. Fastest path, but adds a third-party trust surface to a security component — evaluate before adopting.

---

## 3. Machine / Environment Probe

| Environment | Finding | Implication |
|---|---|---|
| Dev machine | Windows 11 Pro **10.0.26300.9711** | meets MXC build threshold (26300+); **availability probe still pending** (`wxc-exec` not installed) |
| WSL2 | installed; default distro `docker-desktop` (stopped) | bubblewrap/Landlock path available after installing a general-purpose distro with `util-linux` |
| CI | GitHub Actions **Linux** runners | `bwrap`/Landlock available; the runner VM itself is already a disposable sandbox |
| Node | repo toolchain | `--permission` baseline available if runtime ≥ 22.13 (verify `.nvmrc`/engines at spike time) |

---

## 4. Recommendation (proposed ADR-021: `CommandExecutor` seam)

Mirror ADR-003's proven pattern: **seam + injected backends**, so isolation strategy is swappable and testable.

```ts
interface CommandExecutor {
  run(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult>;
}
```

Tiered adoption:

| Tier | Backend | Platform | Role |
|---|---|---|---|
| 0 | `NodePermissionExecutor` (`node --permission`) | all | dependency-free baseline; deny fs writes + child process outside policy |
| 1 | `MxcExecutor` (`wxc-exec`) | Windows 26300+ | real OS process container on dev machines — **spike pending probe** |
| 1 | `BwrapExecutor` (`bwrap`) | Linux / CI | namespace+seccomp equivalent on runners and WSL2 |
| 2 | `CloudMicroVmExecutor` (E2B etc.) | hosted | optional later map for hosted autonomous runs |
| — | `none` | — | explicit opt-out; must log a loud warning (parity with file-sandbox escape hatch) |

Config surface: `perfgym.config → sandbox.commandBackend: "node-permission" | "mxc" | "bwrap" | "none"`.

**Integration points** (file sandbox stays unchanged; the executor complements it):

* Map 3 — fitness pipeline runs every grader command through `CommandExecutor`.
* Map 4 — MCP server / autonomous loop gates agent-proposed shell commands through the same seam.
* Tests — in-memory executor adapter for unit tests (parity with `InMemoryWorkspaceDriver`).

---

## 5. Next Steps

1. **Probe MXC** on the dev machine (`wxc-exec` availability + `BaseContainer` support).
2. **Spike `MxcExecutor`** behind the seam (Windows) and a `BwrapExecutor` (Linux CI).
3. **Record ADR-021** with probe results and backend choice per platform.
4. **Ticket** the `CommandExecutor` seam + Tier 0 backend into the next applicable map (Map 3 pipeline or Map 4 loop).
