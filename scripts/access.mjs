import { developerCommand } from '../lib/admin-socket.mjs';

const action = process.argv[2];
const value = process.argv[3];
try {
  const result = await developerCommand({ action: 'access-' + action, count: Number(value || 1), id: value });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
