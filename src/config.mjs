// ZCode provider_config.json reader/writer + provider/model merge logic.
// Latest schema (ZCode >= 3.x, schemaVersion 1 — root is STRICT, unknown keys
// are rejected by the app): config.providerConfigRules.providerRules[],
// models live in rule.config.modelOrder (mirrors the app's addModels).
// Legacy schema: provider / provider.models (still supported for reading).
// Deletion tombstones live in OUR state file (~/.zcode/model-hub/state.json),
// never inside provider_config.json — the app's strict schema would reject
// any extra root key and treat the whole config as corrupted.
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./platform.mjs";
import { atomicWriteBuffer } from "./archive/verify.mjs";

export function zcodeProviderConfigPath() {
  return path.join(process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH || "", ".zcode", "v2", "provider_config.json");
}

function stateFilePath() {
  return path.join(stateDir(), "state.json");
}

function readStateFile() {
  try {
    const st = JSON.parse(fs.readFileSync(stateFilePath(), "utf8"));
    return st && typeof st === "object" && !Array.isArray(st) ? st : {};
  } catch {
    return {};
  }
}

function writeStateFile(st) {
  fs.mkdirSync(stateDir(), { recursive: true });
  atomicWriteBuffer(stateFilePath(), Buffer.from(JSON.stringify(st, null, 2), "utf8"));
}

function tombstoneKey(providerId) {
  return String(providerId ?? "*");
}

function readTombstones(providerId) {
  const st = readStateFile();
  const map = st.deletedModels && typeof st.deletedModels === "object" && !Array.isArray(st.deletedModels) ? st.deletedModels : {};
  const list = Array.isArray(map[tombstoneKey(providerId)]) ? map[tombstoneKey(providerId)] : [];
  return new Set(list.map(String));
}

function writeTombstones(providerId, ids) {
  const st = readStateFile();
  if (!st.deletedModels || typeof st.deletedModels !== "object" || Array.isArray(st.deletedModels)) st.deletedModels = {};
  const list = [...ids].map(String).sort();
  if (list.length) st.deletedModels[tombstoneKey(providerId)] = list;
  else delete st.deletedModels[tombstoneKey(providerId)];
  writeStateFile(st);
}

// Old tool versions stored tombstones in the config root (cfg.zcode.deletedModels).
// The latest app validates the root strictly, so migrate them into the state
// file (per provider) and strip the key before anything writes the config back.
function migrateLegacyTombstones(cfg) {
  const legacy = cfg && typeof cfg === "object" ? cfg.zcode?.deletedModels : null;
  if (!Array.isArray(legacy) || !legacy.length) return;
  const legacyIds = legacy.map(String);
  const providerIds = new Set(["*"]);
  const rules = cfg?.config?.providerConfigRules?.providerRules;
  if (Array.isArray(rules)) for (const r of rules) if (r && typeof r === "object") providerIds.add(String(r.providerId ?? r.id ?? ""));
  const section = cfg?.provider;
  if (Array.isArray(section)) section.forEach((p, i) => p && typeof p === "object" && providerIds.add(String(p.id || p.name || i)));
  else if (section && typeof section === "object") for (const key of Object.keys(section)) providerIds.add(String(key));
  for (const pid of providerIds) {
    const merged = new Set([...readTombstones(pid), ...legacyIds]);
    merged.delete("undefined");
    writeTombstones(pid, merged);
  }
  delete cfg.zcode;
}

// Plugin versions before intelligent configuration wrote a full
// manual-provider-model rule for every model they added. Those rules stay valid
// for the app, but each one switches that model OFF its intelligent
// configuration and replaces the builtin recommendation with plugin-generated
// defaults. Convert the ones this plugin generated (default shape — the user
// never tuned them): an enabled:false rule becomes the equivalent provider-model
// hide rule, anything else is dropped so the model falls back to the builtin
// recommendation. Rules carrying real tuning (reasoning levels, a custom
// context window, feature flags) are left untouched.
function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function hasOnlyKeys(v, allowed) {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every(k => allowed.includes(k));
}

