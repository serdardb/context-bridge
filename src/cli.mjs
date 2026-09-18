import { runLoop } from "./launcher.mjs";
import { runDoctor, runVerify } from "./doctor.mjs";
import { runHook } from "./hooks.mjs";
import { handoff } from "./handoff.mjs";
import {
  loadState,
  ensureState,
  mutateProject,
  mutateState,
  createLane,
  emptyLane,
  switchActiveLane,
  removeLaneFromState,
  removeLane,
  unlinkAgent,
  laneSummaries,
  laneHasLiveLauncher,
  isValidLaneName,
  bridgeDir,
  DEFAULT_LANE,
} from "./state.mjs";
import { pruneCheckpoints, DEFAULT_KEEP_GROUPS, DEFAULT_MAX_AGE_DAYS } from "./clean.mjs";
import { prepareSeed, writeSeed } from "./seed.mjs";
import { runEvaluation } from "./eval.mjs";
import { runLiveEvaluation } from "./live-eval.mjs";
import { releaseChecks } from "./release.mjs";
import { prepareReleaseEvidence, verifyReleaseEvidence } from "./release-evidence.mjs";
import { exportArtifact, importArtifact, cacheArtifact } from "./artifact.mjs";
import { sealArtifact, openSealedArtifact } from "./sealed-artifact.mjs";
import { sendArtifact, fetchArtifact, removeRemoteArtifact, startArtifactServer } from "./remote-artifact.mjs";
import { searchProject } from "./search.mjs";
import { projectStatus, switchHistory } from "./status.mjs";
import { inspectRegisteredProject } from "./project-inspect.mjs";
import { projectLifecycle, purgeProject } from "./project-lifecycle.mjs";
import { ADAPTER_API_VERSION, adapterDescriptor } from "./adapter-contract.mjs";
import { createWorktreeLane } from "./worktree.mjs";
import { planLegacyMigration, migrateLegacyStorage, registeredProjects, adoptProject, cleanupLegacyIgnore, recoverProjectOperations } from "./storage.mjs";
import { splitLauncherArgs, argumentSummary } from "./agentargs.mjs";
import { loadConfig, savedArgs, isDangerous } from "./config.mjs";
import { AGENT_IDS, adapterFor } from "./agents/index.mjs";
import { log, bold, dim, OK, BAD, NONE, WARN, BridgeError } from "./util.mjs";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

// Read from the manifest rather than repeating it. This was a hardcoded string,
// and a release bumped package.json while `bridge --version` kept answering the
// previous version to everyone who installed it. Two sources of one truth drift
// the moment somebody remembers only one of them, which is every time.
const VERSION = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")
).version;

// Wide enough for the longest command label there actually is. This was a fixed
// 16, which fitted every agent until one was called antigravity and its
// description ran into its name. A fifth agent would have found it again.
const LABEL_WIDTH = Math.max(
  ...AGENT_IDS.map((a) => a.length + " [flags]".length),
  "doctor [--fix]".length,
  "verify [--all] [--json]".length,
  "eval --live codex [--json]".length,
  "release-check [--json]".length,
  "artifact export <file>".length,
  "artifact import <file>".length,
  "artifact cache <file>".length,
  "search <text>".length,
  "storage plan [--json]".length,
  "project adopt <id>".length,
  "status [--json]".length,
  "lane attach <name> --worktree <path>".length,
  "handoff <agent> [flags]".length,
  "internal-hook <event>".length
) + 2;
/** Column the descriptions start in: "  " + "bridge " + the widest label. */
const COL = 2 + "bridge ".length + LABEL_WIDTH;
const cmd = (label) => `  ${`bridge ${label}`.padEnd(COL - 2)}`;
const cont = " ".repeat(COL);

export const HELP = `${bold("context-bridge")} ${VERSION} — Switch agents. Not context.

Usage:
${cmd("")}Start the bridged session loop (resumes where you left off)
${AGENT_IDS.map((a) => `${cmd(`${a} [flags]`)}Start the loop with ${adapterFor(a).displayName} ( flags go to it as-is )`).join("\n")}
${cmd("doctor [--fix]")}Check agents, auth, plugins and routes ( --fix bootstraps,
${cont}--deep asks each agent a real one-line question )
${cmd("verify [--all] [--json]")}Smoke-test installed agents; --all requires every supported agent
${cmd("eval [--json]")}Evaluate deterministic context-quality fixtures (no agent calls)
${cmd("eval --live codex [--json]")}Run opt-in synthetic live recall (provider usage applies)
${cont}--scenario decision tests final decisions, reasons and omitted context
${cont}--scenario summary measures an agent-written summary in a second fresh session
${cmd("release-check [--json]")}Check release gates; --ci verifies HEAD on GitHub
${cmd("release-prepare")}Run acceptance gates and record commit/package-bound evidence
${cmd("release-check --evidence")}Verify local acceptance without calling agents or GitHub
${cmd("artifact export <file>")}Export redacted context; --sign-key <pem> adds an Ed25519 signature
${cmd("artifact import <file>")}Verify; --verify-key <pem> requires trusted signing, --apply stages it
${cmd("artifact cache <file>")}Verify and store by content hash outside the project; accepts --verify-key
${cmd("artifact seal <file>")}Create a private encrypted bundle: --out <new-directory> [--verify-key <pem>]
${cmd("artifact open <file>")}Decrypt without importing: --key-file <key.bin> --out <new-file>
${cmd("share send <file>")}Preview sealed upload; --endpoint <origin> --apply sends with --token-file
${cmd("share fetch <hash>")}Download ciphertext only; --endpoint --token-file --out are required
${cmd("share remove <hash>")}Preview remote removal; --endpoint --token-file --apply removes
${cmd("share serve")}Run a loopback opaque store; --dir <private-directory> --token-file required
${cmd("search <text>")}Search local summaries, checkpoints and audits
${cmd("storage plan [--json]")}Preview legacy storage migration without changing files
${cmd("storage migrate")}Migrate legacy storage; --retirement-dir selects an external source-filesystem vault
${cmd("storage cleanup-ignore")}Preview obsolete .gitignore rules (--apply to remove, --json)
${cmd("project list")}List machine-local project identities ( --json supported )
${cmd("project adopt <id>")}Reconnect this moved directory to an existing project store
${cmd("project inspect <id>")}Inspect retained state by UUID, including missing projects (--json)
${cmd("project recover <id>")}Preview interrupted operation records (--apply to clear; --json)
${cmd("project retire <id>")}Preview archiving a quiescent project store (--apply; --json)
${cmd("project restore <id>")}Preview restoring its archived store (--apply; --json)
${cmd("project purge <id>")}Preview permanent archive removal (--apply --confirm <id>; --json)
${cmd("status [--json]")}Show project bridge status
${cmd("lane new <name> --worktree <path>")}Create an isolated Git worktree lane (optional)
${cmd("lane attach <name> --worktree <path>")}Connect an existing worktree without copying sessions
${cmd("adapters [--json]")}List registered adapters and their declared capabilities
${cmd("mcp [--allow-content]")}Serve read-only MCP over stdio for this project
${cmd("watch --policy read-only")}Stream status changes as JSON lines; no automatic actions
${cmd("handoff <agent> [flags]")}Prepare a handoff; --dry-run previews without changing state
${cmd("inspect")}Show what the last handoff's agents actually ran ( failures first;
${cont}--json for the raw manifest; --lane <name> for another lane )
${cmd("clean")}Prune old checkpoints (keeps newest ${DEFAULT_KEEP_GROUPS} handoffs and
${cont}everything younger than ${DEFAULT_MAX_AGE_DAYS} days; --dry-run, --keep N,
${cont}--days N, --all, --lane <name>; a pending injection is never deleted)
${cont}--staging cleans only abandoned evidence staging files; supports --dry-run
${cmd("lane")}List lines of work in this project ( lane new <name> starts a
${cont}separate one, --seed <lane> gives it another lane's decisions and git
${cont}state to start from, lane switch <name> moves the default, lane rm
${cont}<name> --yes deletes one; lanes share files, not sessions )
${cmd("unlink <agent>")}Forget one agent's session in the active lane, and every
${cont}watermark that named it, so the next switch links it fresh

Agent flags:
  bridge claude --dangerously-skip-permissions --model claude-fable-5
  Put the agent name first, then its flags. They are forwarded untouched and reused
  every time the bridge reopens it in this launcher run. Nothing is written to
  disk: the next 'bridge' starts from the agent's own defaults again.

  --cb-save-args         Keep the flags typed with this launch in the machine-local store
                         and use them every time this agent opens in this project
  --cb-clear-args        Forget them again
  --resume [lane]        Open a specific lane; with no name, pick one from a list
                         ( a bare 'bridge' resumes the lane you were last in )

Recovering a dead agent:
  If an agent hits a quota limit or crashes mid-switch, it cannot run the handoff
  itself and its work is left in its own session. From any healthy terminal:
    bridge handoff <target> --from <the-dead-agent>
  rebuilds the delta straight from that agent's transcript on disk.

Inside the agents:
  ${adapterFor("claude").displayName}:  /bridge <agent>   hand off to another agent
  ${AGENT_IDS.filter((a) => a !== "claude")
    .map((a) => adapterFor(a).displayName)
    .join(", ")}:  $bridge <agent>   hand off to another agent

Docs and write-ups: https://dogrubakar.com/projects/context-bridge
`;

