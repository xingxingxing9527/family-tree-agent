import type { FileHandle } from "node:fs/promises";

export type SniffedMediaMime = "image/jpeg" | "image/png" | "image/webp" | "audio/mpeg" | "audio/wav" | "audio/mp4" | "audio/ogg";

const MAX_WAV_CHUNKS = 128;
const MAX_OGG_PAGES = 4_096;
const MAX_OGG_BYTES = 256 * 1024 * 1024;
const MAX_OGG_STREAMS = 16;
const MAX_OGG_FIRST_PACKET_BYTES = 64 * 1024;
const MAX_MP4_BOXES = 4_096;
const MAX_MP4_DEPTH = 12;

async function readAt(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) return Buffer.alloc(0);
  const bytes = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const result = await handle.read(bytes, total, length - total, offset + total);
    if (result.bytesRead === 0) break;
    total += result.bytesRead;
  }
  return bytes.subarray(0, total);
}

async function readExactly(handle: FileHandle, offset: number, length: number): Promise<Buffer | null> {
  const bytes = await readAt(handle, offset, length);
  return bytes.length === length ? bytes : null;
}

async function wavFromHandle(handle: FileHandle, size: number): Promise<boolean> {
  const header = await readExactly(handle, 0, 12);
  if (!header || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") return false;
  if (header.readUInt32LE(4) !== size - 8) return false;

  let offset = 12;
  let formatValid = false;
  let dataValid = false;
  let chunkCount = 0;
  while (offset < size) {
    if (++chunkCount > MAX_WAV_CHUNKS || offset + 8 > size) return false;
    const chunk = await readExactly(handle, offset, 8);
    if (!chunk) return false;
    const kind = chunk.toString("ascii", 0, 4);
    const length = chunk.readUInt32LE(4);
    const bodyStart = offset + 8;
    if (length > size - bodyStart) return false;

    if (kind === "fmt ") {
      if (length < 16) return false;
      const fields = await readExactly(handle, bodyStart, 16);
      if (!fields) return false;
      const format = fields.readUInt16LE(0);
      const channels = fields.readUInt16LE(2);
      const sampleRate = fields.readUInt32LE(4);
      const blockAlign = fields.readUInt16LE(12);
      const bitsPerSample = fields.readUInt16LE(14);
      formatValid = (format === 1 || format === 3) && channels > 0 && sampleRate > 0 && blockAlign > 0 && bitsPerSample > 0 && bitsPerSample % 8 === 0;
    } else if (kind === "data") {
      dataValid ||= length > 0;
    }

    const paddedLength = length + (length & 1);
    if (paddedLength > size - bodyStart) return false;
    offset = bodyStart + paddedLength;
  }
  return offset === size && formatValid && dataValid;
}

interface MpegFrame {
  version: 1 | 2 | 2.5;
  layer: 1 | 2 | 3;
  sampleRate: number;
  length: number;
}

const MPEG1_BITRATES: Record<1 | 2 | 3, readonly number[]> = {
  1: [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
};
const MPEG2_BITRATES: Record<1 | 2 | 3, readonly number[]> = {
  1: [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  2: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  3: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
};

function parseMpegFrame(header: Buffer): MpegFrame | null {
  if (header.length !== 4) return null;
  const value = header.readUInt32BE(0);
  if (((value & 0xffe00000) >>> 0) !== 0xffe00000) return null;
  const versionBits = (value >>> 19) & 0x03;
  const layerBits = (value >>> 17) & 0x03;
  const bitrateIndex = (value >>> 12) & 0x0f;
  const sampleRateIndex = (value >>> 10) & 0x03;
  const padding = (value >>> 9) & 0x01;
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null;

  const version: MpegFrame["version"] = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const layer: MpegFrame["layer"] = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;
  const baseSampleRate = [44_100, 48_000, 32_000][sampleRateIndex]!;
  const sampleRate = version === 1 ? baseSampleRate : version === 2 ? baseSampleRate / 2 : baseSampleRate / 4;
  const bitrates = version === 1 ? MPEG1_BITRATES[layer] : MPEG2_BITRATES[layer];
  const bitrate = bitrates[bitrateIndex - 1]! * 1_000;
  const length = layer === 1
    ? Math.floor((12 * bitrate) / sampleRate + padding) * 4
    : Math.floor(((layer === 3 && version !== 1 ? 72 : 144) * bitrate) / sampleRate) + padding;
  if (!Number.isSafeInteger(length) || length < 4) return null;
  return { version, layer, sampleRate, length };
}

async function mp3FromHandle(handle: FileHandle, size: number): Promise<boolean> {
  let offset = 0;
  const initial = await readAt(handle, 0, Math.min(10, size));
  if (initial.length >= 3 && initial.toString("ascii", 0, 3) === "ID3") {
    if (initial.length !== 10) return false;
    const major = initial[3]!;
    const revision = initial[4]!;
    const flags = initial[5]!;
    if (major < 2 || major > 4 || revision === 0xff) return false;
    if (initial.subarray(6, 10).some((value) => (value & 0x80) !== 0)) return false;
    const tagSize = (initial[6]! * 0x20_0000) + (initial[7]! * 0x4000) + (initial[8]! * 0x80) + initial[9]!;
    const footerSize = major === 4 && (flags & 0x10) !== 0 ? 10 : 0;
    offset = 10 + tagSize + footerSize;
    if (!Number.isSafeInteger(offset) || offset > size) return false;
  }

  const first = parseMpegFrame(await readAt(handle, offset, 4));
  if (!first || first.length > size - offset) return false;
  const secondOffset = offset + first.length;
  const second = parseMpegFrame(await readAt(handle, secondOffset, 4));
  if (!second || second.version !== first.version || second.layer !== first.layer || second.sampleRate !== first.sampleRate) return false;
  return second.length <= size - secondOffset;
}

interface OggStreamState {
  nextSequence: number;
  firstPacketParts: Buffer[];
  firstPacketBytes: number;
  classified: boolean;
  packetContinues: boolean;
  ended: boolean;
}

function isOggAudioCodec(packet: Buffer): boolean {
  return packet.length >= 8 && packet.subarray(0, 8).toString("ascii") === "OpusHead"
    || packet.length >= 7 && packet[0] === 1 && packet.subarray(1, 7).toString("ascii") === "vorbis";
}

async function oggFromHandle(handle: FileHandle, size: number): Promise<boolean> {
  if (size <= 0 || size > MAX_OGG_BYTES) return false;
  const streams = new Map<number, OggStreamState>();
  let offset = 0;
  let pageCount = 0;
  while (offset < size) {
    if (++pageCount > MAX_OGG_PAGES || offset + 27 > size) return false;
    const fixed = await readExactly(handle, offset, 27);
    if (!fixed || fixed.toString("ascii", 0, 4) !== "OggS" || fixed[4] !== 0) return false;
    const headerType = fixed[5]!;
    if ((headerType & ~0x07) !== 0) return false;
    const continued = (headerType & 0x01) !== 0;
    const beginning = (headerType & 0x02) !== 0;
    const ending = (headerType & 0x04) !== 0;
    const serial = fixed.readUInt32LE(14);
    const sequence = fixed.readUInt32LE(18);
    const segmentCount = fixed[26]!;
    const lacing = await readExactly(handle, offset + 27, segmentCount);
    if (!lacing) return false;
    const bodyLength = lacing.reduce((total, value) => total + value, 0);
    const bodyOffset = offset + 27 + segmentCount;
    if (bodyLength > size - bodyOffset) return false;
    const body = await readExactly(handle, bodyOffset, bodyLength);
    if (!body) return false;

    let state = streams.get(serial);
    if (!state) {
      if (!beginning || continued || sequence !== 0 || segmentCount === 0 || streams.size >= MAX_OGG_STREAMS) return false;
      state = { nextSequence: 0, firstPacketParts: [], firstPacketBytes: 0, classified: false, packetContinues: false, ended: false };
      streams.set(serial, state);
    } else if (beginning || state.ended) {
      return false;
    }
    if (sequence !== state.nextSequence || continued !== state.packetContinues) return false;

    let bodyCursor = 0;
    for (const segmentLength of lacing) {
      const segment = body.subarray(bodyCursor, bodyCursor + segmentLength);
      bodyCursor += segmentLength;
      if (!state.classified) {
        state.firstPacketBytes += segmentLength;
        if (state.firstPacketBytes > MAX_OGG_FIRST_PACKET_BYTES) return false;
        state.firstPacketParts.push(segment);
      }
      state.packetContinues = segmentLength === 255;
      if (!state.packetContinues && !state.classified) {
        const firstPacket = Buffer.concat(state.firstPacketParts, state.firstPacketBytes);
        if (!isOggAudioCodec(firstPacket)) return false;
        state.classified = true;
        state.firstPacketParts = [];
      }
    }
    if (segmentCount === 0 && continued) return false;
    state.nextSequence = (sequence + 1) >>> 0;
    state.ended = ending;
    offset = bodyOffset + bodyLength;
  }
  return offset === size && streams.size > 0 && [...streams.values()].every((stream) => stream.classified && !stream.packetContinues);
}

interface Mp4ScanState {
  boxes: number;
  hasFtyp: boolean;
  hasMoov: boolean;
  trackHandlers: Map<number, Set<string>>;
}

async function scanMp4Range(
  handle: FileHandle,
  start: number,
  end: number,
  ancestors: readonly string[],
  state: Mp4ScanState,
  trackId?: number
): Promise<boolean> {
  if (ancestors.length > MAX_MP4_DEPTH) return false;
  let offset = start;
  while (offset < end) {
    if (++state.boxes > MAX_MP4_BOXES || end - offset < 8) return false;
    const basic = await readExactly(handle, offset, 8);
    if (!basic) return false;
    const type = basic.toString("ascii", 4, 8);
    let headerSize = 8;
    let boxSize = basic.readUInt32BE(0);
    if (boxSize === 1) {
      const extended = await readExactly(handle, offset + 8, 8);
      if (!extended) return false;
      const largeSize = extended.readBigUInt64BE(0);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      boxSize = Number(largeSize);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = end - offset;
    }
    if (!Number.isSafeInteger(boxSize) || boxSize < headerSize || boxSize > end - offset) return false;
    const boxEnd = offset + boxSize;
    const payloadStart = offset + headerSize;
    const isTopLevel = ancestors.length === 0;

    if (isTopLevel && offset === 0) {
      if (type !== "ftyp" || boxSize < headerSize + 4) return false;
      state.hasFtyp = true;
    }
    if (isTopLevel && type === "moov") {
      state.hasMoov = true;
      if (!await scanMp4Range(handle, payloadStart, boxEnd, ["moov"], state)) return false;
    } else if (ancestors.length === 1 && ancestors[0] === "moov" && type === "trak") {
      const currentTrack = offset;
      state.trackHandlers.set(currentTrack, new Set());
      if (!await scanMp4Range(handle, payloadStart, boxEnd, ["moov", "trak"], state, currentTrack)) return false;
    } else if (ancestors.length === 2 && ancestors[0] === "moov" && ancestors[1] === "trak" && type === "mdia") {
      if (!await scanMp4Range(handle, payloadStart, boxEnd, ["moov", "trak", "mdia"], state, trackId)) return false;
    } else if (ancestors.length === 3 && ancestors[0] === "moov" && ancestors[1] === "trak" && ancestors[2] === "mdia" && type === "hdlr") {
      if (trackId === undefined || boxSize < headerSize + 12) return false;
      const handler = await readExactly(handle, payloadStart + 8, 4);
      if (!handler) return false;
      state.trackHandlers.get(trackId)?.add(handler.toString("ascii"));
    }
    offset = boxEnd;
  }
  return offset === end;
}

async function mp4FromHandle(handle: FileHandle, size: number): Promise<boolean> {
  if (!Number.isSafeInteger(size) || size < 8) return false;
  const state: Mp4ScanState = { boxes: 0, hasFtyp: false, hasMoov: false, trackHandlers: new Map() };
  if (!await scanMp4Range(handle, 0, size, [], state)) return false;
  const tracks = [...state.trackHandlers.values()];
  return state.hasFtyp && state.hasMoov && tracks.some((handlers) => handlers.has("soun")) && !tracks.some((handlers) => handlers.has("vide"));
}

export async function sniffMediaHandle(handle: FileHandle, header: Buffer, size: number): Promise<SniffedMediaMime | null> {
  if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (await wavFromHandle(handle, size)) return "audio/wav";
  if (await mp3FromHandle(handle, size)) return "audio/mpeg";
  if (await oggFromHandle(handle, size)) return "audio/ogg";
  if (await mp4FromHandle(handle, size)) return "audio/mp4";
  return null;
}
