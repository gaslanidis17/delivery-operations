export interface LateOrder {
  purchase_id: string;
  venue_name: string;
  venue_id: string;
  venue_lat: number | null;
  venue_long: number | null;
  dropoff_h3_index: string | null;
  dropoff_h3_lat: number | null;
  dropoff_h3_lon: number | null;
  status: string;
  pre_estimate_avg: number | null;
  pre_estimate_high: number | null;
  delivered_date: string;
  delivered_at: string;
  received_at: string;
  delivered_hour: number;
  completion_time_min: number | null;
  pre_estimate_error_min: number | null;
  is_sla_breach: boolean;
  is_sla_breach_official: boolean;
  bundled_count: number;
  dropoff_distance_m: number | null;
  shown_to_couriers_count: number | null;
  task_accepted_count: number | null;
  eta_error_seconds: number | null;
  vehicle_type: string | null;
  restaurant_total_time_min: number | null;
  courier_travel_to_venue_min: number | null;
  is_heavy_delivery: boolean;
  is_large_delivery: boolean;
  // Boolean lateness flags (computed by backend)
  is_venue_late: boolean;
  is_venue_early: boolean;
  is_courier_waited: boolean;
  is_slow_pickup: boolean;
  is_slow_dropoff: boolean;
  is_bundled: boolean;
  is_cloned: boolean;
  is_rotten: boolean;
  is_long_distance: boolean;
  is_reassigned: boolean;
  is_low_acceptance: boolean;
  is_restaurant_slow: boolean;
  is_eta_underestimate: boolean;
  is_heavy_large: boolean;
  courier_count: number;
}

export interface RottenOrder {
  purchase_id: string;
  venue_name: string;
  venue_id: string;
  venue_lat: number | null;
  venue_long: number | null;
  dropoff_h3_index: string | null;
  dropoff_h3_lat: number | null;
  dropoff_h3_lon: number | null;
  delivered_date: string;
  delivered_hour: number;
  time_to_accept_min: number;
  is_rotten: boolean;
  is_late_official: boolean;
  completion_time_min: number | null;
  shown_to_couriers_count: number | null;
  task_accepted_count: number | null;
  acceptance_rate: number | null;
  vehicle_type: string | null;
  is_heavy_delivery: boolean;
  is_large_delivery: boolean;
  courier_count?: number;
}

export interface LateSummary {
  total_orders: number;
  late_orders: number;
  late_orders_official: number;
  late_pct: number;
  avg_late_completion_min: number;
  avg_completion_min: number;
  period_start: string;
  period_end: string;
}

export interface TrendPoint {
  delivered_date: string;
  total_orders: number;
  late_orders_official: number;
  late_orders_sla: number;
  avg_completion_min: number;
  total_heavy?: number;
  total_large?: number;
  total_heavy_or_large?: number;
}

export interface FlagCounts {
  [key: string]: number;
}

export interface FlagLabels {
  [key: string]: string;
}

export interface OverlapEntry {
  flag_a: string;
  label_a: string;
  flag_b: string;
  label_b: string;
  count: number;
}

export interface CombinationEntry {
  flags: string[];
  labels: string[];
  count: number;
}

export interface FlagAnalysis {
  flag_counts: FlagCounts;
  flag_labels: FlagLabels;
  overlap_matrix: OverlapEntry[];
  top_combinations: CombinationEntry[];
}

export interface VenueMapPoint {
  venue_id?: string;
  venue_name: string;
  venue_lat: number;
  venue_long: number;
  total_orders: number;
  late_orders: number;
  lateness_rate: number;
  avg_completion_min: number;
  avg_dropoff_distance: number;
}

export interface HexMapPoint {
  h3_index: string;
  total_orders: number;
  late_orders: number;
  lateness_rate: number;
  avg_completion_min: number;
}

export interface HourlyPoint {
  delivered_date: string;
  hour_of_day: number;
  total_orders: number;
  late_orders: number;
  late_orders_sla: number;
  avg_completion_min: number;
}

export interface RottenSummaryDay {
  delivered_date: string;
  total_orders: number;
  platform_orders: number;
  late_count: number;
  rotten_count: number;
}

export interface CityInfo {
  name: string;
  country: string;
  lat: number;
  lon: number;
  zoom: number;
}

export type TabView = "late" | "rotten" | "country" | "clone" | "region" | "ttla" | "logs";

// --- Retail Accept latency panel (GET /api/retail-ttla/{summary,venues,freshness}) --------
// Merged into the Accept latency tab as its first "overview" panel (RetailPanel).
// City-level average Accept latency (Task to Last Accept) for sample platform courier orders
// (Drive / preorder / time-slot orders excluded), split by venue product line,
// plus the retail venues that most WORSEN the city average (ranked by excess
// Accept latency-seconds) with coordinates for the map.
// The two venue segments the panel toggles between (per-group denominators).
export type VenueSegment = "restaurant" | "retail";

export interface RetailTtlaSummary {
  city: string;
  country: string;
  city_avg_sec: number | null;
  city_order_count: number;
  // Total reassignment rate (fraction 0–1) for the whole on-demand city set.
  city_unassign_rate: number | null;
  restaurant_avg_sec: number | null;
  restaurant_order_count: number;
  restaurant_unassign_rate: number | null;
  retail_avg_sec: number | null;
  retail_order_count: number;
  retail_unassign_rate: number | null;
  ttla_target_sec?: number | null;
  _freshness?: DataFreshness;
}

