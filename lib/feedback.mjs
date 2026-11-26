const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function feedbackStore(db,now=Date.now){
  db.exec('CREATE TABLE IF NOT EXISTS feedback_inbox(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, created INTEGER NOT NULL, reviewed INTEGER NOT NULL DEFAULT 0)');
  function admin(allowed){if(!allowed)throw fail('Support admin required.',403);}
  return {
    submit(message,confirmed){
      if(typeof message!=='string'||!message.trim()||message.trim().length>2000||confirmed!==true)throw fail('Enter and confirm your feedback.');
      return {id:Number(db.prepare('INSERT INTO feedback_inbox(body,created) VALUES(?,?)').run(message.trim(),now()).lastInsertRowid)};
    },
    count(allowed){admin(allowed);return db.prepare('SELECT count(*) AS n FROM feedback_inbox WHERE reviewed=0').get().n;},
    list(allowed,before=Number.MAX_SAFE_INTEGER){admin(allowed);if(!Number.isSafeInteger(before)||before<1)throw fail('Invalid feedback reference.');return db.prepare('SELECT id,body AS text,created AS at,reviewed FROM feedback_inbox WHERE id<? ORDER BY id DESC LIMIT 100').all(before).map(row=>({...row}));},
    review(allowed,id){admin(allowed);if(!Number.isSafeInteger(id)||id<1)throw fail('Invalid feedback reference.');if(!db.prepare('UPDATE feedback_inbox SET reviewed=1 WHERE id=?').run(id).changes)throw fail('Feedback unavailable.',404);return {ok:true};},
    remove(allowed,id){admin(allowed);if(!Number.isSafeInteger(id)||id<1)throw fail('Invalid feedback reference.');if(!db.prepare('DELETE FROM feedback_inbox WHERE id=?').run(id).changes)throw fail('Feedback unavailable.',404);return {ok:true};}
  };
}
