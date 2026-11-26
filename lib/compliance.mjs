import {randomBytes,randomUUID,createHash} from 'node:crypto';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const hash=value=>createHash('sha256').update(value).digest('hex');
export const TERMS_VERSION=1;
export function complianceStore(db,now=Date.now){
  const cols=new Set(db.prepare('PRAGMA table_info(accounts)').all().map(x=>x.name));
  for(const [name,definition] of Object.entries({terms_version:'INTEGER NOT NULL DEFAULT 0',suspended:'INTEGER NOT NULL DEFAULT 0',deletion_hash:'TEXT'}))if(!cols.has(name))db.exec('ALTER TABLE accounts ADD COLUMN '+name+' '+definition);
  db.exec(`PRAGMA secure_delete=ON; CREATE UNIQUE INDEX IF NOT EXISTS deletion_hash ON accounts(deletion_hash);
  CREATE TABLE IF NOT EXISTS abuse_reports(id TEXT PRIMARY KEY,reporter TEXT,target TEXT,room TEXT,reason TEXT NOT NULL,evidence TEXT NOT NULL,created INTEGER NOT NULL,resolved INTEGER);
  CREATE TABLE IF NOT EXISTS suspended_devices(device_id TEXT PRIMARY KEY,until INTEGER NOT NULL);`);
  if(!db.prepare('PRAGMA table_info(abuse_reports)').all().some(x=>x.name==='message_id'))db.exec('ALTER TABLE abuse_reports ADD COLUMN message_id TEXT');
  const sweep=()=>{db.prepare('DELETE FROM abuse_reports WHERE created<?').run(now()-90*86400000);db.prepare('DELETE FROM suspended_devices WHERE until<=?').run(now());};
  return {
    sweep,
    accept(id,version){if(version!==TERMS_VERSION)throw fail('Read the current Terms of Service.');db.prepare('UPDATE accounts SET terms_version=? WHERE id=?').run(version,id);return {ok:true};},
    deletionCode(id){const code=randomBytes(24).toString('hex').toUpperCase();if(db.prepare('UPDATE accounts SET deletion_hash=? WHERE id=?').run(hash(code),id).changes!==1)throw fail('Account unavailable.',404);return code;},
    byDeletionCode(code){if(typeof code!=='string'||!/^[A-Fa-f0-9]{48}$/.test(code))return null;return db.prepare('SELECT id FROM accounts WHERE deletion_hash=?').get(hash(code.toUpperCase()))?.id||null;},
    suspended(device){return Boolean(device&&db.prepare('SELECT 1 FROM suspended_devices WHERE device_id=? AND until>?').get(device,now()));},
    report(reporter,target,room,reason,evidence='',messageId=null){sweep();if(!['Harassment','Threats or violence','Sexual exploitation','Spam or scam','Other'].includes(reason)||typeof evidence!=='string'||evidence.length>2000||reporter===target)throw fail('Invalid report.');const id=randomUUID();db.prepare('INSERT INTO abuse_reports(id,reporter,target,room,reason,evidence,created,message_id) VALUES(?,?,?,?,?,?,?,?)').run(id,reporter,target,room,reason,evidence.trim(),now(),messageId);return {id};},
    list(){sweep();return db.prepare('SELECT * FROM abuse_reports WHERE resolved IS NULL ORDER BY created LIMIT 100').all().map(x=>({...x}));},
    resolve(id,action){if(!['dismiss','suspend'].includes(action))throw fail('Invalid action.');const row=db.prepare('SELECT * FROM abuse_reports WHERE id=? AND resolved IS NULL').get(id);if(!row)throw fail('Report unavailable.',404);db.exec('BEGIN IMMEDIATE');try{if(action==='suspend'){if(!row.target)throw fail('Reported account no longer exists.');const a=db.prepare('SELECT device_id,access_plan FROM accounts WHERE id=?').get(row.target);if(!a||a.access_plan==='admin')throw fail('Account unavailable for suspension.');db.prepare('UPDATE accounts SET suspended=1 WHERE id=?').run(row.target);if(a.device_id)db.prepare('INSERT INTO suspended_devices(device_id,until) VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET until=excluded.until').run(a.device_id,now()+90*86400000);}db.prepare('UPDATE abuse_reports SET resolved=? WHERE id=?').run(now(),id);db.exec('COMMIT');return {ok:true,target:action==='suspend'?row.target:null};}catch(e){db.exec('ROLLBACK');throw e;}},
    purge(id){db.exec('BEGIN IMMEDIATE');try{
      if(!db.prepare('SELECT id FROM accounts WHERE id=?').get(id))throw fail('Account unavailable.',404);
      db.prepare('DELETE FROM contacts WHERE a=? OR b=?').run(id,id);
      db.prepare('DELETE FROM blocks WHERE owner=? OR target=?').run(id,id);
      db.prepare('DELETE FROM security_activity WHERE owner=?').run(id);
      db.prepare('DELETE FROM official_reads WHERE account=?').run(id);
      db.prepare('DELETE FROM push_devices WHERE account=?').run(id);
      db.prepare('UPDATE access_invoices SET account=NULL,activation_key=NULL,state=CASE WHEN redeemed IS NULL THEN \'cancelled\' ELSE state END WHERE account=?').run(id);
      db.prepare('UPDATE access_invoices SET redeemed_account=NULL,redeemed_device=NULL WHERE redeemed_account=?').run(id);
      db.prepare('UPDATE support_keys SET account=NULL WHERE account=?').run(id);
      db.prepare('UPDATE abuse_reports SET reporter=NULL WHERE reporter=?').run(id);
      db.prepare('UPDATE abuse_reports SET target=NULL WHERE target=?').run(id);
      db.prepare('DELETE FROM accounts WHERE id=?').run(id);
      db.exec('COMMIT');return {ok:true};
    }catch(e){db.exec('ROLLBACK');throw e;}}
  };
}
