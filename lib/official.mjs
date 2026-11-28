const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function officialStore(db,now=Date.now){
  db.exec(`CREATE TABLE IF NOT EXISTS official_posts(id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS official_reads(account TEXT PRIMARY KEY, seen INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS official_revision(id INTEGER PRIMARY KEY CHECK(id=1),deleted INTEGER NOT NULL);INSERT OR IGNORE INTO official_revision VALUES(1,0);`);
  const latest=()=>db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM official_posts').get().id;
  const deletedRevision=()=>db.prepare('SELECT deleted FROM official_revision WHERE id=1').get().deleted;
  const before=db.prepare('SELECT id,body AS text,created AS at FROM official_posts WHERE id<? ORDER BY id DESC LIMIT ?');
  const after=db.prepare('SELECT id,body AS text,created AS at FROM official_posts WHERE id>? ORDER BY id ASC LIMIT ?');
  function page(posts){
    return {
      posts,
      hasOlder:Boolean(posts.length&&db.prepare('SELECT 1 FROM official_posts WHERE id<? LIMIT 1').get(posts[0].id)),
      hasNewer:Boolean(posts.length&&db.prepare('SELECT 1 FROM official_posts WHERE id>? LIMIT 1').get(posts.at(-1).id)),
      deletedRevision:deletedRevision()
    };
  }
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
    snapshot(account,{paged=false}={}){
      const seen=db.prepare('SELECT seen FROM official_reads WHERE account=?').get(account)?.seen||0;
      const last=latest();
      const summary={latest:last,seen,unread:last>seen,unreadCount:db.prepare('SELECT COUNT(*) AS n FROM official_posts WHERE id>?').get(seen).n};
      if(paged){
        const posts=last>seen?[...before.all(seen+1,30).reverse(),...after.all(seen,30)]:before.all(last+1,40).reverse();
        return {...page(posts),...summary};
      }
      const posts=db.prepare('SELECT id,body AS text,created AS at FROM official_posts ORDER BY id ASC').all();
      return {posts,...summary,deletedRevision:deletedRevision()};
    },
    recent(){
      return page(before.all(latest()+1,40).reverse());
    },
    history(id,{forward=false,paged=false}={}){
      if(!Number.isSafeInteger(id)||id<(forward?0:1))throw fail('Invalid announcement reference.');
      const posts=forward?after.all(id,40):before.all(id,paged?40:100).reverse();
      return page(posts);
    },
    mark(account,id){
      if(!Number.isSafeInteger(id)||id<0||id>latest())throw fail('Invalid announcement reference.');
      db.prepare('INSERT INTO official_reads(account,seen) VALUES(?,?) ON CONFLICT(account) DO UPDATE SET seen=MAX(seen,excluded.seen)').run(account,id);
      return {ok:true};
    },
    erase(account){db.prepare('DELETE FROM official_reads WHERE account=?').run(account);}
  };
}
