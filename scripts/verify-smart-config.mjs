// Verification for the "pulled models stay on ZCode's intelligent model
// configuration" behaviour.
//
// Three layers are exercised against a throwaway fixture config:
//   1. src/config.mjs            — merge + migration as the CLI uses them
//   2. the injected renderer     — mergeFinalState() sliced straight out of
//      (src/features/modelhub/ui/zcode-model-hub.js) must produce the SAME config
//   3. the injected main process — migrateSmartConfig() sliced out of
//      src/features/modelhub/main-handlers.js must agree with src/config.mjs
//
// Everything the plugin writes is then checked against the constraints the app
// enforces on provider_config.json (strict root, required rule arrays, strict
// manual-rule config, no provider/model declared in both rule arrays).
//
// No network, no real install, no writes under the real ~/.zcode: the state
// directory is redirected to a temp dir (ZCODE_SUITE_STATE_DIR) and the
// config fixture lives in a temp dir too.
//
//   node scripts/verify-smart-config.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "zmh-verify-"));
process.env.ZCODE_SUITE_STATE_DIR = path.join(TMP, "state");
// keep every legacy fallback path inside the tmp root too — nothing may ever
// read the real ~/.zcode during verification
process.env.ZCODE_MODEL_HUB_STATE_DIR = path.join(TMP, "legacy-model-hub");
process.env.ZCODE_PLUS_ASAR_STATE_DIR = path.join(TMP, "legacy-zcode-plus");
const CONFIG_PATH = path.join(TMP, "provider_config.json");

const { mergeFetchedModels, readConfig } = await import(pathToFileURL(path.join(ROOT, "src", "config.mjs")).href);

// ---------------------------------------------------------------- fixtures --
function fixture() {
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "np",
            providerName: "New Provider",
            templateId: "tpl-x",
            config: {
              api: { type: "openai-chat-completions", baseUrl: "https://api.example.com/v1" },
              access: { apiKey: "sk-test" },
              modelOrder: ["old-model"],
              personalModelIds: ["old-model"],
              builtinModelIds: ["tpl-a", "tpl-b"],
            },
          },
        ],
      },
      modelConfigRules: {
        // rules ZCode itself wrote (the live config carries 44 of these) —
        // the plugin must never edit or remove them
        providerModelRules: [
          { providerId: "np", modelId: "old-model", config: { enabled: true } },
          { providerId: "np", modelId: "tpl-a", config: { enabled: true, properties: { contextWindow: 200000 } } },
        ],
        manualProviderModelRules: [],
      },
    },
  };
}

const PROVIDER_KEY = "np";
const ruleOf = (cfg) => cfg.config.providerConfigRules.providerRules[0];
const ruleConfigOf = (cfg) => ruleOf(cfg).config;
const mcrOf = (cfg) => cfg.config.modelConfigRules;
const modelIds = (fetched) => fetched.map((f) => f.id);
const models = (...ids) => ids.map((id) => ({ id }));

