import {randomUUID} from 'node:crypto';

const limit = 100;
const maxQuantity = 1_000_000;
const currencies = new Set(['CHF', 'EUR', 'GBP', 'USD']);
const methods = new Set(['unspecified', 'pickup', 'delivery', 'both']);
const fail = (message, status = 400) => Object.assign(new Error(message), {status});

function itemId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) {
    throw fail('Invalid listing ID.');
  }
  return id;
}

function itemFields({name, quantity, price, currency, fulfillment, published, description: providedDescription}, current, submittedDescription) {
  const title = typeof name === 'string' ? name.trim() : '';
  if (!title || title.length > 80 || /[\p{Cc}\p{Cf}]/u.test(title)) throw fail('Enter an item name of 1 to 80 characters.');
  let description = providedDescription === undefined ? submittedDescription ?? current?.description ?? '' : providedDescription;
  if (typeof description !== 'string') throw fail('Enter a description of up to 300 characters.');
  description = description.replace(/\r\n?/g, '\n').trim();
  if (description.length > 300 || /[\p{Cc}\p{Cf}]/u.test(description.replaceAll('\n', ''))) {
    throw fail('Enter a description of up to 300 characters.');
  }
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > maxQuantity) throw fail('Enter a whole quantity from 0 to 1,000,000.');
  if (!currencies.has(currency)) throw fail('Choose a supported currency.');
  if (published !== undefined && typeof published !== 'boolean') throw fail('Choose whether to publish the listing.');
  const visible = published ?? Boolean(current?.published ?? 1);
  const method = fulfillment === undefined ? current?.fulfillment || 'unspecified' : fulfillment;
  if (!methods.has(method) || (published === true && method === 'unspecified')) throw fail('Choose pickup, delivery, or both.');
  const amount = typeof price === 'string' && /^(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(price.trim());
  if (!amount && (visible || typeof price !== 'string' || price.trim())) throw fail('Enter a price up to 9,999,999.99 with no more than two decimal places.');
  const [, units = '0', fraction = ''] = amount || [];
  return {name: title, description, quantity, priceMinor: amount ? Number(units) * 100 + Number(fraction.padEnd(2, '0')) : null,
    currency, fulfillment:method, published:visible};
}

const listingView = row => ({
  id:row.id, name:row.name, description:row.description, quantity:row.quantity, priceMinor:row.price_minor,
  currency:row.currency, fulfillment:row.fulfillment, published:Boolean(row.published)
});