export interface RetailTtlaVenueRow {
  product_line_category: string;
  segment: VenueSegment;
  venue_name: string;
  venue_id: string | null;
  venue_lat: number | null;
  venue_long: number | null;
  // Venue sub-type (public.venues.product_line: grocery/pharmacy/alcohol/pet/...)
  // + attached account manager (resolved name); both null when unavailable.
  venue_type: string | null;
  account_manager: string | null;
  order_count: number;
  avg_ttla_sec: number | null;
  // Excess Accept latency-seconds the venue adds vs its SEGMENT's city average = Accept latency rank key.
  ttla_impact_sec: number | null;
  // That excess as a percentage of the segment's total Accept latency-seconds.
  ttla_impact_pct: number | null;
  // Total reassignment rate (fraction 0–1) + the courier-/ops-initiated breakdown.
  unassign_rate: number | null;
  unassign_rate_courier: number | null;
  unassign_rate_ops: number | null;
  // Express partner additive impact: the venue's contribution to its segment's reassignment rate
  // in percentage POINTS (Σ over venues == group rate).
  unassign_contribution_pp: number | null;
  // Fraction 0–1 of the segment's total unassigns this venue accounts for.
  share_of_unassigns: number | null;
  // Order-weighted average venue preparation time, in MINUTES.
  avg_prep_min: number | null;
  avg_pickup_service_sec: number | null;
  // Order-weighted average prep-estimate error, in MINUTES (signed): the gap
  // between the venue's INITIAL pickup ETA (prep-time promise) and the actual
  // ready time. + = ready later than promised; null when unavailable.
  avg_prep_error_min: number | null;
}

// Per-segment city denominators / references (order-weighted).
export interface RetailTtlaGroupStats {
  order_count: number;
  ttla_sec_sum: number;
  avg_ttla_sec: number | null;
  unassigned_count: number;
  unassigned_courier: number;
  unassigned_ops: number;
  avg_unassign_rate: number | null;
  avg_unassign_rate_courier: number | null;
  avg_unassign_rate_ops: number | null;
}

// Country-wide per-segment Accept latency totals (same on-demand population as the city
// groups, minus the city filter) — the denominator for the selected-venues
// "what-if" recompute of the country segment Accept latency.
export interface RetailTtlaCountryGroupStats {
  order_count: number;
  ttla_sec_sum: number;
  avg_ttla_sec: number | null;
}

export interface RetailTtlaVenuesResponse {
  // Venues for BOTH segments (frontend filters to the toggled one).
  venues: RetailTtlaVenueRow[];
  groups: Record<VenueSegment, RetailTtlaGroupStats>;
  country_groups: Record<VenueSegment, RetailTtlaCountryGroupStats>;
  total_by_segment: Record<VenueSegment, number>;
  min_venue_orders: number;
  city: string;
  country: string;
  ttla_target_sec?: number | null;
  _freshness?: DataFreshness;
}

// --- Accept latency tab (Task to Last Accept, GET /api/ttla{,/venues,/couriers}) ---------
// Accept latency is the seconds before the courier who ultimately completed pickup accepted
// the task (higher = slower = worse), from synthetic job records. Each of the
// three stacked panels now owns an INDEPENDENT filter set (see TtlaQuery) and its
// own freshness scope.
export type TtlaVenueType = "all" | "restaurant" | "retail";

// GLOBAL order type (is_drive): Regular = on-demand Restaurant + Retail
// (is_drive=FALSE, the default), Drive = Relay Express routes
// (is_drive=TRUE).
export type TtlaOrderType = "regular" | "drive";

// GLOBAL Accept latency-calculation-logic mode: how each order's Accept latency is computed. The
// order SET is unchanged (still filtered by city / period / order type /
// delivery-counts / size / venue-type); only the per-order Accept latency value differs.
//   default       = synthetic_jobs.time_to_last_accept_sec (combined; current
//                   behavior — includes idle gaps on reassigns / splits).
//   first_courier = the 1st (original) task group's own TIME_TO_LAST_ACCEPT
//                   (the courier shown the task first; isolates that courier's
//                   accept speed).
//   fixed         = AVG(TIME_TO_LAST_ACCEPT) over ALL the order's task groups
//                   (each courier's own per-task Accept latency, idle gaps excluded); the
//                   order-list Accept latency column shows this average, the city/country/
//                   venue/courier panels use the order-weighted mean of these
//                   per-order averages. For deliveries_count=1 all three coincide.
export type TtlaMode = "default" | "first_courier" | "fixed";

// The Accept latency tab's four GLOBAL filters, shared by every panel (Retail overview,
// Orders, Venues, Couriers). Country is implied by the selected city.
export interface TtlaGlobalFilters {
  city: string;
  lookbackDays: number;
  // Last N complete ISO weeks (Mon–Sun, current partial week excluded); when set
  // it overrides lookbackDays. A custom dateFrom+dateTo range overrides both.
  completeWeeks?: number | null;
  dateFrom?: string;
  dateTo?: string;
  orderType: TtlaOrderType;
  // GLOBAL Accept latency-calculation-logic mode (default | first_courier | fixed). Swaps
  // the per-order Accept latency expression; applied to ALL Accept latency panels (Orders/Venues/
  // Couriers/Country-Context). null/undefined = "default" (current behavior).
  ttlaMode?: TtlaMode;
  // MASTER filter: keep only orders whose courier-delivery count
  // (synthetic_jobs.deliveries_count) is one of the selected values (e.g. [2,3,4]
  // or [1,5] or [2,4]). Applied to ALL Accept latency panels (Orders/Venues/Couriers/
  // Country-Context) so the whole tab recalculates on the same subset. null/empty
  // = no filter / All (default). Values 1-5 are selectable; >5 only shows under All.
  deliveryCounts?: number[] | null;
}

