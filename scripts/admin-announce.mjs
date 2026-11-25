import { developerCommand } from '../lib/admin-socket.mjs';

const message = process.argv.slice(2).join(' ').trim();

if (!message) {
  console.error('Usage: npm run admin-announce -- "Announcement"');
  process.exit(1);
}

try {
  const result = await developerCommand({ action: 'announce', message });
  console.log('Announcement sent to ' + result.delivered + ' unlocked accounts.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
