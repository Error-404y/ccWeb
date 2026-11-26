import {validRoomKey} from './encryption.mjs';
const DAY=86400000,TTL=7*DAY,MAX=12,MIN=25*60*60_000;
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const validId=id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
export function prekeyStore(db,now=Date.now){
  db.exec('CREATE TABLE IF NOT EXISTS encryption_prekeys(id TEXT PRIMARY KEY,account TEXT NOT NULL,record TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);CREATE INDEX IF NOT EXISTS prekeys_account ON encryption_prekeys(account,used,expires)');
  const sweep=()=>db.prepare('DELETE FROM encryption_prekeys WHERE expires<=? OR account NOT IN (SELECT id FROM accounts)').run(now());
  const rows=account=>db.prepare('SELECT * FROM encryption_prekeys WHERE account=? AND used=0 AND expires>? ORDER BY expires,id').all(account,now()+MIN);
  const usable=account=>db.prepare("SELECT device_id FROM accounts WHERE id=? AND pin_state!='retired' AND (suspended=0 OR (suspended_until IS NOT NULL AND suspended_until<=?))").get(account,now())?.device_id;
  return {
    sweep,
    count(account){return rows(account).length;},
    register(account,deviceId,items){
      if(!deviceId||deviceId!==usable(account)||!Array.isArray(items)||!items.length||items.length>MAX)throw fail('Invalid prekey registration.');
      const ids=new Set();for(const item of items){if(!validId(item?.id)||ids.has(item.id)||!validRoomKey(item.id,deviceId,item.record))throw fail('Invalid signed prekey.',403);ids.add(item.id);}
      sweep();db.exec('BEGIN IMMEDIATE');try{let remaining=MAX-rows(account).length;for(const item of items){if(remaining<=0)break;const record={key:item.record.key,identity:item.record.identity,signature:item.record.signature,prekey:item.id};const result=db.prepare('INSERT OR IGNORE INTO encryption_prekeys(id,account,record,expires) VALUES(?,?,?,?)').run(item.id,account,JSON.stringify(record),now()+TTL);remaining-=Number(result.changes);}db.exec('COMMIT');return {count:rows(account).length};}catch(e){db.exec('ROLLBACK');throw e;}
    },
    claimPair(a,b){
      if(a===b)return null;const ad=usable(a),bd=usable(b);if(!ad||!bd)return null;
      db.exec('BEGIN IMMEDIATE');try{const pick=(account,device)=>rows(account).find(row=>validRoomKey(row.id,device,JSON.parse(row.record)));const x=pick(a,ad),y=pick(b,bd);if(!x||!y){db.exec('ROLLBACK');return null;}const update=db.prepare('UPDATE encryption_prekeys SET used=1 WHERE id=? AND used=0');if(update.run(x.id).changes!==1||update.run(y.id).changes!==1)throw Error('Prekey already used.');db.exec('COMMIT');return new Map([[a,JSON.parse(x.record)],[b,JSON.parse(y.record)]]);}catch(e){db.exec('ROLLBACK');throw e;}
    },
    remove(account){db.prepare('DELETE FROM encryption_prekeys WHERE account=?').run(account);}
  };
}
