export const ADAPTER_API_VERSION = 1;

export const REQUIRED_OPERATIONS = Object.freeze([
  "discover", "hydrate", "resumeCommand", "startCommand", "currentMark",
  "activitySince", "idleAfter", "health", "smokeCommand", "detectHost",
  "discoveryProbe", "parseProbe", "adoptStartedSession", "auditSince", "observeAudit",
]);
const OPTIONAL_OPERATIONS = [
  "promptArgs", "kickoffArgs", "refById", "preResume", "fabricateSession",
  "evaluationCommand", "evaluationUsage", "snapshotSource",
];
export const RECORD_FIELDS = Object.freeze([
  "commands", "commandArgs", "outcome", "exitCode", "duration", "filesRead",
  "filesChanged", "toolOutput", "reasoning", "tokenUsage", "pairing",
]);
export const RECORD_VALUES = Object.freeze([
  true, false, "full", "parsed", "partial", "pointer", "summary", "truncated", "keyed", "positional",
]);

/** Structural validation only. Never invokes an adapter or proves its claims. */
export function validateAdapter(adapter, apiVersion = ADAPTER_API_VERSION) {
  const fail = (message) => { throw new TypeError(`Invalid adapter contract: ${message}`); };
  if (apiVersion !== ADAPTER_API_VERSION) fail(`unsupported API version ${apiVersion}`);
  if (!adapter || typeof adapter !== "object") fail("expected an adapter object");
  if (typeof adapter.id !== "string" || !/^[a-z]+$/.test(adapter.id)) fail("id must contain lowercase ASCII letters only");
  if (typeof adapter.displayName !== "string" || !adapter.displayName.trim()) fail(`${adapter.id}: displayName is required`);
  if (!["hook", "prompt"].includes(adapter.injection)) fail(`${adapter.id}: unknown injection mode`);
  for (const name of REQUIRED_OPERATIONS) {
    if (typeof adapter[name] !== "function") fail(`${adapter.id}: ${name} must be a function`);
  }
  for (const name of OPTIONAL_OPERATIONS) {
    if (adapter[name] !== undefined && typeof adapter[name] !== "function") fail(`${adapter.id}: ${name} must be a function when supplied`);
  }
  const delivery = adapter.injection === "hook" ? "kickoffArgs" : "promptArgs";
  if (typeof adapter[delivery] !== "function") fail(`${adapter.id}: ${delivery} is required for ${adapter.injection} delivery`);
  if (adapter.evaluationUsage && !adapter.evaluationCommand) fail(`${adapter.id}: evaluationUsage requires evaluationCommand`);
  const capabilities = adapter.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) fail(`${adapter.id}: capabilities are required`);
  for (const field of RECORD_FIELDS) {
    if (!Object.hasOwn(capabilities, field) || !RECORD_VALUES.includes(capabilities[field])) fail(`${adapter.id}: invalid or missing capability ${field}`);
  }
  for (const field of Object.keys(capabilities)) {
    if (!RECORD_FIELDS.includes(field)) fail(`${adapter.id}: unknown capability ${field}`);
  }
  if (!Array.isArray(adapter.conflictFlags)) fail(`${adapter.id}: conflictFlags must be an array`);
  for (const rule of adapter.conflictFlags) {
    if (!rule || !Array.isArray(rule.flags) || !rule.flags.length ||
        rule.flags.some((flag) => typeof flag !== "string" || !/^--?[^\s]+$/.test(flag)) ||
        !["none", "optional", "required"].includes(rule.value) ||
        typeof rule.why !== "string" || !rule.why.trim()) fail(`${adapter.id}: invalid conflict flag rule`);
  }
  return adapter;
}

export function createAdapterRegistry(adapters, apiVersion = ADAPTER_API_VERSION) {
  if (apiVersion !== ADAPTER_API_VERSION) throw new TypeError(`Unsupported adapter API version: ${apiVersion}`);
  const entries = Object.create(null);
  for (const adapter of adapters) {
    validateAdapter(adapter, apiVersion);
    if (Object.hasOwn(entries, adapter.id)) throw new TypeError(`Duplicate adapter: ${adapter.id}`);
    entries[adapter.id] = checkedAdapter(adapter);
  }
  return Object.freeze(entries);
}

const COMMAND_OPERATIONS = ["startCommand", "resumeCommand", "smokeCommand", "evaluationCommand"];
const ARG_OPERATIONS = ["promptArgs", "kickoffArgs"];
const SESSION_OPERATIONS = ["discover", "hydrate", "refById", "snapshotSource"];
const REPORT_OPERATIONS = ["auditSince", "observeAudit", "health", "parseProbe", "discoveryProbe", "idleAfter", "detectHost"];
const strings = (value) => Array.isArray(value) && Array.from(value).every((item) => typeof item === "string" && !item.includes("\0"));
const text = (value) => typeof value === "string" && Boolean(value.trim()) && !value.includes("\0");
const commandResult = (value) => value && typeof value === "object" && !Array.isArray(value) && text(value.cmd) && strings(value.args);
const sessionResult = (value) => value && typeof value === "object" && !Array.isArray(value) && text(value.id) &&
  ["transcriptPath", "eventsPath"].every((key) => value[key] == null || text(value[key]));
