import {
  auditConsentEvent,
  bootstrapFirstSystemAdmin,
  canonicalList,
  findConsentApproval,
  getAuthzPool,
  hasActiveClientAccess,
  rememberConsentApproval,
} from "@idnest/authz-store";
import {
  hasVerifiedEmailAddress,
  normalizeEmailAddress,
  toUserClaims,
  type HydraClient,
  type HydraClientTrustTier,
  type HydraConsentRequest,
  type KratosUser,
} from "@idnest/shared-types";
import {
  getAdminBootstrapEmails,
  getAuthzDatabaseUrl,
  getAdminOidcClientId,
  getConsentGateMode,
  getHydraAdminUrl,
  getKratosAdminUrl,
} from "../config";
import { errorBody, type HandlerResult } from "./types";

export interface LoadedConsent {
  request: HydraConsentRequest;
  identity: KratosUser;
  client: HydraClient;
  challenge: string;
  subject: string;
  clientId: string;
  scopes: string[];
  audiences: string[];
  trustTier: HydraClientTrustTier;
  consentVersion: number;
}

export interface ConsentDecision {
  loaded: LoadedConsent;
  hasAccess: boolean;
  canAutoAccept: boolean;
  autoAcceptReason?: ConsentAutoAcceptReason;
  reasons: string[];
  observeOnly: boolean;
}

export type ConsentAutoAcceptReason =
  | "remembered_low_risk_consent"
  | "remembered_first_party_offline_access_consent";

const ADMIN_OFFLINE_ACCESS_SCOPES = new Set(["openid", "profile", "email", "offline_access"]);

export function clientIdOf(client: HydraClient | undefined): string {
  return typeof client?.client_id === "string" ? client.client_id : "";
}

export function trustTierOf(client: HydraClient): HydraClientTrustTier {
  const tier = client.metadata?.trust_tier;
  return tier === "partner" || tier === "third_party" ? tier : "first_party";
}

export function consentVersionOf(client: HydraClient): number {
  const version = client.metadata?.consent_version;
  return Number.isInteger(version) && Number(version) > 0 ? Number(version) : 1;
}

export function isHighRiskConsent(input: {
  scopes: string[];
  audiences: string[];
  trustTier: HydraClientTrustTier;
}): boolean {
  const scopes = new Set(input.scopes);
  return (
    input.trustTier !== "first_party" ||
    scopes.has("offline_access") ||
    input.scopes.some((scope) => !["openid", "profile", "email"].includes(scope)) ||
    input.audiences.length > 1
  );
}

export function isRememberedOfflineAccessAllowed(input: {
  client: HydraClient;
  scopes: string[];
  audiences: string[];
  trustTier: HydraClientTrustTier;
}): boolean {
  const scopes = new Set(input.scopes);
  const registeredAudiences = new Set(canonicalList(input.client.audience ?? []));
  const audiencesAllowed = input.audiences.every((audience) => registeredAudiences.has(audience));

  return (
    input.client.metadata?.remember_offline_access === true &&
    input.trustTier === "first_party" &&
    scopes.has("offline_access") &&
    input.scopes.every((scope) => ADMIN_OFFLINE_ACCESS_SCOPES.has(scope)) &&
    audiencesAllowed
  );
}

async function fetchConsentRequest(consentChallenge: string): Promise<HydraConsentRequest> {
  const res = await fetch(
    `${getHydraAdminUrl()}/oauth2/auth/requests/consent?consent_challenge=${encodeURIComponent(
      consentChallenge,
    )}`,
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch consent request: ${await res.text().catch(() => res.statusText)}`);
  }
  return (await res.json()) as HydraConsentRequest;
}

async function fetchIdentity(subject: string): Promise<KratosUser> {
  const res = await fetch(`${getKratosAdminUrl()}/identities/${encodeURIComponent(subject)}`);
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Identity lookup failed: ${err}`);
  }
  return (await res.json()) as KratosUser;
}

function identityFromEmailSubject(subject: string): KratosUser | null {
  const email = normalizeEmailAddress(subject);
  if (!email) return null;
  return {
    id: email,
    traits: { email },
    verifiable_addresses: [{ via: "email", value: email, verified: true }],
    state: "active",
  };
}

export async function loadConsent(consentChallenge: string): Promise<LoadedConsent> {
  const request = await fetchConsentRequest(consentChallenge);
  const emailIdentity = identityFromEmailSubject(request.subject);
  const subject = emailIdentity?.id ?? request.subject;
  const identity = emailIdentity ?? await fetchIdentity(subject);
  const client = request.client;
  const clientId = clientIdOf(client);
  if (!clientId) throw new Error("Consent request is missing client_id");
  return {
    request,
    identity,
    client,
    challenge: request.challenge || consentChallenge,
    subject,
    clientId,
    scopes: canonicalList(request.requested_scope ?? []),
    audiences: canonicalList(request.requested_access_token_audience ?? []),
    trustTier: trustTierOf(client),
    consentVersion: consentVersionOf(client),
  };
}

