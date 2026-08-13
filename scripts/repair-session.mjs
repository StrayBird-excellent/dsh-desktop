// 会话日志修复工具（只读分析 + 生成修复产物，不修改原文件）
// 用法：node scripts/repair-session.mjs <输入 .jsonl.zstd> <输出 .jsonl.zstd>
//
// 原理：dsh 的会话日志是「校验头帧 + 若干追加帧」的 zstd 级联流，每条记录解码为
// 一个或多个带 seq 的事件，seq 必须从 0 稠密递增。两个进程同时写同一会话会产生
// 重复 seq 区域（回退跳变）。修复 = 按文件顺序保留每个 seq 的首次出现，丢弃重复，
// 再用 dsh 自身的 packChunkRuns 重编码，头帧原样保留。

import { readFileSync, writeFileSync } from 'node:fs';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { decodeStorageRecord, packChunkRuns } from '@deepseek-ai/dsh-session';

const ZSTD_MAGIC = 4247762216; // 0xFD2FB528 LE

// ---- 与 dsh 一致的帧扫描（来自 dsh-session-persistence-jsonl/zstd.js）----
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

function decompressPrefix(buf) {
  // 模拟 dsh 对不完整尾帧的恢复：ZSTD_e_flush 模式
  return zstdDecompressSync(buf, { finishFlush: constants.ZSTD_e_flush });
}

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('用法: node scripts/repair-session.mjs <input> <output>');
  process.exit(2);
}

const buffer = readFileSync(inputPath);
const { frames, tornStart } = scanZstdFrames(buffer);
console.log(`帧数: ${frames.length}${tornStart !== undefined ? ' + 1 个不完整尾帧' : ''}, 文件 ${buffer.length} 字节`);

if (frames.length === 0) throw new Error('empty or header-less session log');

// 帧 0 = 头帧（原样保留其字节）
const headerFrameBytes = buffer.subarray(frames[0].start, frames[0].end);
const headerPlain = zstdDecompressSync(headerFrameBytes).toString('utf8');
const headerLine = headerPlain.split('\n', 1)[0];
console.log(`头帧内容: ${headerLine.slice(0, 120)}...`);

// 其余帧解码为事件
const events = [];
const rowLog = [];
for (let i = 1; i < frames.length; i++) {
  const plain = zstdDecompressSync(buffer.subarray(frames[i].start, frames[i].end)).toString('utf8');
  for (const line of plain.split('\n')) {
    if (line === '') continue;
    let decoded;
    try {
      decoded = decodeStorageRecord(JSON.parse(line));
    } catch (err) {
      rowLog.push({ kind: 'unparsable', line });
      continue;
    }
    rowLog.push({ kind: 'row', events: decoded });
    for (const ev of decoded) events.push(ev);
  }
}
if (tornStart !== undefined) {
  const recovered = decompressPrefix(buffer.subarray(tornStart)).toString('utf8');
  for (const line of recovered.split('\n')) {
    if (line === '') continue;
    let decoded;
    try {
      decoded = decodeStorageRecord(JSON.parse(line));
    } catch {
      rowLog.push({ kind: 'unparsable-torn', line });
      continue;
    }
    rowLog.push({ kind: 'row', events: decoded });
    for (const ev of decoded) events.push(ev);
  }
}

console.log(`解码事件总数: ${events.length}`);

// 去重：保留每个 seq 的首次出现（要求 seq === 已保留数量）
const kept = [];
let dropped = 0;
let firstGap = undefined;
let dupRuns = [];
let runStart = undefined;
for (const ev of events) {
  const seq = typeof ev?.seq === 'number' ? ev.seq : undefined;
  if (seq === undefined) {
    // 无 seq 的记录：保留（不动它），但会导致后续错位 —— 记录并保留原样
    kept.push(ev);
    continue;
  }
  if (seq === kept.length) {
    kept.push(ev);
    if (runStart !== undefined) {
      dupRuns.push({ from: runStart, to: seq - 1, count: seq - runStart });
      runStart = undefined;
    }
  } else if (seq < kept.length) {
    dropped += 1;
    if (runStart === undefined) runStart = seq;
  } else {
    if (firstGap === undefined) firstGap = { at: kept.length, got: seq };
    break; // 前向空洞无法伪造，到此为止
  }
}
if (runStart !== undefined) dupRuns.push({ from: runStart, to: undefined, count: '到文件尾' });

console.log(`保留事件: ${kept.length}, 丢弃重复: ${dropped}`);
if (dupRuns.length > 0) console.log(`重复区域: ${dupRuns.map((r) => `seq ${r.from}-${r.to} (${r.count}个)`).join('; ')}`);
if (firstGap) console.log(`⚠ 前向空洞: 期望 ${firstGap.at} 但遇到 ${firstGap.got}，空洞之后的内容被截断！`);
if (dropped === 0 && firstGap === undefined) {
  console.log('未发现损坏（seq 全稠密），无需修复');
  process.exit(0);
}

// 重编码：packChunkRuns 打包 chunk 事件
const rows = packChunkRuns(kept);
const dataText = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

// 校验往返：重编码后每行解码的事件数与 seq 稠密性
let checkIdx = 0;
for (const line of dataText.split('\n')) {
  if (line === '') continue;
  for (const ev of decodeStorageRecord(JSON.parse(line))) {
    if (ev.seq !== checkIdx) throw new Error(`往返校验失败: 期望 seq ${checkIdx}, 得到 ${ev.seq}`);
    checkIdx += 1;
  }
}
if (checkIdx !== kept.length) throw new Error(`往返校验失败: 事件数 ${checkIdx} != ${kept.length}`);
console.log('往返校验通过');

// 压缩写出：头帧原样 + 数据按 256KB 分帧（每帧带校验和）
const CHUNK = 256 * 1024;
const outParts = [headerFrameBytes];
for (let off = 0; off < dataText.length; off += CHUNK) {
  const chunk = Buffer.from(dataText.slice(off, off + CHUNK), 'utf8');
  outParts.push(zstdCompressSync(chunk, { params: { [constants.ZSTD_c_checksumFlag]: 1 } }));
}
writeFileSync(outputPath, Buffer.concat(outParts));
console.log(`已写出修复文件: ${outputPath} (${Buffer.concat(outParts).length} 字节)`);
