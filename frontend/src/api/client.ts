import axios from "axios";
import type {
  LateOrder,
  LateSummary,
  TrendPoint,
  FlagAnalysis,
  RottenOrder,
  RottenSummaryDay,
  VenueMapPoint,
  HexMapPoint,
  HourlyPoint,
  CityInfo,
  CountryInfo,
  CountryCityList,
  CityAnalyticsData,
  CountryMasterData,
  CourierPerformanceData,
  VenuePerformanceData,
  CloneSummaryResponse,
  CloneAcceptanceResponse,
  CloneVehicleDistributionResponse,
  VehicleCalendarResponse,
  CloneOrdersResponse,
  CloneVenuesResponse,
  OrdersCalendarResponse,
  VehicleShareResponse,
  CourierPositionsResponse,
  OrderPositionsResponse,
  RegionOverview,
  RegionCityBreakdown,
  CountryLateReasons,
  CountryAIResponse,
  DataFreshness,
  TtlaOrdersResponse,
  TtlaVenuesResponse,
  TtlaCouriersResponse,
  TtlaCountryContext,
  TtlaQuery,
  TtlaOrderType,
  TtlaMode,
  RetailTtlaSummary,
  RetailTtlaVenuesResponse,
  VenueDiagJob,
} from "../types";

const api = axios.create({ baseURL: "/api", withCredentials: true, timeout: 300_000 });

// Per-call timeout for the tab DATA fetches. The global 300s ceiling is only a
// last-resort guard against a totally wedged connection; with the backend now
// serving stale cache + warming in the background (never blocking the request on
// a live synthetic data source pull), these endpoints should answer from cache in well under
// a second. A tight 45s cap means a genuinely hung request surfaces as an error
// (and the poll/retry path kicks in) instead of showing a ~5-minute spinner.
// 45s (not 30s) leaves headroom for the one path that can still run live: a cold
// `late-reasons` deep-cache miss for a high-volume country.
const TAB_FETCH_TIMEOUT_MS = 45_000;

let isRedirecting = false;
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && !err.config.url?.includes("/auth/") && !isRedirecting) {
      isRedirecting = true;
      document.cookie = "session_token=; max-age=0; path=/";
      window.location.reload();
    }
    return Promise.reject(err);
  }
);

export async function fetchCities(): Promise<CityInfo[]> {
  const { data } = await api.get("/cities");
  return data.cities;
}

export async function fetchLateOrders(
  city: string,
  lookbackDays: number
): Promise<{ orders: LateOrder[]; total: number }> {
  const { data } = await api.get("/late-orders", {
    params: { city, lookback_days: lookbackDays },
  });
  return data;
}

export async function fetchLateSummary(
  city: string,
  lookbackDays: number
): Promise<LateSummary> {
  const { data } = await api.get("/late-orders/summary", {
    params: { city, lookback_days: lookbackDays },
  });
  return data;
}

export async function fetchLateTrend(
  city: string,
  lookbackDays: number
): Promise<TrendPoint[]> {
  const { data } = await api.get("/late-orders/trend", {
    params: { city, lookback_days: lookbackDays },
  });
  return data.trend;
}

export async function fetchFlagAnalysis(
  city: string,
  lookbackDays: number
): Promise<FlagAnalysis> {
  const { data } = await api.get("/late-orders/flags", {
    params: { city, lookback_days: lookbackDays },
  });
  return data;
}

export async function fetchRottenOrders(
  city: string,
  lookbackDays: number
): Promise<{ orders: RottenOrder[]; total: number }> {
  const { data } = await api.get("/rotten-orders", {
    params: { city, lookback_days: lookbackDays },
  });
  return data;
}

export async function fetchRottenSummary(
  city: string,
  lookbackDays: number
): Promise<RottenSummaryDay[]> {
  const { data } = await api.get("/rotten-orders/summary", {
    params: { city, lookback_days: lookbackDays },
  });
  return data.summary;
}

export async function fetchVenueMap(
  city: string,
  lookbackDays: number
): Promise<VenueMapPoint[]> {
  const { data } = await api.get("/map/venues", {
    params: { city, lookback_days: lookbackDays },
  });
  return data.venues;
}

