require("dotenv").config();
const express = require("express");
const http = require("node:http");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const axios = require("axios");
const { initializeSocket } = require("./src/socket");

const authRoutes = require("./src/routes/auth.routes");
const logger = require("./src/utils/logger");
const { errorHandler } = require("./src/utils/errorHandler");

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());

// Auth routes
app.use("/auth", authRoutes);

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

/**
 * ===========================
 *  FIXED VIDEO PROXY ROUTE
 * ===========================
 */
app.get("/proxy/video", async (req, res) => {
  try {
    if (!req.query.url) {
      return res.status(400).json({ error: "Missing url parameter" });
    }

    // IMPORTANT FIX → decode the video URL
    const videoUrl = decodeURIComponent(req.query.url);

    console.log(`[Proxy] Streaming: ${videoUrl}`);

    const upstream = await axios({
      method: "GET",
      url: videoUrl,
      responseType: "stream",
      headers: {
        Range: req.headers.range || undefined,
        "User-Agent": req.headers["user-agent"] || "Mozilla/5.0",
      },
      maxRedirects: 5,
      validateStatus: () => true,
    });

    // Copy important headers
    const importantHeaders = [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
    ];

    importantHeaders.forEach((header) => {
      if (upstream.headers[header]) {
        res.setHeader(header, upstream.headers[header]);
      }
    });

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(upstream.status);

    // Stream to client
    upstream.data.pipe(res);
  } catch (err) {
    console.error("[Proxy Error]", err.message);
    return res
      .status(500)
      .json({ error: "Failed to stream video", details: err.message });
  }
});

/**
 * ===========================
 *  404 HANDLER
 * ===========================
 */
app.use((req, res) =>
  res.status(404).json({ success: false, error: "Not Found" })
);

// Global error handler
app.use(errorHandler);

/**
 * ===========================
 *  SOCKET.IO + SERVER INIT
 * ===========================
 */
const port = process.env.PORT || 3000;
const server = http.createServer(app);
const io = require("socket.io")(server, {
  cors: { origin: "*" },
});

initializeSocket(io);

server.listen(port, () => {
  logger.info(`Server listening on port ${port}`);
});

module.exports = server;