function looksPluginGenerated(config) {
  if (!hasOnlyKeys(config, ["enabled", "properties", "optionSpecs"])) return false;
  if (typeof config.enabled !== "boolean") return false;
  const p = config.properties;
  if (!hasOnlyKeys(p, ["contextWindow", "supportsJsonSchemaOutput", "supportsNativeWebSearch", "supportsMidConversationSystem", "inputFormat"])) return false;
  if (!Number.isInteger(p.contextWindow) || p.contextWindow <= 0) return false;
  if (p.supportsJsonSchemaOutput === true || p.supportsNativeWebSearch === true || p.supportsMidConversationSystem === true) return false;
  const input = p.inputFormat;
  if (!hasOnlyKeys(input, ["supportsImage", "supportsVideo", "supportsPdf"])) return false;
  if (input.supportsVideo === true || input.supportsPdf === true) return false;
  const o = config.optionSpecs;
  if (!hasOnlyKeys(o, ["reasoningLevel", "maxOutputTokens"])) return false;
  const rl = o.reasoningLevel;
  if (!hasOnlyKeys(rl, ["values", "map"])) return false;
  if (!Array.isArray(rl.values) || rl.values.length !== 2 || rl.values[0] !== "disabled" || rl.values[1] !== "enabled") return false;
  if (typeof rl.map !== "string" || rl.map.replace(/\s+/g, "") !== "{}") return false;
  const mot = o.maxOutputTokens;
  if (!hasOnlyKeys(mot, ["max"])) return false;
  return Number.isInteger(mot.max) && mot.max > 0;
}

function migrateSmartConfig(cfg) {
  // latest format only — the legacy config.json layout has no model rules
  if (!cfg || typeof cfg !== "object" || !cfg.config || typeof cfg.config !== "object") return false;
  const mcr = modelConfigRules(cfg);
  const before = mcr.manualProviderModelRules.length;
  mcr.manualProviderModelRules = mcr.manualProviderModelRules.filter(rule => {
    if (!rule || typeof rule !== "object") return false;
    if (!looksPluginGenerated(rule.config)) return true;
    const providerId = String(rule.providerId ?? "");
    const modelId = String(rule.modelId ?? "");
    // the app rejects a config that declares both rule kinds for the same
    // provider/model, so an existing provider-model rule wins and our own
    // generated default is dropped — that collision is otherwise unfixable
    if (findSmartRule(mcr, providerId, modelId)) return false;
    if (rule.config.enabled === false) hideModel(mcr, providerId, modelId);
    return false;
  });
  return mcr.manualProviderModelRules.length !== before;
}

export function readConfig(configPath = zcodeProviderConfigPath()) {
  if (!fs.existsSync(configPath)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    migrateLegacyTombstones(cfg);
    if (migrateSmartConfig(cfg)) {
      // persist the conversion so the app picks it up on its next read; a
      // failure here must never break the command that triggered the read
      try {
        writeConfigAtomic(cfg, configPath);
      } catch {}
    }
    return cfg;
  } catch (e) {
    throw new Error(`provider_config.json unreadable (${configPath}): ${e.message}`);
  }
}

export function writeConfigAtomic(cfg, configPath = zcodeProviderConfigPath()) {
  // never leak our legacy tombstone key into the strict-schema config
  if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) delete cfg.zcode;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (fs.existsSync(configPath)) {
    const bak = configPath + ".model-hub.bak";
    fs.rmSync(bak + ".model-hub-tmp", { force: true });
    fs.copyFileSync(configPath, bak + ".model-hub-tmp");
    fs.renameSync(bak + ".model-hub-tmp", bak);
  }
  atomicWriteBuffer(configPath, Buffer.from(JSON.stringify(cfg, null, 2), "utf8"));
}

function providerRules(cfg) {
  return cfg?.config?.providerConfigRules?.providerRules;
}

function newProviderView(rule, index) {
  const c = rule?.config && typeof rule.config === "object" ? rule.config : {};
  const access = c.access && typeof c.access === "object" ? c.access : {};
  const api = c.api && typeof c.api === "object" ? c.api : {};
  const modelOrder = Array.isArray(c.modelOrder) ? c.modelOrder.map(String) : [];
  const personalModelIds = Array.isArray(c.personalModelIds) ? c.personalModelIds.map(String) : [];
  const models = Object.fromEntries(modelOrder.map(id => [id, { name: id }]));
  const apiType = String(api.type || "openai-chat-completions");
  return {
    key: String(rule?.providerId ?? rule?.id ?? index),
    id: String(rule?.providerId ?? rule?.id ?? rule?.providerName ?? `provider-${index}`),
    name: String(rule?.providerName ?? rule?.name ?? rule?.providerId ?? `provider-${index}`),
    kind: apiType.includes("anthropic") ? "anthropic" : "openai-compatible",
    baseURL: String(api.baseUrl ?? api.baseURL ?? c.baseUrl ?? c.baseURL ?? ""),
    apiKey: String(access.apiKey ?? c.apiKey ?? ""),
    models,
    modelOrder,
    personalModelIds,
    templateId: String(rule?.templateId ?? ""),
    format: "providerRules",
  };
}

