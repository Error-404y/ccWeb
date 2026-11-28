import {randomBytes,randomUUID,createHash} from 'node:crypto';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const hash=value=>createHash('sha256').update(value).digest('hex');
export const TERMS_VERSION=1;
export function complianceStore(db,now=Date.now){
  const cols=new Set(db.prepare('PRAGMA table_info(accounts)').all().map(x=>x.name));
  for(const [name,definition] of Object.entries({terms_version:'INTEGER NOT NULL DEFAULT 0',terms_required:'INTEGER NOT NULL DEFAULT 0',suspended:'INTEGER NOT NULL DEFAULT 0',suspended_until:'INTEGER',restricted_until:'INTEGER',deletion_hash:'TEXT'}))if(!cols.has(name))db.exec('ALTER TABLE accounts ADD COLUMN '+name+' '+definition);
  db.exec(`PRAGMA secure_delete=ON; CREATE UNIQUE INDEX IF NOT EXISTS deletion_hash ON accounts(deletion_hash);
  CREATE TABLE IF NOT EXISTS abuse_reports(id TEXT PRIMARY KEY,reporter TEXT,target TEXT,room TEXT,reason TEXT NOT NULL,evidence TEXT NOT NULL,created INTEGER NOT NULL,resolved INTEGER);
  CREATE TABLE IF NOT EXISTS suspended_devices(device_id TEXT PRIMARY KEY,until INTEGER NOT NULL);`);
  if(!db.prepare('PRAGMA table_info(abuse_reports)').all().some(x=>x.name==='message_id'))db.exec('ALTER TABLE abuse_reports ADD COLUMN message_id TEXT');
  const reportCols=new Set(db.prepare('PRAGMA table_info(abuse_reports)').all().map(x=>x.name));
  for(const [name,type] of Object.entries({context:"TEXT NOT NULL DEFAULT '[]'",chat_type:"TEXT NOT NULL DEFAULT 'unknown'",action:'TEXT',moderator:'TEXT',notes:'TEXT',workflow:"TEXT NOT NULL DEFAULT 'inspection'"}))if(!reportCols.has(name))db.exec('ALTER TABLE abuse_reports ADD COLUMN '+name+' '+type);
  db.exec('CREATE TABLE IF NOT EXISTS moderation_actions(id TEXT PRIMARY KEY,report_id TEXT,actor TEXT,target TEXT,action TEXT NOT NULL,notes TEXT NOT NULL,created INTEGER NOT NULL)');
  db.exec("UPDATE abuse_reports SET workflow='solved' WHERE resolved IS NOT NULL");
  db.exec('CREATE TABLE IF NOT EXISTS report_collaboration(report_id TEXT NOT NULL,actor TEXT,at INTEGER NOT NULL,status TEXT NOT NULL,note TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS report_media(report_id TEXT PRIMARY KEY,message_id TEXT NOT NULL,kind TEXT NOT NULL,mime TEXT NOT NULL,body BLOB NOT NULL,source TEXT NOT NULL,at INTEGER NOT NULL)');
  const sweep=()=>{db.prepare('DELETE FROM report_collaboration WHERE report_id IN (SELECT id FROM abuse_reports WHERE created<?)').run(now()-90*86400000);db.prepare('DELETE FROM report_media WHERE report_id IN (SELECT id FROM abuse_reports WHERE created<?)').run(now()-90*86400000);db.prepare('DELETE FROM abuse_reports WHERE created<?').run(now()-90*86400000);db.prepare('DELETE FROM moderation_actions WHERE created<?').run(now()-90*86400000);db.prepare('DELETE FROM suspended_devices WHERE until<=?').run(now());db.prepare('UPDATE accounts SET suspended=0,suspended_until=NULL WHERE suspended_until IS NOT NULL AND suspended_until<=?').run(now());db.prepare('UPDATE accounts SET restricted_until=NULL WHERE restricted_until IS NOT NULL AND restricted_until<=?').run(now());};
  const account=id=>db.prepare('SELECT id,device_id,access_plan,suspended,suspended_until,restricted_until FROM accounts WHERE id=?').get(id);
  const allowedActions=['dismiss','warn','restrict','suspend24h','suspend7d','suspend'];
  const history=target=>db.prepare('SELECT id,action,notes,created FROM moderation_actions WHERE target=? ORDER BY created DESC LIMIT 50').all(target);
  const audit=(report,actor,target,action,notes)=>db.prepare('INSERT INTO moderation_actions(id,report_id,actor,target,action,notes,created) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),report,actor,target,action,notes,now());
  return {
    sweep,
    requireTerms(id){db.prepare('UPDATE accounts SET terms_required=1 WHERE id=?').run(id);},
    accept(id,version){if(version!==TERMS_VERSION)throw fail('Read the current Terms of Service.');db.prepare('UPDATE accounts SET terms_version=?,terms_required=1 WHERE id=?').run(version,id);return {ok:true};},
    deletionCode(id){const code=randomBytes(24).toString('hex').toUpperCase();if(db.prepare('UPDATE accounts SET deletion_hash=? WHERE id=?').run(hash(code),id).changes!==1)throw fail('Account unavailable.',404);return code;},
    byDeletionCode(code){if(typeof code!=='string'||!/^[A-Fa-f0-9]{48}$/.test(code))return null;return db.prepare('SELECT id FROM accounts WHERE deletion_hash=?').get(hash(code.toUpperCase()))?.id||null;},
    suspended(device){return Boolean(device&&db.prepare('SELECT 1 FROM suspended_devices WHERE device_id=? AND until>?').get(device,now()));},
    report(reporter,target,room,reason,evidence='',messageId=null,context=[],chatType='unknown',attachment=null){
      sweep();if(!['Harassment','Threats or violence','Sexual exploitation','Spam or scam','Other'].includes(reason)||typeof evidence!=='string'||evidence.length>2000||reporter===target||!Array.isArray(context)||context.length>24||JSON.stringify(context).length>70000)throw fail('Invalid report.');
      const id=randomUUID();if(attachment){if(!['image','audio'].includes(attachment.kind)||!Buffer.isBuffer(attachment.body)||attachment.body.length<1||attachment.body.length>2*1024*1024)throw fail('Invalid evidence attachment.');const used=db.prepare('SELECT COALESCE(SUM(length(body)),0) AS n FROM report_media').get().n;if(used+attachment.body.length>50*1024*1024)throw fail('Evidence capacity reached. Submit a text report instead.',429);if(db.prepare('SELECT COUNT(*) AS n FROM report_media m JOIN abuse_reports r ON r.id=m.report_id WHERE r.reporter=? AND r.created>?').get(reporter,now()-86400000).n>=10)throw fail('Daily evidence upload limit reached.',429);}
      db.exec('BEGIN IMMEDIATE');try{db.prepare('INSERT INTO abuse_reports(id,reporter,target,room,reason,evidence,created,message_id,context,chat_type) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,reporter,target,room,reason,evidence.trim(),now(),messageId,JSON.stringify(context),chatType);if(attachment)db.prepare('INSERT INTO report_media(report_id,message_id,kind,mime,body,source,at) VALUES(?,?,?,?,?,?,?)').run(id,attachment.messageId,attachment.kind,attachment.mime,attachment.body,attachment.source,attachment.at);db.exec('COMMIT');return {id};}catch(error){db.exec('ROLLBACK');throw error;}
    },
    list(includeResolved=false){
      sweep();return db.prepare('SELECT * FROM abuse_reports '+(includeResolved?'':'WHERE resolved IS NULL ')+'ORDER BY created DESC LIMIT 100').all().map(x=>({...x,context:JSON.parse(x.context),collaboration:db.prepare('SELECT actor,at,status,note FROM report_collaboration WHERE report_id=? ORDER BY at DESC LIMIT 100').all(x.id),attachment:db.prepare('SELECT message_id,kind,mime,source,at FROM report_media WHERE report_id=?').get(x.id)||null,previousReports:x.target?db.prepare('SELECT COUNT(*) AS n FROM abuse_reports WHERE target=? AND id!=?').get(x.target,x.id).n:0,account:x.target?(()=>{const a=account(x.target);return a?{suspended:Boolean(a.suspended),suspendedUntil:a.suspended_until,restrictedUntil:a.restricted_until}:null;})():null,history:x.target?history(x.target):[]}));
    },
    media(id){sweep();return db.prepare('SELECT mime,body,kind FROM report_media WHERE report_id=?').get(id)||null;},
    collaborate(id,actor,status,note=''){
      if(!['inspection','help'].includes(status)||typeof note!=='string'||note.length>1000)throw fail('Invalid case status.');
      db.exec('BEGIN IMMEDIATE');try{
        const row=db.prepare('SELECT id FROM abuse_reports WHERE id=? AND resolved IS NULL').get(id);if(!row)throw fail('Report unavailable.',404);
        db.prepare('UPDATE abuse_reports SET workflow=? WHERE id=?').run(status,id);
        db.prepare('INSERT INTO report_collaboration(report_id,actor,at,status,note) VALUES(?,?,?,?,?)').run(id,actor,now(),status,note.trim());
        db.exec('COMMIT');return {ok:true};
      }catch(e){db.exec('ROLLBACK');throw e;}
    },
    resolve(id,action,actor=null,notes=''){
      if(!allowedActions.includes(action)||typeof notes!=='string'||notes.length>1000)throw fail('Invalid action.');
      const row=db.prepare('SELECT * FROM abuse_reports WHERE id=? AND resolved IS NULL').get(id);if(!row)throw fail('Report unavailable.',404);
      db.exec('BEGIN IMMEDIATE');try{
        if(action!=='dismiss'){
          const a=row.target&&account(row.target);if(!a||a.access_plan==='admin')throw fail('Account unavailable for moderation.');
          if(action==='restrict')db.prepare('UPDATE accounts SET restricted_until=? WHERE id=?').run(now()+86400000,row.target);
          if(action.startsWith('suspend')){
            const until=action==='suspend24h'?now()+86400000:action==='suspend7d'?now()+7*86400000:null;
            db.prepare('UPDATE accounts SET suspended=1,suspended_until=? WHERE id=?').run(until,row.target);
            if(a.device_id)db.prepare('INSERT INTO suspended_devices(device_id,until) VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET until=excluded.until').run(a.device_id,until??now()+90*86400000);
          }
        }
        db.prepare('UPDATE abuse_reports SET resolved=?,action=?,moderator=?,notes=?,workflow=\'solved\' WHERE id=?').run(now(),action,actor,notes.trim(),id);
        audit(id,actor,row.target,action,notes.trim());db.exec('COMMIT');return {ok:true,target:action.startsWith('suspend')?row.target:null,warn:action==='warn'?row.target:null};
      }catch(e){db.exec('ROLLBACK');throw e;}
    },
    reinstate(target,actor,notes=''){
      if(typeof notes!=='string'||notes.length>1000)throw fail('Invalid notes.');const a=account(target);if(!a||a.access_plan==='admin')throw fail('Account unavailable.');
      db.exec('BEGIN IMMEDIATE');try{db.prepare('UPDATE accounts SET suspended=0,suspended_until=NULL,restricted_until=NULL WHERE id=?').run(target);if(a.device_id)db.prepare('DELETE FROM suspended_devices WHERE device_id=?').run(a.device_id);audit(null,actor,target,'reinstate',notes.trim());db.exec('COMMIT');return {ok:true};}catch(e){db.exec('ROLLBACK');throw e;}
    },
    purge(id){db.exec('BEGIN IMMEDIATE');try{
      if(!db.prepare('SELECT id FROM accounts WHERE id=?').get(id))throw fail('Account unavailable.',404);
      db.prepare('DELETE FROM contacts WHERE a=? OR b=?').run(id,id);
      db.prepare('DELETE FROM blocks WHERE owner=? OR target=?').run(id,id);
      db.prepare('DELETE FROM security_activity WHERE owner=?').run(id);
      db.prepare('DELETE FROM official_reads WHERE account=?').run(id);
      db.prepare('DELETE FROM push_devices WHERE account=?').run(id);
      db.prepare('UPDATE access_invoices SET account=NULL,activation_key=NULL,state=CASE WHEN redeemed IS NULL THEN \'cancelled\' ELSE state END WHERE account=?').run(id);
      db.prepare('UPDATE access_invoices SET redeemed_account=NULL,redeemed_device=NULL WHERE redeemed_account=?').run(id);
      db.prepare('UPDATE support_keys SET account=NULL,redeemed=NULL WHERE account=?').run(id);
      db.prepare('UPDATE abuse_reports SET reporter=NULL WHERE reporter=?').run(id);
      db.prepare('UPDATE abuse_reports SET target=NULL WHERE target=?').run(id);
      db.prepare('UPDATE moderation_actions SET actor=NULL WHERE actor=?').run(id);db.prepare('UPDATE moderation_actions SET target=NULL WHERE target=?').run(id);db.prepare('UPDATE abuse_reports SET moderator=NULL WHERE moderator=?').run(id);db.prepare('UPDATE report_collaboration SET actor=NULL WHERE actor=?').run(id);
      db.prepare('DELETE FROM accounts WHERE id=?').run(id);
      db.exec('COMMIT');return {ok:true};
    }catch(e){db.exec('ROLLBACK');throw e;}}
  };
}
