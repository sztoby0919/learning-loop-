/** Small STORE-only ZIP encoder for adversarial fixtures; not a production decoder. */
export function rawZip(entries: Array<{ path: string; text: string }>): Uint8Array {
  const join = (chunks: Uint8Array[]) => { const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0)); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result; };
  const header = (size: number) => { const bytes = new Uint8Array(size); const view = new DataView(bytes.buffer); return { bytes, u16: (offset: number, value: number) => view.setUint16(offset, value, true), u32: (offset: number, value: number) => view.setUint32(offset, value, true) }; };
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = []; const central: Uint8Array[] = []; let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.path); const bytes = encoder.encode(entry.text);
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = header(30); local.u32(0, 0x04034b50); local.u16(4, 20); local.u16(6, 0x800); local.u32(14, crc); local.u32(18, bytes.length); local.u32(22, bytes.length); local.u16(26, name.length);
    locals.push(local.bytes, name, bytes);
    const record = header(46); record.u32(0, 0x02014b50); record.u16(4, 20); record.u16(6, 20); record.u16(8, 0x800); record.u32(16, crc); record.u32(20, bytes.length); record.u32(24, bytes.length); record.u16(28, name.length); record.u32(42, offset);
    central.push(record.bytes, name); offset += local.bytes.length + name.length + bytes.length;
  }
  const records = join(central); const end = header(22); end.u32(0, 0x06054b50); end.u16(8, entries.length); end.u16(10, entries.length); end.u32(12, records.length); end.u32(16, offset);
  return join([...locals, records, end.bytes]);
}
