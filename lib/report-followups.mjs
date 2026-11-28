export const reportLifetime = 90 * 86400000;

const fail = (message, status = 400) => Object.assign(new Error(message), {status});
const validId = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

export function reportFollowUps(db, now = Date.now) {
  db.exec(`CREATE TABLE IF NOT EXISTS report_followups (
    id TEXT PRIMARY KEY, report_id TEXT NOT NULL, requested_at INTEGER NOT NULL, request_text TEXT NOT NULL,
    requested_by TEXT, replied_at INTEGER, reply_text TEXT
  );
  CREATE INDEX IF NOT EXISTS report_followups_created ON report_followups(report_id,requested_at);
  CREATE UNIQUE INDEX IF NOT EXISTS report_followups_pending ON report_followups(report_id) WHERE replied_at IS NULL;`);

  const rows = db.prepare(`SELECT id, requested_at AS requestedAt, request_text AS request,
    replied_at AS repliedAt, reply_text AS reply FROM report_followups WHERE report_id=? ORDER BY requested_at,rowid`);
  const latest = db.prepare('SELECT replied_at FROM report_followups WHERE report_id=? ORDER BY requested_at DESC,rowid DESC LIMIT 1');
  const firstReviewNote = db.prepare('SELECT MIN(at) AS first FROM report_collaboration WHERE report_id=?');
  const markReview = db.prepare(`UPDATE abuse_reports SET reviewed_at=COALESCE(reviewed_at,
    (SELECT MIN(at) FROM report_collaboration WHERE report_id=abuse_reports.id),?) WHERE id=? AND resolved IS NULL AND created>=?`);
  const reportForStaff = db.prepare('SELECT id,reporter,resolved FROM abuse_reports WHERE id=? AND created>=?');
  const reportForOwner = db.prepare(`SELECT id,reason,created,resolved,reviewed_at FROM abuse_reports
    WHERE id=? AND reporter=? AND created>=?`);
  const reportsForOwner = db.prepare(`SELECT id,reason,created,resolved,reviewed_at FROM abuse_reports
    WHERE reporter=? AND created>=? ORDER BY created DESC,id LIMIT 100`);
  const pendingCount = db.prepare(`SELECT COUNT(*) AS total FROM abuse_reports r JOIN report_followups f ON f.report_id=r.id
    WHERE r.reporter=? AND r.created>=? AND r.resolved IS NULL AND f.replied_at IS NULL`);
  const requestById = db.prepare('SELECT report_id,requested_by,request_text,replied_at,reply_text FROM report_followups WHERE id=?');
  const insertRequest = db.prepare('INSERT INTO report_followups(id,report_id,requested_at,request_text,requested_by) VALUES(?,?,?,?,?)');
  const updateReply = db.prepare('UPDATE report_followups SET replied_at=?, reply_text=? WHERE id=?');

  function ownReport(reporter, id) {
    const row = validId(id) && reportForOwner.get(id,reporter,now()-reportLifetime);
    if (!row) throw fail('Report unavailable.',404);
    return row;
  }

  function reporterView(row, detail = false) {
    const reviewedAt = row.reviewed_at ?? firstReviewNote.get(row.id).first ?? row.resolved;
    return {
      id: row.id, reason: row.reason, receivedAt: row.created, reviewedAt, closedAt: row.resolved,
      status: row.resolved!==null?'closed':reviewedAt!==null?'in-review':'received',
      awaitingReply: row.resolved===null && latest.get(row.id)?.replied_at===null,
      ...(detail?{followUps:rows.all(row.id)}:{})
    };
  }

  function markReviewed(id) {
    const at = now();
    markReview.run(at,id,at-reportLifetime);
  }

  function request(id, actor, {requestId, text} = {}) {
    if (!validId(id)) throw fail('Report unavailable.',404);
    if (!validId(requestId) || typeof text!=='string' || !text.trim() || text.length>1000) {
      throw fail('Enter a request of up to 1,000 characters.');
    }
    const message = text.trim();
    db.exec('BEGIN IMMEDIATE');
    try {
      const at = now(), row = reportForStaff.get(id,at-reportLifetime);
      if (!row?.reporter) throw fail('Reporter unavailable.',404);
      const prior = requestById.get(requestId);
      if (prior && (prior.report_id!==id || prior.requested_by!==actor || prior.request_text!==message)) throw fail('Request already used.',409);
      if (!prior) {
        if (row.resolved!==null) throw fail('Report closed.',409);
        if (latest.get(id)?.replied_at===null) throw fail('The reporter already has an open request.',409);
        insertRequest.run(requestId,id,at,message,actor);
        markReview.run(at,id,at-reportLifetime);
      }
      db.exec('COMMIT');
      return {reporter:row.reporter,duplicate:Boolean(prior)};
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function reply(reporter, id, {requestId, text} = {}) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = ownReport(reporter,id);
      if (!validId(requestId) || typeof text!=='string' || !text.trim() || text.length>2000) {
        throw fail('Enter evidence of up to 2,000 characters.');
      }
      const request = requestById.get(requestId);
      if (!request || request.report_id!==id) throw fail('Evidence request unavailable.',404);
      const duplicate = request.replied_at!==null;
      const message = text.trim();
      if (duplicate && request.reply_text!==message) throw fail('Evidence has already been sent for this request.',409);
      if (!duplicate) {
        if (row.resolved!==null) throw fail('Report closed.',409);
        updateReply.run(now(),message,requestId);
      }
      const report = reporterView(row,true);
      db.exec('COMMIT');
      return {report,staff:request.requested_by,duplicate};
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    request, reply, markReviewed,
    list: reporter => reportsForOwner.all(reporter,now()-reportLifetime).map(row=>reporterView(row)),
    get: (reporter,id) => reporterView(ownReport(reporter,id),true),
    pendingCount: reporter => pendingCount.get(reporter,now()-reportLifetime).total,
    forStaff: id => rows.all(id),
    staffStatus(id, resolved) {
      const last = resolved===null && latest.get(id);
      return last ? (last.replied_at===null?'awaiting-reporter':'reporter-replied') : null;
    },
    sweep(cutoff) {
      db.prepare(`DELETE FROM report_followups WHERE NOT EXISTS (
        SELECT 1 FROM abuse_reports WHERE id=report_followups.report_id AND created>=?)`).run(cutoff);
    },
    eraseLinks(account) {
      db.prepare('DELETE FROM report_followups WHERE replied_at IS NULL AND report_id IN (SELECT id FROM abuse_reports WHERE reporter=?)').run(account);
      db.prepare('UPDATE report_followups SET requested_by=NULL WHERE requested_by=?').run(account);
    }
  };
}
