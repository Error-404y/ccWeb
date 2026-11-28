import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {linkSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';

const keys = new WeakMap();
const algorithm = 'aes-256-gcm';
const ivLength = 12;
const tagLength = 16;

function wrappingKey(db, create) {
  const cached = keys.get(db);
  if (cached) return cached;
  const database = db.prepare('PRAGMA database_list').get().file;
  if (!database) {
    if (!create) return null;
    const key = randomBytes(32);
    keys.set(db,key);
    return key;
  }
  const path = database + '.access-key-vault';
  let key;
  try {
    key = readFileSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!create) return null;
    const temporary = path + '.' + randomBytes(12).toString('hex');
    writeFileSync(temporary,randomBytes(32),{flag:'wx',mode:0o600});
    try {
      try { linkSync(temporary,path); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      key = readFileSync(path);
    } finally {
      unlinkSync(temporary);
    }
  }
  if (key.length !== 32) throw Error('Invalid access key vault.');
  keys.set(db,key);
  return key;
}

export function sealAccessKey(db, id, secret) {
  const iv = randomBytes(ivLength);
  const cipher = createCipheriv(algorithm,wrappingKey(db,true),iv);
  cipher.setAAD(Buffer.from(id));
  const encrypted = Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),encrypted]);
}

export function openAccessKey(db, id, sealed) {
  if (!sealed || sealed.length <= ivLength+tagLength) return null;
  try {
    const key = wrappingKey(db,false);
    if (!key) return null;
    const iv = sealed.subarray(0,ivLength);
    const tag = sealed.subarray(ivLength,ivLength+tagLength);
    const cipher = createDecipheriv(algorithm,key,iv);
    cipher.setAAD(Buffer.from(id));
    cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(sealed.subarray(ivLength+tagLength)),cipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
