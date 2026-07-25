import { useState, useMemo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowUpDown, ChevronLeft, ChevronRight, Search, X, Filter, ExternalLink } from "lucide-react";
import { formatMinutes } from "../lib/utils";
import { LEX } from "../lib/lexicon";
import type { LateOrder, RottenOrder } from "../types";

interface OrderTableProps {
  orders: LateOrder[] | RottenOrder[];
  mode: "late" | "rotten";
}

const FLAG_BADGE_COLORS: Record<string, string> = {
  is_venue_late: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  is_venue_early: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  is_courier_waited: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  is_slow_pickup: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  is_slow_dropoff: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  is_bundled: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  is_cloned: "bg-lime-100 text-lime-700 dark:bg-lime-900/40 dark:text-lime-300",
  is_rotten: "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
  is_long_distance: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  is_reassigned: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  is_low_acceptance: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
  is_eta_underestimate: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
};

const FLAG_SHORT: Record<string, string> = {
  is_venue_late: "Ready lag",
  is_venue_early: "Early handoff",
  is_courier_waited: "Field wait",
  is_slow_pickup: "Slow en-route",
  is_slow_dropoff: "Slow final",
  is_bundled: "Batch",
  is_cloned: "Redispatch",
  is_rotten: "Queue",
  is_long_distance: "Long route",
  is_reassigned: "Reassign",
  is_low_acceptance: "Low uptake",
  is_eta_underestimate: "Promise gap",
};

const FLAGS = Object.keys(FLAG_SHORT);

const CAPABILITY_KEYS = ["is_heavy_delivery", "is_large_delivery"] as const;
const CAPABILITY_LABELS: Record<string, string> = {
  is_heavy_delivery: LEX.metrics.oversizeA,
  is_large_delivery: LEX.metrics.oversizeB,
};
const CAPABILITY_COLORS: Record<string, string> = {
  is_heavy_delivery: "bg-slate-200 text-slate-700 dark:bg-slate-700/40 dark:text-slate-300",
  is_large_delivery: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
};

function FlagBadges({ row }: { row: Record<string, unknown> }) {
  const active = FLAGS.filter((f) => row[f]);
  if (!active.length) return <span className="text-xs text-[var(--color-text-muted)]">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {active.map((f) => (
        <span
          key={f}
          className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${FLAG_BADGE_COLORS[f]}`}
        >
          {FLAG_SHORT[f]}
        </span>
      ))}
    </div>
  );
}

function CapabilityBadges({ row }: { row: Record<string, unknown> }) {
  const active = CAPABILITY_KEYS.filter((k) => row[k]);
  if (!active.length) return <span className="text-xs text-[var(--color-text-muted)]">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {active.map((k) => (
        <span
          key={k}
          className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${CAPABILITY_COLORS[k]}`}
        >
          {CAPABILITY_LABELS[k]}
        </span>
      ))}
    </div>
  );
}

function VehicleCell({ value }: { value: string | null }) {
  if (!value) return <span className="text-[var(--color-text-muted)]">—</span>;
  const icon: Record<string, string> = { car: "🚗", bicycle: "🚲", walking: "🚶", motorcycle: "🏍️" };
  const parts = value.split("|").map((v) => v.trim());
  return (
    <div className="flex items-center gap-1">
      {parts.map((p, i) => (
        <span key={i} className="inline-flex items-center gap-0.5 rounded bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]">
          {icon[p.toLowerCase()] ?? ""} {p}
        </span>
      ))}
    </div>
  );
}