const LAUNCHER_COMMANDS = AGENT_IDS;

export async function main(argv) {
  const args = argv.filter((a) => !a.startsWith("--"));
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const cmd = args[0];
  const projectDir = process.cwd();

  // --help and --version belong to the bridge only until an agent is named.
  // After `bridge claude` they are Claude's own flags, like every other flag.
  if (!LAUNCHER_COMMANDS.includes(cmd)) {
    if (flags.has("--version") || cmd === "version") {
      log(VERSION);
      return;
    }
    if (flags.has("--help") || cmd === "help") {
      log(HELP);
      return;
    }
  }

  if (AGENT_IDS.includes(cmd)) {
    process.exitCode = await launchAgent(projectDir, cmd, argv);
    return;
  }

  switch (cmd) {
    case "watch": {
      const parsed = parseArgs({ args: argv.slice(1), strict: true, allowPositionals: false,
        options: { policy: { type: "string" }, interval: { type: "string" }, project: { type: "string" } } });
      const { runWatch } = await import("./watch.mjs");
      await runWatch(parsed.values.project ? path.resolve(projectDir, parsed.values.project) : projectDir,
        { policy: parsed.values.policy, interval: parsed.values.interval === undefined ? 1000 : Number(parsed.values.interval) });
      return;
    }
    case "mcp": {
      const parsed = parseArgs({ args: argv.slice(1), strict: true, allowPositionals: false,
        options: { "allow-content": { type: "boolean", default: false }, project: { type: "string" } } });
      const { runMcp } = await import("./mcp.mjs");
      await runMcp(parsed.values.project ? path.resolve(projectDir, parsed.values.project) : projectDir,
        { allowContent: parsed.values["allow-content"] });
      return;
    }
    case "adapters": {
      const descriptors = AGENT_IDS.map((id) => adapterDescriptor(adapterFor(id)));
      if (flags.has("--json")) log(JSON.stringify({ apiVersion: ADAPTER_API_VERSION, adapters: descriptors }, null, 2));
      else for (const entry of descriptors) log(`${entry.id}: ${entry.displayName} (${entry.injection}, API ${entry.apiVersion})`);
      return;
    }
    case undefined:
      // Anything after the agent name is the agent's own flag, forwarded as-is.
      process.exitCode = await launchAgent(projectDir, null, argv);
      return;

    case "doctor":
      process.exitCode = await runDoctor(projectDir, {
        fix: flags.has("--fix"),
        json: flags.has("--json"),
        deep: flags.has("--deep"),
      });
      return;

    case "verify":
      process.exitCode = await runVerify(projectDir, { json: flags.has("--json"), all: flags.has("--all") });
      return;

    case "project": {
      let projectOptions;
      try {
        projectOptions = parseArgs({ args: argv.slice(1), allowPositionals: true, strict: true,
          options: { apply: { type: "boolean" }, confirm: { type: "string" }, json: { type: "boolean" } } });
      } catch (cause) {
        throw new BridgeError("Invalid project options. Use bridge --help; no project operation was performed.", { cause });
      }
      const action = projectOptions.positionals[0];
      const allowed = { list: ["json"], inspect: ["json"], adopt: ["json"],
        recover: ["apply", "json"], retire: ["apply", "json"], restore: ["apply", "json"],
        purge: ["apply", "confirm", "json"] };
      if (!Object.hasOwn(allowed, action ?? "") ||
          projectOptions.positionals.length !== (action === "list" ? 1 : 2) ||
          Object.keys(projectOptions.values).some(key => !allowed[action].includes(key))) {
        throw new BridgeError("Invalid project action or options. Use bridge --help; no project operation was performed.");
      }
      if (args[1] === "purge") {
        const parsed = parseArgs({ args: argv.slice(2), allowPositionals: true, strict: true,
          options: { apply: { type: "boolean" }, confirm: { type: "string" }, json: { type: "boolean" } } });
        if (parsed.positionals.length !== 1) throw new BridgeError("Usage: bridge project purge <id> [--apply --confirm <id>] [--json]");
        const report = purgeProject(parsed.positionals[0], parsed.values);
        if (parsed.values.json) log(JSON.stringify(report, null, 2));
        else {
          log(`${report.id}: ${report.lifecycle}; ${report.files} files, ${report.bytes} bytes${report.applied ? " removed" : " in archive"}.`);
          for (const blocker of report.blockers) log(`${WARN} ${blocker}`);
          if (!parsed.values.apply) log("Irreversible archive removal. Apply requires --apply --confirm followed by this UUID. Code, native sessions and external backups are not deleted.");
        }
        if (report.blockers.length) process.exitCode = 1;
      } else if (args[1] === "list" && args.length === 2) {
        const projects = registeredProjects();
        if (flags.has("--json")) log(JSON.stringify(projects, null, 2));
        else if (!projects.length) log("No registered bridge projects.");
        else for (const project of projects) log(`${project.id}  [${project.lifecycle}; ${project.availability}${project.errorCode ? `: ${project.errorCode}` : ""}]  ${project.root}`);
      } else if (["retire", "restore"].includes(args[1]) && args.length === 3) {
        const report = projectLifecycle(args[2], args[1], { apply: flags.has("--apply") });
        if (flags.has("--json")) log(JSON.stringify(report, null, 2));
        else {
          log(`${report.id}: ${report.lifecycle}${report.applied ? " (applied)" : " (unchanged)"}.`);
          for (const blocker of report.blockers) log(`${WARN} ${blocker}`);
          if (!flags.has("--apply")) log("Preview only. Use --apply to perform this transition; project code and native agent sessions are not removed.");
        }
        if (report.blockers.length) process.exitCode = 1;
      } else if (args[1] === "inspect" && args.length === 3) {
        const report = inspectRegisteredProject(args[2]);
        if (flags.has("--json")) log(JSON.stringify(report, null, 2));
        else {
          log(`${report.id}  [${report.availability}]  ${report.root}`);
          log(`Store: ${report.store}; state: ${report.state}; ${report.files} files, ${report.bytes} bytes.`);
          log(`Pending: ${report.pending.length}; live launchers: ${report.launchers.length}; preparations: ${report.preparations.length}.`);
          log(`Unfinished operation records: ${report.operations.length} (may include interrupted processes).`);
          log(`Migration evidence entries: ${report.migrationEvidence.length} (metadata only; contents and external locations not verified).`);
          for (const issue of report.issues) log(`${WARN} ${issue.file}: ${issue.reason}`);
          log("Read-only observation, not authorization to remove this project store.");
        }
        if (!report.complete) process.exitCode = 1;
      } else if (args[1] === "recover" && args.length === 3) {
        const report = recoverProjectOperations(args[2], { apply: flags.has("--apply") });
        if (flags.has("--json")) log(JSON.stringify(report, null, 2));
        else {
          log(`${report.recoverable.length} interrupted operation record(s); ${report.removed.length} removed; ${report.retained.length} retained.`);
          for (const entry of report.retained) log(`${WARN} ${entry.file}: ${entry.reason}`);
          if (!report.applied) log("Preview only. Use --apply to clear validated records whose owners have exited; handoff evidence is not removed.");
        }
        if (!report.complete) process.exitCode = 1;
      } else if (args[1] === "adopt" && args.length === 3) {
        const result = adoptProject(projectDir, args[2]);
        log(flags.has("--json") ? JSON.stringify(result, null, 2) : `${OK} Reconnected ${result.root} to project ${result.id}.`);
      } else throw new Error("Usage: bridge project list [--json] | inspect <id> [--json] | recover|retire|restore <id> [--apply] [--json] | adopt <id> [--json]");
      return;
    }

    case "storage": {
      if (args[1] === "migrate") {
        const { values } = parseArgs({ args: argv.slice(2), allowPositionals: false, options: {
          "retirement-dir": { type: "string" }, json: { type: "boolean" },
        } });
        const result = migrateLegacyStorage(projectDir, { retirementDir: values["retirement-dir"] ?? null });
        if (values.json) log(JSON.stringify(result || { migrated: false }, null, 2));
        else if (!result) log("No legacy migration is pending.");
        else {
          log(`${OK} Runtime storage: ${result.target}`);
          log(`Verified backup: ${result.backup}`);
          log(`Retired originals: ${result.retired}`);
        }
        return;
      }
      if (args[1] === "cleanup-ignore" && args.length === 2) {
        if ([...flags].some((flag) => !["--apply", "--json"].includes(flag))) throw new Error("Usage: bridge storage cleanup-ignore [--apply] [--json]");
        const result = cleanupLegacyIgnore(projectDir, { apply: flags.has("--apply") });
        if (flags.has("--json")) log(JSON.stringify(result, null, 2));
        else {
          for (const match of result.matches) log(`Line ${match.line}: ${match.rule}`);
          if (result.blocked) log(`${BAD} ${result.blocked}`);
          else log(result.applied ? "Removed the listed legacy ignore rules." : "No files changed. Use --apply to remove listed rules.");
        }
        process.exitCode = result.blocked ? 1 : 0;
        return;
      }
      if (args[1] !== "plan" || args.length !== 2) throw new Error("Usage: bridge storage plan [--json]");
      const plan = planLegacyMigration(projectDir);
      if (flags.has("--json")) log(JSON.stringify(plan, null, 2));
      else {
        log(`Source: ${plan.source}`);
        log(`Target: ${plan.target ?? (plan.createsIdentity ? "assigned under the global store when migration runs" : "no migration needed")}`);
        log(`Files: ${plan.files.length}, ${plan.bytes} bytes`);
        if (plan.needed) log(`Backup directory: ${plan.backupRoot}`);
        if (plan.recovery) {
          log(`Resume verified source cleanup using backup: ${plan.recovery.backup}`);
          log(`Retired originals: ${plan.recovery.retired}`);
        }
        for (const receipt of plan.completed) {
          log(`Completed migration originals: ${receipt.retired ?? receipt.receipt}`);
          for (const change of receipt.changes) log(`  ${change.reason}: ${change.file}`);
        }
        if (plan.removedEntries.length) log(`Files removed after verified backup: ${plan.removedEntries.join(", ")}`);
        if (plan.retainedEntries.length) {
          log(`Kept in the project: ${plan.retainedEntries.join(", ")}`);
          log("These files are not deleted automatically. Review and move files you want to keep; remove .bridge only when empty, then run bridge storage cleanup-ignore.");
        }
        for (const candidate of plan.staging.removable) log(`Verified abandoned staging copy: ${candidate}`);
        for (const candidate of plan.staging.retained) log(`Staging copy retained: ${candidate.path} (${candidate.reason})`);
        for (const blocker of plan.blockers) log(`${BAD} ${blocker}`);
        log("Read-only plan; no files were changed.");
      }
      process.exitCode = plan.blockers.length ? 1 : 0;
      return;
    }

    case "eval": {
      const { values } = parseArgs({ args: argv.slice(1), allowPositionals: false, options: {
        live: { type: "string" }, scenario: { type: "string" }, json: { type: "boolean" },
      } });
      if (values.live !== undefined) {
        const agent = values.live;
        if (!agent || agent.startsWith("--")) throw new Error("eval --live requires an agent: codex");
        const report = await runLiveEvaluation(agent, { scenario: values.scenario ?? "recall" });
        if (values.json) log(JSON.stringify(report, null, 2));
        else {
          log(`${report.passed ? OK : BAD} ${agent}: ${report.recall.satisfied}/${report.recall.total} live ${report.scenario} checks passed.`);
          log(report.scope);
        }
        process.exitCode = report.passed ? 0 : 1;
        return;
      }
      if (values.scenario !== undefined) throw new Error("eval --scenario requires --live codex");
      const report = runEvaluation();
      if (flags.has("--json")) log(JSON.stringify(report, null, 2));
      else {
        for (const result of report.results) {
          log(`${result.passed ? OK : BAD} ${result.id} (${result.bytes}/${result.budget} bytes, ${result.kept} kept, ${result.omitted} omitted)`);
          for (const m of result.metrics) log(`  ${m.passed ? OK : BAD} ${m.name}: ${m.detail}`);
        }
        log(`${report.passed ? OK : BAD} ${report.total} deterministic context evaluations ${report.passed ? "passed" : "failed"}.`);
      }
      process.exitCode = report.passed ? 0 : 1;
      return;
    }

    case "release-prepare": {
      const report = prepareReleaseEvidence(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
      log(`${OK} Release acceptance recorded at ${report.file}. Valid for this candidate for 24 hours from preparation start.`);
      return;
    }

    case "release-check": {
      if (flags.has("--evidence")) {
        if (flags.has("--ci")) throw new Error("Use --ci for live verification or --evidence for recorded acceptance, not both.");
        const report = verifyReleaseEvidence(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
        log(flags.has("--json") ? JSON.stringify(report, null, 2) : `${OK} Recorded acceptance matches this commit and package.`);
        return;
      }
      const report = releaseChecks(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), { verifyCI: flags.has("--ci") });
      if (flags.has("--json")) log(JSON.stringify(report, null, 2));
      else {
        for (const item of report.checks) log(`${item.passed ? OK : BAD} ${item.name}: ${item.detail}`);
        log(`${report.passed ? OK : BAD} release checks ${report.passed ? "passed" : "failed"} for ${report.version}.`);
      }
      process.exitCode = report.passed ? 0 : 1;
      return;
    }

    case "share": {
      const parsed = parseArgs({ args: argv.slice(1), allowPositionals: true, options: {
        endpoint: { type: "string" }, "token-file": { type: "string" }, out: { type: "string" },
        dir: { type: "string" }, port: { type: "string" }, "quota-bytes": { type: "string" },
        "ttl-seconds": { type: "string" }, apply: { type: "boolean" }, json: { type: "boolean" },
        "allow-loopback-http": { type: "boolean" },
      } });
      const [action, input] = parsed.positionals;
      const allowed = {
        send: ["endpoint", "token-file", "apply", "json", "allow-loopback-http", "ttl-seconds"],
        fetch: ["endpoint", "token-file", "out", "json", "allow-loopback-http"],
        remove: ["endpoint", "token-file", "apply", "json", "allow-loopback-http"],
        serve: ["dir", "token-file", "port", "quota-bytes", "json"],
      };
      if (!Object.hasOwn(allowed, action ?? "") || parsed.positionals.length !== (action === "serve" ? 1 : 2) ||
          Object.keys(parsed.values).some(key => !allowed[action].includes(key))) throw new Error("Usage: bridge share send|fetch|remove <file-or-hash> --endpoint <origin> | serve --dir <private-directory> --token-file <file>");
      const values = parsed.values;
      if (action === "serve") {
        if (!values.dir || !values["token-file"]) throw new Error("Sharing server requires --dir and --token-file.");
        const { server, endpoint } = await startArtifactServer({ directory: values.dir, tokenFile: values["token-file"],
          port: values.port === undefined ? 0 : Number(values.port),
          quotaBytes: values["quota-bytes"] === undefined ? undefined : Number(values["quota-bytes"]) });
        log(values.json ? JSON.stringify({ event: "listening", endpoint, encryptedObjectsOnly: true }) : `Sharing store listening at ${endpoint}; use a TLS proxy for remote access.`);
        await new Promise(resolve => {
          const stop = () => { server.close(resolve); server.closeAllConnections(); };
          process.once("SIGINT", stop); process.once("SIGTERM", stop);
          server.once("close", () => { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); resolve(); });
        });
        return;
      }
      if (!values.endpoint || (action === "fetch" && !values.out)) throw new Error("An explicit --endpoint is required; fetch also requires --out.");
      const options = { endpoint: values.endpoint, tokenFile: values["token-file"], apply: values.apply,
        allowLoopbackHttp: values["allow-loopback-http"], ttl: values["ttl-seconds"] === undefined ? undefined : Number(values["ttl-seconds"]) };
      const result = action === "send" ? await sendArtifact(input, options)
        : action === "fetch" ? await fetchArtifact(input, values.out, options)
          : await removeRemoteArtifact(input, options);
      log(values.json ? JSON.stringify(result, null, 2) : `${result.applied === false ? "Preview" : "Completed"}: ${action} ${result.hash}`);
      return;
    }

    case "artifact": {
      const parsed = parseArgs({ args: argv.slice(1), allowPositionals: true, options: {
        lane: { type: "string" }, apply: { type: "boolean" }, json: { type: "boolean" },
        "sign-key": { type: "string" }, "verify-key": { type: "string" },
        out: { type: "string" }, "key-file": { type: "string" },
      } });
      const [action, file] = parsed.positionals;
      if (["seal", "open"].includes(action)) {
        if (parsed.positionals.length !== 2 || !parsed.values.out || parsed.values.apply || parsed.values.lane ||
            parsed.values["sign-key"] || (action === "seal" && parsed.values["key-file"] !== undefined) ||
            (action === "open" && !parsed.values["key-file"])) {
          throw new Error("Usage: bridge artifact seal <file> --out <new-directory> [--verify-key <pem>] | open <file> --key-file <key.bin> --out <new-file> [--verify-key <pem>]");
        }
        const options = { keyFile: parsed.values["key-file"], verifyKey: parsed.values["verify-key"] };
        const result = action === "seal" ? sealArtifact(file, parsed.values.out, options)
          : openSealedArtifact(file, parsed.values.out, options);
        log(parsed.values.json ? JSON.stringify(result, null, 2) : `${OK} Artifact ${action} completed: ${result.path}`);
        if (!parsed.values.json && action === "seal") log("Share only context.cbsealed; deliver key.bin separately through a trusted channel. Do not upload the whole bundle.");
        return;
      }
      if (parsed.values.out !== undefined || parsed.values["key-file"] !== undefined) throw new Error("--out and --key-file are only for artifact seal/open.");
      if (parsed.positionals.length !== 2 || !["export", "import", "cache"].includes(action)) {
        throw new Error("Usage: bridge artifact export <file> [--sign-key <pem>] | import <file-or-sha256:hash> [--verify-key <pem>] [--apply] | cache <file> [--verify-key <pem>]");
      }
      if (action === "export" && (parsed.values.apply || parsed.values["verify-key"]) ||
          action !== "export" && parsed.values["sign-key"] ||
          action === "cache" && (parsed.values.apply || parsed.values.lane)) throw new Error("Artifact signing is for export; --apply is for import; cache is independent of lanes.");
      let result;
      if (action === "export") result = exportArtifact(projectDir, file, { lane: parsed.values.lane || DEFAULT_LANE, signKey: parsed.values["sign-key"] });
      else if (action === "import") result = importArtifact(file, { projectDir, lane: parsed.values.lane || DEFAULT_LANE, apply: parsed.values.apply, verifyKey: parsed.values["verify-key"] });
      else result = cacheArtifact(file, { verifyKey: parsed.values["verify-key"] });
      log(parsed.values.json ? JSON.stringify(result, null, 2) : `${OK} Artifact ${action} ${result.applied === false ? "verified" : "completed"}${result.reference ? `: ${result.reference}` : result.path ? `: ${result.path}` : "."}`);
      return;
    }

    case "search": {
      const parsed = parseArgs({ args: argv.slice(1), allowPositionals: true, options: {
        lane: { type: "string" }, agent: { type: "string" }, branch: { type: "string" }, since: { type: "string" }, until: { type: "string" }, json: { type: "boolean" },
      } });
      const query = parsed.positionals.join(" ");
      const report = searchProject(projectDir, query, parsed.values);
      const { results, incomplete, issues } = report;
      if (parsed.values.json) log(JSON.stringify(report, null, 2));
      else if (!results.length) log(`${NONE} No matches in the evidence that could be searched for ${JSON.stringify(query)}.`);
      else for (const result of results) {
        log(`${result.lane} ${result.kind} ${result.file}`);
        for (const match of result.matches) log(`  ${match.line}: ${match.text}`);
      }
      if (incomplete) {
        if (!parsed.values.json) {
          log(`${WARN} Search incomplete: ${issues.length} access or metadata issue(s). Results are not exhaustive.`);
          for (const issue of issues) log(`  ${issue.lane ?? "lanes"}${issue.file ? `/${issue.file}` : ""}: ${issue.reason}`);
        }
        process.exitCode = 1;
      }
      return;
    }

    case "status": {
      if (flags.has("--json")) {
        log(JSON.stringify(projectStatus(projectDir), null, 2));
        return;
      }
      const s = loadState(projectDir, { readOnly: true });
      if (!s) {
        log(`${NONE} No bridge state in this project yet. Run 'bridge' to start.`);
        return;
      }
      if (Object.hasOwn(s.lanes[s.activeLane], "worktree")) {
        const report = projectStatus(projectDir);
        log(`Lane ${s.activeLane}: isolated worktree`);
        log(`  Workspace: ${s.lanes[s.activeLane].worktree?.root ?? "invalid link"}`);
        log(`  Available: ${report.workspace.available ? "yes" : "no (invalid, missing or changed identity)"}`);
        log(`  Active agent: ${report.activeAgent ?? "none"}`);
        log(`  Pending: ${report.pending ? JSON.stringify(report.pending) : "none recorded"}`);
        return;
      }
      // What this used to print was true and unreadable. Every agent's progress
      // was shown as its raw watermark, and a watermark is opaque by design:
      // Claude's is an ISO instant, Grok's a {rows, ts} object printed as JSON,
      // Antigravity's a bare step number. Each adapter has its own opaque mark shape; one column
      // labelled "synced", and nobody could say synced from what, to whom, or
      // when. The fix is not to format the watermark better. It is to stop
      // showing it: what a person wants is who handed to whom and how recently,
      // and that was already on disk in the checkpoint filenames, unread.
      const debug = flags.has("--debug");
      const history = switchHistory(projectDir, s?.activeLane);
      const lastOut = new Map(); // agent -> when it last handed its work onward
      for (const h of history) if (!lastOut.has(h.source)) lastOut.set(h.source, h.at);

      log(bold("context-bridge") + dim(` · ${s.project}`));
      log("");
      const here = s.activeAgent ? (adapterFor(s.activeAgent)?.displayName ?? s.activeAgent) : dim("nobody yet");
      log(`  You are in     ${here}`);
      const pending = s.pendingHandoff
        ? `handoff → ${adapterFor(s.pendingHandoff.target)?.displayName ?? s.pendingHandoff.target}`
        : s.pendingInjection?.seed
          ? "seed waiting for the first agent opened here"
          : s.pendingInjection
            ? `context waiting for ${adapterFor(s.pendingInjection.agent)?.displayName ?? s.pendingInjection.agent}`
          : dim("nothing");
      log(`  Pending        ${pending}`);

      if (history.length) {
        log("");
        log("  Recent switches");
        // Both columns are padded, not just the timestamp: agent names differ in
        // length, so aligning only the stamp leaves the arrows staggered and the
        // list stops being scannable at a glance, which was the whole complaint.
        const recent = history.slice(0, 5).map((h) => ({
          when: clock(h.at),
          from: adapterFor(h.source)?.displayName ?? h.source,
          to: adapterFor(h.target)?.displayName ?? h.target,
        }));
        const stampW = Math.max(...recent.map((h) => h.when.length));
        const fromW = Math.max(...recent.map((h) => h.from.length));
        for (const h of recent) {
          log(`    ${dim(h.when.padEnd(stampW))}  ${h.from.padEnd(fromW)} → ${h.to}`);
        }
      }

      // Outside the block on purpose. The list is only as long as the
      // checkpoints that survive, and when pruning takes all of them there is no
      // list at all — which is precisely when saying so matters most. Keeping
      // this inside the branch meant the notice appeared for a partly-trimmed
      // history and vanished for a completely erased one, telling the least
      // where there was least to see. Found in review.
      const forgotten = AGENT_IDS.some((id) => s.agents?.[id]?.mark && !lastOut.has(id));
      if (forgotten) {
        if (!history.length) {
          log("");
          log("  Recent switches");
        }
        log(dim("    older switches are no longer kept: their checkpoints have been pruned"));
      }

      log("");
      log("  Agents");
      const width = Math.max(...AGENT_IDS.map((a) => (adapterFor(a)?.displayName ?? a).length)) + 3;
      for (const agentId of AGENT_IDS) {
        const slot = s.agents?.[agentId] ?? {};
        const name = (adapterFor(agentId)?.displayName ?? agentId).padEnd(width);
        if (!slot.id) {
          log(`    ${name}${dim("not linked")}`);
          continue;
        }
        const when = lastOut.get(agentId);
        // A mark is only ever set by handing off, so an agent that carries one
        // has handed off whether or not a checkpoint still proves it. Retention
        // deletes those checkpoints, and the first version of this read their
        // absence as "has never handed off" — not incomplete but false, about an
        // agent that had handed off many times. The state knew all along.
        const state =
          agentId === s.activeAgent
            ? "you are here"
            : when
              ? `handed off ${ago(when)}`
              : slot.mark
                ? dim("handed off before the kept history")
                : dim("has never handed off");
        log(`    ${name}${state}${debug ? dim(`   ${slot.id}  mark ${JSON.stringify(slot.mark)}`) : ""}`);
      }

      // Saved launch flags. Listed even when empty for the agents that have them,
      // because a saved permission bypass that nobody can find is one nobody can
      // undo, and `--cb-clear-args` is only useful if you know there is something
      // to clear.
      const config = loadConfig(projectDir);
      const armedAgents = AGENT_IDS.filter((agentId) => savedArgs(config, agentId).length);
      if (armedAgents.length) {
        log("");
        log("  saved launch flags");
        for (const agentId of armedAgents) {
          const args = savedArgs(config, agentId);
          const loud = args.some(isDangerous);
          log(`  ${agentId.padEnd(14)} ${argumentSummary(args)}${loud ? "   (changes what it may do without asking)" : ""}`);
        }
        log(dim(`  forget them with: bridge <agent> --cb-clear-args`));
      }
      // Work that never made it out of an agent, and the command that frees it.
      //
      // This lives here rather than only in the launcher because the launcher can
      // only speak at the moment an agent exits, and the case it was written for
      // never produces one: an agent out of quota does not die, it sits in its
      // own interface and eventually says the quota is gone. Nothing exits,
      // nothing fires, and the work waits with nobody mentioning it. Status reads
      // the disk instead, so it answers the same whether the agent crashed, hung,
      // stalled on a limit, or was closed days ago — and status is where a
      // confused person actually looks.
      //
      // Only agents that are NOT the active one count. The one you are working in
      // is supposed to have unsent work; saying so every time would be noise, and
      // noise is how a real warning gets ignored.
      for (const agentId of AGENT_IDS) {
        if (agentId === s.activeAgent) continue;
        const slot = s.agents?.[agentId];
        if (!slot?.id) continue;
        let stranded = false;
        try {
          const adapter = adapterFor(agentId);
          const ref = adapter.hydrate(projectDir, slot);
          if (!ref) continue;
          const activity = adapter.activitySince(ref, slot.mark);
          stranded = (activity.messages?.length ?? 0) > 0 || (activity.patchedFiles?.length ?? 0) > 0;
        } catch {
          continue; // an unreadable session is doctor's problem, not this line's
        }
        if (!stranded) continue;
        const target = AGENT_IDS.find((id) => id !== agentId && s.agents?.[id]?.id) ?? "<target>";
        log("");
        log(`  ${adapterFor(agentId).displayName} has work that was never handed off. It is saved, not lost:`);
        log(dim(`    bridge handoff ${target} --from ${agentId}`));
      }

      // Only the gaps. This was a full matrix of who had caught up with whom,
      // which is exact and unreadable: on a healthy project every cell says the
      // same thing and the one cell that matters is buried among them. A pair
      // that has never exchanged anything is worth a sentence; a pair that is up
      // to date is worth nothing, and printing it anyway is how the one real line
      // gets skipped.
      const linked = AGENT_IDS.filter((a) => s.agents?.[a]?.id);
      const gaps = [];
      for (const target of linked) {
        for (const src of linked) {
          if (src === target || s.knownBy?.[target]?.[src]) continue;
          gaps.push(
            `${adapterFor(target)?.displayName ?? target} has never received ` +
              `${adapterFor(src)?.displayName ?? src}'s work`
          );
        }
      }
      if (gaps.length) {
        log("");
        log("  Not yet shared");
        for (const g of gaps) log(`    ${g}`);
      }
      return;
    }

    case "inspect": {
      const { latestManifest, renderManifest } = await import("./audit.mjs");
      let s = null;
      let corrupt = false;
      try {
        s = loadState(projectDir, { readOnly: true });
      } catch {
        corrupt = true;
      }
      // --lane inspects a specific lane's newest audit; without it, the active lane's.
      // Resolving a named lane needs readable state, so corrupt state is its own clear
      // error rather than a misleading 'unknown lane'. Plain inspect stays lenient.
      const wantLane = valueOf(argv, "--lane") || null;
      if (wantLane) {
        if (corrupt) {
          log(`${BAD} Bridge state could not be read, so a lane cannot be resolved. Run 'bridge doctor'.`);
          process.exitCode = 1;
          return;
        }
        if (!s?.lanes?.[wantLane]) {
          log(`${BAD} No lane named '${wantLane}'. 'bridge lane' lists them.`);
          process.exitCode = 1;
          return;
        }
      }
      const lane = wantLane || s?.activeLane;
      const found = latestManifest(projectDir, lane);
      if (!found) {
        log(`${NONE} No audit manifest yet. One is written beside the delta on the next handoff.`);
        return;
      }
      if (flags.has("--json")) {
        log(JSON.stringify(found.manifest, null, 2));
        return;
      }
      log(dim(found.rel));
      log(renderManifest(found.manifest));
      return;
    }

    case "handoff": {
      let parsed;
      try {
        parsed = parseArgs({ args: argv.slice(1), allowPositionals: true, strict: true,
          options: { summary: { type: "string" }, decisions: { type: "string" }, next: { type: "string" },
            from: { type: "string" }, adopt: { type: "boolean" }, "dry-run": { type: "boolean" } } });
      } catch (cause) { throw new BridgeError("Invalid handoff options; no handoff was prepared.", { cause }); }
      if (parsed.positionals.length !== 1) throw new BridgeError("Handoff requires exactly one target agent; no handoff was prepared.");
      const target = parsed.positionals[0];
      // `--from` names the departing agent explicitly instead of inferring it.
      // The whole normal flow runs inside the departing agent, so it never needs
      // to say who it is. But when that agent has died — a quota 429, a crash —
      // it cannot run the command at all, and its work is stranded in its own
      // session with no way to carry it forward. This is the escape hatch: from
      // any healthy terminal, `bridge handoff codex --from antigravity` rebuilds
      // the delta straight from the dead agent's transcript on disk, because the
      // agent being alive was never what the handoff actually needed.
      const from = parsed.values.from ?? null;
      const opts = {
        summary: parsed.values.summary,
        decisions: parsed.values.decisions,
        next: parsed.values.next,
        adopt: parsed.values.adopt ?? false,
        dryRun: parsed.values["dry-run"] ?? false,
        from,
      };
      const usage =
        `Usage: bridge handoff <${AGENT_IDS.join("|")}> [--summary "…"] [--decisions "…"] [--next "…"]` +
        " [--from <agent>] [--adopt] [--dry-run]";
      if (!AGENT_IDS.includes(target)) {
        log(usage);
        process.exitCode = 1;
        return;
      }
      if (from !== null && !AGENT_IDS.includes(from)) {
        log(`${BAD} Unknown --from agent '${from}'. Known: ${AGENT_IDS.join(", ")}.`);
        process.exitCode = 1;
        return;
      }
      log(handoff(projectDir, target, opts));
      return;
    }

    case "clean": {
      let values;
      try {
        ({ values } = parseArgs({ args: argv.slice(1), allowPositionals: false, strict: true,
          options: { staging: { type: "boolean" }, all: { type: "boolean" },
            "dry-run": { type: "boolean" }, keep: { type: "string" }, days: { type: "string" }, lane: { type: "string" } } }));
      } catch (cause) { throw new BridgeError("Invalid clean options; nothing was pruned.", { cause }); }
      for (const name of ["keep", "days"]) {
        if (values[name] === undefined) continue;
        if (!/^\d+$/.test(values[name]) || !Number.isSafeInteger(Number(values[name]))) {
          throw new BridgeError(`--${name} requires a nonnegative whole number; nothing was pruned.`);
        }
        values[name] = Number(values[name]);
      }
      if (values.lane !== undefined && !isValidLaneName(values.lane)) throw new BridgeError("Invalid --lane; nothing was pruned.");
      if (values.staging && ["all", "keep", "days"].some((name) => values[name] !== undefined)) {
        throw new Error("Use clean --staging [--dry-run] [--lane NAME] separately from checkpoint retention options.");
      }
      // --lane scopes the prune to one lane; without it, every lane is pruned.
      // Read state through a guard: corrupt or unreadable state must NOT crash here,
      // it must fall through to pruneCheckpoints, whose fail-closed path reports it
      // clearly and deletes nothing. Only a readable state with the lane genuinely
      // absent is an 'unknown lane' error.
      const laneFlag = values.lane ?? null;
      if (laneFlag) {
        let known = null;
        try {
          known = loadState(projectDir, { readOnly: true });
        } catch {
          known = null; // corrupt: let pruneCheckpoints fail-close below
        }
        if (known && !known.lanes?.[laneFlag]) {
          log(`${BAD} No lane named '${laneFlag}'. 'bridge lane' lists them.`);
          process.exitCode = 1;
          return;
        }
      }
      const res = pruneCheckpoints(projectDir, {
        staging: values.staging,
        keep: values.keep,
        days: values.days,
        all: values.all,
        dryRun: values["dry-run"],
        lane: laneFlag,
      });
      if (
        res.skippedCorruptState ||
        res.skippedNoState ||
        res.skippedUnreadableStore ||
        res.skippedEscapingBridge ||
        res.skippedMalformedPending ||
        res.skippedInvalidPreparation ||
        res.skippedInvalidLane
      ) {
        const why = res.skippedCorruptState
          ? "bridge state could not be read"
          : res.skippedUnreadableStore
            ? "the runtime directory tree could not be inspected completely"
          : res.skippedEscapingBridge
            ? "the runtime tree contains a symlink escape"
            : res.skippedInvalidPreparation
              ? "a handoff preparation journal could not be identified safely"
            : res.skippedInvalidLane
              ? "state names a lane whose name could not be a real lane directory"
              : res.skippedMalformedPending
                ? "pendingInjection.deltaFile is malformed or points outside the checkpoint namespace"
                : "there are checkpoints but no bridge state";
        log(
          `${WARN} ${why}, so nothing was pruned. Without readable state a pending delta cannot be told from an orphan, ` +
            `and deleting could take a handoff. Run 'bridge doctor' to sort out the state, then clean.`
        );
        process.exitCode = 1;
        return;
      }
      const verb = flags.has("--dry-run") ? "Would delete" : "Deleted";
      const scope = laneFlag ? ` in lane ${bold(laneFlag)}` : "";
      if (res.failedOperations) {
        log(`${WARN} Cleanup incomplete${scope}: ${verb.toLowerCase()} ${res.deletedFiles} files; ${res.deletedGroups} checkpoint groups complete. An inspection or deletion failed; remaining groups were not processed. Inspect permissions and retry.`);
        process.exitCode = 1;
        return;
      }
      if (flags.has("--staging")) {
        log(`${OK} ${verb} ${res.deletedStagingFiles ?? 0} abandoned staging files${scope}; ${res.retainedStagingFiles ?? 0} retained (live, uncertain, changed or protected). Checkpoint groups were not pruned.`);
        return;
      }
      // There is one schedule now. This used to report two, because the full
      // context files were pruned on their own clock and counting groups alone
      // said "nothing to prune" while dozens of files were going.
      if (res.deletedGroups === 0) {
        log(`${NONE} Nothing to prune${scope} (${res.groups} checkpoint groups, all recent or protected).`);
      } else {
        log(`${OK} ${verb} ${res.deletedGroups} checkpoint groups (${res.deletedFiles} files)${scope}. ${res.groups - res.deletedGroups} kept.`);
      }
      return;
    }

    case "lane": {
      if (argv.some((arg) => arg === "--worktree" || arg.startsWith("--worktree="))) {
        const parsed = parseArgs({ args: argv.slice(1), allowPositionals: true, strict: true,
          options: { worktree: { type: "string" }, branch: { type: "string" }, base: { type: "string" }, json: { type: "boolean" } } });
        const [action, name, ...extra] = parsed.positionals;
        if (!["new", "attach"].includes(action) || !name || extra.length ||
            (action === "attach" && (parsed.values.branch || parsed.values.base))) {
          throw new Error("Usage: bridge lane new <name> --worktree <path> [--branch <branch>] [--base <ref>] | lane attach <name> --worktree <path>");
        }
        const result = createWorktreeLane(projectDir, name, parsed.values.worktree, {
          attach: action === "attach", branch: parsed.values.branch, base: parsed.values.base,
        });
        log(parsed.values.json ? JSON.stringify(result, null, 2) : `${OK} Lane ${result.lane}: ${result.path}`);
        return;
      }
      let parsed;
      try {
        parsed = parseArgs({ args: argv.slice(1), allowPositionals: true, strict: true,
          options: { seed: { type: "string" }, yes: { type: "boolean" }, "dry-run": { type: "boolean" } } });
      } catch (cause) { throw new BridgeError("Invalid lane options; no lane operation was performed.", { cause }); }
      const action = parsed.positionals[0];
      const allowed = { new: ["seed"], switch: [], rm: ["yes", "dry-run"] };
      if ((action === undefined && Object.keys(parsed.values).length) ||
          (action !== undefined && (!Object.hasOwn(allowed, action) || parsed.positionals.length !== 2 ||
            Object.keys(parsed.values).some(key => !allowed[action].includes(key))))) {
        throw new BridgeError("Invalid lane action or options; no lane operation was performed.");
      }
      process.exitCode = runLane(projectDir, parsed.positionals,
        new Set(Object.keys(parsed.values).map(key => `--${key}`)), parsed.values.seed);
      return;
    }

    case "unlink": {
      let parsed;
      try {
        parsed = parseArgs({ args: argv.slice(1), allowPositionals: true, strict: true, options: {} });
      } catch (cause) { throw new BridgeError("Invalid unlink options; no session was forgotten.", { cause }); }
      if (parsed.positionals.length !== 1) throw new BridgeError("Unlink requires exactly one agent; no session was forgotten.");
      process.exitCode = runUnlink(projectDir, parsed.positionals[0]);
      return;
    }

    case "internal-hook": {
      // The hook command names the agent it was installed for, so the identity
      // guard can compare that against the environment it actually woke up in.
      const forIndex = argv.indexOf("--agent");
      const hookAgent = forIndex >= 0 ? argv[forIndex + 1] : "claude";
      process.exitCode = await runHook(args[1], AGENT_IDS.includes(hookAgent) ? hookAgent : "claude");
      return;
    }

    default:
      // A flag's value lands here when no agent was named: `bridge --model opus`
      // makes 'opus' look like a command. Say so instead of just "unknown".
      if (flags.size) {
        log(
          `Unknown command (value hidden). If it was a value for an agent flag, name the agent first:\n` +
            `  bridge claude <agent arguments>\n\n${HELP}`
        );
      } else {
        log(`Unknown command (value hidden).\n\n${HELP}`);
      }
      process.exitCode = 1;
  }
}

