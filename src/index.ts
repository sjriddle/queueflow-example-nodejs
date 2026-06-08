import { createApp } from "./server.js";

const port = Number(process.env.PORT ?? 3000);
const app = createApp();

app.listen(port, () => {
  console.log(`queueflow-express-example listening on http://localhost:${port}`);
  console.log(`  QueueFlow:  ${process.env.QUEUEFLOW_URL ?? "http://localhost:8000"}`);
  console.log("  Try:        curl -s -XPOST localhost:" + port + "/signup -H 'content-type: application/json' -d '{\"email\":\"ada@example.com\"}'");
});