// Per-panel filter set. Every field beyond city/lookback is optional and only
// serialized to the query string when it deviates from the default, so an
// unfiltered panel reads/warms the same cache file as before.
export interface TtlaQuery {
  city: string;
  lookbackDays: number;
  // Global filters merged in from TtlaGlobalFilters (see above).
  completeWeeks?: number | null;
  orderType?: TtlaOrderType;
  // GLOBAL Accept latency-calculation-logic mode (default | first_courier | fixed); merged
  // from TtlaGlobalFilters, applied to all Accept latency views. null/undefined = "default".
  ttlaMode?: TtlaMode;
  // MASTER delivery-count multi-select (specific values, e.g. [2,3,4] or [1,5]);
  // merged from TtlaGlobalFilters, applied to all Accept latency views. null/empty = All.
  deliveryCounts?: number[] | null;
  sizeFilter?: SizeFilter;
  venueType?: TtlaVenueType;
  // Specific retail venue ids to restrict to (only meaningful when venueType is
  // "retail"); empty/undefined = all retail venues.
  retailVenueIds?: string[];
  // Keep orders with Accept latency ≥ this (orders view) / venues whose avg Accept latency ≥ this
  // (venues view). Seconds.
  minTtla?: number | null;
  // Couriers view only: restrict to purchases completed on this vehicle type.
  vehicleType?: string;
  // Custom confirmed-date range (inclusive, YYYY-MM-DD); overrides lookback.
  dateFrom?: string;
  dateTo?: string;
  // Orders view drill-down: restrict to a single venue / courier (used by the
  // Venues/Couriers order-count popovers).
  venueId?: string;
  courierId?: string;
  // Orders view: restrict to the SET of venue ids checked in the Venue Accept latency panel
  // (cross-panel "inspect these venues" selection). Empty/undefined = no restriction.
  inspectVenueIds?: string[] | null;
}

export interface TtlaOrderRow {
  purchase_id: string;
  confirmed_date: string;
  confirmed_at: string;
  city: string;
  country: string;
  status: string;
  venue_name: string;
  venue_id: string | null;
  product_line_category: string | null;
  courier_id: string | null;
  is_heavy: number;
  is_large: number;
  // # of completed courier deliveries for this purchase. >1 = cloned/duplicated
  // order (fulfilled by more than one courier delivery). Defaults to 1 when the
  // backend omits it (old on-disk cache rows pre-v9).
  delivery_count: number;
  ttla_sec: number;
  // Signed minutes between the venue's INITIAL pickup ETA (its prep-time promise)
  // and the actual ready time. + = ready later than promised; null when missing.
  prep_error_min: number | null;
}

export interface TtlaOrdersResponse {
  orders: TtlaOrderRow[];
  total: number;
  row_limit: number;
  country: string;
  ttla_target_sec?: number | null;
  _freshness?: DataFreshness;
}

export interface TtlaVenueRow {
  venue_name: string;
  venue_id: string | null;
  product_line_category: string | null;
  order_count: number;
  ttla_sec_sum: number;
  avg_ttla_sec: number | null;
}

export interface TtlaVenuesResponse {
  venues: TtlaVenueRow[];
  total: number;
  country: string;
  ttla_target_sec?: number | null;
  _freshness?: DataFreshness;
}

export interface TtlaCourierRow {
  courier_id: string;
  order_count: number;
  ttla_sec_sum: number;
  avg_ttla_sec: number | null;
}

export interface TtlaCouriersResponse {
  couriers: TtlaCourierRow[];
  total: number;
  country: string;
  ttla_target_sec?: number | null;
  _freshness?: DataFreshness;
}

// Country Accept latency context panel (GET /api/ttla/country-context): the whole country's
// order-weighted Accept latency for the chosen period + order type, plus the selected city's
// share (order-volume weight) + leave-one-out impact on the country Accept latency, and the
// gap vs the target. Same population as the Orders/Venues/Couriers panels.
export interface TtlaCountryContext {
  country: string;
  country_name: string;
  city: string;
  order_type: TtlaOrderType;
  country_avg_sec: number | null;
  country_order_count: number;
  city_avg_sec: number | null;
  city_order_count: number;
  // Country avg Accept latency with the selected city removed (leave-one-out baseline).
  rest_avg_sec: number | null;
  // City's share of the country's Accept latency orders (fraction 0–1) = its weight.
  influence_pct: number | null;
  // Seconds the city adds to the country avg Accept latency (country_avg − rest_avg).
  impact_sec: number | null;
  // Number of operations areas (cities) contributing to the country total.
  city_count: number;
  ttla_target_sec?: number | null;
  _freshness?: DataFreshness;
}

export interface CloneDailyRow {
  confirmed_date: string;
  total_orders: number;
  heavy_count: number;
  large_count: number;
  cloned_count: number;
  clone_rate_pct: number;
  avg_ttla_sec: number;
  weight_l_count: number;
  weight_xl_count: number;
  weight_xxl_count: number;
  weight_xxxl_count: number;
}

export interface CloneSummary {
  total_orders: number;
  heavy_count: number;
  large_count: number;
  cloned_count: number;
  clone_rate_pct: number;
  avg_ttla_sec: number;
  days: number;
}