export function listProviders(cfg) {
  const rules = providerRules(cfg);
  if (Array.isArray(rules)) {
    return rules
      .map((rule, i) => rule && typeof rule === "object" ? newProviderView(rule, i) : null)
      .filter(Boolean);
  }

  // Legacy format fallback.
  const section = cfg?.provider;
  const out = [];
  const push = (key, id, p) => {
    if (!p || typeof p !== "object") return;
    const opts = p.options || {};
    out.push({
      key,
      id: p.id || id || key,
      name: p.name || id || key,
      kind: p.kind || "openai-compatible",
      baseURL: opts.baseURL || p.baseURL || "",
      apiKey: opts.apiKey || p.apiKey || "",
      models: p.models || {},
      modelOrder: Object.keys(p.models || {}),
      personalModelIds: [],
      format: "legacy",
    });
  };
  if (Array.isArray(section)) section.forEach((p, i) => push(String(i), p?.id ?? p?.name, p));
  else if (section && typeof section === "object") for (const [key, p] of Object.entries(section)) push(key, key, p);
  return out;
}

function getProviderEntry(cfg, key) {
  const want = String(key);
  const rules = providerRules(cfg);
  if (Array.isArray(rules)) {
    const idx = rules.findIndex((rule, i) => rule && (
      String(rule.providerId ?? "") === want ||
      String(rule.providerName ?? "") === want ||
      String(rule.id ?? "") === want ||
      String(i) === want
    ));
    if (idx < 0) throw new Error(`provider ${key} not found in config.providerConfigRules.providerRules`);
    const rule = rules[idx];
    return { format: "providerRules", key: String(rule?.providerId ?? rule?.id ?? idx), rule };
  }

  const section = cfg.provider ?? (cfg.provider = {});
  if (Array.isArray(section)) {
    const idx = section.findIndex((p, i) => p && (String(p.id ?? "") === want || String(p.name ?? "") === want || String(i) === want));
    if (idx < 0) throw new Error(`provider ${key} not found`);
    return { format: "legacy-array", container: section, idx };
  }
  if (section && typeof section === "object" && Object.prototype.hasOwnProperty.call(section, key)) {
    return { format: "legacy-object", container: section, key };
  }
  throw new Error(`provider ${key} not found`);
}

export function defaultModelEntry(id, vision) {
  return {
    name: id,
    limit: { context: 128000, output: 8192 },
    modalities: {
      input: vision ? ["text", "image"] : ["text"],
      output: ["text"],
    },
  };
}

// --- latest-format model plumbing -------------------------------------------
// The app builds a provider's model list as:
//   universe = builtinModelIds ∪ personalModelIds   (modelOrder only sorts it —
//   ids that are not in the universe are silently dropped)
// and every model's config is resolved from the app's builtin model rules,
// which start from a catch-all {enabled: true, ...recommendation} and overlay
// the more specific model/api/site/template rules. A model keeps using that
// intelligent configuration for as long as no manual-provider-model rule
// exists for it, so pulling a model into a custom provider needs only the two
// universe writes (personalModelIds + modelOrder) and NO manual rule.
function modelConfigRules(cfg) {
  const c = cfg?.config;
  if (!c || typeof c !== "object") return null;
  if (!c.modelConfigRules || typeof c.modelConfigRules !== "object" || Array.isArray(c.modelConfigRules)) {
    c.modelConfigRules = { providerModelRules: [], manualProviderModelRules: [] };
  }
  const m = c.modelConfigRules;
  if (!Array.isArray(m.providerModelRules)) m.providerModelRules = [];
  if (!Array.isArray(m.manualProviderModelRules)) m.manualProviderModelRules = [];
  return m;
}