export async function decideConsent(consentChallenge: string): Promise<ConsentDecision> {
  const loaded = await loadConsent(consentChallenge);
  if (!hasVerifiedEmailAddress(loaded.identity)) {
    return {
      loaded,
      hasAccess: false,
      canAutoAccept: false,
      reasons: ["email_not_verified"],
      observeOnly: false,
    };
  }

  const pool = getAuthzPool(getAuthzDatabaseUrl());
  const mode = getConsentGateMode();
  const observeOnly = mode === "observe" && loaded.clientId !== getAdminOidcClientId();
  if (!pool) {
    return {
      loaded,
      hasAccess: observeOnly,
      canAutoAccept: false,
      reasons: ["authz_store_unavailable"],
      observeOnly,
    };
  }

  const identityEmail = String(loaded.identity.traits?.email ?? "").trim().toLowerCase();
  if (loaded.clientId === getAdminOidcClientId() && getAdminBootstrapEmails().includes(identityEmail)) {
    await bootstrapFirstSystemAdmin(pool, {
      identityId: loaded.subject,
      clientId: loaded.clientId,
      grantedBy: "bootstrap-email",
    });
  }

  const hasAccess = await hasActiveClientAccess(pool, loaded.subject, loaded.clientId);
  if (!hasAccess) {
    await auditConsentEvent(pool, {
      identityId: loaded.subject,
      clientId: loaded.clientId,
      eventType: observeOnly ? "observe_missing_grant" : "access_denied",
      reason: "missing_client_access_grant",
      scopes: loaded.scopes,
      audiences: loaded.audiences,
    });
  }

  const approval = await findConsentApproval(pool, {
    identityId: loaded.subject,
    clientId: loaded.clientId,
    scopes: loaded.scopes,
    audiences: loaded.audiences,
    trustTier: loaded.trustTier,
    consentVersion: loaded.consentVersion,
  });
  const highRisk = isHighRiskConsent(loaded);
  const effectiveAccess = hasAccess || observeOnly;
  const rememberedOfflineAccess = isRememberedOfflineAccessAllowed(loaded);
  let autoAcceptPolicyReason: ConsentAutoAcceptReason | undefined;
  if (!highRisk) {
    autoAcceptPolicyReason = "remembered_low_risk_consent";
  } else if (rememberedOfflineAccess) {
    autoAcceptPolicyReason = "remembered_first_party_offline_access_consent";
  }
  const canAutoAccept = effectiveAccess && Boolean(approval) && Boolean(autoAcceptPolicyReason);
  const autoAcceptReason = canAutoAccept ? autoAcceptPolicyReason : undefined;
  const reasons = [
    ...(hasAccess ? [] : ["missing_client_access_grant"]),
    ...(approval ? [] : ["no_prior_approval"]),
    ...(highRisk ? ["high_risk_request"] : []),
  ];

  return { loaded, hasAccess: effectiveAccess, canAutoAccept, autoAcceptReason, reasons, observeOnly };
}

export async function acceptLoadedConsent(loaded: LoadedConsent): Promise<HandlerResult> {
  const user = toUserClaims(loaded.identity);
  const hydraRes = await fetch(
    `${getHydraAdminUrl()}/oauth2/auth/requests/consent/accept?consent_challenge=${encodeURIComponent(
      loaded.challenge,
    )}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_scope: loaded.request.requested_scope ?? [],
        grant_access_token_audience: loaded.request.requested_access_token_audience ?? [],
        remember: true,
        remember_for: 3600,
        session: { id_token: { user }, access_token: { user } },
      }),
    },
  );
  const data = (await hydraRes.json()) as { redirect_to?: string; error?: unknown };
  if (!hydraRes.ok) return { status: 500, body: { error: data.error || data } };
  return { status: 200, body: { redirect_to: data.redirect_to } };
}

export async function rememberConsent(loaded: LoadedConsent): Promise<void> {
  const pool = getAuthzPool(getAuthzDatabaseUrl());
  if (!pool) return;
  await rememberConsentApproval(pool, {
    identityId: loaded.subject,
    clientId: loaded.clientId,
    scopes: loaded.scopes,
    audiences: loaded.audiences,
    trustTier: loaded.trustTier,
    consentVersion: loaded.consentVersion,
  });
}

export async function auditDecision(
  loaded: LoadedConsent,
  eventType: "prompt" | "accept" | "auto_accept" | "reject",
  reason?: string,
): Promise<void> {
  const pool = getAuthzPool(getAuthzDatabaseUrl());
  if (!pool) return;
  await auditConsentEvent(pool, {
    identityId: loaded.subject,
    clientId: loaded.clientId,
    eventType,
    reason,
    scopes: loaded.scopes,
    audiences: loaded.audiences,
  });
}

export async function consentErrorResult(err: unknown): Promise<HandlerResult> {
  return { status: 500, body: errorBody(err) };
}
