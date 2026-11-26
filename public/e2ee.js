(() => {
  const bytes = value => new TextEncoder().encode(value);
  const b64 = value => {
    const data = new Uint8Array(value);
    let result = '';
    for (let i = 0; i < data.length; i += 16384) result += String.fromCharCode(...data.subarray(i, i + 16384));
    return btoa(result);
  };
  const un64 = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
  const hex = value => Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('');
  const tuple = (...values) => bytes(JSON.stringify(values));
  function derToRaw(value) {
    const der = un64(value), raw = new Uint8Array(64);
    if (der[0] !== 48 || der[1] !== der.length - 2) throw Error('Invalid signature.');
    let offset = 2;
    for (let i = 0; i < 2; i++) {
      if (der[offset++] !== 2) throw Error('Invalid signature.');
      const size = der[offset++];
      if (!size || size > 33 || offset + size > der.length || der[offset] & 128) throw Error('Invalid signature.');
      const skip = size > 1 && der[offset] === 0 ? 1 : 0;
      if (size - skip > 32) throw Error('Invalid signature.');
      raw.set(der.slice(offset + skip, offset + size), i * 32 + 32 - size + skip);
      offset += size;
    }
    if (offset !== der.length) throw Error('Invalid signature.');
    return raw;
  }
  async function generate(room, sign) {
    const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const key = b64(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey));
    const signed = await sign(JSON.stringify(['qzu-room-key-v1', room, key]));
    return { privateKey: pair.privateKey, record: { key, identity: signed.publicKey, signature: signed.signature } };
  }
  async function verifyRecord(room, record) {
    const subtle = globalThis.crypto.subtle;
    const identity = await subtle.importKey('raw', un64(record.identity), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, identity, derToRaw(record.signature), tuple('qzu-room-key-v1', room, record.key))) throw Error('Invalid signed encryption key.');
    return subtle.importKey('raw', un64(record.key), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  }
  async function establish(room, local, own, peer) {
    if (own.key !== local.record.key || own.identity !== local.record.identity || own.signature !== local.record.signature || peer.identity === own.identity || peer.key === own.key) throw Error('Encryption identity changed.');
    const subtle = globalThis.crypto.subtle;
    await verifyRecord(room, own);
    const peerPublic = await verifyRecord(room, peer);
    const participants = [JSON.stringify([own.identity, own.key]), JSON.stringify([peer.identity, peer.key])].sort();
    const digest = await subtle.digest('SHA-256', tuple('qzu-safety-v1', room, ...participants));
    const code = hex(digest).toUpperCase();
    const secret = await subtle.deriveBits({ name: 'ECDH', public: peerPublic }, local.privateKey, 256);
    const material = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    new Uint8Array(secret).fill(0);
    return { code, material, salt: digest, room, own: own.identity, peer: peer.identity };
  }
  const aad = (context, sender, kind) => tuple('qzu-message-v2', context.room, context.code, sender, kind);
  async function messageKey(context, sender, kind, iv, usage) {
    return globalThis.crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: context.salt, info: tuple('qzu-message-key-v2', context.room, sender, kind, b64(iv)) }, context.material, { name: 'AES-GCM', length: 256 }, false, [usage]);
  }
  async function seal(context, clear, kind) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const key = await messageKey(context, context.own, kind, iv, 'encrypt');
    const data = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(context, context.own, kind), tagLength: 128 }, key, clear);
    return { v: 2, iv: b64(iv), data: b64(data) };
  }
  async function unseal(context, value, mine, kind, limit) {
    if (value?.v !== 2 || typeof value.iv !== 'string' || value.iv.length !== 16 || typeof value.data !== 'string' || value.data.length > Math.ceil(limit / 3) * 4) throw Error('Invalid encrypted message.');
    const iv = un64(value.iv), ciphertext = un64(value.data);
    if (b64(iv)!==value.iv||b64(ciphertext)!==value.data||iv.length !== 12 || ciphertext.length > limit || ciphertext.length < 17) throw Error('Invalid encrypted message.');
    const sender = mine ? context.own : context.peer;
    const key = await messageKey(context, sender, kind, iv, 'decrypt');
    return globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(context, sender, kind), tagLength: 128 }, key, ciphertext);
  }
  async function encrypt(context, text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw Error('Invalid message.');
    const clear=bytes(text);
    try{return await seal(context,clear,'text');}finally{clear.fill(0);}
  }
  async function decrypt(context, value, mine) {
    const clear = new Uint8Array(await unseal(context, value, mine, 'text', 8016));
    try{const text = new TextDecoder('utf-8', { fatal: true }).decode(clear);
      if (!text.trim() || text.length > 2000) throw Error('Invalid message.');
      return text;
    }finally{clear.fill(0);}
  }
  const mediaTypes = { image: ['image/jpeg', 'image/png', 'image/webp'], audio: ['audio/webm', 'audio/mp4', 'audio/ogg'] };
  const mediaLimit = 2 * 1024 * 1024;
  async function encryptMedia(context, kind, blob) {
    const mime = blob.type.split(';')[0];
    if (!mediaTypes[kind]?.includes(mime) || !blob.size || blob.size > mediaLimit) throw Error('Invalid attachment.');
    const header = bytes(mime + '\n');
    const payload = new Uint8Array(header.length + blob.size);
    payload.set(header);
    const data=new Uint8Array(await blob.arrayBuffer());
    payload.set(data,header.length);data.fill(0);
    try{return await seal(context,payload,kind);}finally{payload.fill(0);}
  }
  async function decryptMedia(context, kind, cipher, mine) {
    if (!mediaTypes[kind]) throw Error('Invalid attachment.');
    const clear = new Uint8Array(await unseal(context, cipher, mine, kind, mediaLimit + 64));
    try{
    const split = clear.subarray(0, 48).indexOf(10);
    if (split < 1 || clear.length <= split + 1 || clear.length - split - 1 > mediaLimit) throw Error('Invalid attachment.');
    const mime = new TextDecoder('utf-8', { fatal: true }).decode(clear.subarray(0, split));
    if (!mediaTypes[kind].includes(mime)) throw Error('Invalid attachment type.');
    return new Blob([clear.subarray(split + 1)], { type: mime });
    }finally{clear.fill(0);}
  }
  globalThis.QzuCrypto = Object.freeze({ generate, establish, encrypt, decrypt, encryptMedia, decryptMedia });
})();
