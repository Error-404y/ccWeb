import { approveReset } from './accounts.mjs';

export function handleAdminCommand(db, chats, command) {
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