function seedTombstones(map) {
  const file = path.join(process.env.ZCODE_SUITE_STATE_DIR, "state.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ deletedModels: map }, null, 2), "utf8");
}

function readTombstones() {
  const file = path.join(process.env.ZCODE_SUITE_STATE_DIR, "state.json");
  if (!fs.existsSync(file)) return {};
  const st = JSON.parse(fs.readFileSync(file, "utf8"));
  return st.deletedModels && typeof st.deletedModels === "object" ? st.deletedModels : {};
}

function clearTombstones() {
  fs.rmSync(path.join(process.env.ZCODE_SUITE_STATE_DIR, "state.json"), { force: true });
}

// The default shape pre-1.5 plugin versions wrote for every model they added.
function pluginDefaultRule(providerId, modelId, enabled) {
  return {
    providerId,
    modelId,
    config: {
      enabled,
      properties: {
        contextWindow: 128000,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
        inputFormat: { supportsImage: false, supportsVideo: false, supportsPdf: false },
      },
      optionSpecs: {
        reasoningLevel: { values: ["disabled", "enabled"], map: "{}" },
        maxOutputTokens: { max: 8192 },
      },
    },
  };
}

// ------------------------------------------------- app-side config validity --
// provider_config.json is validated strictly by the app; a config it rejects
// shows NO models at all, so "still valid" is part of the contract.
function validateConfig(cfg) {
  const problems = [];
  for (const k of Object.keys(cfg)) {
    if (k !== "schemaVersion" && k !== "config") problems.push(`unknown root key: ${k}`);
  }
  if (cfg.schemaVersion !== 1) problems.push("schemaVersion must be 1");
  const c = cfg.config;
  if (!c || typeof c !== "object" || Array.isArray(c)) {
    problems.push("config must be an object");
    return problems;
  }
  for (const required of ["providerConfigRules", "modelConfigRules"]) {
    if (!c[required] || typeof c[required] !== "object" || Array.isArray(c[required])) {
      problems.push(`config.${required} missing or not an object`);
    }
  }
  const mcr = c.modelConfigRules;
  if (!mcr || typeof mcr !== "object") return problems;
  for (const list of ["providerModelRules", "manualProviderModelRules"]) {
    if (!Array.isArray(mcr[list])) {
      problems.push(`modelConfigRules.${list} must be an array`);
      return problems;
    }
    for (const r of mcr[list]) {
      if (!r || typeof r !== "object" || typeof r.providerId !== "string" || typeof r.modelId !== "string") {
        problems.push(`${list} entry needs string providerId + modelId`);
        continue;
      }
      if (!r.config || typeof r.config !== "object" || Array.isArray(r.config)) {
        problems.push(`${list} entry needs a config object`);
      }
    }
  }
  // the strict manual-rule config schema (Ko in the bundle)
  for (const r of mcr.manualProviderModelRules) {
    const cfg2 = r.config;
    const bad = (m) => problems.push(`manual rule ${r.providerId}/${r.modelId}: ${m}`);
    if (Object.keys(cfg2).sort().join(",") !== "enabled,optionSpecs,properties") bad("config keys must be exactly enabled/properties/optionSpecs");
    if (typeof cfg2.enabled !== "boolean") bad("enabled must be boolean");
    const p = cfg2.properties;
    if (!p || typeof p !== "object") bad("properties missing");
    else {
      if (!Number.isInteger(p.contextWindow) || p.contextWindow <= 0) bad("properties.contextWindow must be a positive integer");
      for (const f of ["supportsJsonSchemaOutput", "supportsNativeWebSearch", "supportsMidConversationSystem"]) {
        if (typeof p[f] !== "boolean") bad(`properties.${f} must be boolean`);
      }
      if (!p.inputFormat || typeof p.inputFormat !== "object") bad("properties.inputFormat missing");
      else {
        if (Object.keys(p.inputFormat).sort().join(",") !== "supportsImage,supportsPdf,supportsVideo") bad("inputFormat keys");
        for (const f of ["supportsImage", "supportsVideo", "supportsPdf"]) {
          if (typeof p.inputFormat[f] !== "boolean") bad(`inputFormat.${f} must be boolean`);
        }
      }
    }
    const o = cfg2.optionSpecs;
    if (!o || typeof o !== "object") bad("optionSpecs missing");
    else {
      const rl = o.reasoningLevel;
      if (!rl || !Array.isArray(rl.values) || rl.values.length === 0 || rl.values.some((v) => typeof v !== "string")) {
        bad("optionSpecs.reasoningLevel.values must be a non-empty string array");
      }
      if (typeof rl?.map !== "string") bad("optionSpecs.reasoningLevel.map must be a string");
      if (!Number.isInteger(o.maxOutputTokens?.max) || o.maxOutputTokens.max <= 0) bad("optionSpecs.maxOutputTokens.max must be a positive integer");
    }
  }
  // one provider/model may not declare both rule kinds
  const smart = new Set(mcr.providerModelRules.map((r) => `${r.providerId}\u0000${r.modelId}`));
  for (const r of mcr.manualProviderModelRules) {
    if (smart.has(`${r.providerId}\u0000${r.modelId}`)) {
      problems.push(`${r.providerId}/${r.modelId} declares both intelligent and manual configuration`);
    }
  }
  return problems;
}

// A model is on intelligent configuration exactly when NO manual-provider-model
// rule exists for it; the builtin catch-all then supplies enabled: true plus the
// recommendation. It is usable when no provider-model rule disables it.
function assertIntelligent(cfg, providerId, modelId) {
  const mcr = mcrOf(cfg);
  const manual = mcr.manualProviderModelRules.filter((r) => r.providerId === providerId && r.modelId === modelId);
  assert.equal(manual.length, 0, `${modelId} still has a manual rule (intelligent config off)`);
  const hidden = mcr.providerModelRules.some(
    (r) => r.providerId === providerId && r.modelId === modelId && r.config && r.config.enabled === false,
  );
  assert.equal(hidden, false, `${modelId} is disabled by a provider-model rule`);
}

function manualRulesFor(cfg, providerId, modelId) {
  return mcrOf(cfg).manualProviderModelRules.filter((r) => r.providerId === providerId && r.modelId === modelId);
}

function assertValid(cfg, label) {
  const problems = validateConfig(cfg);
  assert.deepEqual(problems, [], `${label}: config would be rejected by the app`);
}

// --------------------------------------------- injected renderer payload ---
// Slice the merge functions (plus the helpers they close over) out of the UI
// payload by brace matching, then run them standalone.
function extractFunctions(src, names) {
  const parts = [];
  for (const name of names) {
    const match = new RegExp(`\\n[ \\t]*function ${name}\\s*\\(`).exec(src);
    assert.ok(match, `payload: function ${name}() not found`);
    const start = match.index;
    let i = src.indexOf("{", start);
    assert.notEqual(i, -1, `UI payload: ${name}() has no body`);
    let depth = 0;
    let j = i;
    while (j < src.length) {
      const ch = src[j];
      if (ch === "/" && src[j + 1] === "/") {
        while (j < src.length && src[j] !== "\n") j++;
        continue;
      }
      if (ch === "/" && src[j + 1] === "*") {
        j += 2;
        while (j < src.length && !(src[j] === "*" && src[j + 1] === "/")) j++;
        j += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        const quote = ch;
        j++;
        while (j < src.length) {
          if (src[j] === "\\") {
            j += 2;
            continue;
          }
          if (src[j] === quote) {
            j++;
            break;
          }
          j++;
        }
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
      j++;
    }
    parts.push(src.slice(start + 1, j));
  }
  return parts.join("\n");
}

const uiSrc = fs.readFileSync(path.join(ROOT, "src", "features", "modelhub", "ui", "zcode-model-hub.js"), "utf8");
const uiMerge = new Function(
  extractFunctions(uiSrc, [
    "mergeFinalState",
    "ruleProviderId",
    "modelConfigRulesOf",
    "dropManualRuleOf",
    "enableSmartConfigOf",
    "findSmartRuleOf",
    "hideModelOf",
    "unhideModelOf",
    "enableModelOf",
  ]) + "\nreturn { mergeFinalState: mergeFinalState };",
)();

const mainSrc = fs.readFileSync(path.join(ROOT, "src", "features", "modelhub", "main-handlers.js"), "utf8");
const mainMigrate = new Function(
  extractFunctions(mainSrc, ["modelRulesOf", "onlyKeys", "looksPluginGenerated", "migrateSmartConfig"]) +
    "\nreturn { migrateSmartConfig: migrateSmartConfig };",
)();

// --------------------------------------------------------------- scenarios --
const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (e) {
    checks.push({ name, ok: false, error: e.message });
    console.log(`  FAIL ${name}\n       ${e.message.split("\n").join("\n       ")}`);
  }
}

console.log("CLI layer (src/config.mjs)");

// 1. pulling new models adds universe membership + ordering ONLY.
check("pull adds models without any manual rule (intelligent config on)", () => {
  const cfg = fixture();
  const res = mergeFetchedModels(cfg, PROVIDER_KEY, models("m1", "m2", "m3"), { selected: ["m1", "m2", "m3"] });
  assert.deepEqual(res.added, ["m1", "m2", "m3"]);
  assert.deepEqual(ruleConfigOf(cfg).modelOrder, ["old-model", "m1", "m2", "m3"]);
  assert.deepEqual(ruleConfigOf(cfg).personalModelIds, ["old-model", "m1", "m2", "m3"]);
  assert.deepEqual(mcrOf(cfg).manualProviderModelRules, []);
  assert.deepEqual(mcrOf(cfg).providerModelRules, fixture().config.modelConfigRules.providerModelRules);
  assert.deepEqual(readTombstones(), {});
  for (const id of ["m1", "m2", "m3"]) assertIntelligent(cfg, PROVIDER_KEY, id);
  assertValid(cfg, "pull");
});

// 2. deleting a personal model removes it from the universe, no rule residue.
check("deleting a personal model leaves no manual/provider rule behind", () => {
  const cfg = fixture();
  mergeFetchedModels(cfg, PROVIDER_KEY, models("m1", "m2", "m3"), { selected: ["m1", "m2", "m3"] });
  mergeFetchedModels(cfg, PROVIDER_KEY, models("m1", "m2", "m3"), { selected: ["m1", "m2"] });
  assert.deepEqual(ruleConfigOf(cfg).personalModelIds, ["old-model", "m1", "m2"]);
  assert.deepEqual(ruleConfigOf(cfg).modelOrder, ["old-model", "m1", "m2"]);
  assert.deepEqual(mcrOf(cfg).manualProviderModelRules, []);
  assert.deepEqual(mcrOf(cfg).providerModelRules, fixture().config.modelConfigRules.providerModelRules);
  assert.deepEqual(readTombstones()[PROVIDER_KEY], ["m3"]);
  assertValid(cfg, "delete personal");
});

// 3. a template built-in cannot leave the universe: hide it, and merge into the
//    app's own rule instead of dropping its tuned properties.
check("deleting a template built-in writes an enabled:false provider-model rule", () => {
  const cfg = fixture();
  mergeFetchedModels(cfg, PROVIDER_KEY, models("m1", "m2", "m3"), { selected: ["m1", "m2", "m3"] });
  mergeFetchedModels(cfg, PROVIDER_KEY, models("m1", "m2", "m3"), { selected: ["m1", "m2"] });
  mergeFetchedModels(cfg, PROVIDER_KEY, models("m1", "m2", "tpl-a"), { selected: ["m1", "m2"] });
  assert.deepEqual(mcrOf(cfg).providerModelRules, [
    { providerId: "np", modelId: "old-model", config: { enabled: true } },
    { providerId: "np", modelId: "tpl-a", config: { enabled: false, properties: { contextWindow: 200000 } } },
  ]);
  assert.deepEqual(ruleConfigOf(cfg).modelOrder, ["old-model", "m1", "m2"]);
  assert.deepEqual(ruleConfigOf(cfg).personalModelIds, ["old-model", "m1", "m2"]);
  assert.deepEqual(mcrOf(cfg).manualProviderModelRules, []);
  assert.deepEqual(readTombstones()[PROVIDER_KEY], ["m3", "tpl-a"]);
  assertValid(cfg, "delete template built-in");
});

// 4. re-checking a hidden template model clears the hide rule and brings it back.
const CYCLE = [
  { fetched: ["m1", "m2", "m3"], selected: ["m1", "m2", "m3"] },
  { fetched: ["m1", "m2", "m3"], selected: ["m1", "m2"] },
  { fetched: ["m1", "m2", "m3", "tpl-a"], selected: ["m1", "m2"] },
  { fetched: ["m1", "m2", "m3", "tpl-a"], selected: ["m1", "m2", "tpl-a"] },
];

check("re-checking a hidden template model unhides it", () => {
  const cfg = fixture();
  for (const step of CYCLE) mergeFetchedModels(cfg, PROVIDER_KEY, models(...step.fetched), { selected: step.selected });
  // tpl-a is back and its app-written rule is restored, not dropped
  assert.deepEqual(mcrOf(cfg).providerModelRules, fixture().config.modelConfigRules.providerModelRules);
  assert.deepEqual(ruleConfigOf(cfg).modelOrder, ["old-model", "m1", "m2", "tpl-a"]);
  // template models stay out of personalModelIds — the template defines them
  assert.deepEqual(ruleConfigOf(cfg).personalModelIds, ["old-model", "m1", "m2"]);
  assert.deepEqual(mcrOf(cfg).manualProviderModelRules, []);
  assert.deepEqual(readTombstones()[PROVIDER_KEY], ["m3"]);
  assertIntelligent(cfg, PROVIDER_KEY, "tpl-a");
  assertValid(cfg, "re-check hidden template model");
});

// 5. auto-sync (CLI, no explicit selection) still honours tombstones.
check("auto-sync adds non-tombstoned models only", () => {
  seedTombstones({ [PROVIDER_KEY]: ["skip-me"] });
  const cfg = fixture();
  mergeFetchedModels(cfg, PROVIDER_KEY, models("x", "y", "skip-me"));
  assert.deepEqual(ruleConfigOf(cfg).personalModelIds, ["old-model", "x", "y"]);
  assert.deepEqual(ruleConfigOf(cfg).modelOrder, ["old-model", "x", "y"]);
  assert.deepEqual(readTombstones()[PROVIDER_KEY], ["skip-me"]);
  for (const id of ["x", "y"]) assertIntelligent(cfg, PROVIDER_KEY, id);
  assertValid(cfg, "auto-sync");
});

// 6. one-time migration of pre-1.5 manual rules.
check("migration converts plugin-generated manual rules and keeps tuned ones", () => {
  const cfg = fixture();
  cfg.config.modelConfigRules.manualProviderModelRules = [
    pluginDefaultRule("np", "m-hidden", false), // plugin default, disabled -> hide rule
    pluginDefaultRule("np", "m-ok", true), // plugin default, enabled   -> dropped
    pluginDefaultRule("np", "m-collide", false), // ...and a provider rule already exists
    {
      // hand-tuned by the user: must survive untouched
      providerId: "np",
      modelId: "m-tuned",
      config: {
        enabled: true,
        properties: {
          contextWindow: 300000,
          supportsJsonSchemaOutput: true,
          supportsNativeWebSearch: false,
          supportsMidConversationSystem: true,
          inputFormat: { supportsImage: true, supportsVideo: false, supportsPdf: false },
        },
        optionSpecs: {
          reasoningLevel: { values: ["disabled", "enabled", "xhigh"], map: '{"xhigh":"high"}' },
          maxOutputTokens: { max: 32768 },
        },
      },
    },
    {
      // disabled but not the plugin's default shape (json schema output on)
      providerId: "np",
      modelId: "m-odd",
      config: {
        enabled: false,
        properties: {
          contextWindow: 1000,
          supportsJsonSchemaOutput: true,
          supportsNativeWebSearch: false,
          supportsMidConversationSystem: false,
          inputFormat: { supportsImage: false, supportsVideo: false, supportsPdf: false },
        },
        optionSpecs: {
          reasoningLevel: { values: ["disabled", "enabled"], map: "{}" },
          maxOutputTokens: { max: 8192 },
        },
      },
    },
  ];
  // the app itself wrote a rule for the colliding model
  cfg.config.modelConfigRules.providerModelRules.push({ providerId: "np", modelId: "m-collide", config: { enabled: true } });
  const tuned = cfg.config.modelConfigRules.manualProviderModelRules[3];
  const odd = cfg.config.modelConfigRules.manualProviderModelRules[4];

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
  const read = readConfig(CONFIG_PATH);
  assertValid(read, "migration");
  assert.deepEqual(
    read.config.modelConfigRules.manualProviderModelRules.map((r) => r.modelId),
    ["m-tuned", "m-odd"],
    "plugin-generated manual rules must be gone, tuned ones stay",
  );
  assert.deepEqual(read.config.modelConfigRules.manualProviderModelRules[0], tuned);
  assert.deepEqual(read.config.modelConfigRules.manualProviderModelRules[1], odd);
  assert.deepEqual(read.config.modelConfigRules.providerModelRules, [
    { providerId: "np", modelId: "old-model", config: { enabled: true } },
    { providerId: "np", modelId: "tpl-a", config: { enabled: true, properties: { contextWindow: 200000 } } },
    { providerId: "np", modelId: "m-collide", config: { enabled: true } },
    { providerId: "np", modelId: "m-hidden", config: { enabled: false } },
  ]);
  for (const id of ["m-ok", "m-collide"]) assertIntelligent(read, PROVIDER_KEY, id);
  // the user's own tuning stays manual on purpose
  for (const id of ["m-tuned", "m-odd"]) {
    assert.equal(manualRulesFor(read, PROVIDER_KEY, id).length, 1, `${id} must keep its manual rule`);
  }
  // the conversion is persisted so the app picks it up on its next read
  assert.deepEqual(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")), read, "migration must be written back");
  // and it is idempotent
  const before = fs.readFileSync(CONFIG_PATH, "utf8");
  readConfig(CONFIG_PATH);
  assert.equal(fs.readFileSync(CONFIG_PATH, "utf8"), before, "a second read must not rewrite anything");
});

console.log("renderer payload (src/features/modelhub/ui/zcode-model-hub.js)");

// The renderer must reach byte-identical configs for the same user actions.
function parity(name, steps) {
  check(name, () => {
    // start from a clean tombstone file: the CLI re-reads it on every merge,
    // the renderer keeps one in-memory set for the whole modal session
    clearTombstones();
    const cliCfg = fixture();
    const uiCfg = fixture();
    // one tombstone set for the whole session, exactly like the real flow
    // (the modal reads it once and writes it back on save)
    const deleted = {};
    for (const step of steps) {
      mergeFetchedModels(cliCfg, PROVIDER_KEY, models(...step.fetched), { selected: step.selected });
      uiMerge.mergeFinalState(uiCfg, { format: "rules", rule: ruleOf(uiCfg) }, models(...step.fetched), step.selected, deleted);
      const persisted = readTombstones()[PROVIDER_KEY] ?? [];
      assert.deepEqual([...persisted].sort(), Object.keys(deleted).sort(), "tombstone sets differ");
    }
    assert.deepEqual(uiCfg, cliCfg, "renderer produced a different config than the CLI");
    assertValid(uiCfg, name);
  });
}

parity("renderer: add, delete personal, delete template built-in, re-check", CYCLE);

console.log("main-process payload (src/features/modelhub/main-handlers.js)");

// The injected main process migrates on read too; it must agree with config.mjs.
check("main-process migration matches src/config.mjs", () => {
  const build = () => {
    const cfg = fixture();
    cfg.config.modelConfigRules.manualProviderModelRules = [
      pluginDefaultRule("np", "m-hidden", false),
      pluginDefaultRule("np", "m-ok", true),
      pluginDefaultRule("np", "m-collide", false),
      { providerId: "np", modelId: "m-tuned", config: pluginDefaultRule("np", "m-tuned", true).config },
    ];
    cfg.config.modelConfigRules.providerModelRules.push({ providerId: "np", modelId: "m-collide", config: { enabled: true } });
    return cfg;
  };
  const viaMain = build();
  assert.equal(mainMigrate.migrateSmartConfig(viaMain), true);
  const viaCli = build();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(viaCli, null, 2), "utf8");
  const read = readConfig(CONFIG_PATH);
  assert.deepEqual(viaMain, read, "main-process and CLI migrations disagree");
  assertValid(viaMain, "main-process migration");
});

// ------------------------------------------------------------------ report --
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log(`fixture kept at ${TMP}`);
  process.exitCode = 1;
} else {
  fs.rmSync(TMP, { recursive: true, force: true });
}
