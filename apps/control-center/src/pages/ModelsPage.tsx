import { backendText } from "../backend-text";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Check, ChevronDown, Filter, KeyRound, Link2, LogIn, MoreHorizontal, Plus, SearchX, ShieldCheck, Trash2 } from "lucide-react";
import { Badge, Button, CatalogSkeleton, Dialog, EmptyState, PageHeader, PanelSkeleton, SearchField, SkeletonBlock, Toggle } from "../components";
import { BrandLogo, ProviderLogo, brandForModel } from "../provider-branding";
import { effortLabel, formatContext, formatDateTime } from "../lib";
import {
  addPendingCatalogModels,
  beginCatalogRequest,
  catalogRequestIsCurrent,
  clearProviderCatalogStates,
  invalidateProviderCatalogRequests,
  loadedCatalogModels,
  modelRouteKind,
  pendingCatalogModelIds,
  removePendingCatalogModels,
  type PendingCatalogModels,
} from "../model-catalog-search.mjs";
import { groupModelFamilies, preferredFamilyRoute } from "../model-families.mjs";
import { useOptimisticValues, type RunAction } from "../useOptimisticValues";
import { useI18n, type Translate } from "../i18n";
import type {
  ModelViewFocusRequest,
  ProviderCatalog,
  ProviderSetup,
  ProviderSetupSnapshot,
  ProviderUsageSnapshot,
  RouterCatalogSnapshot,
  RouterControlApi,
  RouterDataReady,
  RouterKnownModel,
  RouterModel,
  RouterTarget,
} from "../types";
import "./providers-models.css";

type StatusFilter = "all" | "on" | "off" | "blocked";
const CATALOG_ADD_BATCH_LIMIT = 200;

/** One model, and every provider route that can serve it. */
interface ModelFamily {
  id: string;
  displayName: string;
  routes: RouterModel[];
}

/** A model a connected provider offers but the router has not registered yet. */
interface CatalogModel {
  key: string;
  modelId: string;
  displayName: string;
  providerId: string;
  providerName: string;
  sourceId: string;
  sourceName: string;
  registered: boolean;
  addable: boolean;
  blockedReason?: string;
  contextWindow?: number;
  isFree: boolean;
}

function statusLabels(t: Translate): Record<StatusFilter, string> {
  return {
    all: t("models.status.all"),
    on: t("models.status.on"),
    off: t("models.status.off"),
    blocked: t("models.status.blocked"),
  };
}

function allProvidersLabel(t: Translate): string {
  return t("models.allProviders");
}

/** Below this, a list is short enough to read whole; filters and bulk switches
 *  would be more chrome than the list they act on. */
const CROWDED_LIST = 8;

/** Picking between two or three providers is slower through a menu than by
 *  reading the provider each row already names. */
const CROWDED_PROVIDERS = 3;

interface ModelsPageProps {
  target?: RouterTarget;
  /** Shared router policy; client probes remain available for native details. */
  catalog?: RouterCatalogSnapshot;
  setup?: ProviderSetupSnapshot;
  usage?: ProviderUsageSnapshot;
  api?: RouterControlApi;
  refreshing: boolean;
  dataReady: RouterDataReady;
  onRefresh: () => void;
  runAction: RunAction;
  focusRequest?: ModelViewFocusRequest;
}

interface ProviderDirectoryEntry {
  id: string;
  displayName: string;
  setup?: ProviderSetup;
  models: RouterModel[];
  knownModels: RouterKnownModel[];
}

interface CatalogViewState {
  status: "idle" | "loading" | "ready" | "error";
  /** A refresh keeps the list on screen instead of replacing it with a skeleton. */
  refreshing: boolean;
  data?: ProviderCatalog;
  error?: string;
}

function catalogEligible(entry: ProviderDirectoryEntry): boolean {
  return Boolean(entry.setup?.configured && entry.setup.catalogSources?.length);
}

// The capability the catalog published wins over the registry's provenance: a
// route the operator selected is v2 to Codex even though the registry never
// certified it, and asking the registry first described it as unusable.
function subagentCertification(model: RouterModel): "v1" | "v2" | "unknown" | string {
  if (model.multiAgentVersion === "v2") return "v2";
  return model.subagentCertification
    ?? (model.multiAgentVersion === "v1" ? "v1" : "unknown");
}

function subagentEnabled(target: RouterTarget, slug: string, settings = target.modelSettings?.subagents): boolean {
  if (!settings) return false;
  if (settings.disabled.includes(slug)) return false;
  const model = target.models.find((entry) => entry.slug === slug);
  if (!model || model.visible === false) return false;
  // Certified routes remain active unless explicitly disabled; selected mode
  // does not silently turn off every other registry-v2 route. For an unknown
  // route, a selected-mode entry means only that its compatibility test was
  // requested — it never becomes an active subagent here.
  if (subagentCertification(model) === "v2") {
    return true;
  }
  return settings.mode === "selected" && settings.enabled.includes(slug);
}

function nativeClientManaged(model: RouterModel): boolean {
  return model.native === true && model.nativeClientManaged !== false;
}

function routeUsable(model: RouterModel): boolean {
  return model.available !== false;
}

