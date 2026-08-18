import { Component, inject, type OnInit } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import {
  TngInputAngularFormsAdapter,
  TngButtonComponent,
  TngCardComponent,
  TngCardContentComponent,
  TngCardDescriptionComponent,
  TngCardHeaderComponent,
  TngCardTitleComponent,
  TngFormFieldComponent,
  TngInputComponent,
  TngLabelComponent,
  TngMultiSelectComponent,
  TngProgressSpinnerComponent,
  TngSelectComponent,
  TngSwitchComponent,
  TngTextareaComponent,
} from "@tailng-ui/components";
import { TngIcon } from "@tailng-ui/icons";
import {
  OAUTH_CLIENT_PROFILES,
  clientCorsOriginsFromRedirectUris,
  isKnownOAuthClientType,
  type KnownOAuthClientType,
  type OAuthClientType,
} from "@idnest/shared-types";
import { AdminApiService, describeError } from "../../core/admin-api.service";
import {
  IDNEST_ADMIN_CLIENT_ID,
  type ClientAccessGrant,
  type ClientFormValue,
  type HydraClient,
} from "../../core/admin-types";
import {
  CLIENT_PROFILE_OPTIONS,
  CLIENT_PROFILE_VIEWS,
  getKnownClientProfile,
  getOAuthClientTypeLabel,
  inferOAuthClientType,
  type ScopeOption,
} from "../../core/oauth-client-profiles";
import { ToastService } from "../../core/toast/toast.service";

interface ClientForm {
  client_id: string;
  client_name: string;
  client_type: OAuthClientType;
  client_uri: string;
  logo_uri: string;
  policy_uri: string;
  tos_uri: string;
  contacts: string;
  trust_tier: "first_party" | "partner" | "third_party";
  consent_version: number | string;
  remember_offline_access: boolean;
  public: boolean;
  grantTypes: string;
  responseTypes: string;
  tokenEndpointAuthMethod: string;
  scope: string;
  redirectUris: string;
  postLogoutUris: string;
  corsOrigins: string;
  returnUris: string;
  audience: string;
}

interface SelectOption {
  value: string;
  label: string;
}

const TRUST_TIER_OPTIONS: readonly SelectOption[] = [
  { value: "first_party", label: "First party" },
  { value: "partner", label: "Partner" },
  { value: "third_party", label: "Third party" },
];
const SCOPE_PLACEHOLDER = "Select scopes";
const DEFAULT_CLIENT_TYPE: KnownOAuthClientType = "spa";

const defaultProfile = OAUTH_CLIENT_PROFILES[DEFAULT_CLIENT_TYPE];

const emptyForm = (): ClientForm => ({
  client_id: "",
  client_name: "",
  client_type: DEFAULT_CLIENT_TYPE,
  client_uri: "",
  logo_uri: "",
  policy_uri: "",
  tos_uri: "",
  contacts: "",
  trust_tier: "first_party",
  consent_version: 1,
  remember_offline_access: false,
  public: defaultProfile.tokenEndpointAuthMethod === "none",
  grantTypes: defaultProfile.grantTypes.join(", "),
  responseTypes: defaultProfile.responseTypes.join(", "),
  tokenEndpointAuthMethod: defaultProfile.tokenEndpointAuthMethod,
  scope: defaultProfile.defaultScope,
  redirectUris: "",
  postLogoutUris: "",
  corsOrigins: "",
  returnUris: "",
  audience: "",
});

const splitList = (value: string): string[] =>
  value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

const normalizeScopeList = (scopes: readonly unknown[]): string[] => {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const scope of scopes) {
    if (typeof scope !== "string") continue;
    const trimmed = scope.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
};

const splitScopes = (value: string): string[] => normalizeScopeList(value.split(/[\s,]+/));

const getScopeOptionValue = (option: ScopeOption): string => option.value;
const getScopeOptionLabel = (option: ScopeOption): string => option.label;
const getSelectOptionValue = (option: SelectOption): string => option.value;
const getSelectOptionLabel = (option: SelectOption): string => option.label;

function isTrustTier(value: unknown): value is ClientForm["trust_tier"] {
  return value === "first_party" || value === "partner" || value === "third_party";
}

const formatProtocolList = (values: readonly string[]): string => (values.length > 0 ? values.join(", ") : "none");