export interface CloneCityShareRow {
  confirmed_date: string;
  all_orders: number;
  heavy_count: number;
  large_count: number;
}

export interface CloneSummaryResponse {
  daily: CloneDailyRow[];
  share_daily: CloneCityShareRow[];
  summary: CloneSummary;
}

export interface VehicleCalendarRow {
  confirmed_date: string;
  hour_of_day: number;
  vehicle_type: string;
  available_vehicles: number;
}

export interface VehicleCalendarResponse {
  rows: VehicleCalendarRow[];
  vehicle_types: string[];
  date_from: string;
  date_to: string;
}

export interface CloneOrderRow {
  purchase_id: string;
  venue_name: string | null;
  confirmed_date: string;
  capability_group: string;
  is_heavy: number;
  is_large: number;
  task_group_count: number;
  clone_count: number;
  ttla_sec: number | null;
  shown_to_couriers: number | null;
  vehicle_types: string | null;
}

export interface CloneOrdersResponse {
  orders: CloneOrderRow[];
  count: number;
}

export interface CloneVenueRow {
  venue_id: string;
  venue_name: string | null;
  venue_vertical: string | null;
  total_orders: number;
  heavy_orders: number;
  large_orders: number;
  hl_orders: number;
  cloned_heavy: number;
  cloned_large: number;
  cloned_hl: number;
  avg_ttla_sec: number | null;
}

export interface CloneVenuesResponse {
  venues: CloneVenueRow[];
  count: number;
}

export interface OrdersCalendarRow {
  confirmed_date: string;
  hour_of_day: number;
  heavy_orders: number;
  large_orders: number;
  hl_orders: number;
}

export interface OrdersCalendarResponse {
  rows: OrdersCalendarRow[];
  date_from: string;
  date_to: string;
}

export interface CourierPositionRow {
  courier_id: number | string;
  vehicle_type: string;
  hour_of_day: number;
  lat: number;
  lon: number;
}

export interface CourierPositionsResponse {
  rows: CourierPositionRow[];
  vehicle_types: string[];
  date_from: string;
  date_to: string;
}

export interface OrderPositionRow {
  venue_name: string | null;
  lat: number;
  lon: number;
  hour_of_day: number;
  orders: number;
  heavy_orders: number;
  large_orders: number;
}

export interface OrderPositionsResponse {
  rows: OrderPositionRow[];
  date_from: string;
  date_to: string;
}

export interface VehicleShareRow {
  confirmed_date: string;
  vehicle_type: string;
  heavy_orders: number;
  large_orders: number;
  hl_orders: number;
}

export interface VehicleShareResponse {
  rows: VehicleShareRow[];
  vehicle_types: string[];
}

export interface WeightTierAcceptance {
  capability_group: string;
  total_orders: number;
  cloned_pct: number;
  acceptance_rate: number;
  avg_ttla_sec: number;
  weight_cost: number;
}

export interface AcceptanceDailyRow {
  confirmed_date: string;
  capability_group: string;
  order_count: number;
  cloned_pct: number;
  acceptance_rate: number | null;
  avg_ttla_sec: number | null;
}

export interface CloneAcceptanceResponse {
  tiers: WeightTierAcceptance[];
  daily: AcceptanceDailyRow[];
  weight_costs: Record<string, number>;
}

export interface VehicleDistributionRow {
  vehicle_type: string;
  total_orders: number;
  order_share_pct: number;
  total_active_hours: number;
}

export interface VehicleDistributionDailyRow {
  confirmed_date: string;
  vehicle_type: string;
  courier_count: number;
  order_count: number;
  total_active_hours: number;
}

export interface CloneVehicleDistributionResponse {
  vehicles: VehicleDistributionRow[];
  daily: VehicleDistributionDailyRow[];
}

export interface LogEntry {
  ts: string;
  category: string;
  action: string;
  user: string | null;
  ip: string | null;
  detail: Record<string, unknown>;
}

export interface LogStats {
  total_events: number;
  by_user: Record<string, number>;
  by_category: Record<string, number>;
}
export type SizeFilter = "all" | "heavy" | "large" | "heavy_or_large" | "normal";

export interface CountryInfo {
  code: string;
  name: string;
  cities: string[];
}

// Complete city list for a country (Country tab city picker). Sourced from the
// by-city deep aggregate, so it includes operational cities not in the curated
// CITY_DATA. `orders` is the window order volume (drives sort + top-N default);
// `curated` flags cities that are also in CITY_DATA.
export interface CountryCityListItem {
  city: string;
  orders: number;
  curated: boolean;
}

export interface CountryCityList {
  code: string;
  name: string;
  cities: CountryCityListItem[];
}

export interface VehicleShareRow {
  confirmed_date: string;
  vehicle_type: string;
  total_orders: number;
  heavy_count?: number;
  large_count?: number;
  split_count?: number;
}

export interface HLLatenessRow {
  confirmed_date: string;
  total_orders: number;
  heavy_count: number;
  heavy_late: number;
  large_count: number;
  large_late: number;
  avg_delivery_time: number | null;
}

export interface WeightPerfRow {
  confirmed_date: string;
  capability_group: string;
  vehicle_type: string;
  dropoff_count: number;
  cloned_pct: number;
  acceptance_rate: number | null;
  avg_ttla_sec: number | null;
}

export interface CountryRateRow {
  confirmed_date: string;
  total_orders: number;
  late_count: number;
  rotten_count: number;
}

