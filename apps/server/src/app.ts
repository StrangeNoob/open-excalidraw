import express, { type Express } from "express";

export const createApp = (): Express => {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "10mb" }));
  app.get("/health/live", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  return app;
};
