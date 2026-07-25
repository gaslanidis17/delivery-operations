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
import { ArrowUpDown, ChevronLeft, ChevronRight, Search, ExternalLink, Loader2 } from "lucide-react";
import type { CloneOrderRow } from "../types";

interface Props {
  orders: CloneOrderRow[];
  loading?: boolean;
}

function fmtTtla(sec: number | null): string {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function CapabilityBadges({ row }: { row: CloneOrderRow }) {
  const badges: { label: string; cls: string }[] = [];
  if (row.is_heavy) badges.push({ label: "Tier A", cls: "bg-slate-200 text-slate-700 dark:bg-slate-700/40 dark:text-slate-300" });
  if (row.is_large) badges.push({ label: "Tier B", cls: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300" });
  if (!badges.length) return <span className="text-[var(--color-text-muted)]">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {badges.map((b) => (
        <span key={b.label} className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${b.cls}`}>
          {b.label}
        </span>
      ))}
    </div>
  );
}

export function CloneOrdersTable({ orders, loading }: Props) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");

  const columns = useMemo<ColumnDef<CloneOrderRow>[]>(
    () => [
      {
        accessorKey: "purchase_id",
        header: "Order ID",
        size: 130,
        cell: (info) => {
          const id = info.getValue() as string;
          return <span className="truncate font-mono">{id}</span>;
        },
      },
      { accessorKey: "venue_name", header: "Venue", size: 160, cell: (i) => (i.getValue() as string) || "—" },
      { accessorKey: "confirmed_date", header: "Date", size: 100 },
      {
        accessorKey: "capability_group",
        header: "Weight Tier",
        size: 110,
        cell: (i) => {
          const v = i.getValue() as string;
          return v && v !== "NONE" ? v : "—";
        },
      },
      {
        id: "capabilities",
        header: "Size",
        size: 110,
        cell: (i) => <CapabilityBadges row={i.row.original} />,
      },
      {
        accessorKey: "clone_count",
        header: "Redispatches",
        size: 70,
        cell: (i) => {
          const v = (i.getValue() as number) || 0;
          return <span className="font-medium text-red-400">{v}</span>;
        },
      },
      {
        accessorKey: "task_group_count",
        header: "Task Groups",
        size: 90,
        cell: (i) => i.getValue() ?? "—",
      },
      {
        accessorKey: "ttla_sec",
        header: "Accept latency",
        size: 90,
        cell: (i) => fmtTtla(i.getValue() as number | null),
      },
      {
        accessorKey: "shown_to_couriers",
        header: "Shown",
        size: 70,
        cell: (i) => i.getValue() ?? "—",
      },
      {
        accessorKey: "vehicle_types",
        header: "Vehicles",
        size: 140,
        cell: (i) => {
          const v = i.getValue() as string | null;
          if (!v) return <span className="text-[var(--color-text-muted)]">—</span>;
          return <span className="text-[var(--color-text-muted)]">{v}</span>;
        },
      },
    ],
    []
  );

  const table = useReactTable({
    data: orders,
    columns,
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
        <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text)]">
          Redispatched Jobs
          <span className="font-normal text-[var(--color-text-muted)]">({orders.length} rows)</span>
          {loading && <Loader2 size={14} className="animate-spin text-violet-400" />}
        </h3>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            type="text"
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            placeholder="Search order / venue…"
            className="h-8 w-56 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] pl-8 pr-3 text-xs text-[var(--color-text)] focus:border-violet-500 focus:outline-none"
          />
        </div>
      </div>

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
            {table.getRowModel().rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-4 py-8 text-center text-[var(--color-text-muted)]">
                  {loading ? "Loading…" : "No redispatched jobs for the current filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between border-t border-[var(--color-border)] px-4 py-3">
        <span className="text-xs text-[var(--color-text-muted)]">
          Page {table.getState().pagination.pageIndex + 1} of {Math.max(table.getPageCount(), 1)}
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
