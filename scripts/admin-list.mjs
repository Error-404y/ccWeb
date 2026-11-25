import { developerCommand } from '../lib/admin-socket.mjs';

try {
  const { accounts } = await developerCommand({ action: 'list' });
  for (const account of accounts) {
    console.log(account);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
