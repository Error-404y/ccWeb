import { developerCommand } from '../lib/admin-socket.mjs';

const [action, target, ...words] = process.argv.slice(2);
try {
  const result = await developerCommand({ action: 'support-' + action, code: target, id: target, message: words.join(' ') });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