/**
 * Everything except the agent name belongs to the agent — including flags typed
 * before it, so `bridge --model opus claude` cannot drop them silently.
 */
function tailAfter(argv, cmd) {
  if (!cmd) return [...argv];
  const i = argv.indexOf(cmd);
  return i === -1 ? [...argv] : [...argv.slice(0, i), ...argv.slice(i + 1)];
}


/**
 * Every switch this project has made, newest first, read from the names of the
 * checkpoints themselves.
 *
 * The history was always on disk and never shown: each checkpoint is written as
 * `<when>-<source>-to-<target>`, so the sequence of who handed to whom is
 * recoverable without storing anything new. Status used to answer "how far is
 * each agent synced" with a raw watermark, which told nobody anything, while the
 * question people actually ask — what happened, in what order — sat unread in a
 * directory listing.
 */
/** "2m ago", "20h ago", "3d ago" — a duration people read without doing arithmetic. */
function ago(date, now = Date.now()) {
  const s = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * When a switch happened: always the date, always the clock.
 *
 * The first version printed only the time, and dropped the date for anything
 * from today on the theory that the hour is enough within your own day. It is
 * not, because you do not read this only on the day you made the switch: come
 * back after two days and a line saying 10:31 is indistinguishable from this
 * morning. A timestamp that cannot be placed is worse than none, because it
 * gets believed. Serdar caught it by asking the obvious question nobody had.
 */
function clock(date) {
  // Keep status output stable across Node/ICU versions: some runtimes render
  // September as "Sep", others as "Sept" for the same en-GB request.
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = `${String(date.getDate()).padStart(2, "0")} ${months[date.getMonth()]}`;
  return `${day} ${date.toTimeString().slice(0, 5)}`;
}

function valueOf(argv, name) {
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1] !== undefined) return argv[i + 1];
  const pref = argv.find((a) => a.startsWith(name + "="));
  return pref ? pref.slice(name.length + 1) : "";
}

