const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function feedbackStore(db,now=Date.now){
  db.exec('CREATE TABLE IF NOT EXISTS feedback_inbox(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, created INTEGER NOT NULL, reviewed INTEGER NOT NULL DEFAULT 0)');
  const columns=new Set(db.prepare('PRAGMA table_info(feedback_inbox)').all().map(x=>x.name));
  if(!columns.has('workflow')){db.exec("ALTER TABLE feedback_inbox ADD COLUMN workflow TEXT NOT NULL DEFAULT 'inspection'");db.exec("UPDATE feedback_inbox SET workflow='solved' WHERE reviewed=1");}
  if(!columns.has('archived'))db.exec('ALTER TABLE feedback_inbox ADD COLUMN archived INTEGER');
  db.exec('CREATE TABLE IF NOT EXISTS feedback_events(feedback_id INTEGER NOT NULL,actor TEXT,at INTEGER NOT NULL,status TEXT NOT NULL,note TEXT NOT NULL)');
  function admin(allowed){if(!allowed)throw fail('Support admin required.',403);}
  return {
    submit(message,confirmed){
      if(typeof message!=='string'||!message.trim()||message.trim().length>2000||confirmed!==true)throw fail('Enter and confirm your feedback.');
      return {id:Number(db.prepare('INSERT INTO feedback_inbox(body,created) VALUES(?,?)').run(message.trim(),now()).lastInsertRowid)};
    },
    count(allowed){admin(allowed);return db.prepare('SELECT count(*) AS n FROM feedback_inbox WHERE reviewed=0').get().n;},
    list(allowed,before=Number.MAX_SAFE_INTEGER,archived=false){admin(allowed);if(!Number.isSafeInteger(before)||before<1)throw fail('Invalid feedback reference.');return db.prepare('SELECT id,body AS text,created AS at,reviewed,workflow,archived FROM feedback_inbox WHERE id<? AND '+(archived?"archived IS NOT NULL AND workflow='solved'":"archived IS NULL")+' ORDER BY id DESC LIMIT 100').all(before).map(row=>({...row,events:db.prepare('SELECT actor,at,status,note FROM feedback_events WHERE feedback_id=? ORDER BY at DESC LIMIT 30').all(row.id)}));},
    review(allowed,id){admin(allowed);if(!Number.isSafeInteger(id)||id<1)throw fail('Invalid feedback reference.');if(!db.prepare('UPDATE feedback_inbox SET reviewed=1,workflow=\'solved\' WHERE id=?').run(id).changes)throw fail('Feedback unavailable.',404);return {ok:true};},
    status(allowed,id,status,actor,note=''){
      admin(allowed);if(!Number.isSafeInteger(id)||id<1||!['inspection','help','solved'].includes(status)||typeof note!=='string'||note.length>1000)throw fail('Invalid feedback update.');
      db.exec('BEGIN IMMEDIATE');try{if(!db.prepare('UPDATE feedback_inbox SET workflow=?,reviewed=?,archived=NULL WHERE id=?').run(status,status==='solved'?1:0,id).changes)throw fail('Feedback unavailable.',404);
      db.prepare('INSERT INTO feedback_events(feedback_id,actor,at,status,note) VALUES(?,?,?,?,?)').run(id,actor,now(),status,note.trim());db.exec('COMMIT');return {ok:true};}catch(e){db.exec('ROLLBACK');throw e;}
    },
    remove(allowed,id){admin(allowed);if(!Number.isSafeInteger(id)||id<1)throw fail('Invalid feedback reference.');if(!db.prepare('DELETE FROM feedback_inbox WHERE id=?').run(id).changes)throw fail('Feedback unavailable.',404);db.prepare('DELETE FROM feedback_events WHERE feedback_id=?').run(id);return {ok:true};}
  };
}