export async function fetchDropoffMap(
  city: string,
  lookbackDays: number
): Promise<HexMapPoint[]> {
  const { data } = await api.get("/map/dropoffs", {
    params: { city, lookback_days: lookbackDays },
  });
  return data.hexagons;
}

export async function fetchHourlyData(
  city: string,
  lookbackDays: number
): Promise<HourlyPoint[]> {
  const { data } = await api.get("/map/hourly", {
    params: { city, lookback_days: lookbackDays },
  });
  return data.hourly;
}

export async function fetchAISummary(
  city: string,
  lookbackDays: number
): Promise<string> {
  const { data } = await api.post("/ai/summarize", null, {
    params: { city, lookback_days: lookbackDays },
  });
  return data.summary;
}

export async function fetchAIVenueSummary(
  city: string,
  lookbackDays: number,
  sizeFilter: string = "all"
): Promise<string> {
  const { data } = await api.post("/ai/summarize-venues", null, {
    params: { city, lookback_days: lookbackDays, size_filter: sizeFilter },
  });
  return data.summary;
}

export async function fetchAICourierSummary(
  city: string,
  lookbackDays: number
): Promise<string> {
  const { data } = await api.post("/ai/summarize-couriers", null, {
    params: { city, lookback_days: lookbackDays },
  });
  return data.summary;
}

export async function fetchAIRottenSummary(
  city: string,
  lookbackDays: number
): Promise<string> {
  const { data } = await api.post("/ai/summarize-rotten", null, {
    params: { city, lookback_days: lookbackDays },
  });
  return data.summary;
}

export async function fetchAICountrySummary(
  country: string,
  lookbackDays: number
): Promise<string> {
  const { data } = await api.post("/ai/summarize-country", null, {
    params: { country, lookback_days: lookbackDays },
  });
  return data.summary;
}

export async function fetchCountries(): Promise<CountryInfo[]> {
  const { data } = await api.get("/countries");
  return data.countries;
}

export async function fetchCityAnalytics(
  countryCode: string,
  city: string,
  lookbackDays: number,
  force = false,
  ttlaMode: TtlaMode = "default"
): Promise<CityAnalyticsData> {
  const { data } = await api.get(`/country/${countryCode}/analytics`, {
    params: {
      city,
      lookback_days: lookbackDays,
      ...(ttlaMode !== "default" ? { ttla_mode: ttlaMode } : {}),
      ...(force ? { force: true } : {}),
    },
    timeout: TAB_FETCH_TIMEOUT_MS,
  });
  return data;
}

// Complete city list for a country (for the Country tab city picker). Includes
// operational cities not in the curated CITY_DATA; read-only on the backend
// (never warms), so calling it can't warm unmarked cities.
export async function fetchCountryCityList(
  countryCode: string,
  lookbackDays: number
): Promise<CountryCityList> {
  const { data } = await api.get(`/country/${countryCode}/cities`, {
    params: { lookback_days: lookbackDays },
    timeout: TAB_FETCH_TIMEOUT_MS,
  });
  return data;
}

export async function fetchCountryMaster(
  countryCode: string,
  lookbackDays: number,
  force = false,
  ttlaMode: TtlaMode = "default"
): Promise<CountryMasterData> {
  const { data } = await api.get(`/country/${countryCode}/master`, {
    params: {
      lookback_days: lookbackDays,
      ...(ttlaMode !== "default" ? { ttla_mode: ttlaMode } : {}),
      ...(force ? { force: true } : {}),
    },
    timeout: TAB_FETCH_TIMEOUT_MS,
  });
  return data;
}

export async function fetchCountryLateReasons(
  code: string,
  lookbackDays: number,
  force = false
): Promise<CountryLateReasons> {
  const { data } = await api.get(`/country/${code}/late-reasons`, {
    params: { lookback_days: lookbackDays, ...(force ? { force: true } : {}) },
    timeout: TAB_FETCH_TIMEOUT_MS,
  });
  return data;
}

export async function fetchCountryAIAnalysis(
  code: string,
  topic: string,
  focus: string,
  lookbackDays: number
): Promise<CountryAIResponse> {
  const { data } = await api.get(`/country/${code}/ai-analysis`, {
    params: { topic, focus, lookback_days: lookbackDays },
  });
  return data;
}

