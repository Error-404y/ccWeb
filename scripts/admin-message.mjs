import { developerCommand } from '../lib/admin-socket.mjs';

const account = process.argv[2];
const message = process.argv.slice(3).join(' ').trim();

if (!account || !message) {
  console.error('Usage: npm run admin-message -- ACCOUNT_ID "Message"');
  process.exit(1);
}

try {
  await developerCommand({ action: 'message', account, message });
  console.log('Admin message sent.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