@Component({
  selector: "app-client-detail",
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    TngInputAngularFormsAdapter,
    TngButtonComponent,
    TngCardComponent,
    TngCardContentComponent,
    TngCardDescriptionComponent,
    TngCardHeaderComponent,
    TngCardTitleComponent,
    TngFormFieldComponent,
    TngIcon,
    TngInputComponent,
    TngLabelComponent,
    TngMultiSelectComponent,
    TngProgressSpinnerComponent,
    TngSelectComponent,
    TngSwitchComponent,
    TngTextareaComponent,
  ],
  templateUrl: "./client-detail.component.html",
  styleUrls: ["./client-detail.component.css"],
})
export class ClientDetailComponent implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  createMode = true;
  loading = true;
  busy = false;
  error = "";
  notice = "";
  form: ClientForm = emptyForm();
  identityGrants: ClientAccessGrant[] = [];
  customScope = "";
  createdClientSecret = "";
  revealClientSecret = false;
  readonly clientProfileOptions = CLIENT_PROFILE_OPTIONS;
  readonly trustTierOptions = TRUST_TIER_OPTIONS;
  readonly scopePlaceholder = SCOPE_PLACEHOLDER;
  readonly getScopeOptionValue = getScopeOptionValue;
  readonly getScopeOptionLabel = getScopeOptionLabel;
  readonly trackScopeOption = (_: number, option: ScopeOption): string => option.value;
  readonly getSelectOptionValue = getSelectOptionValue;
  readonly getSelectOptionLabel = getSelectOptionLabel;

  private clientId = "";
  private existingMetadata: Record<string, unknown> = {};

  get protectedAdminClient(): boolean {
    return !this.createMode && this.form.client_id.trim() === IDNEST_ADMIN_CLIENT_ID;
  }

  get selectedProfile() {
    return getKnownClientProfile(this.form.client_type);
  }

  get clientTypeLabel(): string {
    return getOAuthClientTypeLabel(this.form.client_type);
  }

  get customClient(): boolean {
    return this.form.client_type === "custom";
  }

  get showRedirectFields(): boolean {
    return this.customClient || this.selectedProfile?.requiresRedirectUris === true;
  }

  get showPostLogoutFields(): boolean {
    return this.customClient || this.selectedProfile?.supportsPostLogoutRedirectUris === true;
  }

  get showBrowserOrigins(): boolean {
    return this.form.client_type === "spa" || this.customClient;
  }

  get showReturnUris(): boolean {
    return this.form.client_type === "spa" || this.form.client_type === "web" || this.customClient;
  }

  get supportsRefreshToken(): boolean {
    const grants = this.selectedProfile?.grantTypes ?? splitList(this.form.grantTypes);
    return grants.includes("refresh_token");
  }

  get rememberOfflineAccessDisabled(): boolean {
    return this.protectedAdminClient || this.form.trust_tier !== "first_party" || !this.supportsRefreshToken;
  }

  get selectedScopes(): string[] {
    return splitScopes(this.form.scope);
  }

  get scopeOptions(): ScopeOption[] {
    const options = [
      ...(this.selectedProfile?.scopeOptions ?? [
        ...CLIENT_PROFILE_VIEWS.spa.scopeOptions,
        ...CLIENT_PROFILE_VIEWS.service.scopeOptions,
      ]),
    ];
    const knownValues = new Set(options.map((option) => option.value));
    for (const scope of this.selectedScopes) {
      if (knownValues.has(scope)) continue;
      knownValues.add(scope);
      options.push({ value: scope, label: scope });
    }
    return options;
  }

  get protocolSummary(): Array<{ label: string; value: string }> {
    const profile = this.selectedProfile;
    return [
      {
        label: "grant_types",
        value: formatProtocolList(profile?.grantTypes ?? splitList(this.form.grantTypes)),
      },
      {
        label: "response_types",
        value: formatProtocolList(profile?.responseTypes ?? splitList(this.form.responseTypes)),
      },
      {
        label: "token_endpoint_auth_method",
        value: profile?.tokenEndpointAuthMethod ?? (this.form.tokenEndpointAuthMethod.trim() || "not set"),
      },
    ];
  }

  get canSubmit(): boolean {
    if (this.busy || this.protectedAdminClient || !this.form.client_id.trim()) return false;
    if (this.selectedProfile?.requiresRedirectUris && splitList(this.form.redirectUris).length === 0) return false;
    if (this.form.client_type === "spa" && splitList(this.form.corsOrigins).length === 0) return false;
    return true;
  }

  get maskedClientSecret(): string {
    return "*".repeat(Math.max(this.createdClientSecret.length, 16));
  }

  ngOnInit(): void {
    this.clientId = this.route.snapshot.paramMap.get("clientId") ?? "";
    this.createMode = !this.clientId;
    this.captureCreatedSecret();
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.error = "";
    try {
      if (this.createMode) {
        this.form = emptyForm();
      } else {
        this.applyClient(await this.api.getClient(this.clientId));
        await this.loadIdentityGrants();
      }
    } catch (e) {
      this.error = describeError(e);
      this.toast.danger(this.error);
    } finally {
      this.loading = false;
    }
  }

  private applyClient(client: HydraClient): void {
    const clientType = inferOAuthClientType(client);
    const profile = getKnownClientProfile(clientType);
    const grantTypes = client.grant_types ?? profile?.grantTypes ?? [];
    const responseTypes = client.response_types ?? profile?.responseTypes ?? [];
    const tokenEndpointAuthMethod = client.token_endpoint_auth_method ?? profile?.tokenEndpointAuthMethod ?? "";
    this.existingMetadata = { ...(client.metadata ?? {}) };
    this.form = {
      client_id: client.client_id,
      client_name: client.client_name ?? "",
      client_type: clientType,
      client_uri: client.client_uri ?? "",
      logo_uri: client.logo_uri ?? "",
      policy_uri: client.policy_uri ?? "",
      tos_uri: client.tos_uri ?? "",
      contacts: (client.contacts ?? []).join(", "),
      trust_tier: isTrustTier(client.metadata?.trust_tier) ? client.metadata.trust_tier : "first_party",
      consent_version: client.metadata?.consent_version ?? 1,
      remember_offline_access: client.metadata?.remember_offline_access === true,
      public: tokenEndpointAuthMethod === "none",
      grantTypes: grantTypes.join(", "),
      responseTypes: responseTypes.join(", "),
      tokenEndpointAuthMethod,
      scope: client.scope ?? "",
      redirectUris: (client.redirect_uris ?? []).join(", "),
      postLogoutUris: (client.post_logout_redirect_uris ?? []).join(", "),
      corsOrigins: (client.allowed_cors_origins ?? []).join("\n"),
      returnUris: (client.metadata?.allowed_return_uris ?? []).join("\n"),
      audience: (client.audience ?? []).join(", "),
    };
    if (!this.supportsRefreshToken) {
      this.form.remember_offline_access = false;
    }
  }

  private toPayload(): ClientFormValue {
    const profile = this.selectedProfile;
    const customProtocol = this.customClient;
    return {
      client_id: this.form.client_id.trim(),
      client_name: this.form.client_name.trim(),
      client_uri: this.form.client_uri.trim(),
      logo_uri: this.form.logo_uri.trim(),
      policy_uri: this.form.policy_uri.trim(),
      tos_uri: this.form.tos_uri.trim(),
      contacts: splitList(this.form.contacts),
      metadata: {
        ...this.existingMetadata,
        trust_tier: this.form.trust_tier,
        consent_version: Number(this.form.consent_version) || 1,
        remember_offline_access:
          this.form.trust_tier === "first_party" && this.supportsRefreshToken && this.form.remember_offline_access,
        allowed_return_uris: this.showReturnUris ? splitList(this.form.returnUris) : [],
      },
      client_type: this.form.client_type,
      public: profile ? profile.tokenEndpointAuthMethod === "none" : this.form.tokenEndpointAuthMethod === "none",
      grant_types: customProtocol ? splitList(this.form.grantTypes) : undefined,
      response_types: customProtocol ? splitList(this.form.responseTypes) : undefined,
      token_endpoint_auth_method: customProtocol ? this.form.tokenEndpointAuthMethod.trim() : undefined,
      scope: this.form.scope.trim(),
      redirect_uris: this.showRedirectFields ? splitList(this.form.redirectUris) : [],
      post_logout_redirect_uris: this.showPostLogoutFields ? splitList(this.form.postLogoutUris) : [],
      allowed_cors_origins: this.showBrowserOrigins ? splitList(this.form.corsOrigins) : [],
      audience: splitList(this.form.audience),
    };
  }

  onTrustTierChange(): void {
    if (this.form.trust_tier !== "first_party" || !this.supportsRefreshToken) {
      this.form.remember_offline_access = false;
    }
  }

  onTrustTierSelect(value: string | null): void {
    if (!isTrustTier(value)) return;
    this.form.trust_tier = value;
    this.onTrustTierChange();
  }

  onClientTypeSelect(clientType: KnownOAuthClientType): void {
    if (!this.createMode || this.protectedAdminClient || !isKnownOAuthClientType(clientType)) return;
    const profile = OAUTH_CLIENT_PROFILES[clientType];
    this.form.client_type = clientType;
    this.form.public = profile.tokenEndpointAuthMethod === "none";
    this.form.grantTypes = profile.grantTypes.join(", ");
    this.form.responseTypes = profile.responseTypes.join(", ");
    this.form.tokenEndpointAuthMethod = profile.tokenEndpointAuthMethod;
    this.form.scope = profile.defaultScope;
    if (!profile.requiresRedirectUris) {
      this.form.redirectUris = "";
    }
    if (!profile.supportsPostLogoutRedirectUris) {
      this.form.postLogoutUris = "";
    }
    if (clientType !== "spa") {
      this.form.corsOrigins = "";
    }
    if (clientType !== "spa" && clientType !== "web") {
      this.form.returnUris = "";
    }
    this.onTrustTierChange();
  }

  useRedirectOrigins(): void {
    const origins = clientCorsOriginsFromRedirectUris(splitList(this.form.redirectUris), {
      allowHttpLoopback: true,
    });
    this.form.corsOrigins = origins.join("\n");
  }

  onScopesChange(scopes: readonly unknown[]): void {
    this.form.scope = normalizeScopeList(scopes).join(" ");
  }

  addCustomScope(): void {
    if (this.protectedAdminClient) return;
    const nextScopes = splitScopes(this.customScope);
    if (nextScopes.length === 0) return;
    this.form.scope = normalizeScopeList([...this.selectedScopes, ...nextScopes]).join(" ");
    this.customScope = "";
  }

  onCustomScopeKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter") return;
    event.preventDefault();
    this.addCustomScope();
  }

  scopeValueLabel(scopes: readonly unknown[]): string {
    const selected = normalizeScopeList(scopes);
    return selected.length > 0 ? selected.join(" ") : this.scopePlaceholder;
  }

  async submit(): Promise<void> {
    if (this.protectedAdminClient) {
      this.error = "The admin OAuth client cannot be edited.";
      this.toast.danger(this.error);
      return;
    }
    if (!this.canSubmit) {
      this.error = !this.form.client_id.trim()
        ? "Client ID is required."
        : this.selectedProfile?.requiresRedirectUris && splitList(this.form.redirectUris).length === 0
          ? "A redirect URI is required for this client type."
          : "At least one browser origin is required for a single-page app.";
      this.toast.danger(this.error);
      return;
    }
    await this.run(async () => {
      const payload = this.toPayload();
      if (this.createMode) {
        const created = await this.api.createClient(payload);
        this.toast.success(`Client "${payload.client_id}" created.`);
        await this.router.navigate(["/clients", created.client_id || payload.client_id], {
          state: created.client_secret ? { createdClientSecret: created.client_secret } : undefined,
        });
      } else {
        const updated = await this.api.updateClient(payload);
        this.applyClient(updated);
        this.notice = `Client "${payload.client_id}" updated.`;
        this.toast.success(this.notice);
      }
    });
  }

  private async loadIdentityGrants(): Promise<void> {
    try {
      this.identityGrants = await this.api.listClientIdentityAccess(this.clientId);
    } catch {
      this.identityGrants = [];
    }
  }

  async revokeIdentity(identityId: string): Promise<void> {
    await this.run(async () => {
      await this.api.revokeIdentityClientAccess(identityId, this.clientId);
      await this.loadIdentityGrants();
      this.notice = "Client access revoked.";
      this.toast.success(this.notice);
    });
  }

  async copyClientSecret(): Promise<void> {
    if (!this.createdClientSecret) return;
    try {
      await navigator.clipboard.writeText(this.createdClientSecret);
      this.toast.success("Client secret copied.");
    } catch (e) {
      this.error = describeError(e);
      this.toast.danger(this.error);
    }
  }

  async remove(): Promise<void> {
    const clientId = this.form.client_id.trim();
    if (this.protectedAdminClient) {
      this.error = "The admin OAuth client cannot be deleted.";
      this.toast.danger(this.error);
      return;
    }
    if (!clientId || !window.confirm(`Delete client "${clientId}"?`)) return;
    await this.run(async () => {
      await this.api.deleteClient(clientId);
      this.toast.success(`Client "${clientId}" deleted.`);
      await this.router.navigate(["/clients"]);
    });
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.error = "";
    this.notice = "";
    try {
      await fn();
    } catch (e) {
      this.error = describeError(e);
      this.toast.danger(this.error);
    } finally {
      this.busy = false;
    }
  }

  private captureCreatedSecret(): void {
    const state = window.history.state as { createdClientSecret?: unknown };
    if (typeof state.createdClientSecret !== "string" || !state.createdClientSecret) return;
    this.createdClientSecret = state.createdClientSecret;
    this.revealClientSecret = false;
    this.notice = "Client created. Copy the client secret now; it will not be shown again.";

    const nextState = { ...state };
    delete nextState.createdClientSecret;
    window.history.replaceState(nextState, "", window.location.href);
  }
}
