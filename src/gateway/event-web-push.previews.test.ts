import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { BoundWebPushSubscription } from "../infra/push-web.js";
import {
  listDevicePairingMock,
  prepareSessionMutationFactsMock,
  listBoundWebPushSubscriptionsMock,
  hasBoundWebPushSubscriptionsMock,
  preparedWebPushSendMock,
  getUserPreferenceValuesMock,
  canReceiveSessionEventMock,
  webPushWarnMock,
  createEventWebPushDelivery,
  authorityCompleted,
  resetAuthorityCompletion,
  boundSubscription,
  assistantAnswer,
  pairedOperator,
  installEventWebPushTestHooks,
} from "./event-web-push.test-harness.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { emitAgentEvent, registerChatRun } from "./server-chat.agent-events.test-helpers.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat.js";
import { GatewayClientRegistry } from "./server/client-registry.js";

installEventWebPushTestHooks();

describe("completed answer previews", () => {
  const sessionKey = "agent:research:thread.1";
  const opts = { sessionKeys: [sessionKey], agentId: "research" };
  const fallback = "research: An agent completed its response.";

  beforeEach(() => {
    const subscription = boundSubscription("browser-device");
    subscription.devicePreferences.detailLevel = "detailed";
    subscription.devicePreferences.answerPreviewConsentVersion = 1;
    listBoundWebPushSubscriptionsMock.mockResolvedValue([subscription]);
    prepareSessionMutationFactsMock.mockResolvedValue({
      readCurrent: () => ({
        target: { entry: { label: "Fitness coach" } },
        membership: new Set(),
      }),
      release: () => {},
    });
  });

  it("keeps recipient detail, consent, and visibility separate while retaining routing and deduplication", async () => {
    const subscriptions = [
      "private",
      "identified",
      "legacy",
      "consented",
      "inherited",
      "denied",
    ].map((id) => boundSubscription(id, "bob"));
    for (const subscription of subscriptions) {
      const id = subscription.deviceId;
      subscription.devicePreferences.detailLevel =
        id === "private" || id === "identified" ? id : "detailed";
      if (id !== "legacy") {
        subscription.devicePreferences.answerPreviewConsentVersion = 1;
      }
      if (id === "inherited") {
        delete subscription.devicePreferences.detailLevel;
        delete subscription.devicePreferences.answerPreviewConsentVersion;
      }
    }
    listBoundWebPushSubscriptionsMock.mockResolvedValue(subscriptions);
    listDevicePairingMock.mockReturnValue({
      paired: subscriptions.map((s) => pairedOperator(s.deviceId)),
    });
    getUserPreferenceValuesMock.mockResolvedValue({
      values: new Map([["bob", { detailLevel: "detailed", answerPreviewConsentVersion: 1 }]]),
      isCurrent: () => true,
    });
    canReceiveSessionEventMock.mockImplementation(
      ({ client }) => client.connect.device.id !== "denied",
    );
    const delivery = createEventWebPushDelivery({ getRuntimeConfig: () => ({}) });
    const event = {
      state: "final",
      runId: "preview-run",
      message: assistantAnswer(
        "**Today’s session:** upper body.\nStart with [push-ups](https://example.test/private). NO_REPLY",
      ),
    };
    delivery.handleEvent("chat", event, opts);
    await authorityCompleted.promise;
    const byDevice = new Map(
      preparedWebPushSendMock.mock.calls.flatMap(([request]) =>
        request.subscriptions.map((s: BoundWebPushSubscription) => [s.deviceId, request.payload]),
      ),
    );
    expect(new Set(byDevice.keys())).toEqual(
      new Set(["consented", "identified", "inherited", "legacy", "private"]),
    );
    expect(byDevice.get("private")).toMatchObject({
      title: "OpenClaw agent finished",
      body: "An agent completed its response.",
    });
    expect(byDevice.get("identified")).toMatchObject({
      title: "OpenClaw agent finished",
      body: fallback,
    });
    expect(byDevice.get("legacy")).toMatchObject({
      title: "OpenClaw agent finished — Fitness coach",
      body: fallback,
    });
    for (const id of ["consented", "inherited"]) {
      expect(byDevice.get(id)).toEqual({
        title: "OpenClaw agent finished — Fitness coach",
        body: "Today’s session: upper body. Start with push-ups.",
        tag: "openclaw-agent-finished-preview-run",
        renotify: false,
        url: "chat/research/thread%2E1",
      });
    }
    const topics = preparedWebPushSendMock.mock.calls.map(
      ([request]) => request.deliveryOptions.topic,
    );
    expect(new Set(topics).size).toBe(1);
    const initial = preparedWebPushSendMock.mock.calls.map(([request]) => request.payload);
    preparedWebPushSendMock.mockClear();
    resetAuthorityCompletion();
    delivery.handleEvent("chat", event, opts);
    await authorityCompleted.promise;
    expect(preparedWebPushSendMock.mock.calls.map(([request]) => request.payload)).toEqual(initial);
  });

  it.each([
    { name: "missing terminal message", message: undefined },
    { name: "silent reply", message: assistantAnswer("NO_REPLY") },
    { name: "silent JSON reply", message: assistantAnswer('{"action":"NO_REPLY"}') },
    {
      name: "empty explicit final with stale unphased text",
      message: assistantAnswer("", {
        content: [
          { type: "text", text: "STALE_PRIVATE_LEGACY" },
          { type: "toolCall", name: "read", arguments: {} },
          {
            type: "text",
            text: "",
            textSignature: JSON.stringify({ v: 1, id: "final", phase: "final_answer" }),
          },
        ],
      }),
    },
    {
      name: "silent canvas",
      message: assistantAnswer("NO_REPLY", {
        content: [
          { type: "text", text: "NO_REPLY" },
          { type: "canvas", preview: { kind: "canvas" } },
        ],
      }),
    },
    { name: "control reply", message: assistantAnswer("ANNOUNCE_SKIP") },
    { name: "hidden answer", message: assistantAnswer("Hidden", { display: false }) },
    {
      name: "reasoning only",
      message: assistantAnswer("", {
        content: [{ type: "thinking", thinking: "Private reasoning" }],
      }),
    },
    {
      name: "tool call only",
      message: assistantAnswer("", {
        content: [{ type: "toolCall", name: "exec", arguments: { command: "private" } }],
      }),
    },
    {
      name: "tool result",
      message: { role: "toolResult", content: [{ type: "text", text: "Private result" }] },
    },
    {
      name: "commentary only",
      message: assistantAnswer("Still working", { phase: "commentary" }),
    },
    {
      name: "diagnostics only",
      message: assistantAnswer("", { diagnostics: "Private diagnostic" }),
    },
    {
      name: "raw failure",
      message: assistantAnswer("Private error", {
        stopReason: "error",
        errorMessage: "Raw provider details",
      }),
    },
    { name: "aborted answer", message: assistantAnswer("Partial", { stopReason: "aborted" }) },
    {
      name: "delivery mirror",
      message: assistantAnswer("Mirror", { provider: "openclaw", model: "delivery-mirror" }),
    },
    {
      name: "message-tool mirror",
      message: assistantAnswer("Mirror", { openclawMessageToolMirror: {} }),
    },
    { name: "internal trace", message: assistantAnswer("🛠️ Exec: private command") },
  ])("never alerts for $name, at any detail level", async ({ message }) => {
    for (const detailLevel of ["private", "identified", "detailed"] as const) {
      const subscription = boundSubscription("browser-device");
      subscription.devicePreferences = {
        ...subscription.devicePreferences,
        detailLevel,
        answerPreviewConsentVersion: 1,
      };
      listBoundWebPushSubscriptionsMock.mockResolvedValue([subscription]);
      createEventWebPushDelivery({ getRuntimeConfig: () => ({}) }).handleEvent(
        "chat",
        { state: "final", runId: "excluded", message },
        opts,
      );
    }
    await Promise.resolve();
    expect(hasBoundWebPushSubscriptionsMock).not.toHaveBeenCalled();
    expect(preparedWebPushSendMock).not.toHaveBeenCalled();
  });

  it("extracts only the canonical final answer from mixed content", async () => {
    const message = assistantAnswer("", {
      content: [
        { type: "text", text: "STALE_PRIVATE_LEGACY" },
        { type: "thinking", thinking: "Hidden reasoning" },
        {
          type: "text",
          text: "Working",
          textSignature: JSON.stringify({ v: 1, id: "comment", phase: "commentary" }),
        },
        { type: "toolCall", name: "read", arguments: { path: "private" } },
        { type: "toolResult", text: "Private result" },
        {
          type: "text",
          text: "<think>Hidden</think>Final **answer**. REPLY_SKIP",
          textSignature: JSON.stringify({ v: 1, id: "answer", phase: "final_answer" }),
        },
      ],
      diagnostics: "Private diagnostics",
    });
    createEventWebPushDelivery({ getRuntimeConfig: () => ({}) }).handleEvent(
      "chat",
      { state: "final", runId: "mixed", message },
      opts,
    );
    await authorityCompleted.promise;
    expect(preparedWebPushSendMock).toHaveBeenCalledOnce();
    expect(preparedWebPushSendMock.mock.calls[0]?.[0].payload.body).toBe("Final answer.");
  });

  it("uses the display answer and removes its managed media directives", async () => {
    const message = assistantAnswer("PRIVATE_MODEL_CONTENT", {
      openclawDisplayContent: [
        { type: "text", text: "Public result.\nMEDIA:./attachment-catalog-tiny/private.png" },
      ],
      openclawDelivery: { mediaUrls: ["./attachment-catalog-tiny/private.png"] },
    });
    createEventWebPushDelivery({ getRuntimeConfig: () => ({}) }).handleEvent(
      "chat",
      { state: "final", runId: "display-answer", message },
      opts,
    );
    await authorityCompleted.promise;
    expect(preparedWebPushSendMock.mock.calls[0]?.[0].payload.body).toBe("Public result.");
  });

  it.each([
    { name: "exact limit", text: "a".repeat(240), expected: "a".repeat(240) },
    { name: "input limit", text: "a".repeat(16 * 1024), expected: "a".repeat(239) + "…" },
    { name: "oversized malformed Markdown", text: "[".repeat(16 * 1024 + 1), expected: fallback },
    { name: "surrogate pair", text: "a".repeat(238) + "🦞abc", expected: "a".repeat(238) + "…" },
    {
      name: "combining cluster",
      text: "a".repeat(238) + "e\u0301abc",
      expected: "a".repeat(238) + "…",
    },
    { name: "emoji modifier", text: "a".repeat(236) + "👍🏽abc", expected: "a".repeat(236) + "…" },
    { name: "joiner display policy", text: "👩‍💻", expected: "👩\\u{200D}💻" },
    { name: "oversized cluster", text: "a" + "\u0301".repeat(250), expected: fallback },
    { name: "markdown only", text: "```\nprivate code\n```", expected: fallback },
    {
      name: "display controls",
      text: "First\nsecond\tline\u202E\ud800",
      expected: "First second line\\u{202E}\\u{D800}",
    },
    { name: "oversized display", text: "a".repeat(270_000), expected: fallback },
  ])("normalizes $name within the hard preview bound", async ({ text, expected }) => {
    createEventWebPushDelivery({ getRuntimeConfig: () => ({}) }).handleEvent(
      "chat",
      { state: "final", runId: "bounded", message: assistantAnswer(text) },
      opts,
    );
    await authorityCompleted.promise;
    const body = preparedWebPushSendMock.mock.calls[0]?.[0].payload.body;
    expect(body).toBe(expected);
    expect(body.length).toBeLessThanOrEqual(240);
  });

  it.each([undefined, "", "   "])(
    "keeps an answer preview when the session label is %s",
    async (label) => {
      prepareSessionMutationFactsMock.mockResolvedValue({
        readCurrent: () => ({ target: { entry: { label } }, membership: new Set() }),
        release: () => {},
      });
      createEventWebPushDelivery({ getRuntimeConfig: () => ({}) }).handleEvent(
        "chat",
        { state: "final", runId: "no-label", message: assistantAnswer("Useful answer") },
        opts,
      );
      await authorityCompleted.promise;
      expect(preparedWebPushSendMock.mock.calls[0]?.[0].payload).toMatchObject({
        title: "OpenClaw agent finished",
        body: "Useful answer",
      });
    },
  );

  it("does not reveal labels for ambiguous session scope or use labels for routing", async () => {
    createEventWebPushDelivery({ getRuntimeConfig: () => ({}) }).handleEvent(
      "chat",
      { state: "final", runId: "ambiguous", message: assistantAnswer() },
      { ...opts, sessionKeys: [sessionKey, "global"] },
    );
    await authorityCompleted.promise;
    expect(preparedWebPushSendMock.mock.calls[0]?.[0].payload).toMatchObject({
      title: "OpenClaw agent finished",
      body: "Done.",
      url: "chat/research/thread%2E1",
    });
  });

  it("keeps answer bytes out of failure logs", async () => {
    preparedWebPushSendMock.mockRejectedValue(new Error("PRIVATE_ANSWER"));
    const warned = createDeferred();
    webPushWarnMock.mockImplementation(() => warned.resolve());
    createEventWebPushDelivery({ getRuntimeConfig: () => ({}) }).handleEvent(
      "chat",
      { state: "final", runId: "failed-push", message: assistantAnswer("PRIVATE_ANSWER") },
      opts,
    );
    await warned.promise;
    expect(webPushWarnMock.mock.calls).toEqual([
      ["event Web Push delivery could not complete", { category: "agent-finished" }],
    ]);
  });

  it.each([
    "answer",
    "silent",
    "silent-json",
    "commentary",
    "commentary-then-answer",
    "tool-only",
    "canvas",
    "yielded",
    "aborted",
    "error",
  ] as const)("handles real producer/broadcast completion for %s", async (scenario) => {
    vi.useFakeTimers();
    const delivery = createEventWebPushDelivery({ getRuntimeConfig: () => ({}) });
    const terminal = vi.fn();
    const broadcaster = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(),
      onBroadcast(event, payload, options) {
        if (event === "chat" && (payload as { state?: string }).state !== "delta") {
          terminal(payload);
        }
        delivery.handleEvent(event, payload, options);
      },
    });
    const chatRunState = createChatRunState();
    const handler = createAgentEventHandler({
      ...broadcaster,
      nodeSendToSession: vi.fn(),
      nodeHasSessionSubscribers: () => true,
      agentRunSeq: new Map(),
      chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
      toolEventRecipients: chatRunState.toolEventRecipients,
      sessionEventSubscribers: createSessionEventSubscriberRegistry(),
      sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
      persistGatewaySessionLifecycleEventForEvent: vi.fn(async () => undefined),
    });
    try {
      const runId = `producer-${scenario}`;
      registerChatRun(chatRunState, runId, sessionKey, runId);
      if (scenario === "commentary-then-answer") {
        emitAgentEvent(handler, runId, "assistant", {
          text: "Private work in progress.",
          phase: "commentary",
        });
      }
      if (scenario === "canvas") {
        emitAgentEvent(handler, runId, "tool", {
          phase: "result",
          name: "show_widget",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  kind: "canvas",
                  presentation: {
                    target: "assistant_message",
                    title: "Exercise chart",
                    sandbox: "scripts",
                  },
                  view: {
                    id: "exercise",
                    url: "/__openclaw__/canvas/documents/exercise/index.html",
                  },
                }),
              },
            ],
          },
        });
      } else if (scenario === "tool-only") {
        emitAgentEvent(handler, runId, "tool", {
          phase: "result",
          name: "read",
          result: { content: [{ type: "text", text: "Private tool result" }] },
        });
      } else {
        emitAgentEvent(handler, runId, "assistant", {
          text:
            scenario === "silent"
              ? "NO_REPLY"
              : scenario === "silent-json"
                ? '{"action":"NO_REPLY"}'
                : "Completed answer.",
          ...(scenario === "commentary" ? { phase: "commentary" } : {}),
        });
      }
      emitAgentEvent(
        handler,
        runId,
        "lifecycle",
        {
          phase: scenario === "error" ? "error" : "end",
          ...(scenario === "yielded"
            ? { yielded: true, livenessState: "paused", stopReason: "end_turn" }
            : {}),
          ...(scenario === "aborted" ? { aborted: true, stopReason: "aborted" } : {}),
          ...(scenario === "error"
            ? { error: "Raw provider failure", fallbackExhaustedFailure: true }
            : {}),
        },
        { seq: 2 },
      );
      expect(terminal).toHaveBeenCalledOnce();
      if (scenario === "answer" || scenario === "canvas" || scenario === "commentary-then-answer") {
        await authorityCompleted.promise;
        expect(preparedWebPushSendMock).toHaveBeenCalledOnce();
        expect(preparedWebPushSendMock.mock.calls[0]?.[0].payload).toMatchObject({
          body: scenario === "canvas" ? "An agent completed its response." : "Completed answer.",
          url: "chat/research/thread%2E1",
        });
      } else {
        expect(preparedWebPushSendMock).not.toHaveBeenCalled();
        expect(hasBoundWebPushSubscriptionsMock).not.toHaveBeenCalled();
      }
    } finally {
      handler.dispose();
      chatRunState.clear();
      vi.useRealTimers();
    }
  });
});
