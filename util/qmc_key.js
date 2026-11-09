/**
 * QMC Key derivation implementation
 * Ported from unlock-music-web src/decrypt/qmc_key.ts
 */

const { TeaCipher } = require('./tea');

const SALT_LEN = 2;
const ZERO_LEN = 7;

function QmcDeriveKey(raw) {
  const rawDec = Buffer.from(raw.toString('ascii'), 'base64');
  let n = rawDec.length;
  if (n < 16) {
    throw Error('key length is too short');
  }

  const processedKey = decryptV2Key(rawDec);

  const simpleKey = simpleMakeKey(106, 8);
  let teaKey = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    teaKey[i << 1] = simpleKey[i];
    teaKey[(i << 1) + 1] = processedKey[i];
  }
  const sub = decryptTencentTea(processedKey.subarray(8), teaKey);
  processedKey.set(sub, 8);
  return processedKey.subarray(0, 8 + sub.length);
}

function simpleMakeKey(salt, length) {
  const keyBuf = [];
  for (let i = 0; i < length; i++) {
    const tmp = Math.tan(salt + i * 0.1);
    keyBuf[i] = 0xff & (Math.abs(tmp) * 100.0);
  }
  return keyBuf;
}

const mixKey1 = new Uint8Array([0x33, 0x38, 0x36, 0x5A, 0x4A, 0x59, 0x21, 0x40, 0x23, 0x2A, 0x24, 0x25, 0x5E, 0x26, 0x29, 0x28]);
const mixKey2 = new Uint8Array([0x2A, 0x2A, 0x23, 0x21, 0x28, 0x23, 0x24, 0x25, 0x26, 0x5E, 0x61, 0x31, 0x63, 0x5A, 0x2C, 0x54]);

function decryptV2Key(key) {
  if (key.length < 18 || key.slice(0, 18).toString('ascii') !== 'QQMusic EncV2,Key:') {
    return key;
  }

  let out = decryptTencentTea(key.slice(18), mixKey1);
  out = decryptTencentTea(out, mixKey2);
  const keyDec = Buffer.from(out.toString('ascii'), 'base64');
  let n = keyDec.length;
  if (n < 16) {
    throw Error('EncV2 key Decode failed');
  }

  return keyDec;
}

function decryptTencentTea(inBuf, key) {
  if (inBuf.length % 8 !== 0) {
    throw Error('inBuf size not a multiple of the block size');
  }
  if (inBuf.length < 16) {
    throw Error('inBuf size too small');
  }

  const blk = new TeaCipher(key, 32);

  const tmpBuf = new Uint8Array(8);
  const tmpView = new DataView(tmpBuf.buffer);

  blk.decryptBlock(tmpView, new DataView(inBuf.buffer, inBuf.byteOffset, 8));

  const nPadLen = tmpBuf[0] & 0x7;
  const outLen = inBuf.length - 1 - nPadLen - SALT_LEN - ZERO_LEN;
  const outBuf = new Uint8Array(outLen);

  let ivPrev = new Uint8Array(8);
  let ivCur = inBuf.slice(0, 8);
  let inBufPos = 8;

  let tmpIdx = 1 + nPadLen;

  const cryptBlock = () => {
    ivPrev = ivCur;
    ivCur = inBuf.slice(inBufPos, inBufPos + 8);
    for (let j = 0; j < 8; j++) {
      tmpBuf[j] ^= ivCur[j];
    }
    blk.decryptBlock(tmpView, tmpView);
    inBufPos += 8;
    tmpIdx = 0;
  };

  for (let i = 1; i <= SALT_LEN;) {
    if (tmpIdx < 8) {
      tmpIdx++;
      i++;
    } else {
      cryptBlock();
    }
  }

  let outBufPos = 0;
  while (outBufPos < outLen) {
    if (tmpIdx < 8) {
      outBuf[outBufPos] = tmpBuf[tmpIdx] ^ ivPrev[tmpIdx];
      outBufPos++;
      tmpIdx++;
    } else {
      cryptBlock();
    }
  }

  for (let i = 1; i <= ZERO_LEN; i++) {
    if (tmpBuf[tmpIdx] !== ivPrev[tmpIdx]) {
      throw Error('zero check failed');
    }
  }
  return outBuf;
}

module.exports = { QmcDeriveKey, simpleMakeKey };
