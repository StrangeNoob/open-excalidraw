import "dotenv/config";

import { createServer } from "node:http";

import { createApp } from "./app.js";

const port = Number.parseInt(process.env.APP_PORT ?? "3000", 10);
const server = createServer(createApp());

server.listen(port, () => {
  process.stdout.write(`Open Excalidraw server listening on ${port}\n`);
});
