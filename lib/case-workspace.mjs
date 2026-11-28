import { controlAccounts } from './control.mjs';
import { listActivity } from './activity.mjs';
import { controlReportSummary } from './compliance.mjs';

const day = 86400000;
const noteLifetime = 30 * day;
const caseTypes = new Set(['report', 'ticket', 'support', 'payment-ticket']);
const sharedTypes = new Set(['report', 'payment-ticket']);
const validId = id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
const failure = (message, status = 400) => Object.assign(Error(message), { status });

export function caseWorkspace(db, { audit, reports, isAdmin, support, supportForAccount, deviceInfo = () => null, accountName = () => null, now = Date.now }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_case_claims (
      type TEXT NOT NULL, case_id TEXT NOT NULL, assignee TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY(type,case_id)
    );
    CREATE TABLE IF NOT EXISTS admin_case_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, case_id TEXT NOT NULL,
      account TEXT, actor TEXT NOT NULL, at INTEGER NOT NULL, note TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS admin_case_notes_case ON admin_case_notes(type,case_id,id);
    CREATE INDEX IF NOT EXISTS admin_case_notes_at ON admin_case_notes(at);
    CREATE INDEX IF NOT EXISTS abuse_reports_target ON abuse_reports(target,created);
    CREATE INDEX IF NOT EXISTS abuse_reports_reporter ON abuse_reports(reporter,created);
    CREATE INDEX IF NOT EXISTS user_tickets_owner ON user_tickets(owner,updated);
    CREATE INDEX IF NOT EXISTS access_invoices_account ON access_invoices(account);
  `);

  const findReport = db.prepare('SELECT id,target,reporter,workflow,resolved,archived FROM abuse_reports WHERE id=? AND created>=?');
  const findTicket = db.prepare('SELECT id,owner,admin,closed FROM user_tickets WHERE id=?');
  const findPayment = db.prepare(`SELECT p.id,p.status,p.closed,p.archived,i.redeemed,COALESCE(i.account,i.redeemed_account) AS account
    FROM payment_cases p JOIN access_invoices i ON i.id=p.invoice
    WHERE p.id=? AND (p.status<>'rejected' OR p.closed>?)`);
  const findClaim = db.prepare('SELECT assignee FROM admin_case_claims WHERE type=? AND case_id=?');
  const addClaim = db.prepare(`INSERT INTO admin_case_claims(type,case_id,assignee,at) VALUES(?,?,?,?)
    ON CONFLICT(type,case_id) DO UPDATE SET assignee=excluded.assignee,at=excluded.at`);
  const removeClaim = db.prepare('DELETE FROM admin_case_claims WHERE type=? AND case_id=?');
  const findNotes = db.prepare(`SELECT id,actor,at,note FROM admin_case_notes
    WHERE type=? AND case_id=? AND at>=? ORDER BY id DESC LIMIT 100`);
  const addNote = db.prepare('INSERT INTO admin_case_notes(type,case_id,account,actor,at,note) VALUES(?,?,?,?,?,?)');

  function requireAdmin(actor) {
    if (!isAdmin(actor)) throw failure('Admin required.', 403);
  }

  function caseRecord(actor, type, id) {
    if (!caseTypes.has(type) || !validId(id)) throw failure('Case unavailable.', 404);
    const timestamp = now();
    if (type === 'support') return support(actor, id);
    if (type === 'report') {
      const row = findReport.get(id, timestamp - 90 * day);
      return row && { status: row.workflow, accountId: row.target || row.reporter, closed: row.resolved, archived: Boolean(row.archived) };
    }
    if (type === 'ticket') {
      const row = findTicket.get(id);
      return row && { status: row.closed !== null ? 'completed' : row.admin ? 'assigned' : 'pending',
        accountId: row.owner, assignee: row.admin, closed: row.closed, archived: row.closed !== null };
    }
    const row = findPayment.get(id, timestamp - 12 * 3600000);
    return row && { status: row.status !== 'rejected' && row.redeemed ? 'completed' : row.status,
      accountId: row.account, closed: row.closed || row.redeemed, archived: Boolean(row.archived) };
  }

  function caseState(actor, type, id) {
    const record = caseRecord(actor, type, id);
    if (!record) throw failure('Case unavailable.', 404);
    const shared = sharedTypes.has(type);
    const assignee = shared ? findClaim.get(type, id)?.assignee || null : record.assignee || null;
    const assignedToMe = assignee === actor;
    const open = !record.closed;
    return {
      id, type, status: record.status, accountId: record.accountId || null, archived: record.archived,
      assignee, assignedToMe, open, closedAt: typeof record.closed==='number'?record.closed:null,
      canClaim: shared && open && (!assignee || !isAdmin(assignee)),
      canUnassign: shared && open && assignedToMe,
      canNote: open
    };
  }

  function accountDetails(id) {
    if (!id) return null;
    const owner = controlAccounts(db,id).find(row => row.id === id);
    if (!owner) return null;
    const key = db.prepare(`SELECT id,plan,fingerprint,redeemed FROM access_invoices
      WHERE redeemed_account=? AND key_erased IS NULL ORDER BY redeemed DESC,id DESC LIMIT 1`).get(id);
    const registeredAccessAt = db.prepare('SELECT MIN(redeemed) AS at FROM access_invoices WHERE redeemed_account=?').get(id).at;
    const suspended=owner.suspended&&(!owner.suspended_until||owner.suspended_until>now());
    const accessStatus=owner.pin_state==='retired'?'retired':owner.access_revoked?'revoked':suspended?'suspended':owner.access.active?'active':'expired';
    return {...owner, name:accountName(id), plan:owner.access.plan, accessStatus, device:deviceInfo(id), key:key||null, registeredAccessAt};
  }

  function view(actor, type, id) {
    requireAdmin(actor);
    const current = caseState(actor, type, id);
    const notesExpired=type==='ticket'&&current.closedAt!==null&&current.closedAt<=now()-7*day;
    const notes = (notesExpired?[]:findNotes.all(type, id, now() - noteLifetime))
      .map(row => ({ ...row, id: 'note-' + row.id, action: 'note', outcome: 'success' }));
    const events = audit.caseActivity(type, id)
      .map(({id, actor, action, detail, at, outcome}) => ({id: 'audit-' + id, actor, action, detail, at, outcome}));
    const report = type === 'report' ? reports.get(id) : undefined;
    const record = report && {...controlReportSummary(report), reporterAccount:accountDetails(report.reporter), reportedAccount:accountDetails(report.target)};
    return {...current, record, events:[...events, ...notes].sort((a,b) => b.at - a.at).slice(0, 100)};
  }

  function act(actor, source, type, id, {action, note} = {}) {
    requireAdmin(actor);
    if (!caseTypes.has(type) || !validId(id)) throw failure('Case unavailable.', 404);
    if (!['claim','unassign','note'].includes(action)) throw failure('Choose a case action.');
    if (action === 'note' && (typeof note !== 'string' || !note.trim() || note.length > 1000)) throw failure('Enter an internal note of up to 1,000 characters.');
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = caseState(actor, type, id);
      if (action === 'claim') {
        if (!current.canClaim) throw failure('This case cannot be claimed. Refresh to see its current assignment.', 409);
        addClaim.run(type, id, actor, now());
      } else if (action === 'unassign') {
        if (!current.canUnassign) throw failure('You can only release an open case assigned to you.', 409);
        removeClaim.run(type, id);
      } else {
        if (!current.canNote) throw failure('This case is closed.', 409);
        addNote.run(type, id, current.accountId, actor, now(), note.trim());
      }
      audit.record(actor, source, 'cases/' + action, type, id, current.accountId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      if ([403,404,409].includes(error.status)) audit.record(actor, source, 'cases/' + action, type, id, null, null, 'rejected');
      throw error;
    }
    return view(actor, type, id);
  }

  function requireAssignedOrUnclaimed(actor, type, id) {
    if (!validId(id)) throw failure('Case unavailable.',404);
    const claim = findClaim.get(type, id);
    if (claim && claim.assignee !== actor && isAdmin(claim.assignee)) throw failure('Another administrator has claimed this case.', 409);
  }

  function accountCases(actor, id) {
    const timestamp = now();
    const reportCases = db.prepare(`SELECT id,'report' AS type,reason AS title,workflow AS status,created AS at,archived
      FROM abuse_reports WHERE (target=? OR reporter=?) AND created>=? ORDER BY created DESC LIMIT 30`).all(id,id,timestamp-90*day);
    const ticketCases = db.prepare(`SELECT id,'ticket' AS type,topic AS title,updated AS at,closed AS archived,
      CASE WHEN closed IS NOT NULL THEN 'completed' WHEN admin IS NOT NULL THEN 'assigned' ELSE 'pending' END AS status
      FROM user_tickets WHERE owner=? ORDER BY updated DESC LIMIT 30`).all(id);
    const paymentCases = db.prepare(`SELECT p.id,'payment-ticket' AS type,'Payment ticket' AS title,p.updated AS at,p.archived,
      CASE WHEN p.status<>'rejected' AND i.redeemed IS NOT NULL THEN 'completed' ELSE p.status END AS status
      FROM payment_cases p JOIN access_invoices i ON i.id=p.invoice
      WHERE (i.account=? OR i.redeemed_account=?) AND (p.status<>'rejected' OR p.closed>?)
      ORDER BY p.updated DESC LIMIT 30`).all(id,id,timestamp-12*3600000);
    return [...reportCases, ...ticketCases, ...paymentCases, ...supportForAccount(actor,id)]
      .sort((a,b) => b.at-a.at).slice(0,50).map(row => ({...row,archived:Boolean(row.archived)}));
  }

  function account(actor, source, id) {
    requireAdmin(actor);
    if (!validId(id)) throw failure('Account unavailable.', 404);
    const owner = accountDetails(id.toLowerCase());
    if (!owner) throw failure('Account unavailable.', 404);
    const existingAudit = audit.accountActivity(owner.id);
    audit.record(actor, source, 'accounts/view', 'account', owner.id);
    return {account:owner, activity:listActivity(db,owner.id,now()), cases:accountCases(actor,owner.id), audit:existingAudit};
  }

  function accountForReference(actor, query) {
    if (typeof query !== 'string' || !validId(query.trim())) return null;
    const id = query.trim().toLowerCase();
    if (db.prepare('SELECT 1 FROM accounts WHERE id=?').get(id)) return id;
    for (const type of caseTypes) {
      const record = caseRecord(actor,type,id);
      if (record?.accountId) return record.accountId;
    }
    return null;
  }

  function sweep() {
    db.prepare(`DELETE FROM admin_case_notes WHERE at<? OR
      (type='report' AND NOT EXISTS(SELECT 1 FROM abuse_reports r WHERE r.id=case_id)) OR
      (type='ticket' AND NOT EXISTS(SELECT 1 FROM user_tickets t WHERE t.id=case_id AND (t.closed IS NULL OR t.closed>?))) OR
      (type='payment-ticket' AND NOT EXISTS(SELECT 1 FROM payment_cases p WHERE p.id=case_id)) OR
      (type='support' AND NOT EXISTS(SELECT 1 FROM mobile_support_rooms s WHERE s.id=case_id))`).run(now()-noteLifetime,now()-7*day);
    db.exec(`DELETE FROM admin_case_claims WHERE
      (type='report' AND NOT EXISTS(SELECT 1 FROM abuse_reports r WHERE r.id=case_id)) OR
      (type='payment-ticket' AND NOT EXISTS(SELECT 1 FROM payment_cases p WHERE p.id=case_id))`);
  }

  function eraseAccount(id) {
    db.prepare(`DELETE FROM admin_case_notes WHERE account=? OR actor=? OR
      (type='report' AND case_id IN (SELECT id FROM abuse_reports WHERE reporter=? OR target=?)) OR
      (type='payment-ticket' AND case_id IN (SELECT p.id FROM payment_cases p JOIN access_invoices i ON i.id=p.invoice WHERE i.account=? OR i.redeemed_account=?))`)
      .run(id,id,id,id,id,id);
    db.prepare('DELETE FROM admin_case_claims WHERE assignee=?').run(id);
    audit.unlinkAccount(id);
  }

  return {view,act,account,accountForReference,requireAssignedOrUnclaimed,sweep,eraseAccount};
}
