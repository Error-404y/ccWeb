import { complimentary, reviewLate } from './access.mjs';
import { approveReset } from './accounts.mjs';

export function handleAdminCommand(db, chats, command, unlocks) {
  if (command?.action === 'access-create') return { keys: complimentary(db, command.count) };
  if (command?.action === 'access-review') {
    reviewLate(db, command.id);
    return { ok: true };
  }
  if (command?.action === 'access-invoices') {
    return { invoices: db.prepare('SELECT id,plan,sats,eur_cents,state,confirmations,redeemed FROM access_invoices ORDER BY created DESC LIMIT 100').all() };
  }

  if (command?.action === 'list') {
    return {
      accounts: db.prepare('SELECT id FROM accounts ORDER BY id').all().map(account => account.id)
    };
  }

  if (command?.action === 'message') {
    const id = command.account;
    const message = command.message;

    if (typeof id !== 'string' || !db.prepare('SELECT id FROM accounts WHERE id=?').get(id)) {
      throw new Error('Account not found.');
    }

    chats.sendAdmin(id, message);
    return { ok: true };
  }

  if (command?.action === 'announce') {
    const message = command.message;
    if (typeof message !== 'string' || !message.trim() || message.trim().length > 1980) throw new Error('Announcement must contain 1–1980 characters.');
    if (!unlocks) throw new Error('Announcement service unavailable.');
    const accounts = unlocks.activeAccounts();
    for (const id of accounts) chats.sendAdmin(id, 'Announcement\n' + message.trim());
    return { delivered: accounts.length };
  }

  if (command?.action === 'reset') {
    const reference = command.reference;

    if (typeof reference !== 'string' || !/^[A-F0-9]{18}$/.test(reference)) {
      throw new Error('Invalid reference.');
    }

    const account = db.prepare('SELECT id FROM accounts WHERE request=?').get(reference);

    if (!account || !approveReset(db, reference)) {
      throw new Error('Request not found.');
    }

    chats.sendAdmin(account.id, 'emg.exe has been reset!\nYou can now create a new PIN.');
    return { ok: true };
  }

  throw new Error('Unknown developer command.');
}
