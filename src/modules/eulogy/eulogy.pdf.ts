import PDFDocument from 'pdfkit';

/**
 * Render a Eulogy draft to a PDF stream. Mirrors vault.pdf.ts's
 * renderWrittenVaultPdf almost exactly (same layout/fonts/margins) — no
 * status pill here, since Eulogy has no draft/shared lifecycle equivalent.
 *
 * The returned PDFDocument IS a Node Readable — the caller can `.pipe(res)`
 * directly. `.end()` is called here so the stream fully finalizes as read.
 */
export function renderEulogyPdf(input: {
  title: string; // deceasedName, or 'Eulogy' as a fallback for older rows
  bodyText: string;
  createdAt: Date;
  author: string | null;
}): PDFKit.PDFDocument {
  const heading = input.title === 'Eulogy' ? 'Eulogy' : `Eulogy for ${input.title}`;

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 72, bottom: 72, left: 72, right: 72 },
    info: {
      Title: heading,
      Author: input.author ?? 'Echoes',
      Creator: 'Echoes',
      Producer: 'Echoes',
      CreationDate: input.createdAt,
    },
  });

  doc
    .font('Helvetica-Bold')
    .fontSize(28)
    .fillColor('#111111')
    .text(heading, { align: 'left' });

  const dateLabel = input.createdAt.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const bylinePieces: string[] = [];
  if (input.author) bylinePieces.push(input.author);
  bylinePieces.push(dateLabel);

  doc
    .moveDown(0.5)
    .font('Helvetica')
    .fontSize(11)
    .fillColor('#666666')
    .text(bylinePieces.join('  •  '), { align: 'left' });

  const dividerY = doc.y + 12;
  doc
    .moveDown(1)
    .strokeColor('#dddddd')
    .lineWidth(0.5)
    .moveTo(72, dividerY)
    .lineTo(doc.page.width - 72, dividerY)
    .stroke();

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
