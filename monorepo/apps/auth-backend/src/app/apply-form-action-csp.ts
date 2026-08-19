import type { KratosFlow } from "@idnest/shared-types";
import {
  findAuthConsentTransactionByTokenHash,
  findAuthTransactionByTokenHash,
  getAuthzPool,
} from "@idnest/authz-store";
import type { Request, Response } from "express";
import { getAuthBaseUrl, getAuthzDatabaseUrl } from "./config";
import { buildAuthCsp, clientRedirectOrigins } from "./form-action-csp";
import { getHydraClient } from "./hydra-admin";
import * as kratos from "./kratos-public";
import { transactionTokenFromFlow } from "./login-flow-binding";
import { hashOpaqueValue } from "./transaction-crypto";

function first(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

function database() {
  return getAuthzPool(getAuthzDatabaseUrl());
}

async function originsForHydraClientId(clientId: string): Promise<string[]> {
  const client = await getHydraClient(clientId);
  return clientRedirectOrigins(client.redirect_uris);
}

export async function clientOriginsFromLoginFlow(flow: KratosFlow): Promise<string[]> {
  try {
    const token = transactionTokenFromFlow(flow, getAuthBaseUrl());
    if (!token) return [];
    const db = database();
    if (!db) return [];
    const transaction = await findAuthTransactionByTokenHash(db, hashOpaqueValue(token));
    if (!transaction) return [];
    return await originsForHydraClientId(transaction.hydra_client_id);
  } catch (error) {
    console.error("Failed to resolve client origins for form-action CSP", error);
    return [];
  }
}

async function originsForLoginFlowId(flowId: string, req: Request): Promise<string[]> {
  return clientOriginsFromLoginFlow(await kratos.getLoginFlow(flowId, req));
}

async function originsForConsentTransaction(transactionId: string): Promise<string[]> {
  try {
    const db = database();
    if (!db) return [];
    const transaction = await findAuthConsentTransactionByTokenHash(db, hashOpaqueValue(transactionId));
    if (!transaction) return [];
    return await originsForHydraClientId(transaction.hydra_client_id);
  } catch (error) {
    console.error("Failed to resolve client origins for form-action CSP", error);
    return [];
  }
}

/** Look up the current OAuth client's redirect origins for this HTML request. */
export async function resolveHtmlClientOrigins(req: Request): Promise<string[]> {
  const path = req.path;
  try {
    if (path === "/auth/login" || path === "/login") {
      const flowId = first(req.query["flow"]);
      if (!flowId) return [];
      return await originsForLoginFlowId(flowId, req);
    }
    if (path === "/auth/consent") {
      const transactionId = first(req.query["transaction"]);
      if (!transactionId) return [];
      return await originsForConsentTransaction(transactionId);
    }
  } catch (error) {
    console.error("Failed to resolve client origins for form-action CSP", error);
  }
  return [];
}

export function applyAuthCsp(res: Response, clientOrigins: string[] = []): void {
  res.set("Content-Security-Policy", buildAuthCsp(clientOrigins));
}

/** Best-effort CSP upgrade for SPA login/consent HTML. Never fails the page. */
export async function applyHtmlFormActionCsp(req: Request, res: Response): Promise<void> {
  try {
    applyAuthCsp(res, await resolveHtmlClientOrigins(req));
  } catch (error) {
    console.error("Failed to apply form-action CSP", error);
  }
}