export async function fetchRegionOverview(
  lookbackDays: number,
  force = false,
  ttlaMode: TtlaMode = "default"
): Promise<RegionOverview> {
  const { data } = await api.get("/region/overview", {
    params: {
      lookback_days: lookbackDays,
      ...(force ? { force: true } : {}),
      ...(ttlaMode !== "default" ? { ttla_mode: ttlaMode } : {}),
    },
    timeout: TAB_FETCH_TIMEOUT_MS,
  });
  return data;
}

export async function fetchRegionCountryCities(
  code: string,
  lookbackDays: number,
  force = false,
  ttlaMode: TtlaMode = "default"
): Promise<RegionCityBreakdown> {
  const { data } = await api.get(`/region/country/${code}/cities`, {
    params: {
      lookback_days: lookbackDays,
      ...(force ? { force: true } : {}),
      ...(ttlaMode !== "default" ? { ttla_mode: ttlaMode } : {}),
    },
    timeout: TAB_FETCH_TIMEOUT_MS,
  });
  return data;
}

export async function fetchCourierPerformance(
  city: string,
  lookbackDays: number
): Promise<CourierPerformanceData> {
  const { data } = await api.get("/late-orders/courier-performance", {
    params: { city, lookback_days: lookbackDays },
  });
  return data;
}

export async function fetchVenuePerformance(
  city: string,
  lookbackDays: number,
  sizeFilter: string = "all"
): Promise<VenuePerformanceData> {
  const { data } = await api.get("/late-orders/venue-performance", {
    params: { city, lookback_days: lookbackDays, size_filter: sizeFilter },
  });
  return data;
}

export async function fetchCloneSummary(
  city: string,
  lookbackDays: number,
  sizeFilter: string = "heavy_or_large",
  weightTier: string = "all"
): Promise<CloneSummaryResponse> {
  const { data } = await api.get("/clone-rate/summary", {
    params: { city, lookback_days: lookbackDays, size_filter: sizeFilter, weight_tier: weightTier },
  });
  return data;
}

export async function fetchCloneAcceptance(
  city: string,
  lookbackDays: number,
  sizeFilter: string = "heavy_or_large"
): Promise<CloneAcceptanceResponse> {
  const { data } = await api.get("/clone-rate/acceptance", {
    params: { city, lookback_days: lookbackDays, size_filter: sizeFilter },
  });
  return data;
}

export async function fetchCloneVehicleDistribution(
  city: string,
  lookbackDays: number
): Promise<CloneVehicleDistributionResponse> {
  const { data } = await api.get("/clone-rate/vehicle-distribution", {
    params: { city, lookback_days: lookbackDays },
  });
  return data;
}

export async function fetchCloneVehicleCalendar(
  city: string,
  dateFrom: string,
  dateTo: string,
  vehicleType: string = "all"
): Promise<VehicleCalendarResponse> {
  const { data } = await api.get("/clone-rate/vehicle-calendar", {
    params: { city, date_from: dateFrom, date_to: dateTo, vehicle_type: vehicleType },
  });
  return data;
}

export async function fetchCloneOrders(
  city: string,
  lookbackDays: number,
  sizeFilter: string = "heavy_or_large",
  weightTier: string = "all"
): Promise<CloneOrdersResponse> {
  const { data } = await api.get("/clone-rate/orders", {
    params: { city, lookback_days: lookbackDays, size_filter: sizeFilter, weight_tier: weightTier },
  });
  return data;
}

export async function fetchCloneVenues(
  city: string,
  dateFrom: string,
  dateTo: string
): Promise<CloneVenuesResponse> {
  const { data } = await api.get("/clone-rate/venues", {
    params: { city, date_from: dateFrom, date_to: dateTo },
  });
  return data;
}

export async function fetchOrdersCalendar(
  city: string,
  dateFrom: string,
  dateTo: string
): Promise<OrdersCalendarResponse> {
  const { data } = await api.get("/clone-rate/orders-calendar", {
    params: { city, date_from: dateFrom, date_to: dateTo },
  });
  return data;
}

export async function fetchVehicleShare(
  city: string,
  lookbackDays: number
): Promise<VehicleShareResponse> {
  const { data } = await api.get("/clone-rate/vehicle-share", {
    params: { city, lookback_days: lookbackDays },
  });
  return data;
}

