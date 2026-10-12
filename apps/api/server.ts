import { createServer } from "node:http";
import next from "next";
import { initDesktopGatewaySocketServer } from "./lib/desktop-gateway-socket-server";
import { startSelfHostedCronRunner } from "./lib/self-hosted-cron";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.PORT ?? "3002", 10);

const app = next({
  dev,
  hostname,
  port,
});
const handle = app.getRequestHandler();

app
  .prepare()
  .then(() => {
    const server = createServer((request, response) => {
      handle(request, response).catch((error) => {
        console.error("Failed handling API request", error);
        if (response.headersSent) {
          response.end();
        } else {
          response.statusCode = 500;
          response.end("Internal Server Error");
        }
      });
    });

    initDesktopGatewaySocketServer(server);

    server.listen(port, hostname, () => {
      // Keep output aligned with Next default readiness log.
      console.log(`> Ready on http://${hostname}:${port}`);
      // Self-hosted has no platform cron: workflow ticks and the loop reaper
      // are driven in-process (SELF_HOSTED_CRON_DISABLED=true opts out).
      const stopCronRunner = startSelfHostedCronRunner({ port, hostname });
      server.on("close", stopCronRunner);
    });
  })
  .catch((error) => {
    console.error("Failed to start API server", error);
    process.exit(1);
  });
