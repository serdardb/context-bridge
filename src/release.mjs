import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runEvaluation } from "./eval.mjs";
import { verifyChangelogProvenance } from "./release-provenance.mjs";

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function check(name, passed, detail) {
  return { name, passed: Boolean(passed), detail };
}

/** Release provenance checks. This is intentionally separate from runtime Git use. */
export function releaseChecks(root, { verifyCI = false } = {}) {
  const pkg = readJson(root, "package.json");
  const plugin = readJson(root, "plugin/.claude-plugin/plugin.json");
  const marketplace = readJson(root, ".claude-plugin/marketplace.json");
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  let packageFiles = null;
  try {
    const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 120000, killSignal: "SIGKILL",
    });
    packageFiles = JSON.parse(raw)[0]?.files?.map((entry) => entry.path) ?? [];
  } catch {
    packageFiles = null;
  }
  const requiredPackagePaths = ["bin/bridge.mjs", "src/cli.mjs", "src/storage.mjs", "plugin/hooks/hooks.json", "codex/SKILL.md", "docs/ARCHITECTURE.md"];
  const privatePackageFiles = packageFiles?.filter((file) =>
    file.split("/").some((part) => [".bridge", "notes", "test", "tests"].includes(part) || /^\.env(?:\.|$)/.test(part)) ||
    /(?:\.cbctx|\.cbsealed|\.log)$/.test(file) || /(?:^|\/)key\.bin$/.test(file) ||
    /(?:^|\/)state\.json(?:\.|$)/.test(file));
  const evaluation = runEvaluation();
  const checks = [
    check("manifest-versions", plugin.version === pkg.version && marketplace.metadata?.version === pkg.version, `package ${pkg.version}, plugin ${plugin.version}, marketplace ${marketplace.metadata?.version}`),
    check("changelog-first-version", changelog.match(/^## \[([^\]]+)\]/m)?.[1] === pkg.version, `first heading must be ${pkg.version}`),
    check("previous-tag", Boolean(git(root, ["describe", "--tags", "--abbrev=0"])), "a previous release tag is required for provenance"),
    verifyChangelogProvenance(root),
    check("working-tree", git(root, ["status", "--porcelain"]) === "", "release tree must be clean"),
    check("package-files", packageFiles && requiredPackagePaths.every((entry) => packageFiles.includes(entry)), packageFiles ? `${packageFiles.length} package files include required runtime and docs` : "npm pack --dry-run could not be verified"),
    check("package-private-files", privatePackageFiles && privatePackageFiles.length === 0,
      privatePackageFiles?.length ? `Private/test artifacts in tarball: ${privatePackageFiles.join(", ")}` : "No local state, notes, tests, env files, logs, portable context artifacts or generated sealing keys may be packed"),
    check("context-quality", evaluation.passed, `${evaluation.total} deterministic evaluations passed`),
    check("ci-workflow", fs.existsSync(path.join(root, ".github", "workflows", "ci.yml")), "CI workflow configuration is present; this is not run evidence"),
    verifyCI ? verifyReleaseCI(root) : check("ci-head", false, "HEAD CI has not been verified. Use release-check --ci (requires GitHub CLI authentication)."),
  ];
  return { passed: checks.every((item) => item.passed), version: pkg.version, checks };
}

/** Read-only verification of the latest CI run for this exact commit. */
export function verifyReleaseCI(root, { run = execFileSync } = {}) {
  const head = git(root, ["rev-parse", "HEAD"]);
  if (!head) return check("ci-head", false, "Cannot resolve HEAD for CI verification.");
  const options = { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000, killSignal: "SIGKILL" };
  try {
    const runs = JSON.parse(run("gh", ["run", "list", "--workflow", "ci.yml", "--commit", head,
      "--limit", "100", "--json", "databaseId,headSha,createdAt,attempt"], options));
    if (!Array.isArray(runs)) throw new Error("invalid workflow run response");
    const latest = runs.filter((item) => item.headSha === head)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.databaseId - a.databaseId)[0];
    if (!latest || !Number.isSafeInteger(latest.databaseId) || !Number.isSafeInteger(latest.attempt) || latest.attempt < 1) {
      return check("ci-head", false, `No verifiable CI run for HEAD ${head}.`);
    }
    const result = JSON.parse(run("gh", ["run", "view", String(latest.databaseId), "--attempt", String(latest.attempt),
      "--json", "databaseId,attempt,headSha,status,conclusion,jobs,url"], options));
    const passed = result.databaseId === latest.databaseId && result.attempt === latest.attempt && result.headSha === head &&
      result.status === "completed" && result.conclusion === "success" && Array.isArray(result.jobs) && result.jobs.length > 0 &&
      result.jobs.every((job) => job.status === "completed" && job.conclusion === "success");
    return check("ci-head", passed, `${head}: ${result.status}/${result.conclusion}, ${result.jobs?.length ?? 0} jobs; ${result.url ?? "no run URL"}`);
  } catch (error) {
    return check("ci-head", false, `CI verification unavailable (${error.code ?? error.name}); no success assumed.`);
  }
}

function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000, killSignal: "SIGKILL",
    }).trim();
  } catch {
    return null;
  }
}
