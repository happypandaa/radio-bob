import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRadioApplication } from './app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const application = createRadioApplication({ root });
export const server = application.server;
const port = Number(process.env.PORT || 8080);
server.listen(port, '127.0.0.1', () => console.log(`Radio Bob · http://localhost:${port}`));
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  const timer = setTimeout(() => process.exit(1), 3000);
  timer.unref();
  application.close().then(() => process.exit(0), () => process.exit(1));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
