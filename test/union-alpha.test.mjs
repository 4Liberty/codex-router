import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "union-alpha-test-"));
process.env.MODEL_ROUTER_USER_MODELS = path.join(testRoot, "user-models.json");
process.env.MODEL_ROUTER_STATE_DIR = path.join(testRoot, "state");

const { MODEL_BY_SLUG, PROVIDERS } = await import("../src/model-registry.mjs");
const {
  UNION_ALPHA_COMPLETION_CAP,
  clampUnionAlphaCompletion,
  isUnionAlphaMessagesRoute,
} = await import("../src/union-alpha-compat.mjs");

test("OpenCode Go Messages Union Alpha compacts below the live overflow band", () => {
  const model = MODEL_BY_SLUG.get("opencode-go-messages/union-alpha");
  assert.equal(PROVIDERS.get(model.provider).protocol, "anthropic");
  assert.equal(model.contextWindow, 262_144);
  assert.equal(model.autoCompact, 80_000);
  assert.ok(model.autoCompact < 90_000);
  assert.ok(model.contextWindow - model.autoCompact >= 131_072);
  assert.deepEqual(model.reasoningLevels.map((level) => level.effort), ["high"]);
  assert.equal(isUnionAlphaMessagesRoute(model), true);
});

test("OpenRouter Union Alpha is a separate route this compact policy does not own", () => {
  const model = MODEL_BY_SLUG.get("openrouter/union-alpha");
  if (!model) return;
  assert.equal(isUnionAlphaMessagesRoute(model), false);
  const payload = { max_tokens: 131_072 };
  assert.equal(clampUnionAlphaCompletion(payload, model), payload);
  assert.equal(payload.max_tokens, 131_072);
});

test("Union Alpha Messages caps an oversized completion budget and leaves smaller ones", () => {
  const model = MODEL_BY_SLUG.get("opencode-go-messages/union-alpha");
  const oversized = { max_tokens: 131_072, max_output_tokens: 200_000 };
  assert.equal(clampUnionAlphaCompletion(oversized, model), oversized);
  assert.equal(oversized.max_tokens, UNION_ALPHA_COMPLETION_CAP);
  assert.equal(oversized.max_output_tokens, UNION_ALPHA_COMPLETION_CAP);

  const modest = { max_tokens: 4096 };
  clampUnionAlphaCompletion(modest, model);
  assert.equal(modest.max_tokens, 4096);

  const sibling = {
    max_tokens: 131_072,
  };
  clampUnionAlphaCompletion(sibling, MODEL_BY_SLUG.get("opencode-go-messages/minimax-m3"));
  assert.equal(sibling.max_tokens, 131_072);
});
