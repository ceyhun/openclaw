import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core";
import { findGraphemeChunkEnd } from "@openclaw/normalization-core/grapheme";
import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";
import type { WebPushNotificationCategory } from "../../packages/gateway-protocol/src/schema/push.js";
import { stripInternalMetadataForDisplay } from "../auto-reply/reply/display-text-sanitize.js";
import { isSilentReplyPayloadText } from "../auto-reply/tokens.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCronExecutionId } from "../cron/run-id.js";
import { sanitizeExecApprovalDisplayTextWithStatus } from "../infra/exec-approval-text-sanitize.js";
import {
  isWebPushQuietHours,
  normalizeWebPushDisplayLabel,
  webPushAgentAllowed,
  webPushCategoryEnabled,
} from "../infra/push-web-preferences.js";
import {
  hasBoundWebPushSubscriptions,
  prepareWebPushNotificationSender,
  type BoundWebPushSubscription,
} from "../infra/push-web.js";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";
import { resolveRawAssistantAnswerText } from "../shared/assistant-answer-text.js";
import { projectAssistantDisplayContent } from "../shared/assistant-display-content.js";
import {
  isOpenClawMessageToolMirrorAssistantMessage,
  isTranscriptOnlyOpenClawAssistantMessage,
} from "../shared/transcript-only-openclaw-assistant.js";
import { takeAssistantManagedMediaUrlsForDisplay } from "./chat-display-projection.helpers.js";
import { projectChatDisplayMessage } from "./chat-display-projection.js";
import { resolveControlUiWebPushUrl } from "./control-ui-shared.js";
import {
  normalizeLiveAssistantBufferedText,
  projectLiveAssistantBufferedText,
} from "./live-chat-projector.js";
import { QUESTIONS_SCOPE } from "./method-scopes.js";
import { ADMIN_SCOPE, READ_SCOPE } from "./operator-scopes.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import { canReceiveSessionEvent } from "./session-sharing.js";
import {
  listCurrentWebPushTargets,
  withCurrentWebPushAuthority,
  webPushTargetClient,
  webPushSessionAccess,
} from "./web-push-authority.js";

const EVENT_PUSH_TTL_SECONDS = 5 * 60;
// Match the session-preview default, including the truncation ellipsis.
const ANSWER_PREVIEW_MAX_LENGTH = 240;
// Match the display sanitizer's 16K-code-unit budget before Markdown parsing,
// whose malformed-link patterns can otherwise rescan an arbitrarily long answer.
const ANSWER_PREVIEW_MAX_INPUT_LENGTH = 16 * 1024;
const defaultLog = createSubsystemLogger("gateway/web-push");

type EventNotification = {
  category: WebPushNotificationCategory;
  title: string;
  body: string;
  identifiedBody?: string;
  answerText?: string;
  tag: string;
  path?: string;
};

/** Null suppresses completion; empty text permits a visible nontext answer's fallback. */
function resolveCompletedAnswerText(value: Record<string, unknown>): string | null {
  const message = isRecord(value.message) ? value.message : undefined;
  if (
    !message ||
    message.role !== "assistant" ||
    message.display === false ||
    value.errorMessage != null ||
    message.errorMessage != null ||
    message.isError === true ||
    [value.stopReason, message.stopReason].some(
      (reason) => reason === "error" || reason === "aborted",
    ) ||
    isTranscriptOnlyOpenClawAssistantMessage(message) ||
    isOpenClawMessageToolMirrorAssistantMessage(message)
  ) {
    return null;
  }
  // Select final-answer phases before the history projector flattens mixed tool
  // content and discards text signatures. Its visibility decision still applies.
  const answer = resolveRawAssistantAnswerText(projectAssistantDisplayContent(message));
  if (isSilentReplyPayloadText(answer)) {
    return null;
  }
  // Reject failures before the display projector can turn them into friendly error copy.
  const projected = projectChatDisplayMessage(message, { maxChars: Number.MAX_SAFE_INTEGER });
  if (!projected) {
    return null;
  }
  const managedMedia = takeAssistantManagedMediaUrlsForDisplay({ ...message }, "assistant");
  const normalized = normalizeLiveAssistantBufferedText(stripInternalMetadataForDisplay(answer), {
    final: true,
    managedMediaUrls: managedMedia.urls,
  });
  if (isSilentReplyPayloadText(normalized)) {
    return null;
  }
  const visible = projectLiveAssistantBufferedText(normalized, { suppressLeadFragments: false });
  if (answer.trim()) {
    return visible.suppress ? null : visible.text;
  }
  // Tool calls/results and reasoning are not visible completion fallbacks. The
  // producer can legitimately finish with a canvas or media answer and no prose.
  return Array.isArray(projected.content) &&
    projected.content.some(
      (block) =>
        isRecord(block) &&
        ["canvas", "image", "audio", "video", "attachment"].includes(String(block.type)),
    )
    ? ""
    : null;
}

