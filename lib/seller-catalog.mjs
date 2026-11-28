const limit = 100;
const maxQuantity = 1_000_000;
const currencies = new Set(['CHF', 'EUR', 'GBP', 'USD']);
const fail = (message, status = 400) => Object.assign(new Error(message), {status});

function itemId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) {
    throw fail('Invalid listing ID.');
  }
  return id;
}

function itemFields({name, quantity, price, currency} = {}) {
  const title = typeof name === 'string' ? name.trim() : '';
  if (!title || title.length > 80 || /[\p{Cc}\p{Cf}]/u.test(title)) throw fail('Enter an item name of 1 to 80 characters.');
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > maxQuantity) throw fail('Enter a whole quantity from 0 to 1,000,000.');
  if (!currencies.has(currency)) throw fail('Choose a supported currency.');
  const amount = typeof price === 'string' && /^(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(price.trim());
  if (!amount) throw fail('Enter a price up to 9,999,999.99 with no more than two decimal places.');
  const [, units, fraction = ''] = amount;
  return {name: title, quantity, priceMinor: Number(units) * 100 + Number(fraction.padEnd(2, '0')), currency};
}

export function sellerCatalog(db, {isSeller}) {
  db.exec(`CREATE TABLE IF NOT EXISTS seller_catalog_items (
    owner TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity BETWEEN 0 AND 1000000),
    price_minor INTEGER NOT NULL CHECK (price_minor BETWEEN 0 AND 999999999),
    currency TEXT NOT NULL CHECK (currency IN ('CHF', 'EUR', 'GBP', 'USD')),
    PRIMARY KEY (owner, id)
  )`);
  const rows = db.prepare(`SELECT id,name,quantity,price_minor AS priceMinor,currency FROM seller_catalog_items
    WHERE owner=? ORDER BY quantity=0,name COLLATE NOCASE,id`);
  const existing = db.prepare('SELECT 1 FROM seller_catalog_items WHERE owner=? AND id=?');
  const count = db.prepare('SELECT count(*) AS total FROM seller_catalog_items WHERE owner=?');
  const upsert = db.prepare(`INSERT INTO seller_catalog_items(owner,id,name,quantity,price_minor,currency) VALUES(?,?,?,?,?,?)
    ON CONFLICT(owner,id) DO UPDATE SET name=excluded.name,quantity=excluded.quantity,price_minor=excluded.price_minor,currency=excluded.currency`);
  const remove = db.prepare('DELETE FROM seller_catalog_items WHERE owner=? AND id=?');
  const erase = db.prepare('DELETE FROM seller_catalog_items WHERE owner=?');
  function requireSeller(owner) {
    if (!isSeller(owner)) throw fail('Seller list unavailable.', 403);
  }
  function list(owner) {
    requireSeller(owner);
    return {items: rows.all(owner).map(row => ({...row}))};
  }
  return {
    list,
    save(owner, payload) {
      requireSeller(owner);
      const id = itemId(payload?.id);
      const item = itemFields(payload);
      db.exec('BEGIN IMMEDIATE');
      try {
        requireSeller(owner);
        if (!existing.get(owner,id) && count.get(owner).total >= limit) throw fail(`You can list up to ${limit} items.`, 409);
        upsert.run(owner,id,item.name,item.quantity,item.priceMinor,item.currency);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return list(owner);
    },
    remove(owner, id) {
      requireSeller(owner);
      remove.run(owner,itemId(id));
      return list(owner);
    },
    erase(owner) {
      erase.run(owner);
    }
  };
}
