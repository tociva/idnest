import {
  bootstrapFirstSystemAdmin,
  claimAuthConsentTransaction,
  claimAuthTransactionCompletion,
  createAuthConsentTransaction,
  createAuthTransaction,
  findAuthConsentTransactionByTokenHash,
  findAuthTransactionByChallengeHash,
  findAuthTransactionByKratosFlowId,
  findAuthTransactionByTokenHash,
  getAuthzPool,
  hasActiveClientAccess,
  recordAuthAuditEvent,
  releaseAuthTransactionForStepUp,
  resolveAuthConfiguration,
  setAuthConsentTransactionResult,
  setAuthTransactionResult,
  bindAuthTransactionFlow,
  type AuthConsentTransactionRecord,
  type AuthTransactionRecord,
} from "@idnest/authz-store";
import {
  DEFAULT_AUTH_POLICY,
  DEFAULT_IDNEST_BRAND,
  identityGateRequiresClientGrant,
  normalizeClientHomeUrl,
  publicAuthRecoveryForClient,
  toPublicPolicy,
  toUserClaims,
  type AuthPolicyDefinition,
  type HydraConsentRequest,
  type HydraLoginRequest,
  type KratosFlow,
  type KratosSession,
  type PublicAuthRecovery,
  type ResolvedAuthConfiguration,
} from "@idnest/shared-types";
import { createHmac, randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import {
  getAdminBootstrapEmails,
  getAdminOidcClientId,
  getAuthAuditHashSecret,
  getAuthBaseUrl,
  getAuthBrandingMode,
  getAuthTransactionTtlSeconds,
  getAuthUiBasePath,
  getAuthzDatabaseUrl,
  getKratosPublicUrl,
  getStrictUnmappedClients,
} from "./config";
import {
  acceptHydraConsent,
  acceptHydraLogin,
  getHydraConsentRequest,
  getHydraLoginRequest,
  rejectHydraConsent,
  rejectHydraLogin,
} from "./hydra-admin";
import * as kratos from "./kratos-public";
import { identityAal2Capability } from "./kratos-admin";
import {
  evaluateAuthenticationPolicy,
  requestedKratosAal,
  shouldRequireFreshLogin,
} from "./authentication-policy";
import {
  isSettingsPrivilegedReauthFlow,
  settingsResumeUrlFromFlow,
  transactionTokenFromFlow as transactionTokenFromBoundFlow,
} from "./login-flow-binding";
import {
  createActionToken,
  createOpaqueToken,
  decryptSensitiveValue,
  encryptSensitiveValue,
  hashOpaqueValue,
  verifyActionToken,
} from "./transaction-crypto";
import { renderError } from "./views";

function first(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

function database() {
  const pool = getAuthzPool(getAuthzDatabaseUrl());
  if (!pool) throw new Error("AUTHZ_DATABASE_URL is not configured");
  return pool;
}

function noStore(res: Response): void {
  res.set("Cache-Control", "no-store, max-age=0");
  res.set("Pragma", "no-cache");
}

function rateLimit(maximum: number, windowMs: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const previous = buckets.get(key);
    const bucket =
      !previous || previous.resetAt <= now
        ? { count: 0, resetAt: now + windowMs }
        : previous;
    bucket.count += 1;
    buckets.set(key, bucket);
    if (buckets.size > 5_000) {
      for (const [candidate, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(candidate);
      }
    }
    res.set("RateLimit-Limit", String(maximum));
    res.set("RateLimit-Remaining", String(Math.max(0, maximum - bucket.count)));
    res.set("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > maximum) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      res.status(429).json({ error: "too_many_requests" });
      return;
    }
    next();
  };
}

function sendNeutralError(
  res: Response,
  code: string,
  description: string,
  status = 400,
  recovery: PublicAuthRecovery = { kind: "request_context_unavailable" },
): void {
  noStore(res);
  res.status(status).type("html").send(renderError({
    safeDetails: { error: code, error_description: description },
    hint: status >= 500 ? "Authentication is temporarily unavailable. Please try again." : description,
    recovery,
  }));
}

function publicUiUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(`${getAuthUiBasePath()}${path}`, `${getAuthBaseUrl()}/`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

function completionUrl(token: string): string {
  const url = new URL("/oauth2/login/complete", `${getAuthBaseUrl()}/`);
  url.searchParams.set("transaction", token);
  return url.toString();
}

function maskedRequestMetadata(req: Request): {
  correlationId: string;
  ipHash: string;
  userAgentCategory: string;
} {
  const correlationId =
    (typeof req.headers["x-request-id"] === "string" && req.headers["x-request-id"]) || randomUUID();
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const ipHash = createHmac("sha256", getAuthAuditHashSecret()).update(ip).digest("base64url");
  const ua = req.headers["user-agent"] ?? "";
  const userAgentCategory = /mobile|android|iphone/i.test(ua)
    ? "mobile"
    : /bot|crawler|spider/i.test(ua)
      ? "bot"
      : "desktop";
  return { correlationId, ipHash, userAgentCategory };
}

async function audit(
  req: Request,
  eventType: string,
  resolved: ResolvedAuthConfiguration,
  extra: {
    identityId?: string;
    result?: string;
    failureCode?: string;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const meta = maskedRequestMetadata(req);
  await recordAuthAuditEvent(database(), {
    eventType,
    hydraClientId: resolved.client.hydraClientId,
    brandId: resolved.client.brandId,
    authenticationPolicyId: resolved.client.authPolicyId,
    identityId: extra.identityId,
    result: extra.result,
    failureCode: extra.failureCode,
    correlationId: meta.correlationId,
    ipHash: meta.ipHash,
    userAgentCategory: meta.userAgentCategory,
    metadata: extra.metadata,
  }).catch(() => undefined);
}

async function accessAllowed(
  session: KratosSession,
  policy: AuthPolicyDefinition,
  clientId: string,
): Promise<boolean> {
  if (!identityGateRequiresClientGrant(policy.identityGate)) return true;
  const email = String(session.identity.traits?.email ?? "").trim().toLowerCase();
  if (clientId === getAdminOidcClientId() && getAdminBootstrapEmails().includes(email)) {
    await bootstrapFirstSystemAdmin(database(), {
      identityId: session.identity.id,
      clientId,
      grantedBy: "bootstrap-email",
    });
  }
  return hasActiveClientAccess(database(), session.identity.id, clientId);
}

function requestedMaximumAge(request: HydraLoginRequest): number | undefined {
  const value = request.oidc_context?.max_age;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function resolvedFromAuthTransaction(transaction: AuthTransactionRecord): ResolvedAuthConfiguration {
  return {
    client: transaction.client_config_snapshot,
    brand: transaction.brand_snapshot,
    policy: transaction.policy_snapshot,
    usedFallback: transaction.client_config_snapshot.mappingVersion === 0,
  };
}

function resolvedFromConsentTransaction(
  transaction: AuthConsentTransactionRecord,
): ResolvedAuthConfiguration {
  return {
    client: transaction.client_config_snapshot,
    brand: transaction.brand_snapshot,
    policy: transaction.policy_snapshot,
    usedFallback: transaction.client_config_snapshot.mappingVersion === 0,
  };
}

function recoveryFromAuthTransaction(transaction: AuthTransactionRecord): PublicAuthRecovery {
  return publicAuthRecoveryForClient(
    transaction.client_config_snapshot,
    transaction.brand_snapshot.productName,
  );
}

function recoveryFromConsentTransaction(
  transaction: AuthConsentTransactionRecord,
): PublicAuthRecovery {
  return publicAuthRecoveryForClient(
    transaction.client_config_snapshot,
    transaction.brand_snapshot.productName,
  );
}

function transactionTokenFromFlow(flow: KratosFlow): string | null {
  return transactionTokenFromBoundFlow(flow, getAuthBaseUrl());
}

function isAal2StepUpFlow(flow: KratosFlow): boolean {
  try {
    return new URL(flow.request_url ?? "").searchParams.get("aal") === "aal2";
  } catch {
    return false;
  }
}

/** Permissive policy for privileged settings re-auth (OIDC + any enrolled factors). */
const SETTINGS_REAUTH_POLICY: AuthPolicyDefinition = {
  ...DEFAULT_AUTH_POLICY,
  totpEnabled: true,
  passkeyEnabled: true,
  allowedOidcProviders: ["google", "apple"],
};

function settingsReauthContext(flow: KratosFlow) {
  const resumeUrl = settingsResumeUrlFromFlow(flow, {
    authBaseUrl: getAuthBaseUrl(),
    kratosPublicUrl: getKratosPublicUrl(),
  });
  const brand: typeof DEFAULT_IDNEST_BRAND = {
    ...DEFAULT_IDNEST_BRAND,
    loginHeading: "Confirm it's you",
    loginDescription: "Verify your identity to continue changing account settings.",
  };
  return {
    transactionId: "",
    client: {
      id: "settings",
      displayName: brand.productName,
    },
    recovery: { kind: "request_context_unavailable" as const },
    brand,
    policy: toPublicPolicy(SETTINGS_REAUTH_POLICY),
    expiresAt: flow.expires_at ?? new Date(Date.now() + 10 * 60_000).toISOString(),
    purpose: "settings_reauth" as const,
    settingsResumeUrl: resumeUrl,
  };
}

function allowedGroup(group: string, policy: AuthPolicyDefinition): boolean {
  if (group === "default" || group === "profile") return true;
  if (group === "password") return policy.passwordEnabled;
  if (group === "oidc") return policy.allowedOidcProviders.length > 0;
  if (group === "totp" || group === "lookup_secret") return policy.totpEnabled;
  if (group === "passkey" || group === "webauthn") return policy.passkeyEnabled;
  return false;
}

function publicFlow(flow: KratosFlow, policy: AuthPolicyDefinition): KratosFlow {
  const kratosOrigin = new URL(getKratosPublicUrl()).origin;
  const action = new URL(flow.ui.action);
  if (action.origin !== kratosOrigin || !action.pathname.startsWith("/self-service/")) {
    throw new Error("Kratos returned an untrusted flow action");
  }
  const nodes = flow.ui.nodes.filter((node) => {
    if (node.attributes.type === "hidden") return true;
    if (!allowedGroup(node.group, policy)) return false;
    if (node.group === "oidc" && node.attributes.name === "provider") {
      return (
        typeof node.attributes.value === "string" &&
        policy.allowedOidcProviders.includes(node.attributes.value)
      );
    }
    return true;
  });
  return { ...flow, ui: { ...flow.ui, nodes } };
}

async function rejectLoginAndRedirect(
  transaction: AuthTransactionRecord,
  challenge: string,
  code: string,
  description: string,
): Promise<string> {
  const redirectTo = await rejectHydraLogin(challenge, code, description);
  await setAuthTransactionResult(database(), {
    id: transaction.id,
    status: "rejected",
    failureCode: code,
  });
  return redirectTo;
}

type LoginCompletionResult =
  | { outcome: "accepted"; redirectTo: string }
  | { outcome: "denied"; redirectTo: string; failureCode: string }
  | { outcome: "aal2_required"; subject: string };

async function completeLoginWithSession(
  req: Request,
  transaction: AuthTransactionRecord,
  request: HydraLoginRequest,
  session: KratosSession,
): Promise<LoginCompletionResult> {
  const resolved = resolvedFromAuthTransaction(transaction);
  const decision = evaluateAuthenticationPolicy(session, resolved.policy, {
    expectedSubject: request.skip ? request.subject : undefined,
    maximumAgeSeconds: requestedMaximumAge(request),
  });
  if (!decision.allowed || !decision.acr || !decision.amr) {
    const failureCode = decision.code ?? "policy_denied";
    // AAL2 is a recoverable step-up, not a Hydra rejection.
    if (failureCode === "aal2_required") {
      return { outcome: "aal2_required", subject: session.identity.id };
    }
    const redirectTo = await rejectLoginAndRedirect(
      transaction,
      request.challenge,
      "access_denied",
      decision.description ?? "Authentication policy denied this request.",
    );
    await audit(req, "auth.policy.denied", resolved, {
      identityId: session.identity.id,
      result: "denied",
      failureCode,
    });
    return { outcome: "denied", redirectTo, failureCode };
  }
  if (!(await accessAllowed(session, resolved.policy, request.client.client_id))) {
    const redirectTo = await rejectLoginAndRedirect(
      transaction,
      request.challenge,
      "access_denied",
      "This account is not allowed to use the application.",
    );
    await audit(req, "auth.policy.denied", resolved, {
      identityId: session.identity.id,
      result: "denied",
      failureCode: "missing_client_access_grant",
    });
    return {
      outcome: "denied",
      redirectTo,
      failureCode: "missing_client_access_grant",
    };
  }

  const redirectTo = await acceptHydraLogin(request.challenge, {
    subject: session.identity.id,
    acr: decision.acr,
    amr: decision.amr,
    claims: toUserClaims(session.identity),
    rememberFor: Math.min(resolved.policy.sessionMaximumAgeSeconds, 3600),
    transactionId: transaction.id,
  });
  await setAuthTransactionResult(database(), {
    id: transaction.id,
    status: "hydra-accepted",
    subject: session.identity.id,
  });
  await audit(req, "auth.login.completed", resolved, {
    identityId: session.identity.id,
    result: "accepted",
    metadata: { acr: decision.acr, amr: decision.amr },
  });
  return { outcome: "accepted", redirectTo };
}

async function redirectToAal2StepUp(
  req: Request,
  transaction: AuthTransactionRecord,
  token: string,
  subject: string,
): Promise<string> {
  const released = await releaseAuthTransactionForStepUp(database(), {
    id: transaction.id,
    subject,
  });
  if (!released) {
    throw new Error("Unable to release authentication transaction for AAL2 step-up");
  }

  const policy = transaction.policy_snapshot;
  const capability = await identityAal2Capability(subject, policy);
  const returnTo = completionUrl(token);

  if (capability === "missing") {
    await audit(req, "auth.login.aal2_enrollment_required", resolvedFromAuthTransaction(transaction), {
      identityId: subject,
      result: "redirected-to-settings-enrollment",
    });
    const settingsUrl = new URL("/settings", `${getAuthBaseUrl()}/`);
    settingsUrl.searchParams.set("return_to", returnTo);
    return settingsUrl.toString();
  }

  await audit(req, "auth.login.aal2_required", resolvedFromAuthTransaction(transaction), {
    identityId: subject,
    result: "redirected-to-kratos-aal2",
    metadata: { capability },
  });
  return kratos.browserLoginUrl(returnTo, {
    refresh: true,
    aal: "aal2",
  });
}

function publicContext(
  transaction: AuthTransactionRecord,
  transactionId: string,
  extras: { secondaryFactorEnrollmentUrl?: string } = {},
) {
  return {
    transactionId,
    client: {
      id: transaction.hydra_client_id,
      displayName:
        transaction.client_config_snapshot.clientDisplayName ??
        transaction.brand_snapshot.productName,
    },
    recovery: recoveryFromAuthTransaction(transaction),
    brand: transaction.brand_snapshot,
    policy: toPublicPolicy(transaction.policy_snapshot),
    expiresAt: transaction.expires_at,
    purpose: "oauth" as const,
    ...extras,
  };
}

function hasInteractiveAuthNodes(flow: KratosFlow): boolean {
  return flow.ui.nodes.some((node) => {
    if (node.type !== "input") return false;
    return node.attributes.type !== "hidden";
  });
}

function secondaryFactorEnrollmentUrl(token: string): string {
  const settingsUrl = new URL("/settings", `${getAuthBaseUrl()}/`);
  settingsUrl.searchParams.set("return_to", completionUrl(token));
  return settingsUrl.toString();
}

function publicConsentContext(transaction: AuthConsentTransactionRecord, transactionId: string) {
  const transactionHash = hashOpaqueValue(transactionId);
  return {
    transactionId,
    client: {
      id: transaction.hydra_client_id,
      displayName:
        transaction.client_config_snapshot.clientDisplayName ??
        transaction.brand_snapshot.productName,
    },
    recovery: recoveryFromConsentTransaction(transaction),
    brand: transaction.brand_snapshot,
    policy: toPublicPolicy(transaction.policy_snapshot),
    requestedScopes: transaction.requested_scopes,
    requestedAudiences: transaction.requested_audiences,
    expiresAt: transaction.expires_at,
    acceptToken: createActionToken("accept", transactionHash),
    rejectToken: createActionToken("reject", transactionHash),
  };
}

async function sessionForConsent(req: Request, request: HydraConsentRequest): Promise<KratosSession> {
  const session = await kratos.whoami(req);
  if (session.identity.id !== request.subject) {
    throw new Error("The active identity does not match the consent request");
  }
  return session;
}

export function createOrchestratorRouter(): Router {
  const router = Router();
  const entryLimit = rateLimit(40, 60_000);
  const actionLimit = rateLimit(20, 60_000);

  router.use((_req, res, next) => {
    noStore(res);
    next();
  });

  router.get("/oauth2/login", entryLimit, async (req: Request, res: Response): Promise<void> => {
    const challenge = first(req.query["login_challenge"]);
    if (!challenge) {
      sendNeutralError(res, "invalid_request", "The sign-in request is missing its login challenge.");
      return;
    }
    if (getAuthBrandingMode() === "off") {
      res.redirect(`/login?login_challenge=${encodeURIComponent(challenge)}`);
      return;
    }

    try {
      const hydraRequest = await getHydraLoginRequest(challenge);
      const clientId = hydraRequest.client.client_id;
      const resolved = await resolveAuthConfiguration(database(), clientId);
      resolved.client = {
        ...resolved.client,
        clientDisplayName: hydraRequest.client.client_name?.trim() || clientId,
        clientHomeUrl: normalizeClientHomeUrl(hydraRequest.client.client_uri),
      };
      if (resolved.client.status === "disabled") {
        const redirectTo = await rejectHydraLogin(
          challenge,
          "unauthorized_client",
          "This client is disabled.",
        );
        res.redirect(redirectTo);
        return;
      }
      if (resolved.usedFallback && getStrictUnmappedClients()) {
        const redirectTo = await rejectHydraLogin(
          challenge,
          "unauthorized_client",
          "This client is not configured.",
        );
        res.redirect(redirectTo);
        return;
      }
      if (getAuthBrandingMode() === "observe") {
        resolved.brand = DEFAULT_IDNEST_BRAND;
        resolved.policy = DEFAULT_AUTH_POLICY;
      }

      const token = createOpaqueToken();
      const transaction = await createAuthTransaction(database(), {
        tokenHash: hashOpaqueValue(token),
        challengeHash: hashOpaqueValue(challenge),
        challengeCiphertext: encryptSensitiveValue(challenge),
        hydraClientId: clientId,
        brandId: resolved.client.brandId,
        brandVersion: resolved.client.brandVersion,
        authPolicyId: resolved.client.authPolicyId,
        authPolicyVersion: resolved.client.authPolicyVersion,
        mappingVersion: resolved.client.mappingVersion,
        clientConfigSnapshot: resolved.client,
        brandSnapshot: resolved.brand,
        policySnapshot: resolved.policy,
        ttlSeconds: getAuthTransactionTtlSeconds(),
      });
      await audit(req, "auth.transaction.created", resolved, {
        result: "created",
        metadata: { fallback: resolved.usedFallback },
      });
      await audit(req, "auth.brand.resolved", resolved, {
        result: resolved.usedFallback ? "fallback" : "mapped",
      });
      if (resolved.usedFallback) {
        console.warn("Trusted OAuth client is using neutral fallback authentication", {
          clientId,
        });
      }

      const prompt = hydraRequest.oidc_context?.prompt ?? [];
      const requireFresh = shouldRequireFreshLogin(resolved.policy, {
        prompt,
        maxAge: requestedMaximumAge(hydraRequest),
      });

      let existingSession: KratosSession | null = null;
      try {
        existingSession = await kratos.whoami(req);
      } catch {
        existingSession = null;
      }

      if (hydraRequest.skip && !requireFresh && existingSession) {
        try {
          const decision = evaluateAuthenticationPolicy(existingSession, resolved.policy, {
            expectedSubject: hydraRequest.subject,
            maximumAgeSeconds: requestedMaximumAge(hydraRequest),
          });
          if (
            decision.allowed &&
            (await accessAllowed(existingSession, resolved.policy, clientId))
          ) {
            const completion = await completeLoginWithSession(
              req,
              transaction,
              hydraRequest,
              existingSession,
            );
            if (completion.outcome === "accepted" || completion.outcome === "denied") {
              await audit(req, "auth.login.skipped", resolved, {
                identityId: existingSession.identity.id,
                result: completion.outcome,
                failureCode:
                  completion.outcome === "denied" ? completion.failureCode : undefined,
              });
              res.redirect(completion.redirectTo);
              return;
            }
            // aal2_required: fall through to Kratos step-up below
          }
        } catch {
          // A missing or stale Kratos session is recoverable by starting a fresh flow.
        }
      }

      const returnTo = completionUrl(token);
      const kratosAal = requestedKratosAal(existingSession, resolved.policy);
      const loginUrl = kratos.browserLoginUrl(returnTo, {
        refresh: requireFresh || hydraRequest.skip || kratosAal === "aal2",
        aal: kratosAal,
      });
      await audit(req, "auth.login.started", resolved, {
        result: "redirected-to-kratos",
        metadata: {
          freshAuthentication: requireFresh || hydraRequest.skip,
          kratosAal: kratosAal ?? "aal1",
        },
      });
      res.redirect(loginUrl);
    } catch (error) {
      console.error("Trusted Hydra login initialization failed", error);
      sendNeutralError(res, "login_initialization_failed", "Unable to start this sign-in request.", 502);
    }
  });

  async function findRecoveryTransactionByFlowId(
    flowId: string,
  ): Promise<AuthTransactionRecord | null> {
    try {
      return await findAuthTransactionByKratosFlowId(database(), flowId);
    } catch {
      return null;
    }
  }

  router.get(
    "/auth/v1/flows/login/:flowId/context",
    entryLimit,
    async (req: Request, res: Response): Promise<void> => {
      noStore(res);
      try {
        const flow = await kratos.getLoginFlow(req.params.flowId, req);
        const token = transactionTokenFromFlow(flow);
        if (!token) {
          if (
            isSettingsPrivilegedReauthFlow(flow, {
              authBaseUrl: getAuthBaseUrl(),
              kratosPublicUrl: getKratosPublicUrl(),
            })
          ) {
            res.json({
              flow: publicFlow(flow, SETTINGS_REAUTH_POLICY),
              context: settingsReauthContext(flow),
            });
            return;
          }
          res.status(400).json({
            error: "unbound_login_flow",
            recovery: { kind: "request_context_unavailable" },
          });
          return;
        }
        const tokenHash = hashOpaqueValue(token);
        const transaction = await bindAuthTransactionFlow(
          database(),
          tokenHash,
          flow.id,
          { allowStepUpRebind: isAal2StepUpFlow(flow) },
        );
        if (!transaction) {
          const staleTransaction = await findAuthTransactionByTokenHash(database(), tokenHash);
          res.status(410).json({
            error: "expired_or_reused_transaction",
            recovery: staleTransaction
              ? recoveryFromAuthTransaction(staleTransaction)
              : { kind: "request_context_unavailable" },
          });
          return;
        }
        const published = publicFlow(flow, transaction.policy_snapshot);
        const needsEnrollment =
          transaction.policy_snapshot.totpEnabled &&
          transaction.policy_snapshot.minimumAal === "aal2" &&
          !hasInteractiveAuthNodes(published);
        res.json({
          flow: published,
          context: publicContext(
            transaction,
            token,
            needsEnrollment
              ? { secondaryFactorEnrollmentUrl: secondaryFactorEnrollmentUrl(token) }
              : {},
          ),
        });
      } catch (error) {
        console.error("Branded login flow context failed", error);
        const transaction = await findRecoveryTransactionByFlowId(req.params.flowId);
        res.status(502).json({
          error: "login_flow_unavailable",
          recovery: transaction
            ? recoveryFromAuthTransaction(transaction)
            : { kind: "request_context_unavailable" },
        });
      }
    },
  );

  router.get(
    "/auth/v1/transactions/:transactionId/context",
    entryLimit,
    async (req: Request, res: Response): Promise<void> => {
      noStore(res);
      const transaction = await findAuthTransactionByTokenHash(
        database(),
        hashOpaqueValue(req.params.transactionId),
      );
      if (!transaction || Date.parse(transaction.expires_at) <= Date.now()) {
        res.status(410).json({
          error: "expired_transaction",
          recovery: transaction
            ? recoveryFromAuthTransaction(transaction)
            : { kind: "request_context_unavailable" },
        });
        return;
      }
      res.json(publicContext(transaction, req.params.transactionId));
    },
  );

  router.get(
    "/oauth2/login/complete",
    actionLimit,
    async (req: Request, res: Response): Promise<void> => {
      const token = first(req.query["transaction"]);
      if (!token) {
        sendNeutralError(res, "invalid_request", "The sign-in transaction is missing.");
        return;
      }
      const tokenHash = hashOpaqueValue(token);
      const transaction = await claimAuthTransactionCompletion(database(), tokenHash);
      if (!transaction) {
        const staleTransaction = await findAuthTransactionByTokenHash(database(), tokenHash);
        sendNeutralError(
          res,
          "expired_or_reused_transaction",
          "This sign-in request has expired.",
          410,
          staleTransaction
            ? recoveryFromAuthTransaction(staleTransaction)
            : { kind: "request_context_unavailable" },
        );
        return;
      }
      try {
        const challenge = decryptSensitiveValue(
          transaction.hydra_login_challenge_ciphertext,
        );
        const hydraRequest = await getHydraLoginRequest(challenge);
        if (hydraRequest.client.client_id !== transaction.hydra_client_id) {
          throw new Error("Hydra client changed during the authentication transaction");
        }
        const session = await kratos.whoamiWithRetry(req);
        const completion = await completeLoginWithSession(
          req,
          transaction,
          hydraRequest,
          session,
        );
        if (completion.outcome === "aal2_required") {
          const stepUpUrl = await redirectToAal2StepUp(
            req,
            transaction,
            token,
            completion.subject,
          );
          res.redirect(stepUpUrl);
          return;
        }
        res.redirect(completion.redirectTo);
      } catch (error) {
        console.error("Trusted Hydra login completion failed", error);
        await setAuthTransactionResult(database(), {
          id: transaction.id,
          status: "failed",
          failureCode: "login_completion_failed",
        });
        await audit(req, "auth.login.failed", resolvedFromAuthTransaction(transaction), {
          result: "failed",
          failureCode: "login_completion_failed",
        });
        sendNeutralError(
          res,
          "login_completion_failed",
          "Unable to complete this sign-in request.",
          502,
          recoveryFromAuthTransaction(transaction),
        );
      }
    },
  );

  async function handleLoginReject(req: Request, res: Response): Promise<void> {
    noStore(res);
    const bodyTransactionId =
      typeof (req.body as Record<string, unknown> | undefined)?.["transactionId"] ===
      "string"
        ? String((req.body as Record<string, unknown>)["transactionId"])
        : "";
    const transactionId = req.params.transactionId || bodyTransactionId;
    if (!transactionId) {
      res.status(400).json({ error: "transaction_id_required" });
      return;
    }
    const tokenHash = hashOpaqueValue(transactionId);
    const transaction = await claimAuthTransactionCompletion(database(), tokenHash);
    if (!transaction) {
      const staleTransaction = await findAuthTransactionByTokenHash(database(), tokenHash);
      res.status(410).json({
        error: "expired_or_reused_transaction",
        recovery: staleTransaction
          ? recoveryFromAuthTransaction(staleTransaction)
          : { kind: "request_context_unavailable" },
      });
      return;
    }
    try {
      const challenge = decryptSensitiveValue(
        transaction.hydra_login_challenge_ciphertext,
      );
      const redirectTo = await rejectLoginAndRedirect(
        transaction,
        challenge,
        "access_denied",
        "The user cancelled sign-in.",
      );
      await audit(
        req,
        "auth.login.rejected",
        resolvedFromAuthTransaction(transaction),
        {
          result: "cancelled",
          failureCode: "user_cancelled",
        },
      );
      res.json({ redirectTo });
    } catch {
      await setAuthTransactionResult(database(), {
        id: transaction.id,
        status: "failed",
        failureCode: "login_rejection_failed",
      });
      res.status(502).json({
        error: "login_rejection_failed",
        recovery: recoveryFromAuthTransaction(transaction),
      });
    }
  }

  router.post(
    "/auth/v1/transactions/:transactionId/reject",
    actionLimit,
    handleLoginReject,
  );
  router.post("/oauth2/login/reject", actionLimit, handleLoginReject);

  router.get("/oauth2/consent", entryLimit, async (req: Request, res: Response): Promise<void> => {
    const challenge = first(req.query["consent_challenge"]);
    if (!challenge) {
      sendNeutralError(res, "invalid_request", "The consent request is missing its challenge.");
      return;
    }
    if (getAuthBrandingMode() === "off") {
      res.redirect(`/consent?consent_challenge=${encodeURIComponent(challenge)}`);
      return;
    }
    try {
      const hydraRequest = await getHydraConsentRequest(challenge);
      const clientId = hydraRequest.client.client_id;
      const prior = hydraRequest.login_challenge
        ? await findAuthTransactionByChallengeHash(
            database(),
            hashOpaqueValue(hydraRequest.login_challenge),
          )
        : null;
      if (prior && prior.hydra_client_id !== clientId) {
        throw new Error("Consent client does not match the frozen login transaction");
      }
      const resolved = prior
        ? resolvedFromAuthTransaction(prior)
        : await resolveAuthConfiguration(database(), clientId);
      if (!prior) {
        resolved.client = {
          ...resolved.client,
          clientDisplayName: hydraRequest.client.client_name?.trim() || clientId,
        };
      }
      resolved.client = {
        ...resolved.client,
        clientDisplayName: hydraRequest.client.client_name?.trim() || resolved.client.clientDisplayName,
        clientHomeUrl:
          normalizeClientHomeUrl(hydraRequest.client.client_uri) ?? resolved.client.clientHomeUrl,
      };
      if (resolved.usedFallback && getStrictUnmappedClients()) {
        const redirectTo = await rejectHydraConsent(challenge, "This client is not configured.");
        res.redirect(redirectTo);
        return;
      }
      if (getAuthBrandingMode() === "observe") {
        resolved.brand = DEFAULT_IDNEST_BRAND;
        resolved.policy = DEFAULT_AUTH_POLICY;
      }
      if (resolved.client.status === "disabled") {
        const redirectTo = await rejectHydraConsent(challenge, "This client is disabled.");
        res.redirect(redirectTo);
        return;
      }
      const session = await sessionForConsent(req, hydraRequest);
      const policyDecision = evaluateAuthenticationPolicy(session, resolved.policy, {
        expectedSubject: hydraRequest.subject,
      });
      const hasAccess =
        policyDecision.allowed &&
        (await accessAllowed(session, resolved.policy, clientId));
      if (!hasAccess) {
        const redirectTo = await rejectHydraConsent(
          challenge,
          "This account is not allowed to use the application.",
        );
        res.redirect(redirectTo);
        return;
      }

      const autoAccept =
        (resolved.client.consentMode === "skip-for-first-party" && resolved.client.isFirstParty) ||
        (resolved.client.consentMode === "follow-hydra" && hydraRequest.skip);
      if (autoAccept) {
        const redirectTo = await acceptHydraConsent(challenge, {
          scopes: hydraRequest.requested_scope,
          audiences: hydraRequest.requested_access_token_audience,
          claims: toUserClaims(session.identity),
          rememberFor: 3600,
        });
        await audit(req, "auth.consent.accepted", resolved, {
          identityId: session.identity.id,
          result: "auto-accepted",
        });
        res.redirect(redirectTo);
        return;
      }

      const token = createOpaqueToken();
      await createAuthConsentTransaction(database(), {
        tokenHash: hashOpaqueValue(token),
        challengeHash: hashOpaqueValue(challenge),
        challengeCiphertext: encryptSensitiveValue(challenge),
        loginChallengeHash: hydraRequest.login_challenge
          ? hashOpaqueValue(hydraRequest.login_challenge)
          : null,
        hydraClientId: clientId,
        subject: hydraRequest.subject,
        clientConfigSnapshot: resolved.client,
        brandSnapshot: resolved.brand,
        policySnapshot: resolved.policy,
        requestedScopes: hydraRequest.requested_scope,
        requestedAudiences: hydraRequest.requested_access_token_audience,
        ttlSeconds: getAuthTransactionTtlSeconds(),
      });
      res.redirect(publicUiUrl("/consent", { transaction: token }));
    } catch (error) {
      console.error("Branded Hydra consent initialization failed", error);
      sendNeutralError(res, "consent_initialization_failed", "Unable to start this consent request.", 502);
    }
  });

  router.get(
    "/auth/v1/consent/:transactionId/context",
    entryLimit,
    async (req: Request, res: Response): Promise<void> => {
      noStore(res);
      const transaction = await findAuthConsentTransactionByTokenHash(
        database(),
        hashOpaqueValue(req.params.transactionId),
      );
      if (
        !transaction ||
        transaction.status !== "created" ||
        Date.parse(transaction.expires_at) <= Date.now()
      ) {
        res.status(410).json({
          error: "expired_consent_transaction",
          recovery: transaction
            ? recoveryFromConsentTransaction(transaction)
            : { kind: "request_context_unavailable" },
        });
        return;
      }
      res.json(publicConsentContext(transaction, req.params.transactionId));
    },
  );

  async function handleConsentAction(
    req: Request,
    res: Response,
    action: "accept" | "reject",
  ): Promise<void> {
    noStore(res);
    const bodyTransactionId =
      typeof (req.body as Record<string, unknown> | undefined)?.["transactionId"] === "string"
        ? String((req.body as Record<string, unknown>)["transactionId"])
        : "";
    const transactionId = req.params.transactionId || bodyTransactionId;
    if (!transactionId) {
      res.status(400).json({ error: "transaction_id_required" });
      return;
    }
    const transactionHash = hashOpaqueValue(transactionId);
    const actionToken =
      typeof (req.body as Record<string, unknown> | undefined)?.["actionToken"] === "string"
        ? String((req.body as Record<string, unknown>)["actionToken"])
        : "";
    if (!verifyActionToken(actionToken, action, transactionHash)) {
      res.status(403).json({ error: "invalid_consent_action" });
      return;
    }
    const transaction = await claimAuthConsentTransaction(database(), transactionHash);
    if (!transaction) {
      const staleTransaction = await findAuthConsentTransactionByTokenHash(
        database(),
        transactionHash,
      );
      res.status(410).json({
        error: "expired_or_reused_consent_transaction",
        recovery: staleTransaction
          ? recoveryFromConsentTransaction(staleTransaction)
          : { kind: "request_context_unavailable" },
      });
      return;
    }
    try {
      const challenge = decryptSensitiveValue(transaction.hydra_consent_challenge_ciphertext);
      const hydraRequest = await getHydraConsentRequest(challenge);
      if (
        hydraRequest.client.client_id !== transaction.hydra_client_id ||
        hydraRequest.subject !== transaction.subject
      ) {
        throw new Error("Hydra consent request changed during the transaction");
      }
      const session = await sessionForConsent(req, hydraRequest);
      const resolved = resolvedFromConsentTransaction(transaction);
      let redirectTo: string;
      if (action === "accept") {
        const policyDecision = evaluateAuthenticationPolicy(session, resolved.policy, {
          expectedSubject: transaction.subject,
        });
        if (
          !policyDecision.allowed ||
          !(await accessAllowed(
            session,
            resolved.policy,
            transaction.hydra_client_id,
          ))
        ) {
          redirectTo = await rejectHydraConsent(
            challenge,
            "Authentication policy denied consent.",
          );
          await setAuthConsentTransactionResult(database(), {
            id: transaction.id,
            status: "rejected",
            failureCode: policyDecision.code ?? "missing_client_access_grant",
          });
        } else {
          redirectTo = await acceptHydraConsent(challenge, {
            scopes: transaction.requested_scopes,
            audiences: transaction.requested_audiences,
            claims: toUserClaims(session.identity),
            rememberFor: 3600,
          });
          await setAuthConsentTransactionResult(database(), {
            id: transaction.id,
            status: "accepted",
          });
        }
      } else {
        redirectTo = await rejectHydraConsent(challenge, "The user denied the request.");
        await setAuthConsentTransactionResult(database(), {
          id: transaction.id,
          status: "rejected",
        });
      }
      await audit(
        req,
        action === "accept" ? "auth.consent.accepted" : "auth.consent.rejected",
        resolved,
        {
          identityId: session.identity.id,
          result: action,
        },
      );
      res.json({ redirectTo });
    } catch (error) {
      console.error("Consent action failed", error);
      await setAuthConsentTransactionResult(database(), {
        id: transaction.id,
        status: "failed",
        failureCode: "consent_action_failed",
      });
      res.status(502).json({
        error: "consent_action_failed",
        recovery: recoveryFromConsentTransaction(transaction),
      });
    }
  }

  router.post(
    "/auth/v1/consent/:transactionId/accept",
    actionLimit,
    (req: Request, res: Response) => handleConsentAction(req, res, "accept"),
  );
  router.post(
    "/auth/v1/consent/:transactionId/reject",
    actionLimit,
    (req: Request, res: Response) => handleConsentAction(req, res, "reject"),
  );
  router.post(
    "/oauth2/consent/accept",
    actionLimit,
    (req: Request, res: Response) => handleConsentAction(req, res, "accept"),
  );
  router.post(
    "/oauth2/consent/reject",
    actionLimit,
    (req: Request, res: Response) => handleConsentAction(req, res, "reject"),
  );

  return router;
}
