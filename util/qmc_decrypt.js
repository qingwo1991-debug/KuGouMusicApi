/**
 * QMC Decryptor for .mgg, .mgg0, .mgg1, .mggl, .mflac, .mflac0, etc.
 * Ported from unlock-music-web src/decrypt/qmc.ts
 */

const { QmcMapCipher, QmcRC4Cipher, QmcStaticCipher } = require('./qmc_cipher');
const { QmcDeriveKey } = require('./qmc_key');

const BYTE_COMMA = ','.charCodeAt(0);

// Handler map for QMC file types
const HandlerMap = {
  mgg: { ext: 'ogg', version: 2 },
  mgg0: { ext: 'ogg', version: 2 },
  mggl: { ext: 'ogg', version: 2 },
  mgg1: { ext: 'ogg', version: 2 },
  mflac: { ext: 'flac', version: 2 },
  mflac0: { ext: 'flac', version: 2 },
  mmp4: { ext: 'mmp4', version: 2 },
  qmcflac: { ext: 'flac', version: 2 },
  qmcogg: { ext: 'ogg', version: 2 },
  qmc0: { ext: 'mp3', version: 2 },
  qmc2: { ext: 'ogg', version: 2 },
  qmc3: { ext: 'mp3', version: 2 },
  bkcmp3: { ext: 'mp3', version: 1 },
  bkcflac: { ext: 'flac', version: 1 },
  tkm: { ext: 'm4a', version: 1 },
  '666c6163': { ext: 'flac', version: 1 },
  '6d7033': { ext: 'mp3', version: 1 },
  '6f6767': { ext: 'ogg', version: 1 },
  '6d3461': { ext: 'm4a', version: 1 },
  '776176': { ext: 'wav', version: 1 },
};

// Audio format headers for detection
const FLAC_HEADER = [0x66, 0x4c, 0x61, 0x43];
const MP3_HEADER = [0x49, 0x44, 0x33];
const OGG_HEADER = [0x4f, 0x67, 0x67, 0x53];
const M4A_HEADER = [0x66, 0x74, 0x79, 0x70];
const WAV_HEADER = [0x52, 0x49, 0x46, 0x46];
const AAC_HEADER = [0xff, 0xf1];

function bytesHasPrefix(data, prefix) {
  if (prefix.length > data.length) return false;
  return prefix.every((val, idx) => val === data[idx]);
}

function sniffAudioExt(data, fallbackExt = 'mp3') {
  if (bytesHasPrefix(data, MP3_HEADER)) return 'mp3';
  if (bytesHasPrefix(data, FLAC_HEADER)) return 'flac';
  if (bytesHasPrefix(data, OGG_HEADER)) return 'ogg';
  if (data.length >= 4 + M4A_HEADER.length && bytesHasPrefix(data.slice(4), M4A_HEADER)) return 'm4a';
  if (bytesHasPrefix(data, WAV_HEADER)) return 'wav';
  if (bytesHasPrefix(data, AAC_HEADER)) return 'aac';
  return fallbackExt;
}

function getMimeType(ext) {
  const mimeTypes = {
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    wav: 'audio/x-wav',
    aac: 'audio/aac',
  };
  return mimeTypes[ext] || 'audio/mpeg';
}

class QmcDecoder {
  constructor(file) {
    this.file = file;
    this.size = file.length;
    this.decoded = false;
    this.audioSize = undefined;
    this.cipher = undefined;
    this._songID = undefined;
    this.searchKey();
  }

  get songID() {
    return this._songID;
  }

  decrypt() {
    if (!this.cipher) {
      throw new Error('no cipher found');
    }
    if (!this.audioSize || this.audioSize <= 0) {
      throw new Error('invalid audio size');
    }
    const audioBuf = this.file.subarray(0, this.audioSize);

    if (!this.decoded) {
      this.cipher.decrypt(audioBuf, 0);
      this.decoded = true;
    }

    return audioBuf;
  }

  searchKey() {
    const last4Byte = this.file.slice(-4);
    const textDec = new TextDecoder();

    if (textDec.decode(last4Byte) === 'QTag') {
      const sizeBuf = this.file.slice(-8, -4);
      const sizeView = new DataView(sizeBuf.buffer, sizeBuf.byteOffset);
      const keySize = sizeView.getUint32(0, false);
      this.audioSize = this.size - keySize - 8;

      const rawKey = this.file.subarray(this.audioSize, this.size - 8);
      const keyEnd = rawKey.findIndex((v) => v === BYTE_COMMA);
      if (keyEnd < 0) {
        throw new Error('invalid key: search raw key failed');
      }
      this.setCipher(rawKey.subarray(0, keyEnd));

      const idBuf = rawKey.subarray(keyEnd + 1);
      const idEnd = idBuf.findIndex((v) => v === BYTE_COMMA);
      if (idEnd < 0) {
        throw new Error('invalid key: search song id failed');
      }
      this._songID = parseInt(textDec.decode(idBuf.subarray(0, idEnd)), 10);
    } else {
      const sizeView = new DataView(last4Byte.buffer, last4Byte.byteOffset);
      const keySize = sizeView.getUint32(0, true);
      if (keySize < 0x400) {
        this.audioSize = this.size - keySize - 4;
        const rawKey = this.file.subarray(this.audioSize, this.size - 4);
        this.setCipher(rawKey);
      } else {
        this.audioSize = this.size;
        this.cipher = new QmcStaticCipher();
      }
    }
  }

  setCipher(keyRaw) {
    const keyDec = QmcDeriveKey(keyRaw);
    if (keyDec.length > 300) {
      this.cipher = new QmcRC4Cipher(keyDec);
    } else {
      this.cipher = new QmcMapCipher(keyDec);
    }
  }
}

/**
 * Decrypt a QMC-encrypted file buffer
 * @param {Buffer|Uint8Array} fileBuffer - The encrypted file data
 * @param {string} rawExt - The file extension (mgg, mflac, etc.)
 * @returns {{data: Buffer, ext: string, mime: string, songID?: number}}
 */
function decryptQmcFile(fileBuffer, rawExt) {
  if (!(rawExt in HandlerMap)) {
    throw new Error(`Qmc cannot handle type: ${rawExt}`);
  }

  const handler = HandlerMap[rawExt];
  const file = fileBuffer instanceof Buffer ? new Uint8Array(fileBuffer) : fileBuffer;

  const decoder = new QmcDecoder(file);
  const musicDecoded = decoder.decrypt();

  // Detect actual audio format from decrypted data
  const detectedExt = sniffAudioExt(musicDecoded, handler.ext);
  const mime = getMimeType(detectedExt);

  return {
    data: Buffer.from(musicDecoded),
    ext: detectedExt,
    mime,
    songID: decoder.songID,
  };
}

module.exports = { decryptQmcFile, QmcDecoder, HandlerMap };
