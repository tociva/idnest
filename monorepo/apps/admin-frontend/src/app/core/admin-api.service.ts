import { HttpClient, type HttpErrorResponse } from "@angular/common/http";
import { inject, Injectable } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { AdminAuthService } from "./admin-auth.service";
import { ADMIN_CONFIG } from "./admin-config";
import { ProgressService } from "./progress/progress.service";
import type {
  AdminIdentity,
  AdminMe,
  AuthBrandRecord,
  AuthConfigurationVersion,
  ClientAccessGrant,
  ClientFormValue,
  DelegationActorPolicyRecord,
  DelegationAuditActivity,
  DelegationGrantActivity,
  DelegationResourceRecord,
  HydraClient,
  KratosSession,
  AuthPolicyRecord,
  OAuthClientAuthConfigRecord,
} from "./admin-types";
import type {
  AuthBrandDefinition,
  AuthBrandStatus,
  AuthClientConfigStatus,
  AuthPolicyDefinition,
  ConsentMode,
} from "@idnest/shared-types";

/** Client for admin-backend. BFF auth uses an HttpOnly session cookie + CSRF. */
@Injectable({ providedIn: "root" })
export class AdminApiService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AdminAuthService);
  private readonly config = inject(ADMIN_CONFIG);
  private readonly progress = inject(ProgressService);

  private base(): string {
    return `${this.config.apiBaseUrl}/admin`;
  }

  /** Wraps an async operation with the top-bar progress indicator. */
  private async withProgress<T>(fn: () => Promise<T>): Promise<T> {
    this.progress.show();
    try {
      return await fn();
    } finally {
      this.progress.hideOne();
    }
  }

  private get<T>(path: string): Promise<T> {
    return this.withProgress(async () => {
      const result = await firstValueFrom(
        this.http.get<T>(`${this.base()}${path}`, { withCredentials: true }),
      );
      this.captureCsrf(result);
      return result;
    });
  }

  private async unsafeHeaders(): Promise<Record<string, string>> {
    const csrfToken = await this.auth.ensureCsrfToken();
    return csrfToken ? { "X-Admin-CSRF": csrfToken } : {};
  }

  private async post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.withProgress(async () => {
      const headers = await this.unsafeHeaders();
      return firstValueFrom(
        this.http.post<T>(`${this.base()}${path}`, body, { headers, withCredentials: true }),
      );
    });
  }

  private async put<T>(path: string, body: unknown): Promise<T> {
    return this.withProgress(async () => {
      const headers = await this.unsafeHeaders();
      return firstValueFrom(
        this.http.put<T>(`${this.base()}${path}`, body, { headers, withCredentials: true }),
      );
    });
  }

  private async patch<T>(path: string, body: unknown): Promise<T> {
    return this.withProgress(async () => {
      const headers = await this.unsafeHeaders();
      return firstValueFrom(
        this.http.patch<T>(`${this.base()}${path}`, body, { headers, withCredentials: true }),
      );
    });
  }

  private async delete<T>(path: string): Promise<T> {
    return this.withProgress(async () => {
      const headers = await this.unsafeHeaders();
      return firstValueFrom(
        this.http.delete<T>(`${this.base()}${path}`, { headers, withCredentials: true }),
      );
    });
  }

  private captureCsrf(value: unknown): void {
    if (value && typeof value === "object" && "csrfToken" in value) {
      const csrfToken = (value as { csrfToken?: unknown }).csrfToken;
      this.auth.setCsrfToken(typeof csrfToken === "string" ? csrfToken : undefined);
    }
  }

  // --- Authorization probe ---
  me(): Promise<AdminMe> {
    return this.get<AdminMe>("/me");
  }

  // --- Identities ---
  listIdentities(pageToken?: string): Promise<AdminIdentity[]> {
    const qs = pageToken ? `?page_token=${encodeURIComponent(pageToken)}` : "";
    return this.get<AdminIdentity[]>(`/identities${qs}`);
  }

  getIdentity(id: string): Promise<AdminIdentity> {
    return this.get<AdminIdentity>(`/identities/${encodeURIComponent(id)}`);
  }

  deactivateIdentity(id: string): Promise<AdminIdentity> {
    return this.post<AdminIdentity>(`/identities/${encodeURIComponent(id)}/deactivate`);
  }

  deleteIdentity(id: string): Promise<{ deleted: boolean; id: string }> {
    return this.delete(`/identities/${encodeURIComponent(id)}`);
  }

  setAdminRole(id: string, admin: boolean): Promise<AdminIdentity> {
    return this.post<AdminIdentity>(`/identities/${encodeURIComponent(id)}/role`, { admin });
  }

  listIdentityClientAccess(id: string): Promise<ClientAccessGrant[]> {
    return this.get<ClientAccessGrant[]>(`/identities/${encodeURIComponent(id)}/client-access`);
  }

  grantIdentityClientAccess(id: string, clientId: string, role = "user"): Promise<ClientAccessGrant> {
    return this.post<ClientAccessGrant>(
      `/identities/${encodeURIComponent(id)}/client-access/${encodeURIComponent(clientId)}`,
      { role },
    );
  }

  revokeIdentityClientAccess(
    id: string,
    clientId: string,
  ): Promise<{ revoked: boolean; identity_id: string; client_id: string }> {
    return this.delete(
      `/identities/${encodeURIComponent(id)}/client-access/${encodeURIComponent(clientId)}`,
    );
  }

  // --- Sessions ---
  listIdentitySessions(id: string): Promise<KratosSession[]> {
    return this.get<KratosSession[]>(`/identities/${encodeURIComponent(id)}/sessions`);
  }

  revokeIdentitySessions(id: string): Promise<{ revoked: boolean; id: string }> {
    return this.delete(`/identities/${encodeURIComponent(id)}/sessions`);
  }

  revokeSession(sessionId: string): Promise<{ revoked: boolean; session_id: string }> {
    return this.delete(`/sessions/${encodeURIComponent(sessionId)}`);
  }

  // --- OAuth clients ---
  listClients(): Promise<HydraClient[]> {
    return this.get<HydraClient[]>("/clients");
  }

  getClient(clientId: string): Promise<HydraClient> {
    return this.get<HydraClient>(`/clients/${encodeURIComponent(clientId)}`);
  }

  createClient(value: ClientFormValue): Promise<HydraClient> {
    return this.post<HydraClient>("/clients", value);
  }

  updateClient(value: ClientFormValue): Promise<HydraClient> {
    return this.put<HydraClient>(`/clients/${encodeURIComponent(value.client_id)}`, value);
  }

  deleteClient(clientId: string): Promise<{ deleted: boolean; client_id: string }> {
    return this.delete(`/clients/${encodeURIComponent(clientId)}`);
  }

  listClientIdentityAccess(clientId: string): Promise<ClientAccessGrant[]> {
    return this.get<ClientAccessGrant[]>(`/clients/${encodeURIComponent(clientId)}/identities`);
  }

  // --- Authentication configuration ---
  listAuthBrands(): Promise<AuthBrandRecord[]> {
    return this.get<AuthBrandRecord[]>("/auth-brands");
  }

  listAuthBrandHistory(
    id: string,
  ): Promise<AuthConfigurationVersion<AuthBrandDefinition>[]> {
    return this.get(`/auth-brands/${encodeURIComponent(id)}/history`);
  }

  createAuthBrand(
    status: AuthBrandStatus,
    definition: AuthBrandDefinition,
    reason?: string,
  ): Promise<AuthBrandRecord> {
    return this.post<AuthBrandRecord>("/auth-brands", { status, definition, reason });
  }

  updateAuthBrand(
    id: string,
    expectedVersion: number,
    status: AuthBrandStatus,
    definition: AuthBrandDefinition,
    reason?: string,
  ): Promise<AuthBrandRecord> {
    return this.patch<AuthBrandRecord>(`/auth-brands/${encodeURIComponent(id)}`, {
      expectedVersion,
      status,
      definition,
      reason,
    });
  }

  archiveAuthBrand(id: string): Promise<{ archived: boolean; id: string }> {
    return this.delete(`/auth-brands/${encodeURIComponent(id)}`);
  }

  listAuthPolicies(): Promise<AuthPolicyRecord[]> {
    return this.get<AuthPolicyRecord[]>("/authentication-policies");
  }

  listAuthPolicyHistory(
    id: string,
  ): Promise<AuthConfigurationVersion<AuthPolicyDefinition>[]> {
    return this.get(`/authentication-policies/${encodeURIComponent(id)}/history`);
  }

  createAuthPolicy(
    status: AuthBrandStatus,
    definition: AuthPolicyDefinition,
    reason?: string,
  ): Promise<AuthPolicyRecord> {
    return this.post<AuthPolicyRecord>("/authentication-policies", {
      status,
      definition,
      reason,
    });
  }

  updateAuthPolicy(
    id: string,
    expectedVersion: number,
    status: AuthBrandStatus,
    definition: AuthPolicyDefinition,
    reason?: string,
  ): Promise<AuthPolicyRecord> {
    return this.patch<AuthPolicyRecord>(`/authentication-policies/${encodeURIComponent(id)}`, {
      expectedVersion,
      status,
      definition,
      reason,
    });
  }

  archiveAuthPolicy(id: string): Promise<{ archived: boolean; id: string }> {
    return this.delete(`/authentication-policies/${encodeURIComponent(id)}`);
  }

  listClientAuthConfigs(): Promise<OAuthClientAuthConfigRecord[]> {
    return this.get<OAuthClientAuthConfigRecord[]>("/client-auth-configs");
  }

  getClientAuthConfig(clientId: string): Promise<OAuthClientAuthConfigRecord> {
    return this.get<OAuthClientAuthConfigRecord>(
      `/client-auth-configs/${encodeURIComponent(clientId)}`,
    );
  }

  listClientAuthConfigHistory(
    clientId: string,
  ): Promise<AuthConfigurationVersion<Record<string, unknown>>[]> {
    return this.get(`/client-auth-configs/${encodeURIComponent(clientId)}/history`);
  }

  saveClientAuthConfig(
    clientId: string,
    value: {
      brandId: string;
      authPolicyId: string;
      status: AuthClientConfigStatus;
      isFirstParty: boolean;
      consentMode: ConsentMode;
      reason?: string;
    },
  ): Promise<OAuthClientAuthConfigRecord> {
    return this.put(
      `/client-auth-configs/${encodeURIComponent(clientId)}`,
      value,
    );
  }

  archiveClientAuthConfig(
    clientId: string,
  ): Promise<{ archived: boolean; clientId: string }> {
    return this.delete(`/client-auth-configs/${encodeURIComponent(clientId)}`);
  }

  // --- Generic delegated authorization ---
  listDelegationResources(): Promise<DelegationResourceRecord[]> {
    return this.get<DelegationResourceRecord[]>("/delegation/resources");
  }

  createDelegationResource(
    value: Omit<DelegationResourceRecord, "id" | "version" | "created_at" | "updated_at">,
    reason?: string,
  ): Promise<DelegationResourceRecord> {
    return this.post<DelegationResourceRecord>("/delegation/resources", { ...value, reason });
  }

  updateDelegationResource(
    resource: DelegationResourceRecord,
    reason?: string,
  ): Promise<DelegationResourceRecord> {
    return this.patch<DelegationResourceRecord>(
      `/delegation/resources/${encodeURIComponent(resource.id)}`,
      {
        expectedVersion: resource.version,
        status: resource.status,
        definition: resource.definition,
        reason,
      },
    );
  }

  archiveDelegationResource(id: string): Promise<{ archived: boolean; id: string }> {
    return this.delete(`/delegation/resources/${encodeURIComponent(id)}`);
  }

  listDelegationActorPolicies(resourceId: string): Promise<DelegationActorPolicyRecord[]> {
    return this.get(`/delegation/resources/${encodeURIComponent(resourceId)}/actors`);
  }

  saveDelegationActorPolicy(
    resourceId: string,
    actorClientId: string,
    value: Pick<DelegationActorPolicyRecord, "status" | "definition">,
    reason?: string,
  ): Promise<DelegationActorPolicyRecord> {
    return this.put(
      `/delegation/resources/${encodeURIComponent(resourceId)}/actors/${encodeURIComponent(actorClientId)}`,
      { ...value, reason },
    );
  }

  archiveDelegationActorPolicy(
    resourceId: string,
    actorClientId: string,
  ): Promise<{ archived: boolean; clientId: string }> {
    return this.delete(
      `/delegation/resources/${encodeURIComponent(resourceId)}/actors/${encodeURIComponent(actorClientId)}`,
    );
  }

  listDelegationGrants(resourceId?: string): Promise<DelegationGrantActivity[]> {
    const query = resourceId ? `?resource_id=${encodeURIComponent(resourceId)}` : "";
    return this.get(`/delegation/grants${query}`);
  }

  revokeDelegationGrant(id: string): Promise<{ revoked: boolean; id: string }> {
    return this.delete(`/delegation/grants/${encodeURIComponent(id)}`);
  }

  listDelegationAudit(resourceId?: string): Promise<DelegationAuditActivity[]> {
    const query = resourceId ? `?resource_id=${encodeURIComponent(resourceId)}` : "";
    return this.get(`/delegation/audit${query}`);
  }
}

/** Extract a human-readable message from an admin-backend error response. */
export function describeError(e: unknown): string {
  const err = e as HttpErrorResponse;
  if (err && typeof err === "object" && "error" in err) {
    const body = (err as HttpErrorResponse).error as { error?: unknown } | string | undefined;
    if (body && typeof body === "object" && typeof body.error === "string") return body.error;
    if (typeof body === "string" && body) return body;
    if ((err as HttpErrorResponse).message) return (err as HttpErrorResponse).message;
  }
  return e instanceof Error ? e.message : "An unexpected error occurred";
}
