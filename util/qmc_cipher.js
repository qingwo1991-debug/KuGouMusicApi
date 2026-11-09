/**
 * QMC Cipher implementations (Static, Map, RC4)
 * Ported from unlock-music-web src/decrypt/qmc_cipher.ts
 */

class QmcStaticCipher {
  // prettier-ignore
  static get staticCipherBox() {
    return new Uint8Array([
      0x77, 0x48, 0x32, 0x73, 0xDE, 0xF2, 0xC0, 0xC8,
      0x95, 0xEC, 0x30, 0xB2, 0x51, 0xC3, 0xE1, 0xA0,
      0x9E, 0xE6, 0x9D, 0xCF, 0xFA, 0x7F, 0x14, 0xD1,
      0xCE, 0xB8, 0xDC, 0xC3, 0x4A, 0x67, 0x93, 0xD6,
      0x28, 0xC2, 0x91, 0x70, 0xCA, 0x8D, 0xA2, 0xA4,
      0xF0, 0x08, 0x61, 0x90, 0x7E, 0x6F, 0xA2, 0xE0,
      0xEB, 0xAE, 0x3E, 0xB6, 0x67, 0xC7, 0x92, 0xF4,
      0x91, 0xB5, 0xF6, 0x6C, 0x5E, 0x84, 0x40, 0xF7,
      0xF3, 0x1B, 0x02, 0x7F, 0xD5, 0xAB, 0x41, 0x89,
      0x28, 0xF4, 0x25, 0xCC, 0x52, 0x11, 0xAD, 0x43,
      0x68, 0xA6, 0x41, 0x8B, 0x84, 0xB5, 0xFF, 0x2C,
      0x92, 0x4A, 0x26, 0xD8, 0x47, 0x6A, 0x7C, 0x95,
      0x61, 0xCC, 0xE6, 0xCB, 0xBB, 0x3F, 0x47, 0x58,
      0x89, 0x75, 0xC3, 0x75, 0xA1, 0xD9, 0xAF, 0xCC,
      0x08, 0x73, 0x17, 0xDC, 0xAA, 0x9A, 0xA2, 0x16,
      0x41, 0xD8, 0xA2, 0x06, 0xC6, 0x8B, 0xFC, 0x66,
      0x34, 0x9F, 0xCF, 0x18, 0x23, 0xA0, 0x0A, 0x74,
      0xE7, 0x2B, 0x27, 0x70, 0x92, 0xE9, 0xAF, 0x37,
      0xE6, 0x8C, 0xA7, 0xBC, 0x62, 0x65, 0x9C, 0xC2,
      0x08, 0xC9, 0x88, 0xB3, 0xF3, 0x43, 0xAC, 0x74,
      0x2C, 0x0F, 0xD4, 0xAF, 0xA1, 0xC3, 0x01, 0x64,
      0x95, 0x4E, 0x48, 0x9F, 0xF4, 0x35, 0x78, 0x95,
      0x7A, 0x39, 0xD6, 0x6A, 0xA0, 0x6D, 0x40, 0xE8,
      0x4F, 0xA8, 0xEF, 0x11, 0x1D, 0xF3, 0x1B, 0x3F,
      0x3F, 0x07, 0xDD, 0x6F, 0x5B, 0x19, 0x30, 0x19,
      0xFB, 0xEF, 0x0E, 0x37, 0xF0, 0x0E, 0xCD, 0x16,
      0x49, 0xFE, 0x53, 0x47, 0x13, 0x1A, 0xBD, 0xA4,
      0xF1, 0x40, 0x19, 0x60, 0x0E, 0xED, 0x68, 0x09,
      0x06, 0x5F, 0x4D, 0xCF, 0x3D, 0x1A, 0xFE, 0x20,
      0x77, 0xE4, 0xD9, 0xDA, 0xF9, 0xA4, 0x2B, 0x76,
      0x1C, 0x71, 0xDB, 0x00, 0xBC, 0xFD, 0x0C, 0x6C,
      0xA5, 0x47, 0xF7, 0xF6, 0x00, 0x79, 0x4A, 0x11,
    ]);
  }

  getMask(offset) {
    if (offset > 0x7fff) offset %= 0x7fff;
    return QmcStaticCipher.staticCipherBox[(offset * offset + 27) & 0xff];
  }

  decrypt(buf, offset) {
    for (let i = 0; i < buf.length; i++) {
      buf[i] ^= this.getMask(offset + i);
    }
  }
}

