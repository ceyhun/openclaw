import { afterEach, beforeEach, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { BoundWebPushSubscription } from "../infra/push-web.js";

const {
  listDevicePairingMock,
  prepareDevicePairingMock,
  authorityCompletedMock,
  prepareUserProfileCatalogMock,
  prepareSessionMutationFactsMock,
  listBoundWebPushSubscriptionsMock,
  hasBoundWebPushSubscriptionsMock,
  prepareWebPushNotificationSenderMock,
  preparedWebPushSendMock,
  readCurrentProfileIdentityMock,
  getUserPreferenceValuesMock,
  resolveOperatorRolePolicyForAssignmentMock,
  canReceiveSessionEventMock,
  mentionCurrentMock,
  webPushWarnMock,
} = vi.hoisted(() => ({
  listDevicePairingMock: vi.fn(),
  prepareDevicePairingMock: vi.fn(),
  authorityCompletedMock: vi.fn(),
  prepareUserProfileCatalogMock: vi.fn(),
  prepareSessionMutationFactsMock: vi.fn(),
  listBoundWebPushSubscriptionsMock: vi.fn(),
  hasBoundWebPushSubscriptionsMock: vi.fn(),
  prepareWebPushNotificationSenderMock: vi.fn(),
  preparedWebPushSendMock: vi.fn(),
  readCurrentProfileIdentityMock: vi.fn(),
  getUserPreferenceValuesMock: vi.fn(),
  resolveOperatorRolePolicyForAssignmentMock: vi.fn(),
  canReceiveSessionEventMock: vi.fn(),
  mentionCurrentMock: vi.fn(),
  webPushWarnMock: vi.fn(),
}));

export {
  listDevicePairingMock,
  prepareDevicePairingMock,
  prepareUserProfileCatalogMock,
  prepareSessionMutationFactsMock,
  listBoundWebPushSubscriptionsMock,
  hasBoundWebPushSubscriptionsMock,
  prepareWebPushNotificationSenderMock,
  preparedWebPushSendMock,
  readCurrentProfileIdentityMock,
  getUserPreferenceValuesMock,
  resolveOperatorRolePolicyForAssignmentMock,
  canReceiveSessionEventMock,
  mentionCurrentMock,
  webPushWarnMock,
};

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/web-push" ? { ...logger, warn: webPushWarnMock } : logger;
    },
  };
});

vi.mock("../infra/device-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/device-pairing.js")>(
    "../infra/device-pairing.js",
  );
  return actual;
});

vi.mock("../infra/device-pairing-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-pairing-worker.js")>()),
  withCurrentDevicePairingSnapshot: async <T>(
    _stateDir: string | undefined,
    prepare: (
      paired: import("../infra/device-pairing.types.js").PairedDevice[],
    ) => { start: () => T } | undefined,
  ) => {
    await prepareDevicePairingMock();
    return prepare(listDevicePairingMock().paired)?.start();
  },
}));

vi.mock("../infra/push-web.js", () => ({
  withBoundWebPushSubscriptions: async <T>(
    stateDir: string | undefined,
    prepare: (
      subscriptions: BoundWebPushSubscription[],
      assertCurrent: () => void,
    ) =>
      | { start: () => T | Promise<T> }
      | undefined
      | Promise<{ start: () => T | Promise<T> } | undefined>,
  ) => {
    try {
      return await (
        await prepare(await listBoundWebPushSubscriptionsMock(stateDir), () => {})
      )?.start();
    } finally {
      authorityCompletedMock();
    }
  },
  hasBoundWebPushSubscriptions: hasBoundWebPushSubscriptionsMock,
  prepareWebPushNotificationSender: prepareWebPushNotificationSenderMock,
}));

vi.mock("../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profile-list.js")>()),
  prepareUserProfileCatalog: prepareUserProfileCatalogMock,
}));

vi.mock("./session-sharing-preparation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-sharing-preparation.js")>()),
  prepareSessionMutationFacts: prepareSessionMutationFactsMock,
}));

vi.mock("../state/user-preferences.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-preferences.js")>()),
  getUserPreferenceValues: getUserPreferenceValuesMock,
}));

vi.mock("./operator-role-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./operator-role-policy.js")>()),
  resolveOperatorRolePolicyForAssignment: resolveOperatorRolePolicyForAssignmentMock,
}));

vi.mock("./session-sharing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-sharing.js")>()),
  canReceiveSessionEvent: canReceiveSessionEventMock,
}));

export const { createEventWebPushDelivery } = await import("./event-web-push.js");
export let authorityCompleted = createDeferred();

export function resetAuthorityCompletion() {
  authorityCompleted = createDeferred();
}

export function boundSubscription(
  deviceId: string,
  userProfileId: string | null = null,
): BoundWebPushSubscription {
  return {
    subscriptionId: `subscription-${deviceId}`,
    endpoint: `https://push.example.test/${deviceId}`,
    keys: { p256dh: `p256dh-${deviceId}`, auth: `auth-${deviceId}` },
    createdAtMs: 1,
    updatedAtMs: 1,
    deviceId,
    userProfileId,
    devicePreferences: {
      enabled: true,
      label: "",
      detailLevel: "identified",
      categories: {
        agentFinished: true,
        agentQuestion: true,
        humanMentioned: true,
        scheduledTaskFailed: true,
      },
    },
  };
}

export function assistantAnswer(text = "Done.", fields: Record<string, unknown> = {}) {
  return { role: "assistant", content: [{ type: "text", text }], ...fields };
}

export function pairedOperator(deviceId: string, scopes = ["operator.read"]) {
  return {
    deviceId,
    roles: ["operator"],
    role: "operator",
    scopes,
    approvedScopes: scopes,
    tokens: {
      operator: { token: `token-${deviceId}`, role: "operator", scopes },
    },
  };
}

export function installEventWebPushTestHooks() {
  beforeEach(() => {
    vi.clearAllMocks();
    listBoundWebPushSubscriptionsMock.mockResolvedValue([boundSubscription("browser-device")]);
    hasBoundWebPushSubscriptionsMock.mockResolvedValue(true);
    listDevicePairingMock.mockReturnValue({
      pending: [],
      paired: [pairedOperator("browser-device")],
    });
    prepareWebPushNotificationSenderMock.mockResolvedValue(preparedWebPushSendMock);
    preparedWebPushSendMock.mockResolvedValue([]);
    prepareDevicePairingMock.mockResolvedValue(undefined);
    resetAuthorityCompletion();
    authorityCompletedMock.mockImplementation(() => authorityCompleted.resolve());
    prepareUserProfileCatalogMock.mockResolvedValue({
      readCurrentIdentity: readCurrentProfileIdentityMock,
      release: () => {},
    });
    prepareSessionMutationFactsMock.mockResolvedValue({
      readCurrent: () => ({ target: null, membership: new Set<string>() }),
      release: () => {},
    });
    readCurrentProfileIdentityMock.mockImplementation((profileId: string) => ({
      profileId,
      role: null,
      aliases: new Set([profileId]),
    }));
    getUserPreferenceValuesMock.mockResolvedValue({ values: new Map(), isCurrent: () => true });
    resolveOperatorRolePolicyForAssignmentMock.mockReturnValue(undefined);
    canReceiveSessionEventMock.mockReturnValue(true);
    mentionCurrentMock.mockReturnValue(true);
  });

  afterEach(() => vi.restoreAllMocks());
}