/**
 * `bridge lane` and its subcommands: the user-facing surface for lines of work.
 *   bridge lane                 list every lane, the active one marked, newest first
 *   bridge lane new <name>      create an empty lane and switch to it
 *   bridge lane switch <name>   point the default lane at an existing one
 *   bridge lane rm <name>       delete a lane and its checkpoints (guarded)
 * Returns a process exit code. `args` is the tail after `lane`.
 */
function runLane(projectDir, args, flags, seedSource) {
  const sub = args[0];
  const name = args[1];

  if (sub === undefined) {
    const s = loadState(projectDir, { readOnly: true });
    if (!s) {
      log(`${NONE} No bridge state in this project yet. Run 'bridge' to start.`);
      return 0;
    }
    const summaries = laneSummaries(projectDir, s);
    log(bold("Lanes") + dim(` · ${s.project}`));
    log("");
    const width = Math.max(...summaries.map((l) => l.name.length));
    for (const l of summaries) {
      const marker = l.active ? bold("* ") : "  ";
      const when = l.lastActive ? ago(new Date(l.lastActive)) : "no activity yet";
      const who = l.agents.length
        ? l.agents.map((id) => adapterFor(id)?.displayName ?? id).join(", ")
        : "no agents linked";
      const title = l.title ? dim(` (${l.title})`) : "";
      log(`  ${marker}${l.name.padEnd(width)}${title}  ${dim(when)}  ${dim(who)}`);
      if (Object.hasOwn(s.lanes[l.name], "worktree")) log(`      Worktree: ${s.lanes[l.name].worktree?.root ?? "invalid link"}`);
    }
    if (summaries.length === 1) {
      log("");
      log(dim("  One lane. 'bridge lane new <name>' starts a second, separate line of work."));
    }
    return 0;
  }

  if (sub === "new") {
    if (!name) {
      log("Usage: bridge lane new <name> [--seed <source-lane>]");
      return 1;
    }
    if (!isValidLaneName(name)) {
      log(`${BAD} Invalid lane name '${name}'. Use letters, digits, dot, dash or underscore, starting with a letter or digit.`);
      return 1;
    }
    // --seed carries starter context from another lane. Validate the source and
    // build the whole seed BEFORE creating the new lane, so a bad or unbuildable
    // --seed leaves no half-made lane behind.
    const seeding = flags.has("--seed");
    let prepared = null;
    if (seeding) {
      if (!seedSource) {
        log(`${BAD} --seed needs a source lane: bridge lane new ${name} --seed <lane>.`);
        return 1;
      }
      if (seedSource === name) {
        log(`${BAD} A lane cannot seed from itself.`);
        return 1;
      }
      const s = loadState(projectDir);
      if (!s?.lanes?.[seedSource]) {
        log(`${BAD} No lane named '${seedSource}' to seed from. 'bridge lane' lists them.`);
        return 1;
      }
      try {
        prepared = prepareSeed(projectDir, seedSource);
      } catch (e) {
        log(`${BAD} Could not read lane '${seedSource}' to seed from: ${e.message}`);
        return 1;
      }
    }
    ensureState(projectDir);
    try {
      mutateProject(projectDir, (disk) => {
        createLane(disk, name);
        switchActiveLane(disk, name);
      });
    } catch (e) {
      log(`${BAD} ${e.message}`);
      return 1;
    }
    if (seeding) {
      try {
        writeSeed(projectDir, name, prepared);
      } catch (e) {
        const rolledBack = rollbackLane(projectDir, name, seedSource);
        log(`${BAD} Could not seed lane '${name}' (${e.message}); ${rolledBack ? "the empty lane record was rolled back" : "automatic rollback could not be completed"}.`);
        log(dim("  Existing files were preserved. Inspect 'bridge lane' and 'bridge status' before retrying."));
        return 1;
      }
      log(`${OK} Created lane ${bold(name)}, seeded from ${bold(seedSource)}, and switched to it.`);
      const carried = [
        prepared.report.decisions ? "decisions" : null,
        prepared.report.next ? "next" : null,
        prepared.report.gitLines ? `${prepared.report.gitLines} git line(s)` : null,
        prepared.report.touched ? `${prepared.report.touched} touched file(s)` : null,
        prepared.report.read ? `${prepared.report.read} read file(s)` : null,
      ].filter(Boolean);
      log(dim(`  Carried ${carried.length ? carried.join(", ") : "a briefing"}; no conversation or sessions. The first agent you open here receives it.`));
      return 0;
    }
    log(`${OK} Created lane ${bold(name)} and switched to it. The next 'bridge' opens here.`);
    log(dim("  It starts empty on purpose: a new line of work carries no context from another."));
    return 0;
  }

  if (sub === "switch") {
    if (!name) {
      log("Usage: bridge lane switch <name>");
      return 1;
    }
    try {
      mutateProject(projectDir, (disk) => switchActiveLane(disk, name));
    } catch (e) {
      log(`${BAD} ${e.message}`);
      return 1;
    }
    log(`${OK} Switched to lane ${bold(name)}. A bare 'bridge' with no launcher running opens here.`);
    return 0;
  }

  if (sub === "rm") {
    if (!name) {
      log("Usage: bridge lane rm <name> [--dry-run] [--yes]");
      return 1;
    }
    const s = loadState(projectDir, { readOnly: true });
    if (!s) {
      log(`${NONE} No bridge state in this project yet.`);
      return 1;
    }
    if (name === DEFAULT_LANE) {
      log(`${BAD} The ${DEFAULT_LANE} lane cannot be removed.`);
      return 1;
    }
    if (!s.lanes?.[name]) {
      log(`${BAD} No lane named '${name}'.`);
      return 1;
    }
    if (name === s.activeLane) {
      log(`${BAD} Lane '${name}' is active. Switch away first: bridge lane switch <other>.`);
      return 1;
    }
    // Resurrection itself is blocked in mutateState (it refuses to recreate a
    // removed lane). This guard protects the live session's work: removing a lane a
    // launcher is actively driving would silently drop that session's later writes.
    // The per-lane launcher record makes it exact now — a launcher on ANOTHER lane
    // no longer blocks this removal, only one on the lane being removed does.
    if (laneHasLiveLauncher(s, name)) {
      log(`${BAD} A bridge launcher is running on lane '${name}'.`);
      log(dim("  Close that bridge terminal first, so a live session's work is not lost under the removal."));
      return 1;
    }
    const laneDir = path.join(bridgeDir(projectDir), "lanes", name);
    if (flags.has("--dry-run")) {
      log(`${WARN} Would remove lane ${bold(name)} and its checkpoints (${path.relative(projectDir, laneDir)}/).`);
      return 0;
    }
    if (!flags.has("--yes")) {
      log(`${WARN} Removing lane '${name}' deletes it and its checkpoints, and cannot be undone.`);
      log(dim("  Re-run with --yes to confirm, or --dry-run to preview."));
      return 1;
    }
    let removal;
    try {
      removal = removeLane(projectDir, name);
    } catch (e) {
      log(`${BAD} ${e.message}`);
      return 1;
    }
    log(`${OK} Removed lane ${bold(name)}.`);
    if (!removal.filesRemoved) log(`${WARN} Lane files were retained (${removal.reason}); inspect ${laneDir} before reusing the name.`);
    return 0;
  }

  log(`${BAD} Unknown 'bridge lane' subcommand '${sub}'. Try: bridge lane [new|switch|rm] <name>.`);
  return 1;
}