class QmcMapCipher {
  constructor(key) {
    if (key.length === 0) throw Error('qmc/cipher_map: invalid key size');
    this.key = key;
    this.n = key.length;
  }

  static rotate(value, bits) {
    const rotate = (bits + 4) % 8;
    const left = (value << rotate) & 0xff;
    const right = (value >>> rotate) & 0xff;
    return (left | right) & 0xff;
  }

  decrypt(buf, offset) {
    for (let i = 0; i < buf.length; i++) {
      buf[i] ^= this.getMask(offset + i);
    }
  }

  getMask(offset) {
    if (offset > 0x7fff) offset %= 0x7fff;
    const idx = (offset * offset + 71214) % this.n;
    return QmcMapCipher.rotate(this.key[idx], idx & 0x7);
  }
}

class QmcRC4Cipher {
  constructor(key) {
    if (key.length === 0) throw Error('invalid key size');

    this.key = key;
    this.N = key.length;
    this.S = new Uint8Array(this.N);
    for (let i = 0; i < this.N; ++i) {
      this.S[i] = i & 0xff;
    }
    let j = 0;
    for (let i = 0; i < this.N; ++i) {
      j = (this.S[i] + j + this.key[i % this.N]) % this.N;
      [this.S[i], this.S[j]] = [this.S[j], this.S[i]];
    }

    this.hash = 1;
    for (let i = 0; i < this.N; i++) {
      const value = this.key[i];
      if (!value) continue;
      const next_hash = (this.hash * value) >>> 0;
      if (next_hash === 0 || next_hash <= this.hash) break;
      this.hash = next_hash;
    }
  }

  decrypt(buf, offset) {
    let toProcess = buf.length;
    let processed = 0;

    if (offset < QmcRC4Cipher.FIRST_SEGMENT_SIZE) {
      const len_segment = Math.min(buf.length, QmcRC4Cipher.FIRST_SEGMENT_SIZE - offset);
      this.encFirstSegment(buf.subarray(0, len_segment), offset);
      toProcess -= len_segment;
      processed += len_segment;
      offset += len_segment;
      if (toProcess === 0) return;
    }

    if (offset % QmcRC4Cipher.SEGMENT_SIZE !== 0) {
      const len_segment = Math.min(QmcRC4Cipher.SEGMENT_SIZE - (offset % QmcRC4Cipher.SEGMENT_SIZE), toProcess);
      this.encASegment(buf.subarray(processed, processed + len_segment), offset);
      toProcess -= len_segment;
      processed += len_segment;
      offset += len_segment;
      if (toProcess === 0) return;
    }

    while (toProcess > QmcRC4Cipher.SEGMENT_SIZE) {
      this.encASegment(buf.subarray(processed, processed + QmcRC4Cipher.SEGMENT_SIZE), offset);
      toProcess -= QmcRC4Cipher.SEGMENT_SIZE;
      processed += QmcRC4Cipher.SEGMENT_SIZE;
      offset += QmcRC4Cipher.SEGMENT_SIZE;
    }

    if (toProcess > 0) {
      this.encASegment(buf.subarray(processed), offset);
    }
  }

  encFirstSegment(buf, offset) {
    for (let i = 0; i < buf.length; i++) {
      buf[i] ^= this.key[this.getSegmentKey(offset + i)];
    }
  }

  encASegment(buf, offset) {
    const S = this.S.slice(0);
    const skipLen = (offset % QmcRC4Cipher.SEGMENT_SIZE) + this.getSegmentKey(Math.floor(offset / QmcRC4Cipher.SEGMENT_SIZE));

    let j = 0;
    let k = 0;
    for (let i = -skipLen; i < buf.length; i++) {
      j = (j + 1) % this.N;
      k = (S[j] + k) % this.N;
      [S[k], S[j]] = [S[j], S[k]];
      if (i >= 0) {
        buf[i] ^= S[(S[j] + S[k]) % this.N];
      }
    }
  }

  getSegmentKey(id) {
    const seed = this.key[id % this.N];
    const idx = Math.floor((this.hash / ((id + 1) * seed)) * 100.0);
    return idx % this.N;
  }
}

QmcRC4Cipher.FIRST_SEGMENT_SIZE = 0x80;
QmcRC4Cipher.SEGMENT_SIZE = 5120;

module.exports = { QmcStaticCipher, QmcMapCipher, QmcRC4Cipher };
