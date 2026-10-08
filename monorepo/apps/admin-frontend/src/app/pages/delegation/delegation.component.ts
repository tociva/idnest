import { Component, DestroyRef, inject, type OnInit, viewChild } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import type { DelegationStatus } from "@idnest/shared-types";
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
  TngPaginatorComponent,
  TngProgressSpinnerComponent,
  TngSelectComponent,
  TngTableCellTemplate,
  TngTableComponent,
  TngTooltipComponent,
  type TngTableColumn,
} from "@tailng-ui/components";
import { TngIcon } from "@tailng-ui/icons";
import { TngPopover, TngPopoverPanel, TngPopoverTrigger } from "@tailng-ui/primitives";
import { AdminApiService, describeError } from "../../core/admin-api.service";
import type {
  DelegationAuditActivity,
  DelegationGrantActivity,
  DelegationResourceRecord,
} from "../../core/admin-types";
import {
  LIST_PAGE_SIZE_OPTIONS,
  clampListPage,
  matchesListSearch,
  paginateItems,
  parseListPageQuery,
  toListPageQueryParams,
  type ListPageQuery,
} from "../../core/list-page-query";
import { ToastService } from "../../core/toast/toast.service";

interface ResourceRow {
  resource: DelegationResourceRecord;
  searchText: string;
}

interface SelectOption {
  value: string;
  label: string;
}

const STATUS_OPTIONS: SelectOption[] = [
  { value: "", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "disabled", label: "Disabled" },
];

const getOptionValue = (option: SelectOption): string => option.value;
const getOptionLabel = (option: SelectOption): string => option.label;

