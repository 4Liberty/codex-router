// Union Alpha on OpenCode Go Messages advertises a 262,144-token window and a
// 131,072-token output. Compact-at-window-minus-output therefore fires at
// 131,072, which leaves no room for Console Go to add a completion budget on
// top of a prompt it tokenizes independently of Codex.
//
// Live turns reported ~90–100k input tokens — still under that threshold —
// then Console Go answered HTTP 400 "Prompt too long for every available
// model, including the completion". OpenCode itself reserves 32,768 output
// tokens when estimating whether a prompt will fit. Cap the Messages
// `max_tokens` the same way so a still-legal Codex prompt cannot reserve the
// model's full advertised completion against a smaller available backend.
// Do not invent effort rungs here; OpenCode publishes `reasoning_options=[]`.

export const UNION_ALPHA_MESSAGES_PROVIDER = "opencode-go-messages";
export const UNION_ALPHA_UPSTREAM_MODEL = "union-alpha";
export const UNION_ALPHA_COMPLETION_CAP = 32_768;

export function isUnionAlphaMessagesRoute(model) {
  return model?.provider === UNION_ALPHA_MESSAGES_PROVIDER
    && model?.upstreamModel === UNION_ALPHA_UPSTREAM_MODEL;
}

function positiveTokenLimit(value) {
  const tokens = Number(value);
  return Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : undefined;
}

export function clampUnionAlphaCompletion(payload, model) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (!isUnionAlphaMessagesRoute(model)) return payload;
  for (const field of ["max_tokens", "max_output_tokens"]) {
    const tokens = positiveTokenLimit(payload[field]);
    if (tokens !== undefined && tokens > UNION_ALPHA_COMPLETION_CAP) {
      payload[field] = UNION_ALPHA_COMPLETION_CAP;
    }
  }
  return payload;
}
