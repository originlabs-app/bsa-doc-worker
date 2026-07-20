import { PDFDocument } from "pdf-lib";

export interface PdfSubsetOptions {
  firstPages: number;
  tailPages: number;
}

export interface PdfSubsetResult {
  bytes: Uint8Array;
  pages: string;
  pageCount: number;
  subsetApplied: boolean;
}

function formatPageRanges(pageIndexes: number[]): string {
  if (pageIndexes.length === 0) return "";
  const ranges: string[] = [];
  let start = (pageIndexes[0] ?? 0) + 1;
  let previous = start;
  for (const index of pageIndexes.slice(1)) {
    const page = index + 1;
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    ranges.push(start === previous ? String(start) : `${start}-${previous}`);
    start = page;
    previous = page;
  }
  ranges.push(start === previous ? String(start) : `${start}-${previous}`);
  return ranges.join(",");
}

export interface PdfPageChunk {
  bytes: Uint8Array;
  pages: string;
  pageCount: number;
}

export async function splitPdfIntoPageChunks(
  bytes: Uint8Array,
  pagesPerChunk: number,
): Promise<PdfPageChunk[]> {
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pageCount = source.getPageCount();
  if (pageCount <= pagesPerChunk) {
    return [
      {
        bytes,
        pages: formatPageRanges(
          Array.from({ length: pageCount }, (_value, index) => index),
        ),
        pageCount,
      },
    ];
  }
  const chunks: PdfPageChunk[] = [];
  for (let start = 0; start < pageCount; start += pagesPerChunk) {
    const pageIndexes = Array.from(
      { length: Math.min(pagesPerChunk, pageCount - start) },
      (_value, index) => start + index,
    );
    const target = await PDFDocument.create();
    for (const page of await target.copyPages(source, pageIndexes)) {
      target.addPage(page);
    }
    chunks.push({
      bytes: new Uint8Array(await target.save()),
      pages: formatPageRanges(pageIndexes),
      pageCount: pageIndexes.length,
    });
  }
  return chunks;
}

export async function copyPdfHeadTailPages(
  bytes: Uint8Array,
  options: PdfSubsetOptions,
): Promise<PdfSubsetResult> {
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pageCount = source.getPageCount();
  const pageIndexes = Array.from(
    { length: Math.min(options.firstPages, pageCount) },
    (_value, index) => index,
  );
  const tailStart = Math.max(options.firstPages, pageCount - options.tailPages);
  for (let index = tailStart; index < pageCount; index += 1) {
    if (!pageIndexes.includes(index)) pageIndexes.push(index);
  }
  pageIndexes.sort((a, b) => a - b);
  if (pageIndexes.length >= pageCount) {
    return {
      bytes,
      pages: formatPageRanges(pageIndexes),
      pageCount,
      subsetApplied: false,
    };
  }
  const target = await PDFDocument.create();
  for (const page of await target.copyPages(source, pageIndexes)) {
    target.addPage(page);
  }
  return {
    bytes: new Uint8Array(await target.save()),
    pages: formatPageRanges(pageIndexes),
    pageCount,
    subsetApplied: true,
  };
}
