// The pull-modal "远程已无" group hands mergeFetchedModels a fetched list that
// includes locally-saved models the remote no longer returns. Unchecked ones
// must be deleted (order + personal + rules), checked ones kept untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolateState, makeFixture } from "./helpers.mjs";
import { mergeFetchedModels } from "../src/config.mjs";

const tmpRoot = isolateState();
makeFixture(tmpRoot);

function readTombstoneList(providerKey) {
  const p = path.join(process.env.ZCODE_SUITE_STATE_DIR, "state.json");
  try {
    const st = JSON.parse(fs.readFileSync(p, "utf8"));
    return (st.deletedModels && st.deletedModels[providerKey]) || [];
  } catch {
    return [];
  }
}

function fixtureConfig() {
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [{
          providerId: "np",
          providerName: "N",
          config: {
            api: { type: "openai-chat-completions", baseUrl: "https://x/v1" },
            access: { apiKey: "k" },
            modelOrder: ["old-model", "m2"],
            personalModelIds: ["old-model", "m2"],
            builtinModelIds: ["tpl-a"],
          },
        }],
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  };
}
const providerKey = "np";

test("unchecking a locally-only model deletes it and Tombstones it", () => {
  const cfg = fixtureConfig();
  const res = mergeFetchedModels(cfg, providerKey, [{ id: "m1" }, { id: "m2" }], { selected: ["m1"] });
  const c = cfg.config.providerConfigRules.providerRules[0].config;
  assert.ok(!c.modelOrder.includes("m2"), "m2 must leave modelOrder");
  assert.ok(!c.personalModelIds.includes("m2"), "m2 must leave personalModelIds");
  assert.ok(readTombstoneList(providerKey).includes("m2"), "m2 tombstoned");
  assert.deepEqual(res.added, ["m1"]);
});

test("keeping a locally-only model checked leaves it in place", () => {
  const cfg = fixtureConfig();
  const rules = cfg.config.modelConfigRules.providerModelRules;
  rules.push({ providerId: "np", modelId: "m2", config: { enabled: true, optionSpecs: { reasoningLevel: { map: "remote-map-text" } } } });
  const before = JSON.stringify(rules[0]);
  const res = mergeFetchedModels(cfg, providerKey, [{ id: "m1" }, { id: "m2" }], { selected: ["m1", "m2"] });
  const c = cfg.config.providerConfigRules.providerRules[0].config;
  assert.ok(c.modelOrder.includes("m2") && c.personalModelIds.includes("m2"), "m2 stays");
  assert.equal(JSON.stringify(rules[0]), before, "m2 rule untouched");
  assert.deepEqual(res.added, ["m1"]);
});
