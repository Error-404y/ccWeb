(() => {
  const bytes = value => new TextEncoder().encode(value);
  const b64 = value => btoa(String.fromCharCode(...new Uint8Array(value)));
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
    const derive = record => subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: digest, info: tuple('qzu-direction-v1', record.identity, record.key) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return { code, send: await derive(own), receive: await derive(peer), room, own: own.identity, peer: peer.identity };
  }
  const aad = (context, sender) => tuple('qzu-message-v1', context.room, context.code, sender);
  async function encrypt(context, text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw Error('Invalid message.');
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const data = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(context, context.own), tagLength: 128 }, context.send, bytes(text));
    return { v: 1, iv: b64(iv), data: b64(data) };
  }
  async function decrypt(context, value, mine) {
    if (value?.v !== 1 || typeof value.iv !== 'string' || value.iv.length !== 16 || typeof value.data !== 'string' || value.data.length > 10688) throw Error('Invalid encrypted message.');
    const clear = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: un64(value.iv), additionalData: aad(context, mine ? context.own : context.peer), tagLength: 128 }, mine ? context.send : context.receive, un64(value.data));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(clear);
    if (!text.trim() || text.length > 2000) throw Error('Invalid message.');
    return text;
  }
  globalThis.QzuCrypto = Object.freeze({ generate, establish, encrypt, decrypt });
})();
