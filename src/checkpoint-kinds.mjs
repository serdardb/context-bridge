// Shared by state, retention and migration without a state/storage import cycle.
export const CHECKPOINT_KINDS = {
  delta: ".md",
  fullContext: "-full.md",
  audit: "-audit.json",
};

export const CONSUMED_SUFFIX = ".consumed";

/** Evidence writers accept a single filename, never a relative path. */
export function assertCheckpointName(name) {
  if (typeof name !== "string" || !name || name === "." || name === ".." || /[/\\\0]/.test(name)) {
    throw new Error("Invalid checkpoint filename: expected one nonempty filename without path separators.");
  }
}
