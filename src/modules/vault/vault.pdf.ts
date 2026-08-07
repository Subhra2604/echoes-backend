import PDFDocument from 'pdfkit';

/**
 * Render a WRITTEN VaultItem to a PDF stream.
 *
 * Uses pdfkit's built-in Helvetica family (no font file lookups, ships in the
 * package) for reliability. Layout is deliberately restrained — title big,
 * subtitle small, body flowed as one column with generous margins. Optimized
 * for letters/notes, not marketing collateral.
 *
 * The returned PDFDocument IS a Node Readable — the caller can `.pipe(res)`
 * directly. We call `.end()` here so the stream fully finalizes as it's read.
 */
export function renderWrittenVaultPdf(input: {
  title: string;
  bodyText: string;
  createdAt: Date;
  author: string | null;
  status: 'DRAFT' | 'PENDING' | 'SHARED' | null;
}): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 72, bottom: 72, left: 72, right: 72 }, // 1-inch margins
    info: {
      Title: input.title,
      Author: input.author ?? 'Echoes',
      Creator: 'Echoes',
      Producer: 'Echoes',
      CreationDate: input.createdAt,
    },
  });

  // ── Title ────────────────────────────────────────────────────────────────
  doc
    .font('Helvetica-Bold')
    .fontSize(28)
    .fillColor('#111111')
    .text(input.title, { align: 'left' });

  // ── Byline: author • date • (status pill for drafts) ─────────────────────
  const dateLabel = input.createdAt.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const bylinePieces: string[] = [];
  if (input.author) bylinePieces.push(input.author);
  bylinePieces.push(dateLabel);
  if (input.status === 'DRAFT') bylinePieces.push('DRAFT');

  doc
    .moveDown(0.5)
    .font('Helvetica')
    .fontSize(11)
    .fillColor('#666666')
    .text(bylinePieces.join('  •  '), { align: 'left' });

  // ── Divider ──────────────────────────────────────────────────────────────
  const dividerY = doc.y + 12;
  doc
    .moveDown(1)
    .strokeColor('#dddddd')
    .lineWidth(0.5)
    .moveTo(72, dividerY)
    .lineTo(doc.page.width - 72, dividerY)
    .stroke();

  // ── Body ─────────────────────────────────────────────────────────────────
  doc
    .moveDown(1.5)
    .font('Helvetica')
    .fontSize(12)
    .fillColor('#222222')
    .text(input.bodyText, {
      align: 'left',
      lineGap: 4,
      paragraphGap: 8,
    });

  doc.end();
  return doc;
}