// Auto-refresh-on-tab-open: every tab data response (Country per-city, Country
// master, Region overview, Region city drill-down) carries this block so the UI
// can show a non-blocking "updating…" indicator and re-poll while a stale cache
// is refreshed from synthetic data source in the background. `stale` = the cache is behind
// (newest cached date < yesterday / older than the canonical window). `refreshing`
// = a background warm is in flight. `can_auto_refresh` = the backend could start
// one (a synthetic data source connection is already live — sign-in-safe; when false the data is
// stale but a live login is needed, so show a "needs manual refresh" hint instead
// of waiting). `reason` ∈ {in_progress, cooldown, initialization_required, null}.
// Progress of a background warm for a scope. `total` = number of warm steps
// (SQL files/queries) the view's warm_fn runs; `completed` = finished steps. The
// UI renders a determinate bar when total >= 2, else an indeterminate one, and
// compares `updated_at` against the response's `server_now` to detect a STALL.
// All timestamps are server epoch SECONDS.
export interface RefreshProgress {
  completed: number;
  total: number;
  state?: string | null;
  started_at: number | null;
  updated_at: number | null;
}

export interface DataFreshness {
  scope: string;
  stale: boolean;
  refreshing: boolean;
  can_auto_refresh: boolean;
  // "in_progress" | "cooldown" | "initialization_required" | "error" | null
  reason: string | null;
  // Warm progress for the determinate/indeterminate bar (null when no warm ran).
  progress?: RefreshProgress | null;
  // Last warm's error message — only meaningful when reason === "error".
  last_error?: string | null;
  newest_date: string | null;
  expected_date: string;
  cache_age_seconds: number | null;
  // Server clock (epoch seconds) at response build time, so the client computes
  // elapsed/stall from the server-relative progress timestamps (no skew math).
  server_now?: number;
}

export interface CityAnalyticsData {
  heavy_vehicle_share: VehicleShareRow[];
  large_vehicle_share: VehicleShareRow[];
  split_heavy_vehicle: VehicleShareRow[];
  hl_lateness: HLLatenessRow[];
  daily_rates: CountryRateRow[];
  weight_perf: WeightPerfRow[];
  // Per-city Accept latency (Task to Last Accept) daily inputs + the COUNTRY target the
  // panel colours against. Optional/defensive (older cached payloads may omit).
  ttla?: TtlaTotalRow[];
  ttla_target_sec?: number | null;
  _freshness?: DataFreshness;
}

export interface PerfMetricsRow {
  confirmed_date: string;
  city: string;
  is_heavy: string;
  vehicle_type: string;
  order_count: number;
  task_acceptance_rate: number | null;
  avg_ttla_sec: number | null;
  avg_delivery_time: number | null;
}

export interface CountryMasterData {
  hl_lateness_total: HLLatenessRow[];
  daily_rates_total: CountryRateRow[];
  perf_metrics: PerfMetricsRow[];
  // Country-wide Accept latency (Task to Last Accept) daily inputs + the country target the
  // panel colours against. Optional/defensive (older cached payloads may omit).
  ttla_total?: TtlaTotalRow[];
  ttla_target_sec?: number | null;
  _freshness?: DataFreshness;
}

// --- Country tab: "why are heavy/large orders late?" reason breakdowns ---
// Server-side flag aggregation over the CITY late-orders model, split into the
// heavy and large late subsets. `flag_counts` excludes `is_heavy_large` (the
// whole subset is heavy/large by construction). `total` is the subset size =
// denominator for "% of late heavy/large orders". `overlap_matrix` /
// `top_combinations` are only present at the country level.
export interface LateReasonBlock {
  flag_counts: FlagCounts;
  total: number;
  overlap_matrix?: OverlapEntry[];
  top_combinations?: CombinationEntry[];
}

export interface HeavyLargeReasons {
  heavy: LateReasonBlock;
  large: LateReasonBlock;
}

export interface CountryLateReasonsCity extends HeavyLargeReasons {
  city: string;
}

export interface CountryLateReasons {
  code: string;
  name: string;
  lookback_days: number;
  country: HeavyLargeReasons;
  cities: CountryLateReasonsCity[];
}

// --- Region comparison tab ---
// Country-wide daily clone counts on the synthetic_jobs spine (drive-excluded,
// UTC confirmed_date). Mirrors the cloned/total shape of CountryRateRow.
export interface CloneRateTotalRow {
  confirmed_date: string;
  total_orders: number;
  cloned_count: number;
}

// Country-wide daily ADT (Average Delivery Time) inputs on the synthetic_jobs spine
// (drive-excluded). delivery_min_sum = Σ delivery minutes, delivery_order_count =
// the qualifying delivery-order count it is summed over. ADT (minutes) =
// delivery_min_sum / delivery_order_count is an order-weighted mean, so we carry
// both so it can be aggregated across days/cities/countries without averaging %s.
export interface AdtTotalRow {
  confirmed_date: string;
  delivery_order_count: number;
  delivery_min_sum: number;
}

// Country-wide daily Accept latency (Task to Last Accept) inputs on the synthetic_jobs spine.
// ttla_sec_sum = Σ Accept latency seconds, ttla_order_count = the order count it is
// averaged over. Accept latency (seconds) = ttla_sec_sum / ttla_order_count is an
// order-weighted mean, so we carry both to aggregate across days/cities/countries
// without averaging means. Modelled exactly like AdtTotalRow (average-seconds).
export interface TtlaTotalRow {
  confirmed_date: string;
  ttla_order_count: number;
  ttla_sec_sum: number;
}