// "Intelligent" (smart) configuration: the app's builtin modelRules carry a
// catch-all {enabled: true, ...recommendation} plus more specific model/api/site
// rules, and a model keeps using them as long as NO manual-provider-model rule
// exists for it (the app projects useRecommendedConfig = type !==
// "manual-provider-model"). So enabling smart config for a model means REMOVING
// its manual override — writing one is exactly what switches smart config off.
function findManualRule(mcr, providerId, modelId) {
  return mcr.manualProviderModelRules.find(
    r => r && typeof r === "object" && String(r.providerId ?? "") === providerId && String(r.modelId ?? "") === modelId,
  );
}

function dropManualRule(mcr, providerId, modelId) {
  mcr.manualProviderModelRules = mcr.manualProviderModelRules.filter(
    r => !(r && typeof r === "object" && String(r.providerId ?? "") === providerId && String(r.modelId ?? "") === modelId),
  );
}

function enableSmartConfig(mcr, providerId, modelId) {
  if (mcr) dropManualRule(mcr, providerId, modelId);
}

// A provider-model rule with enabled === false is how a model gets hidden. It
// is the exact shape ZCode itself writes for its enable/disable toggle
// (setPersonalModelEnabled), it keeps the model on intelligent configuration,
// and it is the only way to "delete" a template built-in — the template
// universe always contains those models.
function findSmartRule(mcr, providerId, modelId) {
  return mcr.providerModelRules.find(
    r => r && typeof r === "object" && String(r.providerId ?? "") === providerId && String(r.modelId ?? "") === modelId,
  ) ?? null;
}

function hideModel(mcr, providerId, modelId) {
  const existing = findSmartRule(mcr, providerId, modelId);
  if (existing) {
    const cfg = existing.config && typeof existing.config === "object" ? existing.config : {};
    existing.config = { ...cfg, enabled: false };
    return;
  }
  mcr.providerModelRules.push({ providerId: String(providerId), modelId: String(modelId), config: { enabled: false } });
}

function unhideModel(mcr, providerId, modelId) {
  mcr.providerModelRules = mcr.providerModelRules.filter(
    r => !(r && typeof r === "object" && String(r.providerId ?? "") === providerId && String(r.modelId ?? "") === modelId),
  );
}

// Re-enabling a model keeps whatever else its rule carries (an app-written
// contextWindow, for instance) — this is the same {enabled: true} shape ZCode's
// own enable/disable toggle writes. A model with no rule at all needs nothing:
// the builtin catch-all already enables it.
function enableModel(mcr, providerId, modelId) {
  const existing = findSmartRule(mcr, providerId, modelId);
  if (!existing) return;
  const cfg = existing.config && typeof existing.config === "object" ? existing.config : {};
  existing.config = { ...cfg, enabled: true };
}

function disabledModelIds(mcr, providerId) {
  const out = new Set();
  if (!mcr) return out;
  const scan = (rules) => {
    for (const r of rules) {
      if (!r || typeof r !== "object" || String(r.providerId ?? "") !== providerId) continue;
      const c = r.config;
      if (c && typeof c === "object" && c.enabled === false) out.add(String(r.modelId ?? ""));
    }
  };
  scan(mcr.manualProviderModelRules);
  scan(mcr.providerModelRules);
  return out;
}

