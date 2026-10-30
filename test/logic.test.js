"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { buildPrompt, readyModels, filterChats } = require("../plugin/logic");
test("conversation context includes saved instructions and preserves chronological roles", () => {
  const result = buildPrompt([{ role: "user", content: "First question" }, { role: "assistant", content: "First reply" }, { role: "user", content: "Follow up" }], "Be concise");
  assert.match(result.prompt, /Instructions: Be concise/); assert.match(result.prompt, /User: First question\nAssistant: First reply\nUser: Follow up\n/); assert.equal(result.omitted, 0);
});
test("long history drops oldest complete messages while keeping the newest prompt intact", () => {
  const last = "Newest question", result = buildPrompt([{ role: "user", content: "x".repeat(15000) }, { role: "assistant", content: "y".repeat(2000) }, { role: "user", content: last }]);
  assert.ok(result.prompt.length <= 16000); assert.equal(result.omitted, 1); assert.ok(result.prompt.includes(last)); assert.ok(!result.prompt.includes("x".repeat(100)));
});
test("oversized latest messages are rejected rather than truncated", () => { assert.throws(() => buildPrompt([{ role: "user", content: "x".repeat(16000) }]), /too long/); });
test("a full UI message fits alongside bounded legacy system instructions", () => { const result = buildPrompt([{ role: "user", content: "x".repeat(12000) }], "s".repeat(4000)); assert.equal(result.systemTrimmed, true); assert.ok(result.prompt.length <= 16000); assert.equal(result.omitted, 0); });
test("only installed ready models are offered and missing labels use the alias", () => { assert.deepEqual(readyModels([{ alias: "a", status: "ready" }, { alias: "b", status: "downloading" }, { alias: "c", status: "missing" }, null]), [{ alias: "a", label: "a" }]); });
test("saved conversations filter by case-insensitive title without modifying the list", () => { const chats = [{ title: "Weekend plans" }, { title: "WORK" }]; assert.deepEqual(filterChats(chats, " work "), [chats[1]]); assert.equal(chats.length, 2); });
