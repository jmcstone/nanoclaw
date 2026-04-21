/**
 * Per-group context-mode mount defaults.
 *
 * Used by scripts/group-config.ts `context-mode-defaults <folder>`. Apply is
 * idempotent — running it twice with the same folder yields the same
 * container_config JSON. Existing non-context-mode mounts are preserved.
 *
 * Source of truth for the layout:
 *   lode/plans/active/2026-04-context-mode-integration/tracker.md
 *   lode/infrastructure/persistence.md
 *
 * Context-mode needs one per-group host directory bind-mounted into
 * Madison's container at /workspace/extra/context-mode/. The agent-runner
 * uses fs.existsSync('/workspace/extra/context-mode') as its opt-in sentinel
 * (mirrors a-mem's pattern).
 */

type JsonObj = { [k: string]: unknown };

interface MountEntry {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

const CONTEXT_MODE_CONTAINER_PATH = 'context-mode';

/**
 * Host path for a group's context-mode FTS5 DB directory. Mirrors the
 * a-mem per-group layout at ~/containers/data/NanoClaw/a-mem/<folder>/.
 */
export function getContextModeHostPath(folder: string): string {
  return `~/containers/data/NanoClaw/context-mode/${folder}`;
}

export function getContextModeMount(folder: string): MountEntry {
  return {
    hostPath: getContextModeHostPath(folder),
    containerPath: CONTEXT_MODE_CONTAINER_PATH,
    readonly: false,
  };
}

/**
 * Return a new container_config object with a context-mode mount entry in
 * additionalMounts, idempotently. If an entry with containerPath
 * "context-mode" already exists, it is replaced; otherwise appended.
 * Does not mutate input.
 */
export function applyContextModeMount(existing: JsonObj, folder: string): JsonObj {
  const next: JsonObj = { ...existing };
  const currentMounts = Array.isArray(existing.additionalMounts)
    ? (existing.additionalMounts as MountEntry[])
    : [];
  const filtered = currentMounts.filter(
    (m) => m.containerPath !== CONTEXT_MODE_CONTAINER_PATH,
  );
  next.additionalMounts = [...filtered, getContextModeMount(folder)];
  return next;
}