/**
 * `bridge unlink <agent>`: forget one agent's session in the active lane. Clears
 * its slot and every watermark that names it, in both directions, so the next
 * switch links a fresh session instead of resuming a dead one. Replaces the old
 * `rm -rf .bridge` sledgehammer, which took every agent's link, not just one.
 */
function runUnlink(projectDir, agentId) {
  if (!AGENT_IDS.includes(agentId)) {
    log(`Usage: bridge unlink <${AGENT_IDS.join("|")}>`);
    return 1;
  }
  const s = loadState(projectDir);
  if (!s) {
    log(`${NONE} No bridge state in this project yet.`);
    return 1;
  }
  const name = adapterFor(agentId)?.displayName ?? agentId;
  const lane = s.activeLane ?? DEFAULT_LANE;
  // Unlink is for a session you have finished with. If a launcher is live on this
  // lane, the session may still be running, and its next hook, or a handoff already
  // in flight, would re-link the very agent you just forgot from a pre-unlink
  // snapshot. Refuse while a launcher drives this lane; a launcher on another lane
  // no longer blocks it, now that the record is per-lane. The precise per-session
  // generation barrier is the deferred follow-up.
  if (laneHasLiveLauncher(s, lane)) {
    log(`${BAD} A bridge launcher is running on lane '${lane}'.`);
    log(dim("  Unlink is for a session you are done with. Close that bridge terminal first, so a live session cannot re-link the agent you forget."));
    return 1;
  }
  let changed = false;
  mutateState(projectDir, null, (disk) => {
    changed = unlinkAgent(disk, agentId);
  });
  if (!changed) {
    log(`${NONE} ${name} is not linked in lane ${lane}; nothing to unlink.`);
    return 0;
  }
  log(`${OK} Unlinked ${name} from lane ${bold(lane)}. Its session and every watermark that named it are cleared.`);
  log(dim("  The next switch to it links a fresh session."));
  return 0;
}

