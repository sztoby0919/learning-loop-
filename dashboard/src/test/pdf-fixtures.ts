// Synthetic ASCII PDFs: no private documents or additional fixture dependencies.
export function textPdf(texts: string[], encrypted = false, imageOnly = false): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${texts.map((_, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${texts.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  texts.forEach((text, index) => {
    const escaped = text.replace(/([\\()])/g, "\\$1");
    const stream = imageOnly ? "q 400 0 0 400 50 300 cm /Im1 Do Q" : `BT /F1 18 Tf 50 750 Td (${escaped}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> ${imageOnly ? `/XObject << /Im1 ${4 + texts.length * 2} 0 R >>` : ""} >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`,
    );
  });
  if (imageOnly) objects.push("<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\n808080>\nendstream");
  return encodePdfObjects(objects, encrypted);
}

function encodePdfObjects(objects: string[], encrypted = false): Uint8Array {
  const encoder = new TextEncoder();
  // Standard security dictionary forces password handling before page extraction.
  if (encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4 >>`);
  let raw = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(encoder.encode(raw).length);
    raw += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = encoder.encode(raw).length;
  const security = encrypted ? ` /Encrypt ${objects.length} 0 R /ID [<${"00".repeat(16)}> <${"00".repeat(16)}>]` : "";
  raw += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Root 1 0 R /Size ${objects.length + 1}${security} >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(raw);
}

export const imageOnlyPdf = () => textPdf([""], false, true);

export function positionedPdf(items: Array<{ text: string; x: number; y: number; size?: number }>): Uint8Array {
  const stream = items.map(({ text, x, y, size = 12 }) => `BT /F1 ${size} Tf ${x} ${y} Td (${text.replace(/([\\()])/g, "\\$1")}) Tj ET`).join("\n");
  return encodePdfObjects([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`,
  ]);
}