export function OrderTable({ orders, mode }: OrderTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [selectedFlags, setSelectedFlags] = useState<Set<string>>(new Set());
  const [flagMode, setFlagMode] = useState<"contains" | "is" | "is_not">("contains");
  const [selectedCaps, setSelectedCaps] = useState<Set<string>>(new Set());
  const [capMode, setCapMode] = useState<"contains" | "is" | "is_not">("contains");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selectedVehicles, setSelectedVehicles] = useState<Set<string>>(new Set());

  const availableVehicles = useMemo(() => {
    const set = new Set<string>();
    for (const o of orders) {
      const vt = (o as any).vehicle_type;
      if (vt) {
        vt.split("|").forEach((v: string) => set.add(v.trim()));
      }
    }
    return Array.from(set).sort();
  }, [orders]);

  const locallyFiltered = useMemo(() => {
    let filtered = [...orders];

    if (selectedFlags.size > 0) {
      filtered = filtered.filter((o) => {
        const row = o as unknown as Record<string, unknown>;
        const selected = Array.from(selectedFlags);
        if (flagMode === "contains") {
          return selected.every((f) => row[f]);
        } else if (flagMode === "is") {
          const activeFlags = FLAGS.filter((f) => row[f]);
          return selected.length === activeFlags.length && selected.every((f) => row[f]);
        } else {
          return selected.every((f) => !row[f]);
        }
      });
    }

    if (selectedCaps.size > 0) {
      filtered = filtered.filter((o) => {
        const row = o as unknown as Record<string, unknown>;
        const selected = Array.from(selectedCaps);
        if (capMode === "contains") {
          return selected.every((f) => row[f]);
        } else if (capMode === "is") {
          const activeCaps = CAPABILITY_KEYS.filter((k) => row[k]);
          return selected.length === activeCaps.length && selected.every((f) => row[f]);
        } else {
          return selected.every((f) => !row[f]);
        }
      });
    }

    if (dateFrom) {
      filtered = filtered.filter((o) => o.delivered_date >= dateFrom);
    }
    if (dateTo) {
      filtered = filtered.filter((o) => o.delivered_date <= dateTo);
    }

    if (selectedVehicles.size > 0) {
      filtered = filtered.filter((o) => {
        const vt = (o as any).vehicle_type as string | null;
        if (!vt) return false;
        const parts = vt.split("|").map((v: string) => v.trim());
        return parts.some((p: string) => selectedVehicles.has(p));
      });
    }

    return filtered;
  }, [orders, selectedFlags, flagMode, selectedCaps, capMode, dateFrom, dateTo, selectedVehicles]);

  const toggleFlag = (flag: string) => {
    setSelectedFlags((prev) => {
      const next = new Set(prev);
      if (next.has(flag)) next.delete(flag);
      else next.add(flag);
      return next;
    });
  };

  const toggleCap = (cap: string) => {
    setSelectedCaps((prev) => {
      const next = new Set(prev);
      if (next.has(cap)) next.delete(cap);
      else next.add(cap);
      return next;
    });
  };

  const toggleVehicle = (v: string) => {
    setSelectedVehicles((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  };

  const clearLocalFilters = () => {
    setSelectedFlags(new Set());
    setFlagMode("contains");
    setSelectedCaps(new Set());
    setCapMode("contains");
    setDateFrom("");
    setDateTo("");
    setSelectedVehicles(new Set());
  };

  const hasActiveFilters = selectedFlags.size > 0 || selectedCaps.size > 0 || dateFrom || dateTo || selectedVehicles.size > 0;

  const lateColumns = useMemo<ColumnDef<LateOrder>[]>(
    () => [
      {
        accessorKey: "purchase_id",
        header: "Order ID",
        size: 120,
        cell: (info) => {
          const id = info.getValue() as string;
          return <span className="truncate font-mono">{id}</span>;
        },
      },
      { accessorKey: "venue_name", header: "Venue", size: 150 },
      { accessorKey: "delivered_date", header: "Date", size: 100 },
      {
        accessorKey: "vehicle_type",
        header: "Vehicle",
        size: 100,
        cell: (info) => <VehicleCell value={info.getValue() as string | null} />,
      },
      {
        accessorKey: "completion_time_min",
        header: "Completion",
        size: 90,
        cell: (info) => formatMinutes(info.getValue() as number),
      },
      {
        accessorKey: "pre_estimate_high",
        header: "Est. High",
        size: 80,
        cell: (info) => formatMinutes(info.getValue() as number),
      },
      {
        accessorKey: "pre_estimate_error_min",
        header: "Error (min)",
        size: 80,
        cell: (info) => {
          const v = info.getValue() as number | null;
          if (v == null) return "—";
          return v.toFixed(1);
        },
      },
      { accessorKey: "bundled_count", header: "Bundle", size: 60 },
      {
        accessorKey: "courier_count",
        header: "Couriers",
        size: 65,
        cell: (info) => {
          const v = info.getValue() as number | undefined;
          if (!v || v <= 1) return <span className="text-[var(--color-text-muted)]">1</span>;
          return <span className="font-medium text-amber-400">{v}</span>;
        },
      },
      {
        id: "capabilities",
        header: "Capabilities",
        size: 100,
        cell: (info) => <CapabilityBadges row={info.row.original as unknown as Record<string, unknown>} />,
      },
      {
        id: "flags",
        header: LEX.metrics.reasonHeading,
        size: 220,
        cell: (info) => <FlagBadges row={info.row.original as unknown as Record<string, unknown>} />,
      },
    ],
    []
  );

  const rottenColumns = useMemo<ColumnDef<RottenOrder>[]>(
    () => [
      {
        accessorKey: "purchase_id",
        header: "Order ID",
        size: 120,
        cell: (info) => {
          const id = info.getValue() as string;
          return <span className="truncate font-mono">{id}</span>;
        },
      },
      { accessorKey: "venue_name", header: "Venue", size: 150 },
      { accessorKey: "delivered_date", header: "Date", size: 100 },
      {
        accessorKey: "vehicle_type",
        header: "Vehicle",
        size: 100,
        cell: (info) => <VehicleCell value={info.getValue() as string | null} />,
      },
      {
        accessorKey: "time_to_accept_min",
        header: "Wait (min)",
        size: 90,
        cell: (info) => {
          const v = info.getValue() as number;
          return <span className="font-medium text-red-400">{v.toFixed(1)}</span>;
        },
      },
      {
        id: "ttla",
        header: LEX.metrics.acceptLatencySec,
        size: 85,
        accessorFn: (row) => row.time_to_accept_min != null ? Math.round(row.time_to_accept_min * 60) : null,
        cell: (info) => {
          const v = info.getValue() as number | null;
          if (v == null) return "—";
          return <span className="font-mono">{v.toLocaleString()}</span>;
        },
      },
      {
        accessorKey: "shown_to_couriers_count",
        header: "Shown",
        size: 60,
        cell: (info) => info.getValue() ?? "—",
      },
      {
        accessorKey: "acceptance_rate",
        header: "Accept %",
        size: 75,
        cell: (info) => {
          const v = info.getValue() as number | null;
          if (v == null) return "—";
          return `${(v * 100).toFixed(0)}%`;
        },
      },
      {
        accessorKey: "completion_time_min",
        header: "Completion",
        size: 90,
        cell: (info) => formatMinutes(info.getValue() as number),
      },
      {
        accessorKey: "is_late_official",
        header: "Late?",
        size: 60,
        cell: (info) =>
          info.getValue() ? (
            <span className="text-red-400">Yes</span>
          ) : (
            <span className="text-[var(--color-text-muted)]">No</span>
          ),
      },
    ],
    []
  );

  const table = useReactTable({
    data: locallyFiltered as never[],
    columns: (mode === "late" ? lateColumns : rottenColumns) as ColumnDef<never>[],
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 25 } },
  });

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] p-4">
        <h3 className="text-sm font-semibold text-[var(--color-text)]">
          {mode === "late" ? LEX.tabSla : LEX.tabQueue}{" "}
          <span className="font-normal text-[var(--color-text-muted)]">
            ({locallyFiltered.length}{hasActiveFilters ? ` of ${orders.length}` : ""} rows)
          </span>
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
              showFilters || hasActiveFilters
                ? "bg-[var(--color-primary)] text-white"
                : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            <Filter size={12} />
            Filters
            {hasActiveFilters && (
              <span className="ml-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-white/20 text-[10px]">
                {selectedFlags.size + selectedCaps.size + (dateFrom || dateTo ? 1 : 0) + selectedVehicles.size}
              </span>
            )}
          </button>
          <div className="relative">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
            />
            <input
              type="text"
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder="Search…"
              className="h-8 w-48 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] pl-8 pr-3 text-xs text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* Local Filters Panel */}
      {showFilters && (
        <div className="border-b border-[var(--color-border)] bg-[var(--color-bg)]/50 px-4 py-3 space-y-3">
          {/* Date Range */}
          <div className="flex items-center gap-3">
            <span className="w-20 text-xs font-medium text-[var(--color-text-muted)]">Date range</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-7 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
            />
            <span className="text-xs text-[var(--color-text-muted)]">to</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-7 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
            />
          </div>

          {/* Lateness Reason Tags */}
          {mode === "late" && (
            <div className="flex items-start gap-3">
              <div className="flex w-20 shrink-0 flex-col gap-1 pt-1">
                <span className="text-xs font-medium text-[var(--color-text-muted)]">Reasons</span>
                <select
                  value={flagMode}
                  onChange={(e) => setFlagMode(e.target.value as "contains" | "is" | "is_not")}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-[10px] text-[var(--color-text)]"
                >
                  <option value="contains">Contains</option>
                  <option value="is">Is exactly</option>
                  <option value="is_not">Is not</option>
                </select>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {FLAGS.map((f) => (
                  <button
                    key={f}
                    onClick={() => toggleFlag(f)}
                    className={`rounded-md px-2 py-1 text-[10px] font-medium transition-colors ${
                      selectedFlags.has(f)
                        ? FLAG_BADGE_COLORS[f]
                        : "bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                    }`}
                  >
                    {FLAG_SHORT[f]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Capabilities */}
          {mode === "late" && (
            <div className="flex items-start gap-3">
              <div className="flex w-20 shrink-0 flex-col gap-1 pt-1">
                <span className="text-xs font-medium text-[var(--color-text-muted)]">Capabilities</span>
                <select
                  value={capMode}
                  onChange={(e) => setCapMode(e.target.value as "contains" | "is" | "is_not")}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-[10px] text-[var(--color-text)]"
                >
                  <option value="contains">Contains</option>
                  <option value="is">Is exactly</option>
                  <option value="is_not">Is not</option>
                </select>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {CAPABILITY_KEYS.map((k) => (
                  <button
                    key={k}
                    onClick={() => toggleCap(k)}
                    className={`rounded-md px-2 py-1 text-[10px] font-medium transition-colors ${
                      selectedCaps.has(k)
                        ? CAPABILITY_COLORS[k]
                        : "bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                    }`}
                  >
                    {CAPABILITY_LABELS[k]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Vehicle Type */}
          {availableVehicles.length > 0 && (
            <div className="flex items-center gap-3">
              <span className="w-20 text-xs font-medium text-[var(--color-text-muted)]">Vehicle</span>
              <div className="flex flex-wrap gap-1.5">
                {availableVehicles.map((v) => (
                  <button
                    key={v}
                    onClick={() => toggleVehicle(v)}
                    className={`rounded-md px-2 py-1 text-[10px] font-medium capitalize transition-colors ${
                      selectedVehicles.has(v)
                        ? "bg-[var(--color-primary)] text-white"
                        : "bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Clear all */}
          {hasActiveFilters && (
            <button
              onClick={clearLocalFilters}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-red-400 hover:text-red-300 transition-colors"
            >
              <X size={10} />
              Clear all filters
            </button>
          )}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-[var(--color-border)]">
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    className="cursor-pointer px-4 py-2.5 font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                    style={{ width: h.getSize() }}
                    onClick={h.column.getToggleSortingHandler()}
                  >
                    <div className="flex items-center gap-1">
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      <ArrowUpDown size={12} className="opacity-40" />
                    </div>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className="border-b border-[var(--color-border)] transition-colors hover:bg-[var(--color-surface-hover)]"
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-2">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between border-t border-[var(--color-border)] px-4 py-3">
        <span className="text-xs text-[var(--color-text-muted)]">
          Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
        </span>
        <div className="flex gap-1">
          <button
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            className="flex h-7 w-7 items-center justify-center rounded border border-[var(--color-border)] text-[var(--color-text-muted)] disabled:opacity-30"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            className="flex h-7 w-7 items-center justify-center rounded border border-[var(--color-border)] text-[var(--color-text-muted)] disabled:opacity-30"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