export function ModelsPage({ target, catalog, setup, usage, api, refreshing, dataReady, onRefresh, runAction, focusRequest }: ModelsPageProps) {
  const t = useI18n();
  const [modelSearch, setModelSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const filterMenuRef = useRef<HTMLDivElement | null>(null);
  const [providerFilter, setProviderFilter] = useState("all");
  const [providerFilterMenuOpen, setProviderFilterMenuOpen] = useState(false);
  const providerFilterMenuRef = useRef<HTMLDivElement | null>(null);
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  const bulkMenuRef = useRef<HTMLDivElement | null>(null);
  // The connect menu lives in the connections strip but is also the first-run
  // call to action, so the page owns whether it is open.
  const [connectMenuOpen, setConnectMenuOpen] = useState(false);
  const [expandedFamilyId, setExpandedFamilyId] = useState<string | null>(null);
  const [managedProviderId, setManagedProviderId] = useState<string | null>(null);
  const [addModelsOpen, setAddModelsOpen] = useState(false);
  const [loadingConnectedCatalogs, setLoadingConnectedCatalogs] = useState(false);
  const [credentialProvider, setCredentialProvider] = useState<ProviderSetup | null>(null);
  const [configurationProvider, setConfigurationProvider] = useState<ProviderSetup | null>(null);
  const [removeProvider, setRemoveProvider] = useState<ProviderSetup | null>(null);
  const [catalogStates, setCatalogStates] = useState<Record<string, CatalogViewState>>({});
  const catalogRequestGenerations = useRef<Record<string, number>>({});
  // Slugs committed to the picker but not yet published, per provider. Adding
  // republishes the whole catalog to every installed client, which is the
  // slowest thing this page starts; without a placeholder the models simply are
  // not there for the length of it and the click reads as having done nothing.
  const [pendingModels, setPendingModels] = useState<PendingCatalogModels>({});

  // External model identity and picker visibility come from the router-owned
  // catalog. Native entries remain a Codex-only adapter concern and are merged
  // in for the convenience of the Codex client view.
  const models = useMemo(() => {
    const clientModels = target?.models ?? [];
    if (!catalog) return clientModels;
    const nativeModels = clientModels.filter((model) => model.native);
    const seen = new Set(nativeModels.map((model) => model.slug));
    return [
      ...nativeModels,
      ...catalog.models.filter((model) => !seen.has(model.slug)),
    ];
  }, [catalog, target?.models]);
  const enabledProviders = useMemo(
    () => new Set(catalog?.enabledProviders ?? target?.enabledProviders ?? []),
    [catalog?.enabledProviders, target?.enabledProviders],
  );
  const subagentSettings = catalog?.subagents ?? target?.modelSettings?.subagents;
  // One list covers configured routes and routes that are only known to the
  // registry. A model nobody can reach yet is still the answer to "can I use
  // this model", so it stays on the page with the connection it is waiting for.
  const allModels = useMemo<RouterModel[]>(() => {
    const activeSlugs = new Set(models.map((model) => model.slug));
    return [
      ...models,
      ...(catalog?.knownModels ?? [])
        .filter((model) => !activeSlugs.has(model.slug))
        .map((model) => ({
          ...model,
          enabled: false,
          visible: false,
          available: false,
          subagentCertification: "unknown" as const,
        })),
    ];
  }, [catalog?.knownModels, models]);
  const families = useMemo<ModelFamily[]>(() => groupModelFamilies(allModels), [allModels]);
  const usageById = useMemo(
    () => new Map((usage?.providers ?? []).map((provider) => [provider.id, provider])),
    [usage?.providers],
  );
  const directory = useMemo<ProviderDirectoryEntry[]>(() => {
    const entries = new Map<string, ProviderDirectoryEntry>();
    for (const provider of setup?.providers ?? []) {
      entries.set(provider.id, { id: provider.id, displayName: provider.displayName, setup: provider, models: [], knownModels: [] });
    }
    for (const provider of target?.providers ?? []) {
      const current = entries.get(provider.id);
      entries.set(provider.id, {
        id: provider.id,
        displayName: current?.displayName || provider.displayName,
        setup: current?.setup,
        models: current?.models ?? [],
        knownModels: current?.knownModels ?? [],
      });
    }
    for (const model of models) {
      const current = entries.get(model.provider);
      entries.set(model.provider, {
        id: model.provider,
        displayName: current?.displayName || providerDisplayName(model.provider, t),
        setup: current?.setup,
        models: [...(current?.models ?? []), model],
        knownModels: current?.knownModels ?? [],
      });
    }
    for (const model of catalog?.knownModels ?? []) {
      const current = entries.get(model.provider);
      entries.set(model.provider, {
        id: model.provider,
        displayName: current?.displayName || providerDisplayName(model.provider, t),
        setup: current?.setup,
        models: current?.models ?? [],
        knownModels: [...(current?.knownModels ?? []), model],
      });
    }
    return [...entries.values()].sort((left, right) => {
      const leftConnected = providerConnected(left, enabledProviders);
      const rightConnected = providerConnected(right, enabledProviders);
      return Number(rightConnected) - Number(leftConnected) || left.displayName.localeCompare(right.displayName);
    });
  }, [catalog?.knownModels, enabledProviders, models, setup?.providers, target?.providers, t]);
  const directoryById = useMemo(() => new Map(directory.map((entry) => [entry.id, entry])), [directory]);
  const providerStates = useMemo(() => new Map(directory.map((entry) => [
    entry.id,
    enabledProviders.has(entry.id) || entry.models.some((model) => model.native),
  ])), [directory, enabledProviders]);
  const providerNames = useMemo(
    () => new Map(directory.map((entry) => [entry.id, entry.displayName])),
    [directory],
  );
  // Ordered by the directory, so the menu lists providers in the same order as
  // the connections strip: connected first, then alphabetical.
  const filterProviders = useMemo(() => {
    const routed = new Set(families.flatMap((family) => family.routes.map((model) => model.provider)));
    return directory.filter((entry) => routed.has(entry.id));
  }, [directory, families]);
  const providerCrowded = filterProviders.length > CROWDED_PROVIDERS;
  // A filter whose chip is not on screen -- because the provider left the list,
  // or because there are too few providers left to warrant the chip -- would go
  // on narrowing the list with nothing there to undo it.
  const activeProviderFilter = providerCrowded && filterProviders.some((entry) => entry.id === providerFilter)
    ? providerFilter
    : "all";
  const pickerStates = useMemo(() => new Map(models.map((model) => [model.slug, model.visible])), [models]);
  const subagentStates = useMemo(() => new Map(models.map((model) => [
    model.slug,
    Boolean(target && subagentEnabled(target, model.slug, subagentSettings)),
  ])), [models, subagentSettings, target]);
  const subagentEffortStates = useMemo(() => new Map(models.map((model) => [
    model.slug,
    subagentSettings?.efforts?.[model.slug] ?? "default",
  ])), [models, subagentSettings?.efforts]);
  const optimisticProviders = useOptimisticValues(providerStates, runAction);
  const optimisticPicker = useOptimisticValues(pickerStates, runAction);
  const optimisticSubagents = useOptimisticValues(subagentStates, runAction);
  const optimisticSubagentEfforts = useOptimisticValues(subagentEffortStates, runAction);

  useEffect(() => {
    if (!filterMenuOpen && !providerFilterMenuOpen && !bulkMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!filterMenuRef.current?.contains(event.target as Node)) setFilterMenuOpen(false);
      if (!providerFilterMenuRef.current?.contains(event.target as Node)) setProviderFilterMenuOpen(false);
      if (!bulkMenuRef.current?.contains(event.target as Node)) setBulkMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setFilterMenuOpen(false);
      setProviderFilterMenuOpen(false);
      setBulkMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [bulkMenuOpen, filterMenuOpen, providerFilterMenuOpen]);

  const updateCatalogState = (sourceId: string, update: (current: CatalogViewState) => CatalogViewState) => {
    setCatalogStates((current) => ({
      ...current,
      [sourceId]: update(current[sourceId] ?? { status: "idle", refreshing: false }),
    }));
  };

  const runProviderCredentialAction = async (
    provider: ProviderSetup,
    label: string,
    action: () => Promise<unknown>,
  ) => {
    const invalidateCatalogs = () => {
      invalidateProviderCatalogRequests(catalogRequestGenerations.current, provider.catalogSources);
      setCatalogStates((current) => clearProviderCatalogStates(current, provider.catalogSources));
    };
    // Clear at both boundaries. The command may have changed the credential
    // before a later refresh/publish step rejects, and a discovery that lands
    // while the mutation is running must not show the previous account.
    invalidateCatalogs();
    try {
      await runAction(label, async () => {
        await action();
      });
    } finally {
      invalidateCatalogs();
    }
  };

  const discoverCatalog = async (
    entry: ProviderDirectoryEntry,
    sourceId: string,
    { refresh = false, keepOnFailure = false } = {},
  ) => {
    if (!api || !catalogEligible(entry) || !sourceId) return;
    const generation = beginCatalogRequest(catalogRequestGenerations.current, sourceId);
    updateCatalogState(sourceId, (current) => ({
      ...current,
      status: "loading",
      refreshing: refresh && Boolean(current.data),
      error: undefined,
    }));
    try {
      const data = await api.discoverProviderModels(sourceId, { refresh });
      if (!catalogRequestIsCurrent(catalogRequestGenerations.current, sourceId, generation)) return;
      updateCatalogState(sourceId, (current) => ({ ...current, status: "ready", refreshing: false, data, error: undefined }));
      // A stored list past its trust window is shown immediately and re-read
      // behind it, so a model the provider shipped since the last visit does
      // not stay invisible until somebody thinks to press Reload. A failed
      // re-read leaves the list that is already on screen in place.
      if (!refresh && data.stale) void discoverCatalog(entry, sourceId, { refresh: true, keepOnFailure: true });
    } catch (error) {
      if (!catalogRequestIsCurrent(catalogRequestGenerations.current, sourceId, generation)) return;
      updateCatalogState(sourceId, (current) => keepOnFailure && current.data
        ? { ...current, status: "ready", refreshing: false }
        : {
          ...current,
          status: "error",
          refreshing: false,
          error: error instanceof Error ? error.message : t("models.add.catalogsFailed"),
        });
    }
  };

  const catalogRequests = () => directory.flatMap((entry) => !catalogEligible(entry) || !providerConnected(entry, enabledProviders)
    ? []
    : (entry.setup?.catalogSources ?? []).map((source) => ({ entry, sourceId: source.id })));

  // Opening the picker loads every connected provider at once, so one search
  // box can cover them all. Stored lists answer immediately; only an explicit
  // reload re-asks the providers.
  const loadConnectedCatalogs = async ({ refresh = false } = {}) => {
    if (!api || loadingConnectedCatalogs) return;
    const requests = catalogRequests().filter(({ sourceId }) => refresh || (catalogStates[sourceId]?.status ?? "idle") === "idle");
    if (!requests.length) return;
    setLoadingConnectedCatalogs(true);
    try {
      await Promise.all(requests.map(({ entry, sourceId }) => discoverCatalog(entry, sourceId, { refresh })));
    } finally {
      setLoadingConnectedCatalogs(false);
    }
  };

  const publishCatalogModels = async (entry: ProviderDirectoryEntry, sourceId: string, selected: string[]) => {
    if (!api || !sourceId || !selected.length) return;
    let published = false;
    setPendingModels((current) => addPendingCatalogModels(current, entry.id, selected));
    try {
      await runAction(t("models.action.addModels", { count: selected.length, name: entry.displayName }), async () => {
        await api.addProviderModels(sourceId, selected);
        published = true;
      });
      if (!published) return;
      await discoverCatalog(entry, sourceId);
    } finally {
      // Cleared on failure too: a placeholder left behind after a failed add
      // would claim the model arrived. runAction reports the error itself.
      setPendingModels((current) => removePendingCatalogModels(current, entry.id, selected));
    }
  };

  const addCatalogModels = async (selection: CatalogModel[]) => {
    const bySource = new Map<string, { entry: ProviderDirectoryEntry; modelIds: string[] }>();
    for (const model of selection) {
      const entry = directoryById.get(model.providerId);
      if (!entry) continue;
      const group = bySource.get(model.sourceId) ?? { entry, modelIds: [] };
      group.modelIds.push(model.modelId);
      bySource.set(model.sourceId, group);
    }
    for (const [sourceId, { entry, modelIds }] of bySource) {
      await publishCatalogModels(entry, sourceId, modelIds);
    }
  };

  const openAddModels = () => {
    setAddModelsOpen(true);
    void loadConnectedCatalogs();
  };

  const openProviderMenu = (providerId: string) => {
    setManagedProviderId((current) => (current === providerId ? null : providerId));
  };

  const renderConnections = () => !dataReady.providers && !setup ? (
    <section className="pm-connections pm-connections-loading" aria-label={t("models.loading.connections")} aria-busy="true">
      <SkeletonBlock />
      <SkeletonBlock />
      <SkeletonBlock />
    </section>
  ) : (
    <ConnectionsBar
      directory={directory}
      enabledProviders={enabledProviders}
      usageById={usageById}
      apiAvailable={Boolean(api)}
      platform={api?.platform}
      openProviderId={managedProviderId}
      onOpenProvider={openProviderMenu}
      onCloseProvider={() => setManagedProviderId(null)}
      connectMenuOpen={connectMenuOpen}
      onConnectMenuOpen={setConnectMenuOpen}
      isEnabled={(entry) => optimisticProviders.value(entry.id, enabledProviders.has(entry.id) || entry.models.some((model) => model.native))}
      onEnabledChange={(entry, checked) => {
        if (!api) return;
        void optimisticProviders.mutate(entry.id, checked, checked ? t("models.action.enableProvider", { name: entry.displayName }) : t("models.action.disableProvider", { name: entry.displayName }), () => api.setProviderEnabled(entry.id, checked));
      }}
      onSignIn={(entry) => {
        if (!api || !entry.setup) return;
        const label = entry.setup.action === "probe"
          ? t("models.action.runProbe", { name: entry.displayName })
          : t("models.action.startSignIn", { name: entry.displayName });
        void runProviderCredentialAction(entry.setup, label, () => api.connectProvider(entry.id));
      }}
      onConfigure={(entry) => entry.setup && setConfigurationProvider(entry.setup)}
      onKey={(entry) => entry.setup && setCredentialProvider(entry.setup)}
      onRemove={(entry) => entry.setup && setRemoveProvider(entry.setup)}
    />
  );
  const renderConnectionDialogs = () => (
    <>
      <CredentialDialog
        provider={credentialProvider}
        onSave={(provider, secret) => api
          ? runProviderCredentialAction(provider, t("models.action.saveCredential", { name: provider.displayName }), () => api.saveProviderCredential(provider.id, secret))
          : Promise.resolve()}
        onClose={() => setCredentialProvider(null)}
      />
      <Dialog
        open={Boolean(configurationProvider)}
        title={t("models.config.title", { name: configurationProvider?.displayName || t("models.credential.provider") })}
        description={t("models.config.description")}
        onClose={() => setConfigurationProvider(null)}
      >
        <div className="pm-credential-warning">
          <ShieldCheck aria-hidden size={17} strokeWidth={1.7} />
          <p>{backendText(configurationProvider?.configurationNote, t) || t("models.config.run")}</p>
        </div>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setConfigurationProvider(null)}>{t("models.config.close")}</Button>
        </div>
      </Dialog>
      <Dialog open={Boolean(removeProvider)} title={t("models.disconnect.title")} description={t("models.disconnect.description")} onClose={() => setRemoveProvider(null)}>
        <div className="pm-credential-warning"><ShieldCheck aria-hidden size={17} strokeWidth={1.7} /><p>{removeProvider?.id === "antigravity-oauth"
          ? t("models.disconnect.antigravity")
          : t("models.disconnect.env")}</p></div>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setRemoveProvider(null)}>{t("models.disconnect.cancel")}</Button>
          <Button variant="danger" onClick={() => { const provider = removeProvider; setRemoveProvider(null); if (provider && api) void runProviderCredentialAction(provider, t("models.action.removeCredential", { name: provider.displayName }), () => api.removeProviderCredential(provider.id)); }}><Trash2 aria-hidden size={14} strokeWidth={1.7} /> {t("models.disconnect.confirm")}</Button>
        </div>
      </Dialog>
    </>
  );

  const filteredFamilies = useMemo(() => {
    const needle = modelSearch.trim().toLowerCase();
    if (!needle && activeProviderFilter === "all") return families;
    return families.filter((family) => {
      if (activeProviderFilter !== "all" && !family.routes.some((model) => model.provider === activeProviderFilter)) return false;
      if (!needle) return true;
      return `${family.displayName} ${family.routes.map((model) => `${model.displayName} ${model.slug} ${providerDisplayName(model.provider, t)}`).join(" ")}`
        .toLowerCase()
        .includes(needle);
    });
  }, [activeProviderFilter, families, modelSearch, t]);

  // Row order never depends on a switch. Sorting by on/off would throw the row
  // you just clicked to the other end of the list, at the exact moment you are
  // looking at it to confirm the click did what you meant.
  const rows = useMemo(() => filteredFamilies.map((family) => {
    const usable = family.routes.filter(routeUsable);
    const inPicker = usable.filter((model) => optimisticPicker.value(model.slug, model.visible));
    return { family, usable, inPicker, on: inPicker.length > 0 };
  }), [filteredFamilies, optimisticPicker]);
  const visibleRows = useMemo(() => rows.filter((row) => {
    if (statusFilter === "all") return true;
    if (statusFilter === "blocked") return !row.usable.length;
    if (!row.usable.length) return false;
    return statusFilter === "on" ? row.on : !row.on;
  }), [rows, statusFilter]);
  const readyRows = visibleRows.filter((row) => row.usable.length);
  const blockedRows = visibleRows.filter((row) => !row.usable.length);

  useEffect(() => {
    if (!focusRequest) return;
    const id = focusRequest.region === "providers" ? "model-provider-directory" : "model-catalog-controls";
    const frame = window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest]);

  if (!target) {
    return (
      <>
        <div className="providers-models-page models-page">
          <PageHeader
            eyebrow={t("models.eyebrow")}
            title={t("models.title")}
            description={t("models.description")}
            onRefresh={onRefresh}
            refreshing={refreshing}
          />
          {renderConnections()}
          {!dataReady.snapshot ? (
            <section className="panel-section pm-models-loading" aria-label={t("models.loading.models")} aria-busy="true">
              <PanelSkeleton label={t("models.loading.routes")} count={6} />
            </section>
          ) : (
            <EmptyState icon={<SearchX size={22} />} title={t("models.snapshotUnavailable")} body={t("models.snapshotUnavailableBody")} />
          )}
        </div>
        {renderConnectionDialogs()}
      </>
    );
  }

  const connectedProviderCount = directory.filter((entry) => providerConnected(entry, enabledProviders)).length;
  const labels = statusLabels(t);
  const allProviders = allProvidersLabel(t);
  const pendingSlugs = directory.flatMap((entry) => pendingCatalogModelIds(pendingModels, entry.id)
    .filter((slug) => !entry.models.some((model) => model.slug === slug)));

  const updatePicker = (slug: string, visible: boolean) => api
    ? optimisticPicker.mutate(slug, visible, visible ? t("models.action.show", { name: slug }) : t("models.action.hide", { name: slug }), () => api.setPickerModel(slug, visible))
    : Promise.resolve();
  const updateSubagent = (slug: string, enabled: boolean) => api
    ? optimisticSubagents.mutate(slug, enabled, enabled ? t("models.action.enableSubagent", { name: slug }) : t("models.action.disableSubagent", { name: slug }), () => api.setSubagentModel(slug, enabled))
    : Promise.resolve();
  const updateSubagentEffort = (slug: string, effort: string) => api
    ? optimisticSubagentEfforts.mutate(slug, effort, t("models.action.setEffort", { name: slug, effort: effortLabel(effort, t) }), () => api.setSubagentEffort(slug, effort))
    : Promise.resolve();

  // The row-level switch speaks for the whole model: turning it on publishes
  // the route the router would pick anyway, turning it off withdraws every
  // route. Choosing between routes stays inside the expanded row.
  const updateFamilyPicker = (family: ModelFamily, usable: RouterModel[], inPicker: RouterModel[], visible: boolean) => {
    if (!api) return Promise.resolve();
    const selectable = usable.filter((model) => !nativeClientManaged(model));
    if (visible) {
      const route = preferredFamilyRoute({ ...family, routes: selectable }) ?? selectable[0];
      if (!route) return Promise.resolve();
      return optimisticPicker.mutate(route.slug, true, t("models.action.show", { name: family.displayName }), () => api.setPickerModel(route.slug, true));
    }
    const withdraw = inPicker.filter((model) => !nativeClientManaged(model));
    if (!withdraw.length) return Promise.resolve();
    return optimisticPicker.mutateMany(
      withdraw.map((model) => [model.slug, false] as const),
      t("models.action.hide", { name: family.displayName }),
      async () => {
        for (const model of withdraw) await api.setPickerModel(model.slug, false);
      },
    );
  };

  // The switch is the whole interaction: it runs the checks, and the router
  // promotes the route only if every one of them passed. A refusal comes back
  // as one sentence rather than a state the reader has to decode.
  const renderRow = ({ family, usable, inPicker, on }: (typeof rows)[number]) => (
    <ModelFamilyRow
      key={family.id}
      family={family}
      usable={usable}
      inPicker={inPicker}
      on={on}
      expanded={expandedFamilyId === family.id}
      onToggleExpanded={() => setExpandedFamilyId(expandedFamilyId === family.id ? null : family.id)}
      apiAvailable={Boolean(api)}
      providerNames={providerNames}
      pickerValue={(model) => optimisticPicker.value(model.slug, model.visible)}
      subagentValue={(model) => optimisticSubagents.value(model.slug, Boolean(subagentEnabled(target, model.slug, subagentSettings)))}
      effortValue={(model) => optimisticSubagentEfforts.value(model.slug, subagentSettings?.efforts?.[model.slug] ?? "default")}
      onFamilyPicker={(visible) => void updateFamilyPicker(family, usable, inPicker, visible)}
      onRoutePicker={(model, visible) => void updatePicker(model.slug, visible)}
      onSubagent={(model, enabled) => void updateSubagent(model.slug, enabled)}
      onEffort={(model, effort) => void updateSubagentEffort(model.slug, effort)}
      onConnect={(providerId) => {
        const entry = directoryById.get(providerId);
        if (!entry?.setup) return;
        if (entry.setup.kind === "oauth" || entry.setup.signIn) openProviderMenu(providerId);
        else if (entry.setup.kind === "configuration") setConfigurationProvider(entry.setup);
        else setCredentialProvider(entry.setup);
      }}
    />
  );

  const crowded = rows.length > CROWDED_LIST;

  return (
    <>
      <div className="providers-models-page models-page">
        <PageHeader
          eyebrow={t("models.eyebrow")}
          title={t("models.title")}
          description={t("models.description")}
          onRefresh={onRefresh}
          refreshing={refreshing}
        />

        {renderConnections()}

        <section className="panel-section pm-model-catalog" id="model-catalog-controls">
          <div className="pm-model-toolbar">
            <SearchField value={modelSearch} onChange={setModelSearch} placeholder={t("models.searchModels")} />
            {/* The count describes the list underneath it. Reporting the whole
                catalogue while a filter is narrowing the view made the filter
                look broken. */}
            <span className="pm-results-count" aria-live="polite">
              {modelSearch || statusFilter !== "all" || activeProviderFilter !== "all"
                ? t("models.resultsCount", { shown: visibleRows.length, total: families.length })
                : t("models.resultsCountAll", { total: families.length })}
            </span>
            {/* A short list reads whole. Filters and bulk switches only earn
                their space once scrolling starts. */}
            {crowded ? (
              <div className="pm-filter-menu-wrap" ref={filterMenuRef}>
                <button
                  type="button"
                  className="pm-filter-trigger"
                  aria-haspopup="menu"
                  aria-expanded={filterMenuOpen}
                  onClick={() => setFilterMenuOpen((open) => !open)}
                >
                  <Filter aria-hidden size={14} strokeWidth={1.7} />
                  <span>{t("models.show")}</span>
                  <strong>{labels[statusFilter]}</strong>
                  <ChevronDown aria-hidden size={14} strokeWidth={1.7} className={filterMenuOpen ? "is-open" : ""} />
                </button>
                {filterMenuOpen ? (
                  <div className="pm-filter-menu" role="menu" aria-label={t("models.filterAria")}>
                    {(["all", "on", "off", "blocked"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={statusFilter === value}
                        className={statusFilter === value ? "is-selected" : ""}
                        onClick={() => {
                          setStatusFilter(value);
                          setFilterMenuOpen(false);
                        }}
                      >
                        <span>{labels[value]}</span>
                        {statusFilter === value ? <Check aria-hidden size={14} strokeWidth={1.9} /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {/* Which account serves a model matters most where several of them
                serve overlapping catalogues; below that the list already names
                the provider on every row. */}
            {providerCrowded ? (
              <div className="pm-filter-menu-wrap" ref={providerFilterMenuRef}>
                <button
                  type="button"
                  className="pm-filter-trigger"
                  aria-haspopup="menu"
                  aria-expanded={providerFilterMenuOpen}
                  onClick={() => setProviderFilterMenuOpen((open) => !open)}
                >
                  <Filter aria-hidden size={14} strokeWidth={1.7} />
                  <span>{t("models.provider")}</span>
                  <strong>{activeProviderFilter === "all" ? allProviders : providerNames.get(activeProviderFilter) || activeProviderFilter}</strong>
                  <ChevronDown aria-hidden size={14} strokeWidth={1.7} className={providerFilterMenuOpen ? "is-open" : ""} />
                </button>
                {providerFilterMenuOpen ? (
                  <div className="pm-filter-menu pm-provider-filter-menu" role="menu" aria-label={t("models.filterByProviderAria")}>
                    {[{ id: "all", displayName: allProviders }, ...filterProviders].map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={activeProviderFilter === entry.id}
                        className={activeProviderFilter === entry.id ? "is-selected" : ""}
                        onClick={() => {
                          setProviderFilter(entry.id);
                          setProviderFilterMenuOpen(false);
                        }}
                      >
                        <span>{entry.displayName}</span>
                        {activeProviderFilter === entry.id ? <Check aria-hidden size={14} strokeWidth={1.9} /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="pm-filter-menu-wrap" ref={bulkMenuRef}>
              <button
                type="button"
                className="pm-icon-trigger"
                aria-haspopup="menu"
                aria-expanded={bulkMenuOpen}
                aria-label={t("models.moreActions")}
                disabled={!api}
                onClick={() => setBulkMenuOpen((open) => !open)}
              >
                <MoreHorizontal aria-hidden size={15} strokeWidth={1.9} />
              </button>
              {bulkMenuOpen ? (
                <div className="pm-filter-menu" role="menu" aria-label={t("models.bulkAria")}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setBulkMenuOpen(false);
                      if (api) void optimisticPicker.mutateMany(models.filter((model) => !nativeClientManaged(model)).map((model) => [model.slug, true] as const), t("models.action.showAll"), () => api.setPickerModels(true));
                    }}
                  >
                    <span>{t("models.turnAllOn")}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setBulkMenuOpen(false);
                      if (api) void optimisticPicker.mutateMany(models.filter((model) => !nativeClientManaged(model)).map((model) => [model.slug, false] as const), t("models.action.hideAll"), () => api.setPickerModels(false));
                    }}
                  >
                    <span>{t("models.turnAllOff")}</span>
                  </button>
                </div>
              ) : null}
            </div>
            <Button variant="primary" disabled={!api || !connectedProviderCount} onClick={openAddModels}>
              <Plus aria-hidden size={14} strokeWidth={1.9} /> {t("models.addModels")}
            </Button>
          </div>

          {!connectedProviderCount && !families.length ? (
            <EmptyState
              icon={<Plus size={20} />}
              title={t("models.connectToGetStarted")}
              body={t("models.connectToGetStartedBody")}
              action={<Button variant="primary" disabled={!api} onClick={() => setConnectMenuOpen(true)}>{t("models.connectProvider")}</Button>}
            />
          ) : readyRows.length || blockedRows.length || pendingSlugs.length ? (
            <>
              {readyRows.length || pendingSlugs.length ? (
                <div className="pm-family-list">
                  {pendingSlugs.length ? <PendingModelRows slugs={pendingSlugs} /> : null}
                  {readyRows.map(renderRow)}
                </div>
              ) : null}
              {blockedRows.length ? (
                <section className="pm-group" data-group="blocked">
                  <h3 className="pm-group-heading">
                    <span>{t("models.needsProvider")}</span>
                    <small>{blockedRows.length}</small>
                  </h3>
                  <div className="pm-family-list">{blockedRows.map(renderRow)}</div>
                </section>
              ) : null}
            </>
          ) : (
            <EmptyState
              icon={<SearchX size={20} />}
              title={t("models.noMatch")}
              body={modelSearch || statusFilter !== "all" || activeProviderFilter !== "all"
                ? t("models.noMatchFilteredBody")
                : t("models.noMatchBody")}
            />
          )}
        </section>
      </div>

      <AddModelsDialog
        open={addModelsOpen}
        directory={directory}
        catalogStates={catalogStates}
        loading={loadingConnectedCatalogs}
        disabled={!api}
        pendingModels={pendingModels}
        onReload={() => void loadConnectedCatalogs({ refresh: true })}
        onAdd={(selection) => void addCatalogModels(selection)}
        onClose={() => setAddModelsOpen(false)}
      />
      {renderConnectionDialogs()}
    </>
  );
}

function ConnectionsBar({
  directory,
  enabledProviders,
  usageById,
  apiAvailable,
  platform,
  openProviderId,
  onOpenProvider,
  onCloseProvider,
  connectMenuOpen,
  onConnectMenuOpen,
  isEnabled,
  onEnabledChange,
  onSignIn,
  onConfigure,
  onKey,
  onRemove,
}: {
  directory: ProviderDirectoryEntry[];
  enabledProviders: Set<string>;
  usageById: Map<string, NonNullable<ProviderUsageSnapshot["providers"]>[number]>;
  apiAvailable: boolean;
  platform?: string;
  openProviderId: string | null;
  onOpenProvider: (providerId: string) => void;
  onCloseProvider: () => void;
  connectMenuOpen: boolean;
  onConnectMenuOpen: (open: boolean) => void;
  isEnabled: (entry: ProviderDirectoryEntry) => boolean;
  onEnabledChange: (entry: ProviderDirectoryEntry, checked: boolean) => void;
  onSignIn: (entry: ProviderDirectoryEntry) => void;
  onConfigure: (entry: ProviderDirectoryEntry) => void;
  onKey: (entry: ProviderDirectoryEntry) => void;
  onRemove: (entry: ProviderDirectoryEntry) => void;
}) {
  const t = useI18n();
  const barRef = useRef<HTMLElement | null>(null);
  const setConnectMenuOpen = onConnectMenuOpen;
  const connected = directory.filter((entry) => providerConnected(entry, enabledProviders));
  const available = directory.filter((entry) => !providerConnected(entry, enabledProviders));

  useEffect(() => {
    if (!openProviderId && !connectMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (barRef.current?.contains(event.target as Node)) return;
      onCloseProvider();
      onConnectMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onCloseProvider();
      onConnectMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [connectMenuOpen, onCloseProvider, onConnectMenuOpen, openProviderId]);

  return (
    <section className="panel-section pm-connections" id="model-provider-directory" ref={barRef} aria-label={t("models.providerConnectionsAria")}>
      <div className="pm-connections-label">
        <strong>{t("models.connections")}</strong>
        <small>{t("models.connectionsCount", { connected: connected.length, total: directory.length })}</small>
      </div>
      <div className="pm-connections-chips">
        {connected.map((entry) => (
          <div className="pm-chip-wrap" key={entry.id}>
            <button
              type="button"
              className="pm-chip"
              data-state="connected"
              aria-haspopup="dialog"
              aria-expanded={openProviderId === entry.id}
              onClick={() => { setConnectMenuOpen(false); onOpenProvider(entry.id); }}
            >
              <ProviderLogo providerId={entry.id} displayName={entry.displayName} size="small" />
              <span>{entry.displayName}</span>
              <i className="pm-chip-dot" data-enabled={isEnabled(entry)} aria-hidden />
            </button>
            {openProviderId === entry.id ? (
              <ProviderMenu
                entry={entry}
                usage={usageById.get(entry.id)}
                apiAvailable={apiAvailable}
                platform={platform}
                enabled={isEnabled(entry)}
                onEnabledChange={(checked) => onEnabledChange(entry, checked)}
                onSignIn={() => onSignIn(entry)}
                onKey={() => onKey(entry)}
                onRemove={() => onRemove(entry)}
              />
            ) : null}
          </div>
        ))}
        {available.length ? (
          <div className="pm-chip-wrap">
            <button
              type="button"
              className="pm-chip pm-chip-add"
              aria-haspopup="menu"
              aria-expanded={connectMenuOpen}
              onClick={() => { onCloseProvider(); onConnectMenuOpen(!connectMenuOpen); }}
            >
              <Plus aria-hidden size={13} strokeWidth={2} />
              <span>{t("models.connectProvider")}</span>
            </button>
            {connectMenuOpen ? (
              <div className="pm-connect-menu" role="menu" aria-label={t("models.providersYouCanConnect")}>
                {available.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="menuitem"
                    disabled={!apiAvailable || !entry.setup}
                    onClick={() => {
                      setConnectMenuOpen(false);
                      if (!entry.setup) return;
                      if (entry.setup.kind === "oauth" || entry.setup.signIn) onSignIn(entry);
                      else if (entry.setup.kind === "configuration") onConfigure(entry);
                      else if (entry.setup.kind === "anonymous") onEnabledChange(entry, true);
                      else onKey(entry);
                    }}
                  >
                    <ProviderLogo providerId={entry.id} displayName={entry.displayName} size="small" />
                    <span>{entry.displayName}</span>
                    <small>{connectionMethod(entry, t)}</small>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ProviderMenu({
  entry,
  usage,
  apiAvailable,
  platform,
  enabled,
  onEnabledChange,
  onSignIn,
  onKey,
  onRemove,
}: {
  entry: ProviderDirectoryEntry;
  usage?: NonNullable<ProviderUsageSnapshot["providers"]>[number];
  apiAvailable: boolean;
  platform?: string;
  enabled: boolean;
  onEnabledChange: (checked: boolean) => void;
  onSignIn: () => void;
  onKey: () => void;
  onRemove: () => void;
}) {
  const t = useI18n();
  const setup = entry.setup;
  return (
    <div className="pm-connection-menu" role="dialog" aria-label={t("models.connection.dialog", { name: entry.displayName })}>
      <div className="pm-connection-menu-head">
        <ProviderLogo providerId={entry.id} displayName={entry.displayName} size="large" />
        <div>
          <strong>{entry.displayName}</strong>
          <small>{connectionMethod(entry, t)}</small>
        </div>
      </div>
      <p className="pm-connection-menu-copy">
        {backendText(setup?.planNote, t) || connectionDetail(entry, t, usage?.account?.status, usage?.account?.message, platform === "darwin")}
      </p>
      {usage?.requests ? <small className="pm-connection-menu-usage">{t("models.connection.soFar", { count: usage.requests, word: t(usage.requests === 1 ? "models.connection.request" : "models.connection.requests") })}</small> : null}
      {setup ? (
        <>
          <label className="pm-connection-menu-enable">
            <span>{t("models.connection.available")}</span>
            <Toggle
              checked={enabled}
              disabled={!apiAvailable || !setup.configured}
              label={t("models.connection.makeAvailable", { name: entry.displayName })}
              onChange={onEnabledChange}
            />
          </label>
          <div className="pm-connection-menu-actions">
            {setup.kind === "oauth" || setup.signIn ? (
              <Button
                variant="ghost"
                disabled={!apiAvailable || setup.action === "blocked" || (entry.id !== "antigravity-oauth" && platform !== "darwin")}
                title={entry.id === "antigravity-oauth" || platform === "darwin" ? undefined : t("models.connection.terminalOnly")}
                onClick={onSignIn}
              >
                <LogIn aria-hidden size={14} strokeWidth={1.7} />
                {setup.action === "probe" ? t("models.connection.runLiveTest") : setup.configured ? t("models.connection.signInAgain") : t("models.connection.openSignIn")}
              </Button>
            ) : null}
            {setup.kind === "api" && entry.id !== "local" ? (
              <Button variant="ghost" disabled={!apiAvailable} onClick={onKey}>
                <KeyRound aria-hidden size={14} strokeWidth={1.7} /> {setup.configured ? t("models.connection.replaceKey") : t("models.connection.addKey")}
              </Button>
            ) : null}
            {((setup.kind === "api" && setup.configured) || setup.disconnectable) && entry.id !== "local" ? (
              <Button variant="ghost" disabled={!apiAvailable} onClick={onRemove}>
                <Trash2 aria-hidden size={14} strokeWidth={1.7} /> {t("models.disconnect.confirm")}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function ModelFamilyRow({
  family,
  usable,
  inPicker,
  on,
  expanded,
  onToggleExpanded,
  apiAvailable,
  providerNames,
  pickerValue,
  subagentValue,
  effortValue,
  onFamilyPicker,
  onRoutePicker,
  onSubagent,
  onEffort,
  onConnect,
}: {
  family: ModelFamily;
  usable: RouterModel[];
  inPicker: RouterModel[];
  on: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  apiAvailable: boolean;
  providerNames: Map<string, string>;
  pickerValue: (model: RouterModel) => boolean;
  subagentValue: (model: RouterModel) => boolean;
  effortValue: (model: RouterModel) => string;
  onFamilyPicker: (visible: boolean) => void;
  onRoutePicker: (model: RouterModel, visible: boolean) => void;
  onSubagent: (model: RouterModel, enabled: boolean) => void;
  onEffort: (model: RouterModel, effort: string) => void;
  onConnect: (providerId: string) => void;
}) {
  const t = useI18n();
  const preferred = preferredFamilyRoute(family);
  const maker = brandForModel(preferred);
  const providerIds = [...new Set(family.routes.map((model) => model.provider))];
  const multiRoute = family.routes.length > 1;
  const blocked = usable.length === 0;
  const managedByClient = usable.length > 0 && usable.every(nativeClientManaged);
  const triggerId = `family-trigger-${safeId(family.id)}`;
  const panelId = `family-panel-${safeId(family.id)}`;

  // One muted line under the name instead of a row of columns. Reading left to
  // right beats hunting the same fact in four different x-positions.
  const facts = [
    providerIds.length > 1 ? t("models.fact.providers", { count: providerIds.length }) : providerNames.get(providerIds[0]) || maker.name,
    preferred?.contextWindow ? formatContext(preferred.contextWindow, t) : undefined,
    family.routes.some((model) => model.inputModalities?.includes("image")) ? t("models.fact.textImage") : t("models.fact.text"),
    family.routes.some((model) => model.isFree) ? t("models.fact.free") : undefined,
    multiRoute ? t("models.fact.routes", { count: family.routes.length }) : undefined,
  ].filter(Boolean);

  return (
    <article className="pm-family-row" data-expanded={expanded} data-on={on} data-blocked={blocked}>
      <div className="pm-family-summary">
        <button
          id={triggerId}
          className="pm-family-open"
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggleExpanded}
        >
          {/* The disclosure sits at the far left, where a caret means "open
              this". Beside the switch it only ever read as part of it. */}
          <ChevronDown className="pm-accordion-chevron" aria-hidden size={14} strokeWidth={2} />
          <BrandLogo brand={maker} size="large" />
          <span className="pm-family-main">
            <strong>{family.displayName}</strong>
            <small>{facts.join(" · ")}</small>
          </span>
        </button>
        <div className="pm-family-action">
          {blocked ? (
            <Button variant="secondary" disabled={!apiAvailable} onClick={() => onConnect(providerIds[0])}>
              {providerIds.length > 1 ? t("models.family.connectProvider") : t("models.family.connectName", { name: providerNames.get(providerIds[0]) || providerIds[0] })}
            </Button>
          ) : (
            <>
              <span className="pm-family-state" aria-hidden>{on ? t("models.status.on") : t("models.status.off")}</span>
              <Toggle
                checked={on}
                disabled={!apiAvailable || managedByClient}
                label={managedByClient ? t("models.family.managedByCodex", { name: family.displayName }) : t("models.family.useInCodex", { name: family.displayName })}
                onChange={onFamilyPicker}
              />
            </>
          )}
        </div>
      </div>
      <div id={panelId} className="pm-family-panel" role="region" aria-labelledby={triggerId} hidden={!expanded}>
        {multiRoute ? (
          <>
            <div className="pm-family-route-note">
              {t("models.family.multiRouteNote")}
            </div>
            {/* Labelling every row cost 12 words for 4 switches, and every row
                sized its own columns so nothing lined up down the list. One
                header, one shared grid. */}
            <div className="pm-route-table" role="list" aria-label={t("models.family.routesAria", { name: family.displayName })}>
              <div className="pm-route-head" aria-hidden="true">
                <span>{t("models.route.account")}</span>
                <span>{t("models.route.context")}</span>
                <span>{t("models.route.input")}</span>
                <span>{t("models.route.inPicker")}</span>
                <span>{t("models.route.subagents")}</span>
                <span>{t("models.route.thinking")}</span>
              </div>
              {family.routes.map((model) => (
                <ModelRouteRow
                  key={model.slug}
                  model={model}
                  providerName={providerNames.get(model.provider) || providerDisplayName(model.provider, t)}
                  pickerVisible={pickerValue(model)}
                  selectedInSettings={subagentValue(model)}
                  subagentEffort={effortValue(model)}
                  apiAvailable={apiAvailable}
                  onPickerChange={(checked) => onRoutePicker(model, checked)}
                  onSubagentChange={(checked) => onSubagent(model, checked)}
                  onEffortChange={(effort) => onEffort(model, effort)}
                  onConnect={() => onConnect(model.provider)}
                />
              ))}
            </div>
          </>
        ) : (
          // A single-route model already showed its name and provider in the
          // row above. Repeating that row inside itself explains nothing, so
          // the panel carries only what the summary had to leave out.
          <ModelDetails
            model={family.routes[0]}
            providerName={providerNames.get(family.routes[0].provider) || providerDisplayName(family.routes[0].provider, t)}
            selectedInSettings={subagentValue(family.routes[0])}
            subagentEffort={effortValue(family.routes[0])}
            apiAvailable={apiAvailable}
            onSubagentChange={(checked) => onSubagent(family.routes[0], checked)}
            onEffortChange={(effort) => onEffort(family.routes[0], effort)}
          />
        )}
      </div>
    </article>
  );
}

function ModelDetails({
  model,
  providerName,
  selectedInSettings,
  subagentEffort,
  apiAvailable,
  onSubagentChange,
  onEffortChange,
}: {
  model: RouterModel;
  providerName: string;
  selectedInSettings: boolean;
  subagentEffort: string;
  apiAvailable: boolean;
  onSubagentChange: (checked: boolean) => void;
  onEffortChange: (effort: string) => void;
}) {
  const t = useI18n();
  return (
    <dl className="pm-model-details">
      <div>
        <dt>{t("models.details.modelId")}</dt>
        <dd className="pm-model-details-mono">{model.slug}</dd>
      </div>
      <div>
        <dt>{t("models.details.route")}</dt>
        <dd>{providerName} · {modelRouteKind(model)}</dd>
      </div>
      {routeUsable(model) ? (
        <div>
          <dt>{t("models.details.subagents")}</dt>
          {/* The effort popup extends below this definition-list cell. Keep
              this cell visibly overflowing; the generic text cells still
              ellipsize long ids and route descriptions. */}
          <dd className="pm-model-details-controls">
            <div className="pm-subagent-controls">
              <SubagentToggle
                model={model}
                providerName={providerName}
                selectedInSettings={selectedInSettings}
                apiAvailable={apiAvailable}
                onSubagentChange={onSubagentChange}
              />
              <SubagentEffort
                model={model}
                providerName={providerName}
                selectedInSettings={selectedInSettings}
                subagentEffort={subagentEffort}
                apiAvailable={apiAvailable}
                onEffortChange={onEffortChange}
              />
            </div>
          </dd>
        </div>
      ) : (
        <div>
          <dt>{t("models.details.status")}</dt>
          <dd>{t("models.details.connectToUse", { name: providerName })}</dd>
        </div>
      )}
    </dl>
  );
}

// Turning the switch on adds the route to the subagent selection, and the
// router publishes it as v2 with an agent definition Codex can spawn by name.
// That is the whole mechanism -- documented in
// .claude/skills/codex-subagents/SKILL.md as "proven models plus ones you
// explicitly turn on" -- so the switch needs no certification run behind it.
//
// A registry-proven route and one the operator chose look the same here on
// purpose: both are spawnable, and which of the two it is belongs in the
// application record, not in front of someone picking a model.
function subagentControl(model: RouterModel, selectedInSettings: boolean, t: Translate) {
  return {
    checked: selectedInSettings,
    hint: subagentCertification(model) === "v2"
      ? t("models.subagent.v2Hint")
      : t("models.subagent.enableHint"),
  };
}

function ModelRouteRow({
  model,
  providerName,
  pickerVisible,
  selectedInSettings,
  subagentEffort,
  apiAvailable,
  onPickerChange,
  onSubagentChange,
  onEffortChange,
  onConnect,
}: {
  model: RouterModel;
  providerName: string;
  pickerVisible: boolean;
  selectedInSettings: boolean;
  subagentEffort: string;
  apiAvailable: boolean;
  onPickerChange: (checked: boolean) => void;
  onSubagentChange: (checked: boolean) => void;
  onEffortChange: (effort: string) => void;
  onConnect: () => void;
}) {
  const t = useI18n();
  const identity = (
    <div className="pm-route-identity">
      <ProviderLogo providerId={model.provider} displayName={providerName} size="medium" />
      <div>
        <strong>{providerName}</strong>
        {model.isFree ? <span className="pm-route-free">{t("models.fact.free")}</span> : null}
        <small title={model.slug}>{model.slug}</small>
      </div>
    </div>
  );
  const context = model.contextWindow ? formatContext(model.contextWindow, t) : "—";
  const input = model.inputModalities?.includes("image") ? t("models.fact.textImage") : t("models.fact.text");

  if (!routeUsable(model)) {
    return (
      <article className="pm-route-row" role="listitem" data-availability="known">
        {identity}
        <span className="pm-route-cell">{context}</span>
        <span className="pm-route-cell">{input}</span>
        {/* The same slot the switches occupy, so the right edge answers one
            question all the way down: what can I do with this route. */}
        <span className="pm-route-cell pm-route-connect">
          <Button variant="secondary" disabled={!apiAvailable} onClick={onConnect}>{t("models.family.connectName", { name: providerName })}</Button>
        </span>
      </article>
    );
  }

  const subagent = subagentControl(model, selectedInSettings, t);
  return (
    <article className="pm-route-row" role="listitem" data-subagent={subagent.checked ? "enabled" : "disabled"}>
      {identity}
      <span className="pm-route-cell">{context}</span>
      <span className="pm-route-cell">{input}</span>
      <span className="pm-route-cell pm-route-control">
        <Toggle
          checked={pickerVisible}
          disabled={!apiAvailable || nativeClientManaged(model)}
          label={nativeClientManaged(model) ? t("models.family.managedByCodex", { name: model.displayName }) : t("models.route.pickerLabel", { model: model.displayName, provider: providerName })}
          onChange={onPickerChange}
        />
      </span>
      <span className="pm-route-cell pm-route-control">
        <SubagentToggle
          model={model}
          providerName={providerName}
          selectedInSettings={selectedInSettings}
          apiAvailable={apiAvailable}
          onSubagentChange={onSubagentChange}
        />
      </span>
      <span className="pm-route-cell pm-route-control">
        <SubagentEffort
          model={model}
          providerName={providerName}
          selectedInSettings={selectedInSettings}
          subagentEffort={subagentEffort}
          apiAvailable={apiAvailable}
          onEffortChange={onEffortChange}
        />
      </span>
    </article>
  );
}

// The route row and the single-route details panel must say the same thing
// about subagents, so they share the control rather than the wording.
// Two cells, so the table keeps one row per route. Stacking the switch and the
// effort menu made every row two lines tall and repeated the word "Thinking"
// down the whole list -- the same noise the column headers removed.
function SubagentToggle({
  model,
  providerName,
  selectedInSettings,
  apiAvailable,
  onSubagentChange,
}: {
  model: RouterModel;
  providerName: string;
  selectedInSettings: boolean;
  apiAvailable: boolean;
  onSubagentChange: (checked: boolean) => void;
}) {
  const t = useI18n();
  const subagent = subagentControl(model, selectedInSettings, t);
  return (
    <div className="pm-model-control" title={subagent.hint}>
      <Toggle
        checked={subagent.checked}
        disabled={!apiAvailable}
        label={t("models.route.subagentLabel", { model: model.displayName, provider: providerName })}
        onChange={onSubagentChange}
      />
      <span>{subagent.checked ? t("models.status.on") : t("models.status.off")}</span>
    </div>
  );
}

// A native <select> draws its menu shifted left to make room for the macOS
// checkmark gutter, which reads as misalignment inside a table. This page
// already has its own menu pattern for the filter and the connections chips;
// using it here keeps the popup anchored to the control it belongs to.
function SubagentEffort({
  model,
  providerName,
  selectedInSettings,
  subagentEffort,
  apiAvailable,
  onEffortChange,
}: {
  model: RouterModel;
  providerName: string;
  selectedInSettings: boolean;
  subagentEffort: string;
  apiAvailable: boolean;
  onEffortChange: (effort: string) => void;
}) {
  const t = useI18n();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const effortOptions = model.reasoningLevels ?? [];

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  // Nothing to choose on a route that is off, or one with a single-level
  // ladder. An empty cell reads better than a menu nobody can use.
  if (!selectedInSettings || effortOptions.length < 2) {
    return <span className="pm-route-none">—</span>;
  }
  const choices = ["default", ...effortOptions];
  return (
    <div className="pm-effort-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="pm-effort-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("models.route.subagentEffortAria", { model: model.displayName, provider: providerName })}
        disabled={!apiAvailable}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{effortLabel(subagentEffort, t)}</span>
        <ChevronDown aria-hidden size={12} strokeWidth={1.8} className={open ? "is-open" : ""} />
      </button>
      {open ? (
        <div className="pm-effort-menu" role="menu">
          {choices.map((effort) => (
            <button
              key={effort}
              type="button"
              role="menuitemradio"
              aria-checked={subagentEffort === effort}
              className={subagentEffort === effort ? "is-selected" : ""}
              onClick={() => {
                setOpen(false);
                if (effort !== subagentEffort) onEffortChange(effort);
              }}
            >
              <span>{effortLabel(effort, t)}</span>
              {subagentEffort === effort ? <Check aria-hidden size={13} strokeWidth={1.9} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Placeholder rows for models being published to the picker. They carry the
// slug rather than a bare shimmer: the operator picked those names a moment
// ago, and seeing them is what says the click landed on the right ones. Only
// the controls that do not exist yet are left as blanks.
function PendingModelRows({ slugs }: { slugs: string[] }) {
  const t = useI18n();
  if (!slugs.length) return null;
  return (
    <>
      {slugs.map((slug) => (
        <article className="pm-model-row pm-model-row-pending" role="listitem" key={`pending-${slug}`}>
          <div className="pm-model-identity">
            <SkeletonBlock className="pm-pending-logo" />
            <div>
              <strong>{slug}</strong>
              <small>{t("models.pending.adding")}</small>
            </div>
          </div>
          <div className="pm-pending-meta" aria-hidden="true">
            <SkeletonBlock className="pm-pending-line" />
          </div>
          <div className="pm-pending-controls" aria-hidden="true">
            <SkeletonBlock className="pm-pending-control" />
          </div>
        </article>
      ))}
    </>
  );
}

// One place to add a model, searching every connected provider at once. The
// per-provider catalog browsers this replaces made the same list reachable
// only after picking the right provider first.
function AddModelsDialog({
  open,
  directory,
  catalogStates,
  loading,
  disabled,
  pendingModels,
  onReload,
  onAdd,
  onClose,
}: {
  open: boolean;
  directory: ProviderDirectoryEntry[];
  catalogStates: Record<string, CatalogViewState>;
  loading: boolean;
  disabled: boolean;
  pendingModels: PendingCatalogModels;
  onReload: () => void;
  onAdd: (selection: CatalogModel[]) => void;
  onClose: () => void;
}) {
  const t = useI18n();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [shownLimit, setShownLimit] = useState(120);

  useEffect(() => {
    if (open) return;
    setQuery("");
    setSelected([]);
    setShownLimit(120);
  }, [open]);

  const catalogModels = useMemo(
    (): CatalogModel[] => (open ? loadedCatalogModels(directory, catalogStates) : []),
    [catalogStates, directory, open],
  );
  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return catalogModels;
    return catalogModels.filter((model) => (
      `${model.displayName} ${model.modelId} ${model.providerName} ${model.sourceName}`.toLowerCase().includes(needle)
    ));
  }, [catalogModels, query]);
  // Freshness belongs next to the list it describes: a stored catalog can be
  // up to a day old, and nothing else on this surface would say so.
  const lastRead = useMemo(() => Object.values(catalogStates)
    .map((state) => state.data?.fetchedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1), [catalogStates]);
  const selectedKeys = new Set(selected);
  const selectedModels = catalogModels.filter((model) => selectedKeys.has(model.key));
  const errors = Object.values(catalogStates).filter((state) => state.status === "error");
  const shown = matching.slice(0, shownLimit);

  const toggle = (model: CatalogModel, checked: boolean) => {
    setSelected((current) => {
      if (!checked) return current.filter((key) => key !== model.key);
      if (current.length >= CATALOG_ADD_BATCH_LIMIT || current.includes(model.key)) return current;
      return [...current, model.key];
    });
  };

  return (
    <Dialog
      open={open}
      title={t("models.add.title")}
      description={t("models.add.description")}
      onClose={onClose}
    >
      <div className="pm-add-models">
        <div className="pm-add-models-toolbar">
          <SearchField value={query} onChange={setQuery} placeholder={t("models.add.search")} />
          <span className="pm-results-count" aria-live="polite">
            {loading
              ? t("models.add.loadingCatalogs")
              : `${t("models.add.count", { shown: matching.length, total: catalogModels.length })}${lastRead ? t("models.add.read", { time: formatDateTime(lastRead, t) }) : ""}`}
          </span>
          <Button variant="ghost" disabled={disabled || loading} onClick={onReload}>
            {loading ? t("models.add.asking") : t("models.add.reload")}
          </Button>
        </div>

        {loading && !catalogModels.length ? <CatalogSkeleton label={t("models.add.loadingProviderCatalogs")} /> : null}

        {!loading && !catalogModels.length ? (
          <EmptyState
            icon={<SearchX size={20} />}
            title={errors.length ? t("models.add.catalogsFailed") : t("models.add.noCatalogs")}
            body={errors[0]?.error || t("models.add.noCatalogsBody")}
          />
        ) : null}

        {shown.length ? (
          <div className="pm-add-models-list" role="list" aria-label={t("models.add.catalogAria")}>
            {shown.map((model) => {
              const adding = (pendingModels[model.providerId]?.[model.modelId] ?? 0) > 0;
              const checked = model.registered || selectedKeys.has(model.key);
              const blocked = !model.registered && !model.addable;
              return (
                <label
                  className="pm-add-models-row"
                  role="listitem"
                  key={model.key}
                  data-published={model.registered}
                  data-blocked={blocked}
                  title={model.blockedReason}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || model.registered || blocked || adding
                      || (!selectedKeys.has(model.key) && selected.length >= CATALOG_ADD_BATCH_LIMIT)}
                    onChange={(event) => toggle(model, event.target.checked)}
                  />
                  <ProviderLogo providerId={model.providerId} displayName={model.providerName} size="medium" />
                  <div className="pm-add-models-identity">
                    <strong>{model.displayName}</strong>
                    <small title={model.modelId}>{model.modelId}</small>
                    {model.blockedReason ? <small className="pm-catalog-block-reason">{model.blockedReason}</small> : null}
                  </div>
                  <span className="pm-add-models-provider">{model.providerName}</span>
                  <div className="pm-add-models-meta">
                    {model.contextWindow ? <span>{formatContext(model.contextWindow, t)}</span> : null}
                    {model.isFree ? <Badge tone="success">{t("models.add.free")}</Badge> : null}
                  </div>
                  {adding ? <Badge tone="neutral">{t("models.add.adding")}</Badge>
                    : model.registered ? <Badge tone="neutral">{t("models.add.added")}</Badge>
                    : blocked ? <Badge tone="neutral">{t("models.add.notSupported")}</Badge>
                    : null}
                </label>
              );
            })}
          </div>
        ) : null}

        {matching.length > shown.length ? (
          <div className="pm-add-models-more">
            <span>{t("models.add.moreModels", { count: matching.length - shown.length })}</span>
            <Button variant="ghost" onClick={() => setShownLimit((current) => current + 120)}>{t("models.add.showMore")}</Button>
          </div>
        ) : null}

        {catalogModels.length && !matching.length ? (
          <div className="pm-add-models-empty">{t("models.add.noMatch")}</div>
        ) : null}

        <div className="dialog-actions">
          <span className="pm-add-models-hint">
            {t("models.add.hint", { limit: CATALOG_ADD_BATCH_LIMIT })}
          </span>
          <Button variant="secondary" onClick={onClose}>{t("models.add.cancel")}</Button>
          <Button
            variant="primary"
            disabled={disabled || !selectedModels.length}
            onClick={() => { onAdd(selectedModels); setSelected([]); onClose(); }}
          >
            {selectedModels.length ? t("models.add.addCount", { count: selectedModels.length, word: t(selectedModels.length === 1 ? "models.add.model" : "models.add.models") }) : t("models.addModels")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function CredentialDialog({ provider, onSave, onClose }: { provider: ProviderSetup | null; onSave: (provider: ProviderSetup, secret: string) => Promise<void>; onClose: () => void }) {
  const t = useI18n();
  const [credential, setCredential] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!provider || !credential.trim()) return;
    const secret = credential;
    setCredential("");
    onClose();
    await onSave(provider, secret);
  }
  function close() { setCredential(""); onClose(); }
  return (
    <Dialog open={Boolean(provider)} title={provider?.configured ? t("models.credential.replace", { name: provider.displayName }) : t("models.credential.connect", { name: provider?.displayName || t("models.credential.provider") })} description={t("models.credential.description")} onClose={close}>
      <form className="pm-credential-form" onSubmit={(event) => void submit(event)}>
        {provider ? <div className="pm-credential-provider"><ProviderLogo providerId={provider.id} displayName={provider.displayName} size="large" /><div><strong>{provider.displayName}</strong><small>{provider.id}</small></div></div> : null}
        <label htmlFor="provider-credential">{provider?.credentialLabel || t("models.credential.apiKey")}</label>
        <input id="provider-credential" type="password" value={credential} onChange={(event) => setCredential(event.target.value)} autoComplete="off" spellCheck={false} placeholder={t("models.credential.placeholder")} autoFocus />
        <p><Link2 aria-hidden size={13} strokeWidth={1.7} /> {t("models.credential.note")}</p>
        <div className="dialog-actions"><Button type="button" variant="secondary" onClick={close}>{t("models.add.cancel")}</Button><Button type="submit" variant="primary" disabled={!credential.trim()}>{t("models.credential.save")}</Button></div>
      </form>
    </Dialog>
  );
}

function providerConnected(entry: ProviderDirectoryEntry, enabledProviders: Set<string>): boolean {
  // An anonymous endpoint has no stored account or credential that can make it
  // connected on its own. Treating `configured: true` as a connection here
  // both mislabels an unselected provider and includes its off-box catalog in
  // the bulk "connected" request. Its explicit provider selection is the
  // connection boundary instead.
  if (entry.setup?.kind === "anonymous") return enabledProviders.has(entry.id);
  if (entry.setup) return entry.setup.configured || entry.setup.signedIn === true;
  return entry.models.some((model) => model.native) || enabledProviders.has(entry.id);
}

function providerDisplayName(providerId: string, t: Translate): string {
  return providerId === "openai" ? t("models.provider.openaiNative") : providerId;
}

function connectionMethod(entry: ProviderDirectoryEntry, t: Translate): string {
  if (entry.id === "openai") return t("models.method.chatgpt");
  if (entry.id === "local") return t("models.method.local");
  if (!entry.setup) return t("models.method.managed");
  if (entry.setup.action === "probe") return t("models.method.liveTest");
  if (entry.setup.action === "blocked") return t("models.method.disconnectRequired");
  if (entry.setup.kind === "oauth") return t("models.method.signIn");
  if (entry.setup.kind === "configuration") return t("models.method.localConfig");
  if (entry.setup.kind === "anonymous") return t("models.method.noKey");
  if (entry.setup.signIn) return t("models.method.keyOrSignIn");
  return entry.setup.credentialLabel || t("models.method.apiKey");
}

function connectionDetail(entry: ProviderDirectoryEntry, t: Translate, accountStatus?: string, accountMessage?: string, canOpenTerminal?: boolean): string {
  if (entry.id === "openai") return t("models.detail.openai");
  if (!entry.setup) return t("models.detail.managed");
  if (entry.setup.kind === "configuration") {
    return entry.setup.configured
      ? t("models.detail.configReady")
      : backendText(entry.setup.configurationNote, t) || t("models.detail.configRun");
  }
  if (entry.setup.kind === "anonymous") return t("models.detail.anonymous");
  if (entry.setup.action === "probe") return backendText(entry.setup.probeNote, t) || t("models.detail.probe");
  if (entry.setup.action === "blocked") return backendText(entry.setup.blockedNote, t) || t("models.detail.blocked");
  if (accountStatus === "unavailable") return accountMessage || t("models.detail.unavailable");
  if (entry.setup.configured) return t("models.detail.credentialReady");
  if (entry.setup.kind === "oauth") {
    if (!canOpenTerminal) return t("models.detail.oauthTerminal");
    return entry.setup.cliInstalled === false ? t("models.detail.oauthInstall") : t("models.detail.oauthSignIn");
  }
  if (entry.setup.signIn) return t("models.detail.keyOrBrowser", { credential: entry.setup.credentialLabel || t("models.detail.anApiKey") });
  return t("models.detail.addKey", { credential: entry.setup.credentialLabel || t("models.detail.anApiKey") });
}

function safeId(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, "-"); }
