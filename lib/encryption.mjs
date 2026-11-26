import { createHash, createPublicKey, verify } from 'node:crypto';

const prefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
function decode(value, min, max = min) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length >= min && bytes.length <= max && bytes.toString('base64') === value ? bytes : null;
}
function publicKey(value) {
  const bytes = decode(value, 65);
  if (!bytes || bytes[0] !== 4) throw Error('Invalid public key.');
  return createPublicKey({ key: Buffer.concat([prefix, bytes]), format: 'der', type: 'spki' });
}
export function validRoomKey(room, deviceId, record) {
  try {
    const identity = decode(record.identity, 65);
    const signature = decode(record.signature, 8, 80);
    if (!identity || !signature || createHash('sha256').update(identity).digest('hex') !== deviceId) return false;
    publicKey(record.key);
    return verify('sha256', Buffer.from(JSON.stringify(['qzu-room-key-v1', room, record.key])), publicKey(record.identity), signature);
  } catch { return false; }
}
export function validEnvelope(value, limit = 8016) {
  return value && typeof value === 'object' && Object.keys(value).length === 3 && value.v === 2 && Boolean(decode(value.iv, 12)) && Boolean(decode(value.data, 17, limit));
}
