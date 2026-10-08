import { Component, DestroyRef, inject, type OnInit } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import {
  DELEGATION_EXCHANGE_SCOPE,
  DELEGATION_GRANT_SCOPE,
  isDelegationScope,
  type DelegationStatus,
} from "@idnest/shared-types";
import {
  TngBadgeComponent,
  TngButtonComponent,
  TngCardComponent,
  TngCardContentComponent,
  TngCardDescriptionComponent,
  TngCardHeaderComponent,
  TngCardTitleComponent,
  TngDialogComponent,
  TngFormFieldComponent,
  TngInputAngularFormsAdapter,
  TngInputComponent,
  TngLabelComponent,
  TngMultiSelectComponent,
  TngProgressSpinnerComponent,
  TngSelectComponent,
  TngSwitchComponent,
} from "@tailng-ui/components";
import { TngIcon } from "@tailng-ui/icons";
import { AdminApiService, describeError } from "../../core/admin-api.service";
import type {
  DelegationActorPolicyRecord,
  DelegationAuditActivity,
  DelegationGrantActivity,
  DelegationResourceRecord,
  HydraClient,
} from "../../core/admin-types";
import { ToastService } from "../../core/toast/toast.service";

type EditableDelegationStatus = Exclude<DelegationStatus, "archived">;

interface ResourceDraft {
  id: string;
  version: number;
  status: EditableDelegationStatus;
  key: string;
  displayName: string;
  audience: string;
  authorizerClientId: string;
  scopes: string[];
  tokenTtlSeconds: number;
  authorizationContextRequired: boolean;
}

interface ActorDraft {
  actorClientId: string;
  scopes: string[];
  status: EditableDelegationStatus;
}

interface SelectOption<T = string> {
  value: T;
  label: string;
}

const STATUS_OPTIONS: SelectOption<EditableDelegationStatus>[] = [
  { value: "active", label: "Active" },
  { value: "disabled", label: "Disabled" },
];

const TTL_OPTIONS: SelectOption<number>[] = [
  { value: 30, label: "30 seconds" },
  { value: 60, label: "1 minute" },
  { value: 120, label: "2 minutes" },
  { value: 180, label: "3 minutes" },
  { value: 300, label: "5 minutes" },
];

const getStringOptionValue = (option: SelectOption<string>): string => option.value;
const getNumberOptionValue = (option: SelectOption<number>): number => option.value;
const getOptionLabel = (option: SelectOption<unknown>): string => option.label;

function emptyResource(): ResourceDraft {
  return {
    id: "",
    version: 0,
    status: "active",
    key: "",
    displayName: "",
    audience: "",
    authorizerClientId: "",
    scopes: [],
    tokenTtlSeconds: 180,
    authorizationContextRequired: true,
  };
}

function emptyActor(): ActorDraft {
  return { actorClientId: "", scopes: [], status: "active" };
}

function normalizeScopes(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))].sort();
}