export async function fetchCourierPositions(
  city: string,
  dateFrom: string,
  dateTo: string,
  vehicleType: string = "all"
): Promise<CourierPositionsResponse> {
  const { data } = await api.get("/clone-rate/courier-positions", {
    params: { city, date_from: dateFrom, date_to: dateTo, vehicle_type: vehicleType },
  });
  return data;
}

export async function fetchOrderPositions(
  city: string,
  dateFrom: string,
  dateTo: string,
  sizeFilter: string = "heavy_or_large"
): Promise<OrderPositionsResponse> {
  const { data } = await api.get("/clone-rate/order-positions", {
    params: { city, date_from: dateFrom, date_to: dateTo, size_filter: sizeFilter },
  });
  return data;
}

export async function fetchAICloneSummary(
  city: string,
  lookbackDays: number
): Promise<string> {
  const { data } = await api.post("/ai/summarize-clone", null, {
    params: { city, lookback_days: lookbackDays },
  });
  return data.summary;
}

export async function clearCache(): Promise<void> {
  await api.post("/cache/clear");
}

// --- synthetic data source session (sign-in) control ---------------------------------------
// `getDataSourceStatus` is a cheap, network-free boolean on the backend — it
// NEVER opens a connection, so it's safe to poll. `initializeDataSource` is the ONE
// call that establishes the shared session (pops the one-time interactive popup on the
// backend); any signed-in user may call it. After it succeeds, every tab's
// background auto-refresh can run without popping sign-in again.
export async function getDataSourceStatus(): Promise<{ live: boolean }> {
  const { data } = await api.get("/data-source/status");
  return data;
}

export async function initializeDataSource(): Promise<{ live: boolean }> {
  // The backend blocks until the sign-in login round-trips (or its login timeout),
  // so give this a generous ceiling well above a normal interactive approval.
  const { data } = await api.post("/data-source/connect", null, { timeout: 180_000 });
  return data;
}

// --- City-tab freshness probes (serve-stale + sign-in-gated background warm) -----
// These never run a live query on the backend request path; they report whether
// the current view's cache is behind and, when a session is live, kick off a
// background warm of ONLY that view. The frontend polls them (like the
// Region/Country tabs) and re-fetches the data endpoints as they turn fresh.
// `force` (an explicit user "Retry") bypasses the backend warm cooldown so a
// failed/stalled scope re-warms immediately (still sign-in-gated server-side).
export async function fetchLateViewFreshness(
  city: string,
  lookbackDays: number,
  force = false
): Promise<DataFreshness> {
  const { data } = await api.get("/late-orders/freshness", {
    params: { city, lookback_days: lookbackDays, ...(force ? { force: true } : {}) },
    timeout: TAB_FETCH_TIMEOUT_MS,
  });
  return data._freshness;
}

export async function fetchCloneViewFreshness(
  city: string,
  lookbackDays: number,
  force = false
): Promise<DataFreshness> {
  const { data } = await api.get("/clone-rate/freshness", {
    params: { city, lookback_days: lookbackDays, ...(force ? { force: true } : {}) },
    timeout: TAB_FETCH_TIMEOUT_MS,
  });
  return data._freshness;
}

// --- Accept latency tab (Task to Last Accept) -----------------------------------------
// The tab renders three STACKED panels (Orders / Venues / Couriers). Each panel
// has its OWN freshness scope: its data fetch is cache-only on the backend
// (never a live query) and its freshness probe (sign-in-gated, `view`-scoped) warms
// just that panel's file in the background, so the three serve-stale / warm /
// progress-track independently.
export type TtlaView = "orders" | "venues" | "couriers" | "context";

