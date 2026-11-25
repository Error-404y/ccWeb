import net from 'node:net';
import { mkdirSync, lstatSync, unlinkSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';

const directory = resolve(process.env.QZU_ADMIN_DIR || 'data/admin-control');
export const adminSocketPath = join(directory, 'control.sock');

function secureDirectory() {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);

  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error('Developer control directory must be private (0700).');
  }
}

function checkExistingSocket() {
  return new Promise((resolve, reject) => {
    let info;

    try {
      info = lstatSync(adminSocketPath);
    } catch (error) {
      if (error.code === 'ENOENT') return resolve();
      return reject(error);
    }

    if (!info.isSocket() || info.uid !== process.getuid()) {
      return reject(new Error('Unsafe developer socket path.'));
    }

    const probe = net.createConnection(adminSocketPath);

    probe.once('connect', () => {
      probe.destroy();
      reject(new Error('Another qzu. server is already running.'));
    });

    probe.once('error', error => {
      if (error.code !== 'ECONNREFUSED') return reject(error);
      try {
        unlinkSync(adminSocketPath);
        resolve();
      } catch (failure) {
        reject(failure);
      }
    });
  });
}

export async function startAdminSocket(handleCommand) {
  secureDirectory();
  await checkExistingSocket();

  const server = net.createServer(socket => {
    let input = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => socket.destroy());

    socket.on('data', chunk => {
      if (handled) return;
      input += chunk;

      if (Buffer.byteLength(input) > 16_384) {
        socket.destroy();
        return;
      }

      const newline = input.indexOf('\n');
      if (newline === -1) return;
      handled = true;

      try {
        const command = JSON.parse(input.slice(0, newline));
        const result = handleCommand(command);
        socket.end(JSON.stringify(result) + '\n');
      } catch (error) {
        socket.end(JSON.stringify({ error: error.message }) + '\n');
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(adminSocketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  chmodSync(adminSocketPath, 0o600);
  server.on('error', () => console.error('Developer control unavailable.'));
  return server;
}

export function developerCommand(command) {
  secureDirectory();

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(adminSocketPath);
    let output = '';
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy(new Error('Developer command timed out.')));

    socket.once('connect', () => {
      socket.write(JSON.stringify(command) + '\n');
    });

    socket.on('data', chunk => {
      output += chunk;

      if (Buffer.byteLength(output) > 4_000_000) {
        socket.destroy(new Error('Response too large.'));
      }
    });

    socket.once('error', reject);

    socket.once('end', () => {
      try {
        const result = JSON.parse(output);
        if (result.error) throw new Error(result.error);
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}