export interface RegionCountry {
  code: string;
  name: string;
  daily_rates_total: CountryRateRow[];
  hl_lateness_total: HLLatenessRow[];
  clone_rate_total: CloneRateTotalRow[];
  adt_total: AdtTotalRow[];
  ttla_total: TtlaTotalRow[];
  // Per-country Accept latency target (seconds) or null when unset (placeholder config).
  ttla_target_sec?: number | null;
}

export interface RegionOverview {
  countries: RegionCountry[];
  lookback_days: number;
  _freshness?: DataFreshness;
}

// City drill-down for one country in the Region tab. Each city mirrors the
// RegionCountry shape (with `city` in place of code/name) so the frontend reuses
// buildMetricModel; summing all cities per metric reconciles to the country row.
export interface RegionCityRow {
  city: string;
  daily_rates_total: CountryRateRow[];
  hl_lateness_total: HLLatenessRow[];
  clone_rate_total: CloneRateTotalRow[];
  adt_total: AdtTotalRow[];
  ttla_total: TtlaTotalRow[];
}

export interface RegionCityBreakdown {
  code: string;
  name: string;
  lookback_days: number;
  // Country Accept latency target (seconds) — the reference cities compare against.
  ttla_target_sec?: number | null;
  cities: RegionCityRow[];
  _freshness?: DataFreshness;
}

// --- Country tab: "big analysis" AI panel (GET /api/country/{code}/ai-analysis) ---
// Three-dropdown driven structured analysis. The response always carries the
// computed `stat_pack` (so the UI renders numbers even if the LLM call fails) and
// a structured `analysis` (null on LLM failure, with a plain-text `summary`/`error`).
export type CountryAITopic = "heavy_large_lateness" | "overall_lateness" | "rotten";

export interface CountryAIMetric {
  label: string;
  rate_pct: number | null;
  numerator: number;
  denominator: number;
  num_label: string;
  den_label: string;
  den_is_subpopulation: boolean;
}

export interface CountryAICityStat {
  city: string;
  rate_pct: number | null;
  numerator: number;
  denominator: number;
  influence_pct: number | null;
  delta_vs_country_pp: number | null;
  outlier: boolean;
  outlier_side: "high" | "low" | null;
}

export interface CountryAIOthers {
  cities: number;
  rate_pct: number | null;
  numerator: number;
  denominator: number;
  influence_pct: number | null;
}

export interface CountryAIReasonBlock {
  flag_counts: FlagCounts;
  total: number;
  top_combinations?: CombinationEntry[];
}

export interface CountryAIReasons {
  scope: string;
  all?: CountryAIReasonBlock;
  heavy?: CountryAIReasonBlock;
  large?: CountryAIReasonBlock;
}

export interface CountryAISupplyStat {
  orders: number;
  acceptance_pct: number | null;
  avg_ttla_sec: number | null;
}

export interface CountryAISupply {
  country: CountryAISupplyStat;
  by_city: Record<string, CountryAISupplyStat>;
}

export interface CountryAIWorstPeriod {
  date: string;
  rate_pct: number | null;
  numerator: number;
  denominator: number;
}

export interface CountryAIStatPack {
  topic: string;
  scope: "country" | "city";
  focus: string;
  lookback_days: number;
  country: { code: string; name: string; metrics: Record<string, CountryAIMetric> };
  flag_labels: FlagLabels;
  primary_metric?: string;
  cities?: CountryAICityStat[];
  others?: CountryAIOthers | null;
  focus_city?: CountryAICityStat;
  focus_rank?: number | null;
  total_cities?: number;
  reasons?: CountryAIReasons;
  supply?: CountryAISupply;
  worst_periods?: CountryAIWorstPeriod[];
}

export interface CountryAICityCallout {
  city: string;
  severity: string;
  headline: string;
  reason_tags: string[];
}

export interface CountryAIAnalysisResult {
  headline: string;
  summary: string[];
  key_drivers: string[];
  cities_to_watch: CountryAICityCallout[];
  recommended_actions: string[];
  caveats: string[];
}

export interface CountryAIResponse {
  code: string;
  name: string;
  topic: string;
  topic_label: string;
  focus: string;
  scope: "country" | "city";
  lookback_days: number;
  model: string;
  generated_at: string;
  cached: boolean;
  stat_pack: CountryAIStatPack;
  analysis: CountryAIAnalysisResult | null;
  summary: string | null;
  error: string | null;
}

export interface CourierTravelOrder {
  purchase_id: string;
  delivered_date: string;
  pickup_worker_id: string | null;
  dropoff_worker_id: string | null;
  courier_vehicle_type: string | null;
  pickup_distance_m: number | null;
  dropoff_distance_m: number | null;
  pickup_arrival_min: number | null;
  dropoff_arrival_min: number | null;
  is_cloned: boolean;
  is_bundled: boolean;
  pickup_target_min: number | null;
  dropoff_target_min: number | null;
  pickup_speed_kmh: number | null;
  dropoff_speed_kmh: number | null;
  target_total_min: number | null;
  travel_total_min: number | null;
  is_slow_travel: boolean;
  is_slow_pickup_travel: boolean;
  is_slow_dropoff_travel: boolean;
  travel_ratio: number | null;
}

export interface CourierSummary {
  worker_id: string;
  vehicle_type: string | null;
  order_count: number;
  slow_order_count: number;
  slow_pct: number;
  avg_pickup_min: number;
  avg_dropoff_min: number;
  avg_pickup_dist_m: number;
  avg_dropoff_dist_m: number;
  avg_speed_kmh: number | null;
}

