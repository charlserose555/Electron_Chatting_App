const path = require('node:path');
const { createLanServer } = require('./createServer.cjs');

const PORT = 4000;

async function main() {
  const lanServer = createLanServer({
    port: PORT,
    userDataPath: path.join(__dirname, '.runtime')
  });

  await lanServer.start('0.0.0.0');

  console.log(`LAN Chat server running on http://0.0.0.0:${PORT}`);
}

main().catch((err) => {
  console.error('Failed to start LAN Chat server:', err);
  process.exit(1);
});