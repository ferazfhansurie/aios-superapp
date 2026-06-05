/** Renders an office document (docx/xlsx/pptx/odt/…) inline by converting it
 *  to PDF via headless LibreOffice on the backend, then showing that PDF in an
 *  iframe. First open is slow (~1-3s); re-opens are cached and instant. */
import { useEffect, useState } from "react";

import { openPath } from "@tauri-apps/plugin-opener";
import { FileText } from "lucide-react";

import { convertOfficeToPdf, fileSrc } from "../lib/fs";
import { reportDiag } from "../lib/diag";

export function OfficePreview({ path, name }: { path: string; name?: string }) {
  const [pdf, setPdf] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setPdf(null);
    setError(null);
    convertOfficeToPdf(path)
      .then((p) => alive && setPdf(p))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [path]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[var(--color-muted)]">
        <FileText size={28} />
        <span className="text-[12px]">couldn't render · {error}</span>
        <button
          onClick={() => openPath(path).catch((e) => reportDiag("office.open", e, { action: "openPath" }))}
          className="rounded-md border border-[var(--color-border)] px-3 py-1 text-[11px] hover:border-[var(--color-accent)]/50"
        >
          open externally
        </button>
      </div>
    );
  }

  if (!pdf) {
    return (
      <div className="grid h-full place-items-center text-[12px] text-[var(--color-faint)]">
        rendering {name ?? "document"}…
      </div>
    );
  }

  return <iframe src={fileSrc(pdf)} title={name ?? path} className="h-full w-full border-0" />;
}