export interface SpeedBenchmark {
  vehicle_type: string;
  order_count: number;
  avg_speed_kmh: number | null;
  median_speed_kmh: number | null;
  p25_speed_kmh: number | null;
  p75_speed_kmh: number | null;
  avg_pickup_min: number | null;
  avg_dropoff_min: number | null;
  avg_pickup_distance_m: number | null;
  avg_dropoff_distance_m: number | null;
}

export interface CourierPerformanceData {
  orders: CourierTravelOrder[];
  couriers: CourierSummary[];
  speed_benchmarks: SpeedBenchmark[];
  speed_targets: Record<string, number>;
  summary: {
    total_late_orders: number;
    slow_travel_orders: number;
    slow_travel_pct: number;
    buffer_multiplier: number;
  };
}

export interface VenuePerformance {
  venue_id: string;
  venue_name: string;
  venue_vertical: string | null;
  total_orders: number;
  late_orders: number;
  delayed_orders: number;
  late_pct: number;
  rotten_pct: number;
  avg_ttla_sec: number | null;
  avg_prep_time_min: number | null;
  avg_completion_min: number | null;
  venue_late_count: number;
  venue_early_count: number;
  venue_late_share: number;
  problem_score: number;
}

export interface VenuePerformanceData {
  venues: VenuePerformance[];
  summary: {
    total_venues: number;
    problem_venues: number;
    avg_late_pct: number;
  };
}

export type PeriodMode = "lookback" | "custom" | "completed_days" | "completed_weeks";

export interface Filters {
  city: string;
  lookbackDays: number;
  sizeFilter: SizeFilter;
  periodMode: PeriodMode;
  customFrom?: string;
  customTo?: string;
}

// --- AI Venue Diagnostics (Accept latency tab) -----------------------------------------
// Mirrors backend app/services/venue_diagnostics.py (evidence packs + the
// strict VenueDiagnostic LLM schema) and the job-queue endpoints under
// /api/ttla/venue-diagnostics. Numbers come from the packs (always present); the
// `analysis` is the LLM interpretation (null when insufficient / failed).

export interface VenueDiagBenchmark {
  segment: string | null;
  segment_city_avg_ttla_sec: number | null;
  segment_city_unassign_rate: number | null;
  segment_city_order_count: number | null;
  segment_country_avg_ttla_sec: number | null;
  segment_country_order_count: number | null;
  ttla_target_sec: number | null;
}

export interface VenueDiagMetrics {
  found: boolean;
  venue_id: string;
  venue_name?: string;
  segment?: string | null;
  product_line_category?: string | null;
  venue_type?: string | null;
  account_manager?: string | null;
  order_count?: number;
  avg_ttla_sec?: number | null;
  ttla_impact_sec?: number | null;
  ttla_impact_pct?: number | null;
  unassign_rate?: number | null;
  unassign_rate_courier?: number | null;
  unassign_rate_ops?: number | null;
  unassign_contribution_pp?: number | null;
  share_of_unassigns?: number | null;
  avg_prep_min?: number | null;
  avg_pickup_service_sec?: number | null;
  avg_prep_error_min?: number | null;
  benchmark?: VenueDiagBenchmark;
}

export interface VenueDiagHour {
  hour: number;
  order_count: number;
  avg_ttla_sec: number | null;
  unassign_rate: number | null;
  unassigned_count: number;
  low_volume: boolean;
}

export interface VenueDiagHourlyPack {
  hours: VenueDiagHour[];
  venue_avg_ttla_sec: number | null;
  total_orders: number;
  worst_hours: VenueDiagHour[];
  peak_volume_hours: VenueDiagHour[];
  min_hour_orders: number;
}

export interface VenueDiagDay {
  date: string;
  order_count: number;
  avg_ttla_sec: number | null;
  unassign_rate: number | null;
  low_volume: boolean;
}

export interface VenueDiagDailyPack {
  days: VenueDiagDay[];
  venue_avg_ttla_sec: number | null;
  classification: string;
  trend: string;
  bad_day_count: number;
  eligible_day_count: number;
  worst_days: VenueDiagDay[];
  min_day_orders: number;
}

export interface VenueDiagTheme {
  tag_lvl2: string;
  tag_lvl3: string;
  label: string;
  conversation_count: number;
  order_count: number;
  per_100_orders: number | null;
  share_of_city_theme: number | null;
  confirmed: boolean;
  first_seen: string | null;
  last_seen: string | null;
}

export interface VenueDiagConversationsPack {
  themes: VenueDiagTheme[];
  total_themes: number;
  total_conversations: number;
  conversations_per_100_orders: number | null;
  min_theme_count: number;
}

export interface VenueDiagUnassignPack {
  unassign_rate: number | null;
  unassign_rate_courier: number | null;
  unassign_rate_ops: number | null;
  unassign_contribution_pp: number | null;
  share_of_unassigns: number | null;
  segment_city_unassign_rate: number | null;
  // v2 — F_COURIER_DELIVERY_UNASSIGNS event enrichment (present when events_available).
  events_available?: boolean;
  unassign_events?: number;
  purchases_unassigned?: number;
  distinct_couriers?: number;
  events_courier?: number;
  events_ops?: number;
  events_per_unassigned_order?: number | null;
  events_per_100_orders?: number | null;
  avg_hold_before_unassign_sec?: number | null;
  median_hold_before_unassign_sec?: number | null;
}

