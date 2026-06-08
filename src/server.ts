/**
 * A small Express service that offloads background work to QueueFlow.
 *
 * The pattern: HTTP handlers stay fast by *enqueuing* work and returning a
 * 202 with a status URL, instead of doing the slow work inline. Clients poll
 * the status URL (or you'd push a webhook/websocket) to learn the outcome.
 */

import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { ApiError, NotFoundError, wf } from "@queueflow/sdk";
import { qf, TASKS } from "./queueflow.js";

export function createApp() {
  const app = express();
  app.use(express.json());

  // --- Liveness: also surfaces whether QueueFlow itself is reachable. --------
  app.get(
    "/healthz",
    asyncHandler(async (_req, res) => {
      const upstream = await qf.health();
      res.json({ status: "ok", queueflow: upstream });
    }),
  );

  // --- Sign up a user, then send their welcome email in the background. ------
  // POST /signup { "email": "ada@example.com", "name": "Ada" }
  app.post(
    "/signup",
    asyncHandler(async (req, res) => {
      const { email, name } = req.body ?? {};
      if (typeof email !== "string" || !email.includes("@")) {
        res.status(400).json({ error: "a valid `email` is required" });
        return;
      }

      // ... here you'd persist the user to your own database ...

      // Offload the slow part (sending mail) to QueueFlow.
      const jobId = await qf.jobs.enqueue({
        task: TASKS.sendWelcomeEmail,
        payload: { to: email, name: name ?? null, template: "welcome" },
        maxRetries: 5,
        timeout: 30,
      });

      res.status(202).json({
        message: `signed up ${email}; welcome email queued`,
        jobId,
        statusUrl: `/jobs/${jobId}`,
      });
    }),
  );

  // --- Poll a job's status / result. ----------------------------------------
  app.get(
    "/jobs/:id",
    asyncHandler(async (req, res) => {
      const job = await qf.jobs.get(req.params.id);
      res.json({
        id: job.id,
        status: job.status,
        result: job.result ?? null,
        error: job.error_message ?? null,
        retries: job.retry_count,
        createdAt: job.created_at,
        completedAt: job.completed_at ?? null,
      });
    }),
  );

  // --- Cancel a queued job. -------------------------------------------------
  app.post(
    "/jobs/:id/cancel",
    asyncHandler(async (req, res) => {
      await qf.jobs.cancel(req.params.id);
      res.status(204).end();
    }),
  );

  // --- Kick off a multi-step report build as a DAG workflow. -----------------
  // POST /reports { "dataset": "orders-2026-06" }
  app.post(
    "/reports",
    asyncHandler(async (req, res) => {
      const dataset = String(req.body?.dataset ?? "default");

      const workflow = await qf.workflows.create(
        wf(`report:${dataset}`)
          .context({ dataset })
          .step("extract", TASKS.extract, {
            payload: { dataset },
          })
          .step("transform", TASKS.transform, {
            after: ["extract"],
            payload: { op: "aggregate" },
          })
          .step("load", TASKS.load, {
            after: ["transform"],
            onFailure: "halt",
          }),
      );

      res.status(202).json({
        message: "report workflow started",
        workflowId: workflow.id,
        status: workflow.status,
        statusUrl: `/workflows/${workflow.id}`,
        diagramUrl: `/workflows/${workflow.id}/diagram`,
      });
    }),
  );

  // --- Poll a workflow. ------------------------------------------------------
  app.get(
    "/workflows/:id",
    asyncHandler(async (req, res) => {
      const w = await qf.workflows.get(req.params.id);
      res.json({
        id: w.id,
        name: w.name,
        status: w.status,
        steps: w.steps.map((s) => ({
          name: s.name,
          task: s.task_name,
          dependsOn: s.depends_on ?? [],
        })),
        context: w.context ?? {},
        createdAt: w.created_at,
        completedAt: w.completed_at ?? null,
      });
    }),
  );

  // --- The workflow DAG as a Mermaid diagram. --------------------------------
  app.get(
    "/workflows/:id/diagram",
    asyncHandler(async (req, res) => {
      const { diagram } = await qf.workflows.diagram(req.params.id);
      res.type("text/plain").send(diagram);
    }),
  );

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

// --- Plumbing --------------------------------------------------------------

/** Forward async errors into Express's error pipeline (Express 4 needs this). */
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

const notFound: RequestHandler = (_req, res) => {
  res.status(404).json({ error: "not found" });
};

/** Translate SDK/QueueFlow errors into sensible HTTP responses. */
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: "resource not found" });
    return;
  }
  if (err instanceof ApiError) {
    // Surface the upstream status (e.g. 400 for a workflow cycle, 401 for auth).
    const status = err.status >= 400 && err.status < 600 ? err.status : 502;
    res.status(status).json({ error: err.message, upstreamStatus: err.status });
    return;
  }
  console.error("unhandled error:", err);
  res.status(500).json({ error: "internal error" });
};