// Serialize a per-panel TtlaQuery to query params. Filters are only sent when
// they deviate from the default so an unfiltered panel hits the same cache file
// the admin warm writes. ``include`` narrows to the filters a given view/endpoint
// actually accepts (orders/venues take min_ttla; couriers takes vehicle_type).
function ttlaParams(
  q: TtlaQuery,
  include: { minTtla?: boolean; vehicleType?: boolean } = {},
): Record<string, string | number | boolean> {
  const p: Record<string, string | number | boolean> = {
    city: q.city,
    lookback_days: q.lookbackDays,
  };
  if (q.sizeFilter && q.sizeFilter !== "all") p.size_filter = q.sizeFilter;
  if (q.venueType && q.venueType !== "all") p.venue_type = q.venueType;
  if (q.venueType === "retail" && q.retailVenueIds && q.retailVenueIds.length > 0) {
    p.retail_venue_ids = q.retailVenueIds.join(",");
  }
  if (include.minTtla && q.minTtla != null) p.min_ttla = q.minTtla;
  if (include.vehicleType && q.vehicleType && q.vehicleType !== "all") p.vehicle_type = q.vehicleType;
  // Global filters: order type (regular is the default => omit) + period.
  if (q.orderType && q.orderType !== "regular") p.order_type = q.orderType;
  // GLOBAL Accept latency-calculation-logic mode (default is the default => omit, so the
  // default-mode cache file is shared with the admin warm). Every Accept latency view
  // accepts it.
  if (q.ttlaMode && q.ttlaMode !== "default") p.ttla_mode = q.ttlaMode;
  if (q.completeWeeks) p.complete_weeks = q.completeWeeks;
  if (q.dateFrom && q.dateTo) {
    p.date_from = q.dateFrom;
    p.date_to = q.dateTo;
  }
  // Master delivery-count multi-select (specific values, e.g. [2,3,4] or [1,5]);
  // global, so every Accept latency view accepts it. Omitted when empty/null so the
  // unfiltered cache file is shared with the admin warm.
  if (q.deliveryCounts && q.deliveryCounts.length > 0) {
    p.delivery_counts = q.deliveryCounts.slice().sort((a, b) => a - b).join(",");
  }
  // Drill-down scope (Orders view only) — always forwarded when present.
  if (q.courierId) p.courier_id = q.courierId;
  else if (q.venueId) p.venue_id = q.venueId;
  // Cross-panel inspect selection (Orders view): the checked venue set.
  if (q.inspectVenueIds && q.inspectVenueIds.length > 0) {
    p.inspect_venue_ids = q.inspectVenueIds.join(",");
  }
  return p;
}

// Orders accepts min_ttla AND (for the courier drill-down) vehicle_type.
const ACCEPT_LATENCY_VIEW_INCLUDE: Record<TtlaView, { minTtla?: boolean; vehicleType?: boolean }> = {
  orders: { minTtla: true, vehicleType: true },
  venues: { minTtla: true },
  couriers: { vehicleType: true },
  context: {},
};

export async function fetchTtlaOrders(q: TtlaQuery): Promise<TtlaOrdersResponse> {
  const { data } = await api.get("/ttla", {
    params: ttlaParams(q, ACCEPT_LATENCY_VIEW_INCLUDE.orders),
    timeout: TAB_FETCH_TIMEOUT_MS,
  });
  return data;
}

export async function fetchTtlaVenues(q: TtlaQuery): Promise<TtlaVenuesResponse> {
  const { data } = await api.get("/ttla/venues", {
    params: ttlaParams(q, ACCEPT_LATENCY_VIEW_INCLUDE.venues),
    timeout: TAB_FETCH_TIMEOUT_MS,
  });
  return data;
}

export async function fetchTtlaCouriers(q: TtlaQuery): Promise<TtlaCouriersResponse> {
  const { data } = await api.get("/ttla/couriers", {
    params: ttlaParams(q, ACCEPT_LATENCY_VIEW_INCLUDE.couriers),
    timeout: TAB_FETCH_TIMEOUT_MS,
  });
  return data;
}

export async function fetchTtlaCountryContext(q: TtlaQuery): Promise<TtlaCountryContext> {
  const { data } = await api.get("/ttla/country-context", {
    params: ttlaParams(q, ACCEPT_LATENCY_VIEW_INCLUDE.context),
    timeout: TAB_FETCH_TIMEOUT_MS,
  });
  return data;
}

export async function fetchTtlaViewFreshness(
  q: TtlaQuery,
  view: TtlaView = "orders",
  force = false
): Promise<DataFreshness> {
  const { data } = await api.get("/ttla/freshness", {
    params: { ...ttlaParams(q, ACCEPT_LATENCY_VIEW_INCLUDE[view]), view, ...(force ? { force: true } : {}) },
    timeout: TAB_FETCH_TIMEOUT_MS,
  });
  return data._freshness;
}