export function sellerCatalog(db, {isSeller, canView = () => false, now = Date.now, reviewRequired = false}) {
  db.exec(`CREATE TABLE IF NOT EXISTS seller_catalog_items (
    owner TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    quantity INTEGER NOT NULL CHECK (quantity BETWEEN 0 AND 1000000),
    price_minor INTEGER NOT NULL CHECK (price_minor BETWEEN 0 AND 999999999),
    currency TEXT NOT NULL CHECK (currency IN ('CHF', 'EUR', 'GBP', 'USD')),
    fulfillment TEXT NOT NULL DEFAULT 'unspecified',
    PRIMARY KEY (owner, id)
  );
  CREATE TABLE IF NOT EXISTS seller_catalog_drafts (
    owner TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', quantity INTEGER NOT NULL,
    price_minor INTEGER, currency TEXT NOT NULL, fulfillment TEXT NOT NULL DEFAULT 'unspecified',
    PRIMARY KEY (owner, id)
  )`);
  const columns = new Set(db.prepare('PRAGMA table_info(seller_catalog_items)').all().map(row => row.name));
  if (!columns.has('fulfillment')) db.exec("ALTER TABLE seller_catalog_items ADD COLUMN fulfillment TEXT NOT NULL DEFAULT 'unspecified'");
  for (const table of ['seller_catalog_items','seller_catalog_drafts']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column=>column.name==='description')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN description TEXT NOT NULL DEFAULT ''`);
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS seller_stock_alerts (
    owner TEXT NOT NULL, item TEXT NOT NULL, buyer TEXT NOT NULL, contact TEXT NOT NULL,
    created INTEGER NOT NULL, notified INTEGER, notice_id TEXT, seen INTEGER,
    PRIMARY KEY (owner,item,buyer)
  );
  CREATE INDEX IF NOT EXISTS seller_stock_buyer ON seller_stock_alerts(buyer,contact,item);
  CREATE INDEX IF NOT EXISTS seller_stock_contact ON seller_stock_alerts(contact)`);
  db.exec(`CREATE TABLE IF NOT EXISTS seller_shop_reviews (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, item TEXT NOT NULL, body TEXT NOT NULL,
    submitted INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', UNIQUE(owner,item)
  );
  CREATE INDEX IF NOT EXISTS seller_shop_review_queue ON seller_shop_reviews(status,submitted);
  CREATE TABLE IF NOT EXISTS seller_shop_updates (owner TEXT PRIMARY KEY,version INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS seller_shop_seen (
    buyer TEXT NOT NULL,contact TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(buyer,contact)
  );`);
  const publicRows=db.prepare('SELECT *,1 AS published FROM seller_catalog_items WHERE owner=? ORDER BY quantity=0,name COLLATE NOCASE,id');
  const draftRows=db.prepare('SELECT *,0 AS published FROM seller_catalog_drafts WHERE owner=? ORDER BY name COLLATE NOCASE,id');
  const existing = db.prepare('SELECT *,1 AS published FROM seller_catalog_items WHERE owner=? AND id=?');
  const existingDraft = db.prepare('SELECT *,0 AS published FROM seller_catalog_drafts WHERE owner=? AND id=?');
  const count = db.prepare('SELECT (SELECT count(*) FROM seller_catalog_items WHERE owner=?)+(SELECT count(*) FROM seller_catalog_drafts WHERE owner=?) AS total');
  const upsert = table => db.prepare(`INSERT INTO ${table}(owner,id,name,description,quantity,price_minor,currency,fulfillment)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET name=excluded.name,description=excluded.description,quantity=excluded.quantity,
    price_minor=excluded.price_minor,currency=excluded.currency,fulfillment=excluded.fulfillment`);
  const publishedWrite = upsert('seller_catalog_items'), draftWrite = upsert('seller_catalog_drafts');
  const remove = db.prepare('DELETE FROM seller_catalog_items WHERE owner=? AND id=?');
  const removeDraft = db.prepare('DELETE FROM seller_catalog_drafts WHERE owner=? AND id=?');
  const erase = db.prepare('DELETE FROM seller_catalog_items WHERE owner=?');
  const eraseDraft = db.prepare('DELETE FROM seller_catalog_drafts WHERE owner=?');
  const watch = db.prepare(`INSERT INTO seller_stock_alerts(owner,item,buyer,contact,created) VALUES(?,?,?,?,?)
    ON CONFLICT(owner,item,buyer) DO UPDATE SET contact=excluded.contact,created=excluded.created,notified=NULL,notice_id=NULL,seen=NULL
    WHERE notified IS NOT NULL OR contact<>excluded.contact`);
  const byBuyer = db.prepare(`SELECT a.owner,a.item,a.contact,a.notified,a.notice_id,i.name,i.quantity
    FROM seller_stock_alerts a JOIN seller_catalog_items i ON i.owner=a.owner AND i.id=a.item
    WHERE a.buyer=? ORDER BY a.notified DESC,a.created DESC`);
  const watchers = db.prepare('SELECT buyer,contact FROM seller_stock_alerts WHERE owner=? AND item=? AND notified IS NULL');
  const notify = db.prepare('UPDATE seller_stock_alerts SET notified=?,notice_id=? WHERE owner=? AND item=? AND buyer=? AND notified IS NULL');
  const dismiss = db.prepare('DELETE FROM seller_stock_alerts WHERE buyer=? AND contact=? AND item=?');
  const clearItem = db.prepare('DELETE FROM seller_stock_alerts WHERE owner=? AND item=?');
  const clearAccount = db.prepare('DELETE FROM seller_stock_alerts WHERE owner=? OR buyer=?');
  const buyerCount = db.prepare('SELECT count(*) AS total FROM seller_stock_alerts WHERE buyer=?');
  const alreadyWatching = db.prepare('SELECT 1 FROM seller_stock_alerts WHERE owner=? AND item=? AND buyer=?');
  const notifications = db.prepare(`SELECT a.owner,a.contact,a.notice_id AS id FROM seller_stock_alerts a
    JOIN seller_catalog_items i ON i.owner=a.owner AND i.id=a.item
    WHERE a.buyer=? AND a.notified IS NOT NULL AND a.seen IS NULL ORDER BY a.notified DESC,a.notice_id DESC`);
  const markSeen = db.prepare(`UPDATE seller_stock_alerts SET seen=? WHERE buyer=? AND seen IS NULL AND notified <=
    (SELECT notified FROM seller_stock_alerts WHERE buyer=? AND notice_id=?)`);
  const pruneNotices = db.prepare('DELETE FROM seller_stock_alerts WHERE notified<?');
  const submitReview = db.prepare(`INSERT INTO seller_shop_reviews(id,owner,item,body,submitted) VALUES(?,?,?,?,?)
    ON CONFLICT(owner,item) DO UPDATE SET id=excluded.id,body=excluded.body,submitted=excluded.submitted,status='pending'`);
  const removeReview = db.prepare('DELETE FROM seller_shop_reviews WHERE owner=? AND item=?');
  const bumpUpdate = db.prepare(`INSERT INTO seller_shop_updates(owner,version) VALUES(?,1)
    ON CONFLICT(owner) DO UPDATE SET version=version+1`);
  const updateVersion = db.prepare('SELECT version FROM seller_shop_updates WHERE owner=?');
  const seenVersion = db.prepare('SELECT version FROM seller_shop_seen WHERE buyer=? AND contact=?');
  const markShopSeen = db.prepare(`INSERT INTO seller_shop_seen(buyer,contact,version) VALUES(?,?,?)
    ON CONFLICT(buyer,contact) DO UPDATE SET version=max(version,excluded.version)`);
  const reviewItem = row => ({description:'',...JSON.parse(row.body),id:row.item,published:false,reviewStatus:row.status});
  function requireSeller(owner) {
    if (!isSeller(owner)) throw fail('Seller list unavailable.', 403);
  }
  function requireContact(buyer, owner, contact) {
    if (!isSeller(owner) || !canView(buyer,owner,contact)) throw fail('Seller list unavailable.', 404);
  }
  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function list(owner, managed = false) {
    requireSeller(owner);
    const items=publicRows.all(owner).map(listingView);
    if (managed) {
      items.push(...draftRows.all(owner).map(listingView));
      items.push(...db.prepare('SELECT * FROM seller_shop_reviews WHERE owner=? ORDER BY submitted DESC').all(owner).map(reviewItem));
    }
    return {items};
  }
  function publish(owner,id,item,current) {
    publishedWrite.run(owner,id,item.name,item.description??'',item.quantity,item.priceMinor,item.currency,item.fulfillment);
    removeDraft.run(owner,id);
    if (!current?.published || current.quantity!==0 || item.quantity===0) return [];
    const recipients=[];
    for(const {buyer,contact} of watchers.all(owner,id)){
      if(!canView(buyer,owner,contact))dismiss.run(buyer,contact,id);
      else if(notify.run(now(),randomUUID(),owner,id,buyer).changes)recipients.push(buyer);
    }
    return recipients;
  }
  return {
    list,
    preview(owner, payload) {
      requireSeller(owner);
      const id = itemId(payload?.id);
      const current = existing.get(owner,id) || existingDraft.get(owner,id);
      return {id,...itemFields({...payload,published:true},current)};
    },
    forContact(buyer, owner, contact) {
      requireContact(buyer,owner,contact);
      const subscribed = new Set(byBuyer.all(buyer).filter(row=>row.contact===contact&&row.notified===null).map(row=>row.item));
      return {items:publicRows.all(owner).map(row=>({...listingView(row),watching:subscribed.has(row.id)}))};
    },
    save(owner, payload, managed = false) {
      requireSeller(owner);
      const id = itemId(payload?.id);
      if (managed && typeof payload.published !== 'boolean') throw fail('Choose whether to publish the listing.');
      if (!managed && payload.published !== undefined) throw fail('Use the listing management view to change visibility.');
      const notified = transaction(() => {
        const current = existing.get(owner,id) || existingDraft.get(owner,id);
        const submission=db.prepare('SELECT status,body FROM seller_shop_reviews WHERE owner=? AND item=?').get(owner,id);
        if (!managed && current?.published===0) throw fail('Listing unavailable.',404);
        const item = itemFields(payload,current,submission ? JSON.parse(submission.body).description : undefined);
        const pendingOnly=db.prepare(`SELECT count(*) AS total FROM seller_shop_reviews r WHERE r.owner=?
          AND NOT EXISTS(SELECT 1 FROM seller_catalog_items i WHERE i.owner=r.owner AND i.id=r.item)`).get(owner).total;
        if (!current&&!submission&&count.get(owner,owner).total+pendingOnly>=limit) throw fail(`You can list up to ${limit} items.`,409);
        if(item.published&&reviewRequired){
          const body=JSON.stringify(item);
          if(submission?.status==='pending'&&submission.body===body)return [];
          if(!submission&&current?.published&&current.name===item.name&&current.description===item.description&&current.quantity===item.quantity&&
             current.price_minor===item.priceMinor&&current.currency===item.currency&&current.fulfillment===item.fulfillment)return [];
          submitReview.run(randomUUID(),owner,id,body,now());
          removeDraft.run(owner,id);
          bumpUpdate.run(owner);
          return [];
        }
        if(item.published)return publish(owner,id,item,current);
        removeReview.run(owner,id);
        draftWrite.run(owner,id,item.name,item.description,item.quantity,item.priceMinor,item.currency,item.fulfillment);
        if(!reviewRequired){clearItem.run(owner,id);remove.run(owner,id);}
        return [];
      });
      return {...list(owner,managed), notified};
    },
    pendingCount() {
      return db.prepare("SELECT owner FROM seller_shop_reviews WHERE status='pending'").all().filter(row=>isSeller(row.owner)).length;
    },
    queue() {
      return db.prepare("SELECT * FROM seller_shop_reviews WHERE status='pending' ORDER BY submitted,id").all()
        .filter(row=>isSeller(row.owner)).slice(0,100).map(row=>{
          const current = existing.get(row.owner,row.item);
          return {...reviewItem(row),id:row.id,itemId:row.item,owner:row.owner,submitted:row.submitted,
            previous:current ? listingView(current) : null};
        });
    },
    review(id,approve) {
      itemId(id);
      if(typeof approve!=='boolean')throw fail('Choose approve or return to seller.');
      return transaction(()=>{
        const row=db.prepare("SELECT * FROM seller_shop_reviews WHERE id=? AND status='pending'").get(id);
        if(!row||!isSeller(row.owner))throw fail('This submission is no longer pending. Refresh the queue.',409);
        if(!approve){
          db.prepare("UPDATE seller_shop_reviews SET status='returned' WHERE id=?").run(id);
          return {notified:[]};
        }
        const notified=publish(row.owner,row.item,JSON.parse(row.body),existing.get(row.owner,row.item));
        removeReview.run(row.owner,row.item);
        return {notified};
      });
    },
    shopNotice(buyer,owner,contact) {
      const version=updateVersion.get(owner)?.version||0;
      return version>(seenVersion.get(buyer,contact)?.version||0)?version:null;
    },
    seenShop(buyer,owner,contact,version) {
      requireContact(buyer,owner,contact);
      if(!Number.isSafeInteger(version)||version<1||version>(updateVersion.get(owner)?.version||0))throw fail('Shop update unavailable.');
      markShopSeen.run(buyer,contact,version);
      return {ok:true};
    },
    remove(owner, id, managed = false) {
      requireSeller(owner);
      itemId(id);
      transaction(() => {
        clearItem.run(owner,id);
        remove.run(owner,id);
        removeReview.run(owner,id);
        if (managed) removeDraft.run(owner,id);
      });
      return list(owner,managed);
    },
    watch(buyer, owner, contact, id) {
      itemId(id);
      return transaction(() => {
        requireContact(buyer,owner,contact);
        const item = existing.get(owner,id);
        if (!item?.published) throw fail('Listing unavailable.',404);
        if (item.quantity) throw fail('This item is already in stock.',409);
        if (!alreadyWatching.get(owner,id,buyer) && buyerCount.get(buyer).total >= limit) throw fail('You can watch up to 100 items.',409);
        watch.run(owner,id,buyer,contact,now());
        return {watching:true};
      });
    },
    dismiss(buyer, contact, id) {
      dismiss.run(buyer,itemId(contact),itemId(id));
      return {watching:false};
    },
    alerts(buyer) {
      return byBuyer.all(buyer).filter(row => isSeller(row.owner) && canView(buyer,row.owner,row.contact));
    },
    latestNotice(buyer, eligibleContacts) {
      return notifications.all(buyer).find(row=>eligibleContacts.has(row.contact))?.id || null;
    },
    markSeen(buyer, notice) {
      markSeen.run(now(),buyer,buyer,itemId(notice));
      return {ok:true};
    },
    erase(account) {
      transaction(() => {
        clearAccount.run(account,account);erase.run(account);eraseDraft.run(account);
        db.prepare('DELETE FROM seller_shop_reviews WHERE owner=?').run(account);
        db.prepare('DELETE FROM seller_shop_updates WHERE owner=?').run(account);
        db.prepare('DELETE FROM seller_shop_seen WHERE buyer=?').run(account);
      });
    },
    sweep() {
      pruneNotices.run(now()-30*86400000);
      db.exec(`DELETE FROM seller_stock_alerts
        WHERE NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id=seller_stock_alerts.contact)
           OR NOT EXISTS (SELECT 1 FROM seller_catalog_items i WHERE i.owner=seller_stock_alerts.owner AND i.id=seller_stock_alerts.item)
           OR NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id=seller_stock_alerts.buyer)
           OR NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id=seller_stock_alerts.owner);
        DELETE FROM seller_catalog_drafts WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id=seller_catalog_drafts.owner);
        DELETE FROM seller_shop_seen WHERE NOT EXISTS(SELECT 1 FROM contacts c WHERE c.id=seller_shop_seen.contact)`);
    }
  };
}
