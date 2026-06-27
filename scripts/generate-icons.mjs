import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const SIZES = [192, 512];

for (const size of SIZES) {
  const png = createPng(size);
  await writeFile(`assets/icon-${size}.png`, png);
}

function createPng(size) {
  const width = size;
  const height = size;
  const pixels = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const rounded = insideRoundedRect(x, y, size, size * 0.18);
      const bg = rounded ? [31, 41, 55, 255] : [0, 0, 0, 0];
      pixels.set(bg, offset);
    }
  }

  drawRing(pixels, width, height, size * 0.5, size * 0.46, size * 0.2, size * 0.075, [
    238, 244, 242, 255
  ]);
  drawCircle(pixels, width, height, size * 0.54, size * 0.46, size * 0.1, [31, 41, 55, 255]);
  drawCircle(pixels, width, height, size * 0.55, size * 0.78, size * 0.075, [134, 239, 172, 255]);

  const rawRows = [];
  for (let y = 0; y < height; y += 1) {
    rawRows.push(Buffer.from([0]));
    rawRows.push(pixels.subarray(y * width * 4, (y + 1) * width * 4));
  }

  const chunks = [
    chunk("IHDR", ihdr(width, height)),
    chunk("IDAT", deflateSync(Buffer.concat(rawRows))),
    chunk("IEND", Buffer.alloc(0))
  ];

  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), ...chunks]);
}

function insideRoundedRect(x, y, size, radius) {
  const left = radius;
  const right = size - radius - 1;
  const top = radius;
  const bottom = size - radius - 1;

  if (x >= left && x <= right) return true;
  if (y >= top && y <= bottom) return true;

  const cx = x < left ? left : right;
  const cy = y < top ? top : bottom;
  return Math.hypot(x - cx, y - cy) <= radius;
}

function drawRing(pixels, width, height, cx, cy, radius, stroke, rgba) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const distance = Math.hypot(x - cx, y - cy);
      const inArc = distance >= radius - stroke && distance <= radius + stroke;
      const openSide = x > cx + radius * 0.22 && y < cy + radius * 0.9;
      if (inArc && !openSide) {
        pixels.set(rgba, (y * width + x) * 4);
      }
    }
  }
}

function drawCircle(pixels, width, height, cx, cy, radius, rgba) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (Math.hypot(x - cx, y - cy) <= radius) {
        pixels.set(rgba, (y * width + x) * 4);
      }
    }
  }
}

function ihdr(width, height) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  return data;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