// --- Retail Accept latency tab ---------------------------------------------------------
// Order type + period come from the Accept latency tab's global filters; regular + rolling
// days are the defaults, so they're only serialized when they deviate.
export interface RetailTtlaFilters {
  orderType?: TtlaOrderType;
  completeWeeks?: number | null;
  dateFrom?: string;
  dateTo?: string;
}

function retailParams(city: string, lookbackDays: number, f: RetailTtlaFilters = {}): Record<string, string | number> {
  const p: Record<string, string | number> = { city, lookback_days: lookbackDays };
  if (f.orderType && f.orderType !== "regular") p.order_type = f.orderType;
  if (f.completeWeeks) p.complete_weeks = f.completeWeeks;
  if (f.dateFrom && f.dateTo) {
    p.date_from = f.dateFrom;
    p.date_to = f.dateTo;
  }
  return p;
}

export async function fetchRetailTtlaSummary(
  city: string,
  lookbackDays: number,
  f: RetailTtlaFilters = {}
): Promise<RetailTtlaSummary> {
  const { data } = await api.get("/retail-ttla/summary", {
    params: retailParams(city, lookbackDays, f),
    timeout: TAB_FETCH_TIMEOUT_MS,
  });
  return data;
}

export async function fetchRetailTtlaVenues(
  city: string,
  lookbackDays: number,
  f: RetailTtlaFilters = {}
): Promise<RetailTtlaVenuesResponse> {
  const { data } = await api.get("/retail-ttla/venues", {
    params: retailParams(city, lookbackDays, f),
    timeout: TAB_FETCH_TIMEOUT_MS,
  });
  return data;
}

export async function probeRetailTtlaFreshness(
  city: string,
  lookbackDays: number,
  f: RetailTtlaFilters = {},
  force = false
): Promise<DataFreshness> {
  const { data } = await api.get("/retail-ttla/freshness", {
    params: { ...retailParams(city, lookbackDays, f), ...(force ? { force: true } : {}) },
    timeout: TAB_FETCH_TIMEOUT_MS,
  });
  return data._freshness;
}

// --- AI Venue Diagnostics (Accept latency tab) -----------------------------------------
// A job diagnoses the ticked venues sequentially; the panel polls the job for
// per-venue status + evidence packs + the LLM narrative.
export async function startVenueDiagnosticsJob(
  venueIds: string[],
  city: string,
  lookbackDays: number,
  f: RetailTtlaFilters = {},
  deep = false
): Promise<VenueDiagJob> {
  const body: Record<string, unknown> = {
    venue_ids: venueIds,
    city,
    lookback_days: lookbackDays,
  };
  if (f.orderType && f.orderType !== "regular") body.order_type = f.orderType;
  if (f.completeWeeks) body.complete_weeks = f.completeWeeks;
  if (f.dateFrom && f.dateTo) {
    body.date_from = f.dateFrom;
    body.date_to = f.dateTo;
  }
  if (deep) body.deep = true;
  const { data } = await api.post("/ttla/venue-diagnostics/jobs", body, {
    timeout: TAB_FETCH_TIMEOUT_MS,
  });
  return data;
}

export async function pollVenueDiagnosticsJob(jobId: string): Promise<VenueDiagJob> {
  const { data } = await api.get(`/ttla/venue-diagnostics/jobs/${encodeURIComponent(jobId)}`, {
    timeout: TAB_FETCH_TIMEOUT_MS,
  });
  return data;
}

export async function submitVenueDiagnosticsFeedback(payload: {
  venue_id: string;
  rating: "up" | "down";
  city?: string;
  lookback_days?: number;
  order_type?: string;
  comment?: string;
}): Promise<{ ok: boolean; recorded_at: string }> {
  const { data } = await api.post("/ttla/venue-diagnostics/feedback", payload);
  return data;
}

export interface RefreshStatus {
  running: boolean;
  progress: string;
  completed: number;
  total: number;
  errors: string[];
}

export async function startDataRefresh(opts?: { city?: string; country?: string }): Promise<{ status: string; message: string }> {
  const params: Record<string, string> = {};
  if (opts?.city) params.city = opts.city;
  if (opts?.country) params.country = opts.country;
  const { data } = await api.post("/admin/refresh", null, {
    params: Object.keys(params).length > 0 ? params : undefined,
  });
  return data;
}

export async function getRefreshStatus(): Promise<RefreshStatus> {
  const { data } = await api.get("/admin/refresh/status");
  return data;
}
