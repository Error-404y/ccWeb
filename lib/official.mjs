const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function officialStore(db,now=Date.now){
  db.exec(`CREATE TABLE IF NOT EXISTS official_posts(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS official_reads(account TEXT PRIMARY KEY, seen INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS official_revision(id INTEGER PRIMARY KEY CHECK(id=1),deleted INTEGER NOT NULL);INSERT OR IGNORE INTO official_revision VALUES(1,0);`);
  const latest=()=>db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM official_posts').get().id;
  return {
    publish(text,isAdmin=false){
      if(!isAdmin)throw fail('Support admin required.',403);
      if(typeof text!=='string'||!text.trim()||text.trim().length>2000)throw fail('Announcement must contain 1–2000 characters.');
      return {id:Number(db.prepare('INSERT INTO official_posts(body,created) VALUES(?,?)').run(text.trim(),now()).lastInsertRowid)};
    },
    remove(id,isAdmin=false){
      if(!isAdmin)throw fail('Support admin required.',403);if(!Number.isSafeInteger(id)||id<1)throw fail('Invalid announcement.');
      db.exec('BEGIN IMMEDIATE');try{if(db.prepare('DELETE FROM official_posts WHERE id=?').run(id).changes)db.prepare('UPDATE official_revision SET deleted=deleted+1 WHERE id=1').run();db.exec('COMMIT');return {ok:true};}catch(e){db.exec('ROLLBACK');throw e;}
    },
    snapshot(account){
      const posts=db.prepare('SELECT id,body AS text,created AS at FROM official_posts ORDER BY id ASC').all();
      const seen=db.prepare('SELECT seen FROM official_reads WHERE account=?').get(account)?.seen||0;
      const last=latest();
      return {posts,latest:last,seen,unread:last>seen,unreadCount:posts.filter(p=>p.id>seen).length,deletedRevision:db.prepare('SELECT deleted FROM official_revision WHERE id=1').get().deleted};
    },
    history(before){
      if(!Number.isSafeInteger(before)||before<1)throw fail('Invalid announcement reference.');
      return {posts:db.prepare('SELECT id,body AS text,created AS at FROM official_posts WHERE id<? ORDER BY id DESC LIMIT 100').all(before).reverse(),deletedRevision:db.prepare('SELECT deleted FROM official_revision WHERE id=1').get().deleted};
    },
    mark(account,id){
      if(!Number.isSafeInteger(id)||id<0||id>latest())throw fail('Invalid announcement reference.');
      db.prepare('INSERT INTO official_reads(account,seen) VALUES(?,?) ON CONFLICT(account) DO UPDATE SET seen=MAX(seen,excluded.seen)').run(account,id);
      return {ok:true};
    },
    erase(account){db.prepare('DELETE FROM official_reads WHERE account=?').run(account);}
  };
}
