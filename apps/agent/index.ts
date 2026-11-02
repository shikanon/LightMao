import { resolve } from 'node:path';
import { createLocalAgent } from './server.ts';
import { installServiceShutdown } from '../../packages/shared/service-lifecycle.ts';
// Launchers pass only client configuration. Never read the API server's .env here.
const { app } = await createLocalAgent({
  dataDir: process.env.LIGHTMAO_DATA_DIR || resolve('.lightmao'),
  apiUrl: process.env.LIGHTMAO_API_URL || 'http://127.0.0.1:4318',
  godotPath: process.env.LIGHTMAO_GODOT_PATH,
  electronPath: process.env.LIGHTMAO_ELECTRON_PATH,
  ffmpegPath: process.env.LIGHTMAO_FFMPEG_PATH,
});
await app.listen({ port: Number(process.env.AGENT_PORT || 4319), host: '127.0.0.1' });
const address = app.server.address();
const port =
  typeof address === 'object' && address ? address.port : Number(process.env.AGENT_PORT || 4319);
console.log(`LightMao Agent: http://127.0.0.1:${port}`);
(
  process as NodeJS.Process & { parentPort?: { postMessage: (value: unknown) => void } }
).parentPort?.postMessage({ type: 'lightmao:ready', service: 'agent', port });
installServiceShutdown(() => app.close());