/**
 * Resolve which lane to open, then start the launcher on it. `--resume <lane>`
 * enters a named lane, `--resume` alone opens a picker, and no flag resumes the lane
 * the project was last in. Entering a lane also makes it the active one, so a later
 * bare `bridge` comes back to it. `agent` is null for a bare `bridge`.
 */
async function launchAgent(projectDir, agent, argv) {
  const parsed = extractResume(tailAfter(argv, agent));
  if (parsed.error) {
    log(`${BAD} ${parsed.error}`);
    return 1;
  }
  const { resume, rest } = parsed;
  const r = resolveResumeLane(projectDir, resume);
  if (r.error) {
    log(`${BAD} ${r.error}`);
    return 1;
  }
  let lane = r.lane;
  if (r.pick) {
    lane = await pickLane(projectDir);
    if (!lane) {
      log(`${NONE} No lane chosen.`);
      return 0;
    }
  }
  if (lane) {
    // Entering a lane makes it the default too, so "the lane you were last in" is
    // true next time. A launcher already running on another lane is pinned and
    // unaffected by this move.
    mutateProject(projectDir, (disk) => switchActiveLane(disk, lane));
  }
  return runLoop(projectDir, agent, { ...splitLauncherArgs(rest), lane });
}

/**
 * Pull the bridge-owned `--resume [lane]` out of an agent's forwarded args. The
 * bridge holds `--resume` back from the agent anyway (it manages the session), so
 * here it selects a lane. Returns { resume, rest }: `resume` is undefined when
 * absent, a lane name when one follows, or `true` for the bare picker form; `rest`
 * is the remaining args to forward to the agent.
 */