function normalizeAnswerPreview(answer: string): string | undefined {
  if (answer.length > ANSWER_PREVIEW_MAX_INPUT_LENGTH) {
    return undefined;
  }
  const sanitized = sanitizeExecApprovalDisplayTextWithStatus(flattenMarkdownToPlainText(answer));
  // Never surface an approval-specific size diagnostic as an assistant answer.
  if (sanitized.oversized || !sanitized.text) {
    return undefined;
  }
  if (sanitized.text.length <= ANSWER_PREVIEW_MAX_LENGTH) {
    return sanitized.text;
  }
  const end = findGraphemeChunkEnd(
    sanitized.text,
    0,
    ANSWER_PREVIEW_MAX_LENGTH - 1,
    ANSWER_PREVIEW_MAX_LENGTH - 1,
    false,
  );
  const prefix = sanitized.text.slice(0, end).trimEnd();
  return prefix ? `${prefix}…` : undefined;
}

export type HumanMentionWebPush = {
  id: string;
  recipientProfileId: string;
  sessionKey: string;
  agentId: string;
  senderLabel?: string;
  sessionTitle?: string;
  isCurrent: () => boolean;
};

function resolveEventWebPushNotification(
  event: string,
  payload: unknown,
): EventNotification | null {
  const value = isRecord(payload) ? payload : null;
  if (!value) {
    return null;
  }
  if (event === "question.requested") {
    const id = normalizeWebPushDisplayLabel(value.id) ?? "pending";
    const questionId = normalizeOptionalString(value.id);
    return {
      category: "agent-question",
      title: "OpenClaw needs an answer",
      body: "An agent has a question for you.",
      tag: `openclaw-question-${id}`,
      ...(questionId ? { path: `ask/${encodeURIComponent(questionId)}` } : {}),
    };
  }
  if (event === "chat" && value.state === "final" && value.yielded !== true) {
    const answerText = resolveCompletedAnswerText(value);
    if (answerText === null) {
      return null;
    }
    const runId = normalizeWebPushDisplayLabel(value.runId) ?? "finished";
    return {
      category: "agent-finished",
      title: "OpenClaw agent finished",
      body: "An agent completed its response.",
      answerText,
      tag: `openclaw-agent-finished-${runId}`,
    };
  }
  if (event === "cron" && value.action === "finished" && value.status === "error") {
    const job = isRecord(value.job) ? value.job : null;
    const jobId = normalizeOptionalString(value.jobId);
    const jobTag = normalizeWebPushDisplayLabel(jobId) ?? "failed";
    const jobName = normalizeWebPushDisplayLabel(job?.name);
    const query = new URLSearchParams();
    if (jobId) {
      query.set("job", jobId);
      const runId =
        normalizeOptionalString(value.runId) ??
        (typeof value.runAtMs === "number" &&
        Number.isSafeInteger(value.runAtMs) &&
        value.runAtMs >= 0
          ? createCronExecutionId(jobId, value.runAtMs)
          : undefined);
      if (runId) {
        query.set("run", runId);
      }
    }
    return {
      category: "scheduled-task-failed",
      title: "OpenClaw scheduled task failed",
      body: "A scheduled task needs attention.",
      ...(jobName ? { identifiedBody: `${jobName} needs attention.` } : {}),
      tag: `openclaw-cron-failed-${jobTag}`,
      path: `automations${query.size ? `?${query}` : ""}`,
    };
  }
  return null;
}

