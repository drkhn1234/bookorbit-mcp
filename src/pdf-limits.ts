/** Bounded opt-in expansion for large textbooks; default remains80MiB. */
export function pdfMaxBytes(): number {
  const raw = process.env.PDF_MAX_MIB ?? "80";
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 128)
    throw new Error("PDF_MAX_MIB must be an integer between1 and128");
  return Number(raw) * 1024 * 1024;
}