export function extractResume(tail) {
  const hits = [];
  const rest = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a === "--resume") {
      const next = tail[i + 1];
      const hasName = next !== undefined && !next.startsWith("-");
      hits.push(hasName ? next : true);
      if (hasName) i++; // consume the lane name too, so it never reaches the agent
    } else if (a.startsWith("--resume=")) {
      hits.push(a.slice("--resume=".length)); // may be "" for a bare --resume=
    } else {
      rest.push(a);
    }
  }
  if (hits.length === 0) return { resume: undefined, rest };
  // More than one --resume is ambiguous, and leaving a second one in `rest` would
  // hand it to an agent that does not drop it (Codex, OpenCode). Refuse instead of
  // guessing which lane was meant.
  if (hits.length > 1) return { error: "Use --resume at most once." };
  const only = hits[0];
  if (only === "") return { error: "Empty --resume=; give it a lane name, or use --resume with no value to pick one." };
  return { resume: only, rest };
}

/**
 * A picker answer to a whole number 0..count, or null for anything else. Parsing
 * with parseInt alone accepted "1abc" as 1, silently choosing a lane the user did
 * not type; the whole string must be digits.
 */
export function parseChoice(answer, count) {
  const t = String(answer).trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 0 && n <= count ? n : null;
}

/**
 * Resolve `--resume`'s value: a lane to open, null to fall back to the lane the
 * project was last in, or a picker request. A named lane must already exist — new
 * lanes are made deliberately with `lane new`, never conjured by a resume typo.
 * Returns { lane } | { pick: true } | { error }.
 */
