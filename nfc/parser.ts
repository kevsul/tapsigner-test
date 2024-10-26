import CBOR from '@ellipticoin/cbor';

/**
 * cards consume and send cbor encoded data
 * @param  {object} obj
 */
export const cborEncode = (obj: object) => {
  const data = CBOR.encode(obj);
  return data;
  // const parsed = data.toJSON().data;
  // return [0x00, 0xcb, 0x00, 0x00, parsed.length].concat(parsed); // transceive data format: CLA, INS, P1, P2, Data Len, Data (bytes array)
};

export const decodeAndSplitResponse = (r: number[]) => {
  return {
    response: CBOR.decode(Buffer.from(r)),
    status: bytesToHex(Buffer.from(r.slice(r.length - 2))),
  };
};

/**
 * Convert a byte array or Buffer to a hex string
 * @param  {Buffer} bytes
 */
export const bytesToHex = (bytes: Buffer) => {
  try {
    let hex, i;
    for (hex = [], i = 0; i < bytes.length; i++) {
      const current = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
      hex.push((current >>> 4).toString(16));
      hex.push((current & 0xf).toString(16));
    }
    return hex.join('');
  } catch (e) {
    console.log(e);
  }
};