function mergeNewModels(cfg, entry, fetched, selected) {
  const rule = entry.rule;
  if (!rule.config || typeof rule.config !== "object") rule.config = {};
  const c = rule.config;
  const providerId = String(rule.providerId ?? rule.id ?? entry.key);
  let order = Array.isArray(c.modelOrder) ? c.modelOrder.map(String) : [];
  let personal = Array.isArray(c.personalModelIds) ? c.personalModelIds.map(String) : [];
  const before = new Set(order);
  const beforePersonal = new Set(personal);
  const builtin = new Set(Array.isArray(c.builtinModelIds) ? c.builtinModelIds.map(String) : []);
  const fetchedIds = fetched.map(f => String(f.id));
  const deleted = readTombstones(entry.key);
  const want = new Set(
    selected === undefined
      ? fetchedIds.filter(id => !deleted.has(id))
      : [...selected].map(String),
  );

  const mcr = modelConfigRules(cfg);
  // a rule with enabled === false hides the model (template built-ins are
  // "deleted" this way — the template universe always contains them)
  const disabledByRule = disabledModelIds(mcr, providerId);
  const savedVisible = (id) =>
    (before.has(id) || beforePersonal.has(id) || builtin.has(id)) && !disabledByRule.has(id);

  // checked: add / keep / re-enable. Universe membership (personalModelIds) and
  // ordering (modelOrder) are required for the model to exist at all; the app's
  // builtin recommendation supplies enabled + properties, so no manual rule is
  // written — the model stays on intelligent configuration.
  for (const f of fetched) {
    const id = String(f.id);
    if (!want.has(id)) continue;
    deleted.delete(id);
    if (!order.includes(id)) order.push(id);
    if (!builtin.has(id) && !personal.includes(id)) personal.push(id);
    if (!mcr) continue;
    enableSmartConfig(mcr, providerId, id);
    // re-adding must also clear a hide rule (e.g. a template built-in that was
    // deleted earlier), otherwise the model stays disabled
    if (findSmartRule(mcr, providerId, id)?.config?.enabled === false) enableModel(mcr, providerId, id);
  }

  if (selected !== undefined) {
    // final-state save from the pull modal: unchecked models that are
    // currently SAVED get deleted; unchecked unsaved models only get a
    // tombstone so auto-sync won't force them in later.
    for (const id of fetchedIds) {
      if (want.has(id)) continue;
      deleted.add(id);
      if (!savedVisible(id)) continue;
      if (beforePersonal.has(id)) {
        personal = personal.filter(x => x !== id);
        if (mcr) {
          dropManualRule(mcr, providerId, id);
          unhideModel(mcr, providerId, id);
        }
      }
      order = order.filter(x => x !== id);
      if (builtin.has(id) && !beforePersonal.has(id) && mcr) {
        // template built-in: hide it instead of removing (universe is fixed)
        hideModel(mcr, providerId, id);
      }
    }
  } else {
    // auto-sync adds non-tombstoned ids and prunes tombstoned ones from the
    // ordering; it never removes universe members on its own.
    order = order.filter(id => !deleted.has(id));
    for (const id of want) if (!order.includes(id)) order.push(id);
  }

  c.modelOrder = order;
  c.personalModelIds = personal;
  writeTombstones(entry.key, deleted);
  return { added: fetchedIds.filter(id => want.has(id) && !before.has(id)) };
}

function mergeLegacyModels(cfg, entry, fetched, selected) {
  const deleted = readTombstones(entry.key);
  const want = new Set(
    selected === undefined
      ? fetched.filter(f => !deleted.has(String(f.id))).map(f => String(f.id))
      : [...selected].map(String),
  );
  const p = entry.format === "legacy-array" ? entry.container[entry.idx] : entry.container[entry.key];
  if (!p.models || typeof p.models !== "object" || Array.isArray(p.models)) p.models = {};
  const existing = new Set(Object.keys(p.models));
  const fetchedIds = fetched.map(f => String(f.id));

  // final-state: checked models are added; unchecked models that exist get
  // deleted; unchecked models that don't exist only get a tombstone.
  for (const f of fetched) {
    const id = String(f.id);
    if (want.has(id)) {
      deleted.delete(id);
      if (!p.models[id]) p.models[id] = defaultModelEntry(id, f.visionGuess);
    } else if (existing.has(id)) {
      delete p.models[id];
      deleted.add(id);
    } else {
      deleted.add(id);
    }
  }
  writeTombstones(entry.key, deleted);
  return { added: fetchedIds.filter(id => want.has(id) && !existing.has(id)) };
}

export function mergeFetchedModels(cfg, providerKey, fetched, { selected } = {}) {
  const entry = getProviderEntry(cfg, providerKey);
  if (entry.format === "providerRules") return mergeNewModels(cfg, entry, fetched, selected);
  return mergeLegacyModels(cfg, entry, fetched, selected);
}

export async function syncProvider(cfg, provider, { dialect, selected, timeoutMs } = {}) {
  const { fetchModels } = await import("./providers/index.mjs");
  if (!provider.baseURL) {
    throw new Error(`provider ${provider.id} 没有 config.api.baseUrl，当前配置无法通过模型接口同步`);
  }
  const res = await fetchModels(provider.baseURL, provider.apiKey, { dialect, timeoutMs });
  if (!res.ok) return res;
  const merge = mergeFetchedModels(cfg, provider.key, res.models, { selected });
  return { ok: true, dialect: res.dialect, total: res.models.length, added: merge.added, models: res.models };
}
