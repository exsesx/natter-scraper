import { availableParallelism, totalmem } from "node:os";

/** Conservative CPU/RAM heuristic; resource counts do not establish optimal throughput. */
export function defaultConcurrency(
  resources: { cpus: number; memoryBytes: number } = {
    cpus: availableParallelism(),
    memoryBytes: totalmem(),
  },
): number {
  const { cpus, memoryBytes } = resources;

  if (
    !Number.isFinite(cpus) ||
    cpus <= 0 ||
    !Number.isFinite(memoryBytes) ||
    memoryBytes <= 0
  )
    return 1;

  return Math.max(
    1,
    Math.min(6, Math.floor(cpus), Math.floor(memoryBytes / (2 * 1024 ** 3))),
  );
}
