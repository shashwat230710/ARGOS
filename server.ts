import express from "express";
import path from "path";
import fs from "fs";
import { handlePolarApi } from "./src/polarEngine";

const PORT = 3000;

async function startServer() {
  const app = express();
  app.use(express.json());

  app.use("/api", (req, res) => {
    try {
      const result = handlePolarApi(req.originalUrl, req.method, req.body);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err?.message || String(err) });
    }
  });

  const distDir = path.resolve(process.cwd(), "dist");
  if (process.env.NODE_ENV === "production" && fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`PolarRoute DSS server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