// v2 — Pack 7 peer benchmarking (same segment + venue_type in the city).
export interface VenueDiagPeersPack {
  found: boolean;
  matched_on?: string;
  venue_type?: string | null;
  segment?: string | null;
  peer_count?: number;
  low_peer_count?: boolean;
  ttla_percentile?: number | null;
  unassign_percentile?: number | null;
  peer_ttla_median_sec?: number | null;
  peer_ttla_p75_sec?: number | null;
  peer_unassign_median?: number | null;
  venue_avg_ttla_sec?: number | null;
  venue_unassign_rate?: number | null;
}

// v2 — Pack 4 raw conversation-text themes (PII-scrubbed; deep mode only).
export interface VenueDiagConversationTheme {
  theme: string;
  paraphrase: string;
  mention_count: number;
  severity: string;
  venue_related: boolean;
}

export interface VenueDiagConversationTextPack {
  available: boolean;
  message_count: number;
  themes: VenueDiagConversationTheme[];
  dominant_language?: string | null;
  scrubbed_note?: string | null;
  top_flow_paths?: string[];
}

export interface VenueDiagLocationPack {
  found: boolean;
  venue_type?: string | null;
  product_line_category?: string | null;
  retail_business_segment?: string | null;
  merchant_type?: string | null;
  is_hub_store?: boolean | null;
  is_eatin?: boolean | null;
  is_takeaway?: boolean | null;
  brand_name?: string | null;
  franchise_name?: string | null;
  venue_address?: string | null;
  venue_postcode?: string | null;
  has_courier_notes?: boolean;
  courier_notes?: string | null;
  access_keywords?: string[];
  has_opening_times?: boolean;
  has_special_opening_times?: boolean;
  open_hour?: number | null;
  close_hour?: number | null;
  special_opening_count?: number | null;
  near_close_hours?: number[] | null;
  worst_hours_near_close?: boolean | null;
  out_of_hours_order_share?: number | null;
  venue_hex8?: string | null;
  avg_uptime_l4w_min?: number | null;
  lat?: number | null;
  lon?: number | null;
  city_center_lat?: number | null;
  city_center_lon?: number | null;
  distance_km_from_center?: number | null;
  position_label?: string | null;
  mall_hint?: boolean | null;
  mall_reason?: string | null;
  traffic_hint?: string | null;
}

export interface VenueDiagPacks {
  metrics: VenueDiagMetrics;
  hourly: VenueDiagHourlyPack;
  daily: VenueDiagDailyPack;
  conversations: VenueDiagConversationsPack;
  unassign: VenueDiagUnassignPack;
  location: VenueDiagLocationPack;
  peers?: VenueDiagPeersPack;
  conversation_text?: VenueDiagConversationTextPack;
}

export interface VenueDiagDataQuality {
  sufficient: boolean;
  reasons: string[];
  order_count: number;
  min_venue_orders: number;
  flags: {
    hourly_thin: boolean;
    daily_thin: boolean;
    no_conversations: boolean;
    no_location: boolean;
  };
}

// Strict LLM output (mirror VenueDiagnostic pydantic model).
export interface VenueDiagPerformanceOverview {
  ttla_level: string;
  ttla_trend: string;
  unassign_level: string;
  unassign_trend: string;
  order_volume: string;
  worst_hours: string[];
  worst_days: string[];
  benchmark_delta: string;
}

export interface VenueDiagFinding {
  title: string;
  description: string;
  evidence: string[];
  time_period: string;
  impact_estimate: string;
  confidence: string;
  classification: string;
}

export interface VenueDiagRootCause {
  venue_ops: string[];
  courier_access: string[];
  location_infra: string[];
  peak_capacity: string[];
  bad_venue_info: string[];
  external: string[];
  data_quality: string[];
}

export interface VenueDiagRecommendedAction {
  addresses_finding: string;
  horizon: string;
  expected_impact: string;
  owner: string;
  priority: string;
  success_metric: string;
}

export interface VenueDiagLimitations {
  missing_data: string[];
  weak_evidence: string[];
  assumptions: string[];
  data_needed: string[];
}

export interface VenueDiagnosticAnalysis {
  executive_summary: string;
  performance_overview: VenueDiagPerformanceOverview;
  findings: VenueDiagFinding[];
  root_cause: VenueDiagRootCause;
  recommended_actions: VenueDiagRecommendedAction[];
  limitations: VenueDiagLimitations;
}

export type VenueDiagStatus =
  | "waiting"
  | "collecting_data"
  | "analyzing_performance"
  | "generating_summary"
  | "completed"
  | "insufficient_data"
  | "failed";

// One venue's slot in a job (packs render even before/without the LLM result).
export interface VenueDiagResult {
  venue_id: string;
  venue_name?: string;
  city?: string;
  country?: string;
  status: VenueDiagStatus;
  data_quality?: VenueDiagDataQuality;
  packs?: VenueDiagPacks;
  analysis?: VenueDiagnosticAnalysis | null;
  summary?: string | null;
  error?: string | null;
  insufficient_reasons?: string[];
  model?: string;
  cached?: boolean;
}

export interface VenueDiagJob {
  job_id: string;
  status: string;
  city: string;
  lookback_days: number;
  order_type: TtlaOrderType;
  deep?: boolean;
  venue_ids: string[];
  created_at: string;
  finished_at?: string | null;
  venues: Record<string, VenueDiagResult>;
}