@Component({
  selector: "app-delegation",
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
    TngPaginatorComponent,
    TngPopover,
    TngPopoverPanel,
    TngPopoverTrigger,
    TngProgressSpinnerComponent,
    TngSelectComponent,
    TngTableCellTemplate,
    TngTableComponent,
    TngTooltipComponent,
  ],
  templateUrl: "./delegation.component.html",
  styleUrls: ["./delegation.component.css"],
})
export class DelegationComponent implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly sorter = new Intl.Collator(undefined, { sensitivity: "base" });
  private readonly filterPopover = viewChild<TngPopover>("filterPopover");
  private destroyed = false;
  private loadRequestId = 0;

  rows: ResourceRow[] = [];
  grants: DelegationGrantActivity[] = [];
  auditEvents: DelegationAuditActivity[] = [];
  activeTab: "resources" | "activity" = "resources";
  loading = true;
  error = "";
  filterQ = "";
  filterStatus = "";
  activityResourceId = "";
  revokeDialogOpen = false;
  pendingGrant?: DelegationGrantActivity;
  busyGrantId = "";

  query: ListPageQuery = { q: "", status: "", page: 1, pageSize: 25 };

  readonly pageSizeOptions = [...LIST_PAGE_SIZE_OPTIONS];
  readonly statusOptions = STATUS_OPTIONS;
  readonly getOptionValue = getOptionValue;
  readonly getOptionLabel = getOptionLabel;
  readonly columns: TngTableColumn<ResourceRow>[] = [
    { id: "resource", label: "Resource", accessor: (row) => row.resource.definition.displayName, width: "17rem" },
    { id: "audience", label: "Audience", accessor: (row) => row.resource.definition.audience, width: "19rem" },
    { id: "scopes", label: "Scopes", accessor: (row) => this.scopeLabel(row.resource.definition.allowedScopes), width: "16rem" },
    { id: "ttl", label: "Token lifetime", accessor: (row) => this.ttlLabel(row.resource.definition.tokenTtlSeconds), width: "9rem" },
    { id: "status", label: "Status", accessor: (row) => this.statusLabel(row.resource.status), width: "7rem" },
    { id: "actions", label: "", align: "end", width: "3.5rem" },
  ];

  private readonly dateFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
    });
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      this.query = parseListPageQuery(params);
      this.filterQ = this.query.q;
      this.filterStatus = this.query.status;
      this.activeTab = params.get("view") === "activity" ? "activity" : "resources";
      this.activityResourceId = params.get("resource") ?? "";
    });
  }

  ngOnInit(): void {
    void this.reload();
  }

  get filteredRows(): ResourceRow[] {
    return this.rows.filter((row) => {
      if (this.query.status && row.resource.status !== this.query.status) return false;
      return matchesListSearch(row.searchText, this.query.q);
    });
  }

  get filteredTotal(): number {
    return this.filteredRows.length;
  }

  get pagedRows(): ResourceRow[] {
    return paginateItems(this.filteredRows, this.clampedPage, this.query.pageSize);
  }

  get pageIndex(): number {
    return this.clampedPage - 1;
  }

  get resourceOptions(): SelectOption[] {
    return [
      { value: "", label: "All resources" },
      ...this.rows.map(({ resource }) => ({
        value: resource.id,
        label: resource.definition.displayName,
      })),
    ];
  }

  get visibleGrants(): DelegationGrantActivity[] {
    return this.activityResourceId
      ? this.grants.filter((grant) => grant.resource_id === this.activityResourceId)
      : this.grants;
  }

  get visibleAuditEvents(): DelegationAuditActivity[] {
    return this.activityResourceId
      ? this.auditEvents.filter((event) => event.resource_id === this.activityResourceId)
      : this.auditEvents;
  }

  private get clampedPage(): number {
    return clampListPage(this.query.page, this.filteredTotal, this.query.pageSize);
  }

  async reload(): Promise<void> {
    const requestId = ++this.loadRequestId;
    this.loading = true;
    this.error = "";
    try {
      const [resources, grants, auditEvents] = await Promise.all([
        this.api.listDelegationResources(),
        this.api.listDelegationGrants(),
        this.api.listDelegationAudit(),
      ]);
      if (!this.isActiveLoad(requestId)) return;
      this.rows = [...resources]
        .sort((a, b) => this.sorter.compare(a.definition.displayName, b.definition.displayName))
        .map((resource) => ({
          resource,
          searchText: [
            resource.definition.displayName,
            resource.definition.key,
            resource.definition.audience,
            resource.definition.authorizerClientId,
            ...resource.definition.allowedScopes,
          ].join(" "),
        }));
      this.grants = grants;
      this.auditEvents = auditEvents;
    } catch (error) {
      if (!this.isActiveLoad(requestId)) return;
      this.error = describeError(error);
      this.toast.danger(this.error);
    } finally {
      if (this.isActiveLoad(requestId)) this.loading = false;
    }
  }

  setActiveTab(tab: "resources" | "activity"): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { view: tab === "activity" ? "activity" : null },
      queryParamsHandling: "merge",
      replaceUrl: true,
    });
  }

  applyFilters(): void {
    void this.navigateListQuery({
      q: this.filterQ,
      status: this.filterStatus,
      page: 1,
      pageSize: this.query.pageSize,
    });
    this.filterPopover()?.closePopover("programmatic");
  }

  clearFilters(): void {
    this.filterQ = "";
    this.filterStatus = "";
    void this.navigateListQuery({ q: "", status: "", page: 1, pageSize: this.query.pageSize });
    this.filterPopover()?.closePopover("programmatic");
  }

  onPageChange(event: { pageIndex: number; pageSize: number }): void {
    void this.navigateListQuery({
      q: this.query.q,
      status: this.query.status,
      page: event.pageIndex + 1,
      pageSize: event.pageSize,
    });
  }

  onActivityResourceChange(value: string | null): void {
    this.activityResourceId = value ?? "";
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { resource: this.activityResourceId || null },
      queryParamsHandling: "merge",
      replaceUrl: true,
    });
  }

  asResourceRow(row: unknown): ResourceRow {
    return row as ResourceRow;
  }

  openRevokeDialog(grant: DelegationGrantActivity): void {
    if (!this.isGrantPending(grant)) return;
    this.pendingGrant = grant;
    this.revokeDialogOpen = true;
  }

  async revokeGrant(): Promise<void> {
    const grant = this.pendingGrant;
    if (!grant || !this.isGrantPending(grant) || this.busyGrantId) return;
    this.revokeDialogOpen = false;
    this.busyGrantId = grant.id;
    try {
      await this.api.revokeDelegationGrant(grant.id);
      this.toast.success("Pending grant revoked");
      this.grants = await this.api.listDelegationGrants();
    } catch (error) {
      this.error = describeError(error);
      this.toast.danger(this.error);
    } finally {
      this.busyGrantId = "";
      this.pendingGrant = undefined;
    }
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

  statusLabel(status: DelegationStatus): string {
    return status.charAt(0).toUpperCase() + status.slice(1);
  }

  ttlLabel(seconds: number): string {
    if (seconds < 60) return `${seconds} seconds`;
    const minutes = seconds / 60;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }

  scopeLabel(scopes: string[]): string {
    return scopes.join(" · ") || "No scopes";
  }

  dateLabel(value: string | null): string {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : this.dateFormatter.format(date);
  }

  private navigateListQuery(query: ListPageQuery): Promise<boolean> {
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toListPageQueryParams(query),
      queryParamsHandling: "merge",
      replaceUrl: true,
    });
  }

  private isActiveLoad(requestId: number): boolean {
    return !this.destroyed && requestId === this.loadRequestId;
  }
}
