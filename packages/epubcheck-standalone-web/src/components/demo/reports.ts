// Trigger a client-side file download of an in-memory string (no server).
export function downloadText(
  filename: string,
  mime: string,
  content: string,
): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export type ReportFormat = "json" | "xml" | "xmp" | "console" | "raw";

export interface PreparedReport {
  filename: string;
  mime: string;
  content: string;
}