@Component({
  selector: "app-delegation-detail",
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    TngBadgeComponent,
    TngButtonComponent,
    TngCardComponent,
    TngCardContentComponent,
    TngCardDescriptionComponent,
    TngCardHeaderComponent,
    TngCardTitleComponent,
    TngDialogComponent,
    TngFormFieldComponent,
    TngIcon,
    TngInputAngularFormsAdapter,
    TngInputComponent,
    TngLabelComponent,
    TngMultiSelectComponent,
    TngProgressSpinnerComponent,
    TngSelectComponent,
    TngSwitchComponent,
  ],
  templateUrl: "./delegation-detail.component.html",
  styleUrls: ["./delegation-detail.component.css"],
})
export class DelegationDetailComponent implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private destroyed = false;

  createMode = true;
  loading = true;
  busy = false;
  error = "";
  activeTab: "settings" | "actors" | "activity" = "settings";
  resource?: DelegationResourceRecord;
  form = emptyResource();
  resourceReason = "";
  customScope = "";
  clients: HydraClient[] = [];
  actorPolicies: DelegationActorPolicyRecord[] = [];
  actorForm = emptyActor();
  actorReason = "";
  editingActorId = "";
  grants: DelegationGrantActivity[] = [];
  auditEvents: DelegationAuditActivity[] = [];
  archiveDialogOpen = false;
  removeActorDialogOpen = false;
  actorPendingRemoval?: DelegationActorPolicyRecord;
  revokeDialogOpen = false;
  grantPendingRevocation?: DelegationGrantActivity;

  readonly statusOptions = STATUS_OPTIONS;
  readonly ttlOptions = TTL_OPTIONS;
  readonly getStringOptionValue = getStringOptionValue;
  readonly getNumberOptionValue = getNumberOptionValue;
  readonly getOptionLabel = getOptionLabel;
  readonly trackOption = (_: number, option: SelectOption): string => option.value;

  private readonly dateFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
    });
  }

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get("id");
    this.createMode = !id;
    void this.load(id);
  }

  get resourceScopeOptions(): SelectOption[] {
    return this.form.scopes.map((scope) => ({ value: scope, label: scope }));
  }

  get authorizerOptions(): SelectOption[] {
    return this.clientOptions(DELEGATION_GRANT_SCOPE, this.form.authorizerClientId);
  }

  get actorClientOptions(): SelectOption[] {
    return this.clientOptions(DELEGATION_EXCHANGE_SCOPE, this.actorForm.actorClientId);
  }

  get canSaveResource(): boolean {
    return !this.busy && Boolean(
      this.form.key.trim() &&
      this.form.displayName.trim() &&
      this.form.audience.trim() &&
      this.form.authorizerClientId.trim() &&
      this.form.scopes.length > 0 &&
      this.form.tokenTtlSeconds >= 30 &&
      this.form.tokenTtlSeconds <= 300,
    );
  }

  get canSaveActor(): boolean {
    return !this.busy && Boolean(this.resource && this.actorForm.actorClientId.trim() && this.actorForm.scopes.length > 0);
  }

  async load(id: string | null): Promise<void> {
    this.loading = true;
    this.error = "";
    try {
      if (!id) {
        this.clients = await this.api.listClients();
        return;
      }
      const [resource, clients, actorPolicies, grants, auditEvents] = await Promise.all([
        this.api.getDelegationResource(id),
        this.api.listClients(),
        this.api.listDelegationActorPolicies(id),
        this.api.listDelegationGrants(id),
        this.api.listDelegationAudit(id),
      ]);
      if (this.destroyed) return;
      this.resource = resource;
      this.form = this.toResourceDraft(resource);
      this.clients = clients;
      this.actorPolicies = actorPolicies;
      this.grants = grants;
      this.auditEvents = auditEvents;
    } catch (error) {
      if (this.destroyed) return;
      this.error = describeError(error);
      this.toast.danger(this.error);
    } finally {
      if (!this.destroyed) this.loading = false;
    }
  }

  setActiveTab(tab: "settings" | "actors" | "activity"): void {
    if (this.createMode && tab !== "settings") return;
    this.activeTab = tab;
  }

  onResourceScopesChange(values: readonly unknown[]): void {
    this.form.scopes = normalizeScopes(values);
    const allowed = new Set(this.form.scopes);
    this.actorForm.scopes = this.actorForm.scopes.filter((scope) => allowed.has(scope));
  }

  addResourceScope(): void {
    const scope = this.customScope.trim();
    if (!scope) return;
    if (!isDelegationScope(scope)) {
      this.toast.danger("Use letters, numbers, dots, underscores, colons, or hyphens for scopes");
      return;
    }
    this.form.scopes = normalizeScopes([...this.form.scopes, scope]);
    this.customScope = "";
  }

  onCustomScopeKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter") return;
    event.preventDefault();
    this.addResourceScope();
  }

  onActorScopesChange(values: readonly unknown[]): void {
    this.actorForm.scopes = normalizeScopes(values);
  }

  scopeValueLabel(values: readonly unknown[]): string {
    const scopes = normalizeScopes(values);
    return scopes.length ? scopes.join(" · ") : "Select scopes";
  }

  async saveResource(): Promise<void> {
    if (!this.canSaveResource) return;
    const definition = {
      key: this.form.key.trim(),
      displayName: this.form.displayName.trim(),
      audience: this.form.audience.trim(),
      authorizerClientId: this.form.authorizerClientId.trim(),
      allowedScopes: this.form.scopes,
      tokenTtlSeconds: Number(this.form.tokenTtlSeconds),
      authorizationContextRequired: this.form.authorizationContextRequired,
    };
    await this.run(async () => {
      const saved = this.createMode
        ? await this.api.createDelegationResource(
            { status: this.form.status, definition },
            this.resourceReason.trim() || "Created from delegated access administration",
          )
        : await this.api.updateDelegationResource(
            {
              id: this.form.id,
              version: this.form.version,
              status: this.form.status,
              definition,
              created_at: this.resource?.created_at ?? "",
              updated_at: this.resource?.updated_at ?? "",
            },
            this.resourceReason.trim() || "Updated from delegated access administration",
          );
      this.toast.success(this.createMode ? "Delegation resource created" : "Delegation resource saved");
      if (this.createMode) {
        await this.router.navigate(["/delegation", saved.id]);
        return;
      }
      this.resource = saved;
      this.form = this.toResourceDraft(saved);
      this.resourceReason = "";
    });
  }

  openArchiveDialog(): void {
    if (!this.resource || this.busy) return;
    this.archiveDialogOpen = true;
  }

  async archiveResource(): Promise<void> {
    if (!this.resource || this.busy) return;
    const id = this.resource.id;
    this.archiveDialogOpen = false;
    await this.run(async () => {
      await this.api.archiveDelegationResource(id);
      this.toast.success("Delegation resource archived");
      await this.router.navigate(["/delegation"]);
    });
  }

  newActor(): void {
    this.actorForm = emptyActor();
    this.actorReason = "";
    this.editingActorId = "";
  }

  editActor(policy: DelegationActorPolicyRecord): void {
    this.actorForm = {
      actorClientId: policy.definition.actorClientId,
      scopes: [...policy.definition.allowedScopes],
      status: policy.status === "archived" ? "disabled" : policy.status,
    };
    this.actorReason = "";
    this.editingActorId = policy.definition.actorClientId;
  }

  async saveActor(): Promise<void> {
    if (!this.resource || !this.canSaveActor) return;
    const resourceId = this.resource.id;
    const actorClientId = this.actorForm.actorClientId.trim();
    await this.run(async () => {
      await this.api.saveDelegationActorPolicy(
        resourceId,
        actorClientId,
        {
          status: this.actorForm.status,
          definition: { actorClientId, allowedScopes: this.actorForm.scopes },
        },
        this.actorReason.trim() || "Updated from delegated access administration",
      );
      this.toast.success(this.editingActorId ? "Approved actor updated" : "Actor approved");
      this.actorPolicies = await this.api.listDelegationActorPolicies(resourceId);
      this.newActor();
    });
  }

  openRemoveActorDialog(policy: DelegationActorPolicyRecord): void {
    this.actorPendingRemoval = policy;
    this.removeActorDialogOpen = true;
  }

  async removeActor(): Promise<void> {
    const policy = this.actorPendingRemoval;
    if (!this.resource || !policy || this.busy) return;
    const resourceId = this.resource.id;
    this.removeActorDialogOpen = false;
    await this.run(async () => {
      await this.api.archiveDelegationActorPolicy(resourceId, policy.definition.actorClientId);
      this.toast.success("Approved actor removed");
      this.actorPolicies = await this.api.listDelegationActorPolicies(resourceId);
      if (this.editingActorId === policy.definition.actorClientId) this.newActor();
      this.actorPendingRemoval = undefined;
    });
  }

  openRevokeGrantDialog(grant: DelegationGrantActivity): void {
    if (!this.isGrantPending(grant)) return;
    this.grantPendingRevocation = grant;
    this.revokeDialogOpen = true;
  }

  async revokeGrant(): Promise<void> {
    const grant = this.grantPendingRevocation;
    if (!this.resource || !grant || !this.isGrantPending(grant) || this.busy) return;
    const resourceId = this.resource.id;
    this.revokeDialogOpen = false;
    await this.run(async () => {
      await this.api.revokeDelegationGrant(grant.id);
      this.toast.success("Pending grant revoked");
      this.grants = await this.api.listDelegationGrants(resourceId);
      this.grantPendingRevocation = undefined;
    });
  }

  isGrantPending(grant: DelegationGrantActivity): boolean {
    return !grant.consumed_at && !grant.revoked_at && new Date(grant.expires_at).getTime() > Date.now();
  }

  grantState(grant: DelegationGrantActivity): string {
    if (grant.revoked_at) return "Revoked";
    if (grant.consumed_at) return "Exchanged";
    if (new Date(grant.expires_at).getTime() <= Date.now()) return "Expired";
    return "Pending";
  }

  grantStateClass(grant: DelegationGrantActivity): string {
    return `state-${this.grantState(grant).toLowerCase()}`;
  }

  scopeLabel(scopes: string[]): string {
    return scopes.join(" · ") || "No scopes";
  }

  dateLabel(value: string | null): string {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : this.dateFormatter.format(date);
  }

  private toResourceDraft(resource: DelegationResourceRecord): ResourceDraft {
    return {
      id: resource.id,
      version: resource.version,
      status: resource.status === "archived" ? "disabled" : resource.status,
      key: resource.definition.key,
      displayName: resource.definition.displayName,
      audience: resource.definition.audience,
      authorizerClientId: resource.definition.authorizerClientId,
      scopes: [...resource.definition.allowedScopes],
      tokenTtlSeconds: resource.definition.tokenTtlSeconds,
      authorizationContextRequired: resource.definition.authorizationContextRequired,
    };
  }

  private clientOptions(requiredScope: string, currentValue: string): SelectOption[] {
    const options = this.clients
      .filter((client) => client.grant_types?.includes("client_credentials"))
      .filter((client) => client.scope?.split(/\s+/).includes(requiredScope))
      .map((client) => ({
        value: client.client_id,
        label: client.client_name ? `${client.client_name} (${client.client_id})` : client.client_id,
      }));
    if (currentValue && !options.some((option) => option.value === currentValue)) {
      options.unshift({ value: currentValue, label: currentValue });
    }
    return options;
  }

  private async run(operation: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    try {
      await operation();
    } catch (error) {
      if (this.destroyed) return;
      this.error = describeError(error);
      this.toast.danger(this.error);
    } finally {
      if (!this.destroyed) this.busy = false;
    }
  }
}