/** Routes attention events to offline browsers without expanding live session visibility. */
export function createEventWebPushDelivery(params: {
  getRuntimeConfig: () => OpenClawConfig;
  log?: Pick<SubsystemLogger, "warn">;
  stateDir?: string;
}) {
  const log = params.log ?? defaultLog;
  const deliver = (
    notification: EventNotification,
    event: string,
    payload?: unknown,
    opts?: GatewayBroadcastOpts,
    mention?: HumanMentionWebPush,
  ): void => {
    void (async () => {
      if (!(await hasBoundWebPushSubscriptions(params.stateDir))) {
        return;
      }
      const sender = await prepareWebPushNotificationSender(params.stateDir);
      const agentId = normalizeOptionalString(
        opts?.agentId ?? (isRecord(payload) ? payload.agentId : undefined),
      );
      const sessionKeys = opts?.sessionKeys ?? [];
      const groupedResults = await withCurrentWebPushAuthority(
        { ...params, sessionKeys, agentId },
        (authority) => {
          const { cfg } = authority;
          const recipientProfileId =
            mention &&
            authority.profile?.readCurrentIdentity(mention.recipientProfileId)?.profileId;
          if (mention && !recipientProfileId) {
            return undefined;
          }
          const sessionKey = mention?.sessionKey ?? sessionKeys[0];
          const sessionPath = sessionKey
            ? buildControlUiSessionPath({
                namespace: "chat",
                sessionKey,
                fallbackAgentId: agentId,
                mainKey: cfg.session?.mainKey,
                exactKey: true,
              })
            : undefined;
          if (mention && !sessionPath) {
            return undefined;
          }
          const path = notification.path ?? sessionPath?.slice(1) ?? "sessions";
          const url = resolveControlUiWebPushUrl(cfg, path);
          const targets = listCurrentWebPushTargets({
            ...authority,
            requiredScopes:
              notification.category === "agent-question"
                ? [READ_SCOPE, QUESTIONS_SCOPE]
                : [READ_SCOPE],
            ...(mention ? { visibilityScopes: [ADMIN_SCOPE] } : {}),
          });
          const agentLabel = normalizeWebPushDisplayLabel(agentId);
          const groups = new Map<
            string,
            { title: string; body: string; subscriptions: BoundWebPushSubscription[] }
          >();
          for (const target of targets) {
            if (mention && target.userProfileId !== recipientProfileId) {
              continue;
            }
            const { preferences } = target;
            if (
              !webPushCategoryEnabled(preferences, notification.category) ||
              isWebPushQuietHours(preferences) ||
              !webPushAgentAllowed(preferences, agentId)
            ) {
              continue;
            }
            const client = webPushTargetClient(target);
            if (
              sessionKeys.length > 0 &&
              !canReceiveSessionEvent({
                cfg,
                client,
                prepared: webPushSessionAccess(authority, client),
                sessionKeys,
                ...(agentId ? { agentId } : {}),
                event,
                payload,
              })
            ) {
              continue;
            }
            if (cfg.gateway?.roles && sessionKeys.length === 0) {
              // Multi-user events without an authoritative session owner are not broadcast offline.
              continue;
            }
            const prefix = preferences.label ? `${preferences.label} · ` : "";
            let title = `${prefix}${notification.title}`;
            let body =
              preferences.detailLevel === "private"
                ? notification.body
                : (notification.identifiedBody ??
                  (agentLabel ? `${agentLabel}: ${notification.body}` : notification.body));
            if (
              notification.category === "agent-finished" &&
              preferences.detailLevel === "detailed"
            ) {
              const sessionLabel =
                sessionKeys.length === 1 && sessionKey
                  ? normalizeWebPushDisplayLabel(
                      authority.sessions.get(sessionKey)?.target?.entry?.label,
                    )
                  : undefined;
              if (sessionLabel) {
                title += ` — ${sessionLabel}`;
              }
              if (preferences.answerPreviewConsentVersion === 1) {
                body = normalizeAnswerPreview(notification.answerText ?? "") ?? body;
              }
            }
            const key = JSON.stringify({ title, body });
            const group = groups.get(key) ?? { title, body, subscriptions: [] };
            group.subscriptions.push(target.subscription);
            groups.set(key, group);
          }
          // The mention owner fences dismissal, expiry, session replacement and Gateway
          // teardown after preparation. No awaited work may separate it from the send.
          if (mention && !mention.isCurrent()) {
            return undefined;
          }
          const topic = createHash("sha256")
            .update(notification.tag)
            .digest("base64url")
            .slice(0, 32);
          return {
            start: () =>
              Promise.all(
                [...groups.values()].map((group) =>
                  sender({
                    subscriptions: group.subscriptions,
                    payload: {
                      title: group.title,
                      body: group.body,
                      tag: notification.tag,
                      renotify: false,
                      url,
                    },
                    deliveryOptions: {
                      TTL: EVENT_PUSH_TTL_SECONDS,
                      urgency: notification.category.includes("failed") ? "high" : "normal",
                      topic,
                    },
                  }),
                ),
              ),
          };
        },
      );
      if (!groupedResults) {
        return;
      }
      const results = groupedResults.flat();
      const failed = results.filter((result) => !result.ok).length;
      if (failed > 0) {
        log.warn("event Web Push delivery failed", {
          category: notification.category,
          attempted: results.length,
          failed,
        });
      }
    })().catch(() => {
      // Transport failures can contain endpoints and payload bytes; log only the closed category.
      log.warn("event Web Push delivery could not complete", { category: notification.category });
    });
  };

  return {
    handleEvent(event: string, payload: unknown, opts?: GatewayBroadcastOpts): void {
      const notification = resolveEventWebPushNotification(event, payload);
      if (notification) {
        deliver(notification, event, payload, opts);
      }
    },
    deliverMention(this: void, mention: HumanMentionWebPush): void {
      const senderLabel = normalizeWebPushDisplayLabel(mention.senderLabel) ?? "Someone";
      const sessionTitle = normalizeWebPushDisplayLabel(mention.sessionTitle);
      const id = createHash("sha256").update(mention.id).digest("base64url");
      deliver(
        {
          category: "human-mentioned",
          title: "OpenClaw mention",
          body: "Someone mentioned you in a conversation.",
          identifiedBody: `${senderLabel} mentioned you${sessionTitle ? ` in ${sessionTitle}` : ""}.`,
          tag: `openclaw-mention-${id}`,
        },
        "human-mentioned",
        undefined,
        { agentId: mention.agentId, sessionKeys: [mention.sessionKey] },
        mention,
      );
    },
  };
}