const preparationResult = (value) => commandResult(value) &&
  (value.timeout === undefined || (Number.isSafeInteger(value.timeout) && value.timeout > 0)) &&
  ["note", "operation"].every((key) => value[key] === undefined || text(value[key]));
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const nullableString = (value) => value == null || typeof value === "string";
const object = (value) => value && typeof value === "object" && !Array.isArray(value);

export class AdapterResultError extends TypeError {
  constructor(id, operation) {
    super(`Invalid adapter result: ${id}.${operation}`);
    this.name = "AdapterResultError";
    this.expected = true;
  }
}

export function validateAdapterResult(id, operation, result) {
  const fail = () => { throw new AdapterResultError(id, operation); };
  if (COMMAND_OPERATIONS.includes(operation)) {
    if (!commandResult(result)) fail();
  } else if (ARG_OPERATIONS.includes(operation)) {
    if (!strings(result)) fail();
  } else if (SESSION_OPERATIONS.includes(operation)) {
    if (result !== null && !sessionResult(result)) fail();
  } else if (operation === "adoptStartedSession") {
    if (!Array.isArray(result) || !Array.from(result).every(sessionResult)) fail();
  } else if (operation === "preResume") {
    if (result !== null && !preparationResult(result)) fail();
  } else if (operation === "fabricateSession") {
    if (result !== null && (!sessionResult(result) || !preparationResult(result.preResume))) fail();
  } else if (operation === "idleAfter") {
    if (result !== null && typeof result !== "boolean") fail();
  } else if (operation === "detectHost") {
    if (result !== null && result !== id) fail();
  } else if (operation === "observeAudit") {
    if (!object(result) || Object.entries(result).some(([key, value]) =>
      !RECORD_FIELDS.includes(key) || !(value === null || RECORD_VALUES.includes(value)))) fail();
  } else if (operation === "health") {
    if (!object(result) || !nullableString(result.version) || typeof result.ready !== "boolean" ||
      !object(result.auth) || typeof result.auth.ok !== "boolean" ||
      !nullableString(result.auth.via) || !nullableString(result.auth.account) ||
      !Array.isArray(result.extras) || !text(result.installHint)) fail();
    for (const extra of result.extras) if (!object(extra) || typeof extra.ok !== "boolean" || !text(extra.label)) fail();
  } else if (operation === "parseProbe") {
    if (!object(result) || !["readable", "partial", "mismatch", "missing", "unreadable"].includes(result.status)) fail();
    for (const key of ["rows", "known", "malformed", "messages"]) if (result[key] != null && !count(result[key])) fail();
  } else if (operation === "discoveryProbe") {
    if (!object(result) || !["none", "readable", "blind"].includes(result.status) ||
      !count(result.examined) || !count(result.recognised)) fail();
  } else if (operation === "auditSince") {
    if (!object(result) || !Array.isArray(result.commands) || !strings(result.filesRead) ||
      !strings(result.filesChanged) || !count(result.dropped)) fail();
    if (Object.hasOwn(result, "sourceComplete") && typeof result.sourceComplete !== "boolean") fail();
    for (const command of result.commands) {
      if (!object(command) || !nullableString(command.tool) || !nullableString(command.at) ||
        !(command.ok == null || typeof command.ok === "boolean") ||
        !(command.exitCode == null || Number.isSafeInteger(command.exitCode)) ||
        !(command.durationMs == null || (Number.isFinite(command.durationMs) && command.durationMs >= 0))) fail();
    }
  } else if (operation === "activitySince") {
    if (!result || !Array.isArray(result.messages) || !strings(result.patchedFiles) ||
        !Number.isSafeInteger(result.turnsCompleted) || result.turnsCompleted < 0) fail();
    if (Object.hasOwn(result, "deliveryObserved") && typeof result.deliveryObserved !== "boolean") fail();
    if (Object.hasOwn(result, "sourceComplete") && typeof result.sourceComplete !== "boolean") fail();
    for (const message of result.messages) {
      if (!message || !["user", "assistant"].includes(message.role) ||
          typeof message.text !== "string" ||
          !(message.at == null || typeof message.at === "string")) fail();
    }
  }
  return result;
}

function checkedAdapter(adapter) {
  const view = { ...adapter };
  for (const operation of [...COMMAND_OPERATIONS, ...ARG_OPERATIONS, ...SESSION_OPERATIONS,
    ...REPORT_OPERATIONS, "adoptStartedSession", "preResume", "fabricateSession", "activitySince"]) {
    if (typeof adapter[operation] !== "function") continue;
    view[operation] = (...args) => validateAdapterResult(adapter.id, operation, adapter[operation](...args));
  }
  return Object.freeze(view);
}

/** Operational support is distinct from transcript evidence capabilities. */
export function adapterDescriptor(adapter) {
  validateAdapter(adapter);
  return {
    apiVersion: ADAPTER_API_VERSION, id: adapter.id, displayName: adapter.displayName,
    injection: adapter.injection, record: { ...adapter.capabilities },
    operations: Object.fromEntries([...REQUIRED_OPERATIONS, ...OPTIONAL_OPERATIONS]
      .map((name) => [name, typeof adapter[name] === "function"])),
  };
}
