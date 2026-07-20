export function buildDceTextPath(document: {
  url: string;
  tenderId: string;
  documentId: string;
  companyId?: string | null;
}): string {
  const companyId = document.companyId ?? document.url.split("/")[0];
  if (!companyId) throw new Error("DCE_TEXT_COMPANY_MISSING");
  return `${companyId}/${document.tenderId}/dce-text/${document.documentId}.txt`;
}
