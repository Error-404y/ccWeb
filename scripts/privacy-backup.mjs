import {DatabaseSync} from 'node:sqlite';
import {existsSync,openSync,closeSync,unlinkSync,chmodSync} from 'node:fs';
import {resolve} from 'node:path';
process.umask(0o077);
const source=resolve(process.env.QZU_DB||'data/accounts.sqlite');
if(!process.argv[2])throw Error('Usage: npm run backup:private -- /private/path/backup.sqlite');
const target=resolve(process.argv[2]);
if(!existsSync(source)||source===target)throw Error('Invalid backup source or destination.');
const fd=openSync(target,'wx',0o600);closeSync(fd);
const excluded=new Set(['mobile_support_rooms','push_devices','feedback_inbox','abuse_reports','report_media','moderation_actions']);
const quote=name=>'"'+name.replaceAll('"','""')+'"';
let input,output;
try{
  input=new DatabaseSync(source,{readOnly:true});output=new DatabaseSync(target);
  input.exec('PRAGMA busy_timeout=5000; BEGIN;');output.exec('PRAGMA foreign_keys=OFF; BEGIN;');
  const schema=input.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END").all();
  for(const item of schema.filter(x=>x.type==='table')){
    output.exec(item.sql);
    if(excluded.has(item.name))continue;
    const cols=input.prepare('PRAGMA table_info('+quote(item.name)+')').all().map(x=>x.name);
    if(!cols.length)continue;
    const names=cols.map(quote).join(',');
    const put=output.prepare('INSERT INTO '+quote(item.name)+'('+names+') VALUES('+cols.map(()=>'?').join(',')+')');
    for(const row of input.prepare('SELECT '+names+' FROM '+quote(item.name)).iterate())put.run(...cols.map(k=>row[k]));
  }
  for(const item of schema.filter(x=>x.type!=='table'))output.exec(item.sql);
  if(schema.some(x=>x.type==='table'&&/AUTOINCREMENT/i.test(x.sql))){
    output.exec('DELETE FROM sqlite_sequence');
    const put=output.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)');
    for(const row of input.prepare('SELECT name,seq FROM sqlite_sequence').all())if(!excluded.has(row.name))put.run(row.name,row.seq);
  }
  output.exec('COMMIT;');input.exec('COMMIT;');output.close();output=null;input.close();input=null;
  chmodSync(target,0o600);console.log('Private backup created without support chats or push tokens.');
}catch(error){try{output?.close();}catch{}try{input?.close();}catch{}try{unlinkSync(target);}catch{}throw error;}
