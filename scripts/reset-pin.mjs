import { developerCommand } from '../lib/admin-socket.mjs';

const reference = process.argv[2]?.trim().toUpperCase();

if (!reference || !/^[A-F0-9]{18}$/.test(reference)) {
  console.error('Usage: npm run reset-pin -- REQUEST_REFERENCE');
  process.exit(1);
}

try {
  await developerCommand({ action: 'reset', reference });
  console.log('Reset approved. Admin message sent.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
