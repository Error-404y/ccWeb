import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function chunk(type, data) {
  const name = Buffer.from(type);
  const bytes = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  bytes.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

const vertices = [[5,5],[85,44],[85,64],[5,105],[5,80],[55,54],[5,30]];

function inside(x, y) {
  if (x >= 87 && x <= 167 && y >= 86 && y <= 105) return true;
  if (x < 5 || x > 85 || y < 5 || y > 105) return false;
  let hit = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const [ax, ay] = vertices[i], [bx, by] = vertices[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) hit = !hit;
  }
  return hit;
}

export function renderIcon(size, adaptive = false) {
  if (!Number.isInteger(size) || size < 16 || size > 4096) throw new Error('Invalid icon size.');
  const channels = adaptive ? 4 : 3;
  const stride = size * channels + 1;
  const raw = Buffer.alloc(stride * size);
  const scale = size * (adaptive ? .49 : .60) / 162;
  const originX = size / 2 - 86 * scale;
  const originY = size / 2 - 55 * scale;
  const left = Math.max(0, Math.floor(originX + 5 * scale));
  const right = Math.min(size, Math.ceil(originX + 167 * scale));
  const top = Math.max(0, Math.floor(originY + 5 * scale));
  const bottom = Math.min(size, Math.ceil(originY + 105 * scale));
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      let samples = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          if (inside((x + (sx + .5) / 4 - originX) / scale, (y + (sy + .5) / 4 - originY) / scale)) samples++;
        }
      }
      if (!samples) continue;
      const p = y * stride + 1 + x * channels;
      const coverage = samples / 16;
      raw[p] = adaptive ? 230 : Math.round(230 * coverage);
      raw[p + 1] = adaptive ? 24 : Math.round(24 * coverage);
      raw[p + 2] = adaptive ? 32 : Math.round(32 * coverage);
      if (adaptive) raw[p + 3] = Math.round(255 * coverage);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = adaptive ? 6 : 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export function iconPng(path, size, adaptive = false) {
  writeFileSync(path, renderIcon(size, adaptive));
}
