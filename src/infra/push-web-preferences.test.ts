import { describe, expect, it } from "vitest";
import {
  isWebPushQuietHours,
  normalizeWebPushDevicePreferences,
  normalizeWebPushNotificationPreferences,
  resolveEffectiveWebPushPreferences,
  webPushAgentAllowed,
  webPushCategoryEnabled,
} from "./push-web-preferences.js";

describe("Web Push notification preferences", () => {
  it("keeps new attention categories opt-in while preserving approval notifications", () => {
    const preferences = normalizeWebPushNotificationPreferences(undefined);
    expect(preferences.categories).toEqual({
      approvalRequested: true,
      agentFinished: false,
      agentQuestion: false,
      humanMentioned: false,
      scheduledTaskFailed: false,
    });
  });

  it("applies per-device overrides without changing user defaults", () => {
    const defaults = normalizeWebPushNotificationPreferences(undefined);
    const user = {
      ...defaults,
      categories: {
        ...defaults.categories,
        agentQuestion: true,
      },
      detailLevel: "identified" as const,
    };
    const effective = resolveEffectiveWebPushPreferences({
      user,
      device: {
        enabled: true,
        label: "Slot 1",
        categories: { agentQuestion: false, scheduledTaskFailed: true, humanMentioned: true },
      },
    });

    expect(effective.label).toBe("Slot 1");
    expect(effective.detailLevel).toBe("identified");
    expect(webPushCategoryEnabled(effective, "agent-question")).toBe(false);
    expect(webPushCategoryEnabled(effective, "scheduled-task-failed")).toBe(true);
    expect(webPushCategoryEnabled(effective, "human-mentioned")).toBe(true);
    expect(user.categories.agentQuestion).toBe(true);
    expect(user.categories.humanMentioned).toBe(false);
  });

  it.each([
    ["detailed", undefined, undefined],
    ["detailed", 2, undefined],
    ["detailed", "1", undefined],
    ["private", 1, undefined],
    ["identified", 1, undefined],
    [undefined, 1, undefined],
    ["detailed", 1, 1],
  ] as const)(
    "normalizes stored %s detail with consent %s to %s for both preference scopes",
    (detailLevel, answerPreviewConsentVersion, expected) => {
      const stored = { detailLevel, answerPreviewConsentVersion };
      expect(normalizeWebPushNotificationPreferences(stored).answerPreviewConsentVersion).toBe(
        expected,
      );
      expect(normalizeWebPushDevicePreferences(stored).answerPreviewConsentVersion).toBe(expected);
    },
  );

  it.each([
    {
      name: "inherits account consent with account detail",
      user: { detailLevel: "detailed", answerPreviewConsentVersion: 1 },
      device: { categories: { agentFinished: true } },
      detailLevel: "detailed",
      consent: 1,
    },
    {
      name: "keeps legacy account Detailed labels-only",
      user: { detailLevel: "detailed" },
      device: {},
      detailLevel: "detailed",
      consent: undefined,
    },
    {
      name: "does not apply account consent to a device Detailed override",
      user: { detailLevel: "detailed", answerPreviewConsentVersion: 1 },
      device: { detailLevel: "detailed" },
      detailLevel: "detailed",
      consent: undefined,
    },
    {
      name: "does not apply account consent to a private device",
      user: { detailLevel: "detailed", answerPreviewConsentVersion: 1 },
      device: { detailLevel: "private" },
      detailLevel: "private",
      consent: undefined,
    },
    {
      name: "permits a consented device override of private account defaults",
      user: { detailLevel: "private" },
      device: { detailLevel: "detailed", answerPreviewConsentVersion: 1 },
      detailLevel: "detailed",
      consent: 1,
    },
    {
      name: "does not combine a device consent marker with inherited Detailed",
      user: { detailLevel: "detailed" },
      device: { answerPreviewConsentVersion: 1 },
      detailLevel: "detailed",
      consent: undefined,
    },
  ])("$name", ({ user, device, detailLevel, consent }) => {
    const effective = resolveEffectiveWebPushPreferences({ user, device });
    expect(effective.detailLevel).toBe(detailLevel);
    expect(effective.answerPreviewConsentVersion).toBe(consent);
  });

  it("handles overnight quiet hours in the configured time zone", () => {
    const defaults = normalizeWebPushNotificationPreferences(undefined);
    const effective = resolveEffectiveWebPushPreferences({
      user: {
        ...defaults,
        quietHours: {
          enabled: true,
          startMinute: 22 * 60,
          endMinute: 7 * 60,
          timeZone: "America/Chicago",
        },
      },
    });
    expect(isWebPushQuietHours(effective, Date.parse("2026-08-28T04:30:00Z"))).toBe(true);
    expect(isWebPushQuietHours(effective, Date.parse("2026-08-28T18:00:00Z"))).toBe(false);
  });

  it("normalizes device labels and agent allowlists", () => {
    const device = normalizeWebPushDevicePreferences({
      enabled: true,
      label: "  Production  ",
      agentIds: ["main", "main", "research"],
    });
    const effective = resolveEffectiveWebPushPreferences({ device });
    expect(device.label).toBe("Production");
    expect(effective.agentIds).toEqual(["main", "research"]);
    expect(webPushAgentAllowed(effective, "main")).toBe(true);
    expect(webPushAgentAllowed(effective, "other")).toBe(false);
  });
});
