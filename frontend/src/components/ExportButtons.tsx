import { useState } from "react";
import { Download, FileImage, Loader2 } from "lucide-react";
import { useFilters } from "../hooks/useFilters";

async function exportPDF() {
  const { default: html2canvas } = await import("html2canvas-pro");
  const { jsPDF } = await import("jspdf");

  const main = document.querySelector("main");
  if (!main) return;

  const canvas = await html2canvas(main as HTMLElement, {
    backgroundColor: "#0f1117",
    scale: 1.5,
    useCORS: true,
    logging: false,
  });

  const imgData = canvas.toDataURL("image/png");
  const pdf = new jsPDF({
    orientation: canvas.width > canvas.height ? "landscape" : "portrait",
    unit: "px",
    format: [canvas.width, canvas.height],
  });
  pdf.addImage(imgData, "PNG", 0, 0, canvas.width, canvas.height);
  pdf.save("dashboard-snapshot.pdf");
}

export function ExportButtons() {
  const { filters, activeTab } = useFilters();
  const [pdfLoading, setPdfLoading] = useState(false);

  const base = "/api/export";
  const orderType = activeTab === "late" ? "late-orders" : "rotten-orders";
  const days = activeTab === "late" ? filters.lookbackDays : Math.min(filters.lookbackDays, 14);
  const params = `?city=${encodeURIComponent(filters.city)}&lookback_days=${days}`;

  const handlePDF = async () => {
    setPdfLoading(true);
    try {
      await exportPDF();
    } finally {
      setPdfLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <a
        href={`${base}/csv/${orderType}${params}`}
        download
        className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 text-xs text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      >
        <Download size={12} />
        CSV
      </a>
      <a
        href={`${base}/excel/${orderType}${params}`}
        download
        className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 text-xs text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      >
        <Download size={12} />
        Excel
      </a>
      <button
        onClick={handlePDF}
        disabled={pdfLoading}
        className="flex h-7 items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 text-xs text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50"
      >
        {pdfLoading ? <Loader2 size={12} className="animate-spin" /> : <FileImage size={12} />}
        PDF
      </button>
    </div>
  );
}