export function resolveResumeLane(projectDir, resume) {
  if (resume === undefined) return { lane: null };
  const s = loadState(projectDir);
  if (resume === true) {
    // Nothing to choose between yet: open the one lane there is.
    if (!s || Object.keys(s.lanes ?? {}).length <= 1) return { lane: null };
    return { pick: true };
  }
  if (!isValidLaneName(resume)) return { error: `Invalid lane name '${resume}'.` };
  if (!s?.lanes?.[resume]) {
    return { error: `No lane named '${resume}'. Start it with 'bridge lane new ${resume}', or 'bridge lane' to list them.` };
  }
  return { lane: resume };
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Interactive lane picker for a bare `bridge <agent> --resume`. Lists the lanes
 * newest-active first with "New lane" on top, and returns the chosen lane's name, a
 * freshly created one, or null if the choice was empty or invalid (the caller treats
 * null as cancel).
 */
async function pickLane(projectDir) {
  const s = loadState(projectDir);
  const summaries = laneSummaries(projectDir, s);
  log(bold("Which lane?"));
  log(`  ${dim("0)")} New lane`);
  summaries.forEach((l, idx) => {
    const when = l.lastActive ? ago(new Date(l.lastActive)) : "no activity yet";
    log(`  ${dim(`${idx + 1})`)} ${l.name}${l.active ? dim(" (current)") : ""}  ${dim(when)}`);
  });
  const answer = (await prompt(`Lane [0-${summaries.length}, Enter = ${summaries[0].name}]: `)).trim();
  if (!answer) return summaries[0].name;
  const n = parseChoice(answer, summaries.length);
  if (n === null) return null;
  if (n === 0) {
    const name = (await prompt("New lane name: ")).trim();
    if (!isValidLaneName(name)) {
      log(`${BAD} Invalid lane name '${name}'.`);
      return null;
    }
    if (s.lanes?.[name]) return name; // already exists: just open it
    mutateProject(projectDir, (disk) => createLane(disk, name));
    log(`${OK} Created lane ${bold(name)}.`);
    return name;
  }
  return summaries[n - 1].name;
}

/**
 * Undo only the still-empty lane record after a failed seed. Files may predate
 * this attempt, or the seed/state write may have published before reporting an
 * error. Preserve them; failed rollback must not delete recoverable evidence.
 */
function rollbackLane(projectDir, name, fallback) {
  try {
    mutateProject(projectDir, (disk) => {
      if (laneHasLiveLauncher(disk, name) || JSON.stringify(disk.lanes?.[name]) !== JSON.stringify(emptyLane())) {
        throw new Error("Lane changed during seed preparation; refusing automatic rollback.");
      }
      if (disk.activeLane === name) disk.activeLane = disk.lanes?.[fallback] ? fallback : DEFAULT_LANE;
      removeLaneFromState(disk, name);
    });
    return true;
  } catch {
    return false;
  }
}
