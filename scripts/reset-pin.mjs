import { openAccounts, approveReset } from '../lib/accounts.mjs';
process.umask(0o077);
const ref = process.argv[2]?.trim().toUpperCase();
if (!ref || !/^[A-F0-9]{18}$/.test(ref)) {
  console.error('Usage: npm run reset-pin -- REQUEST_REFERENCE');
  process.exit(1);
}
const db = openAccounts();
const ok = approveReset(db, ref);
db.close();
console.log(ok ? 'Reset approved. The user can now generate a new PIN.': 'Request not found.');
if (!ok) process.exitCode = 1;
