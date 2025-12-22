import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import mongoose from "mongoose";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/**
 * ENV you must set in Render:
 * - RECALL_API_KEY               (from Recall dashboard)
 * - RECALL_BASE_URL              e.g. https://us-east-1.recall.ai/api/v1
 * - N8N_BOT_STATUS_WEBHOOK_URL   your n8n Workflow 2 webhook URL
 * - SHARED_SECRET                shared secret for simple auth between n8n <-> backend
 * - MONGODB_URI                  MongoDB connection string
 */
const RECALL_API_KEY = process.env.RECALL_API_KEY;
const RECALL_BASE_URL = process.env.RECALL_BASE_URL;
const N8N_BOT_STATUS_WEBHOOK_URL = process.env.N8N_BOT_STATUS_WEBHOOK_URL;
const SHARED_SECRET = process.env.SHARED_SECRET;
const MONGODB_URI = process.env.MONGODB_URI;

// Mongoose schema for Meeting
const meetingSchema = new mongoose.Schema(
  {
    meetingId: { type: String, required: true, unique: true, index: true },
    subject: String,
    joinUrl: String,
    startTime: String,
    endTime: String,
    recallBotId: String,
    transcriptId: String,
    status: { type: String, default: "join_requested" },
    joinTs: String,
    leaveTs: String,
    createdAt: { type: String, default: () => new Date().toISOString() },
  },
  { timestamps: true }
);

const Meeting = mongoose.model("Meeting", meetingSchema);

// Connect to MongoDB
mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB");
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err.message);
  });

function requireApiKey(req, res, next) {
  if (!SHARED_SECRET) return next(); // allow if you didn't set one (not recommended)
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== SHARED_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function recallHeaders() {
  if (!RECALL_API_KEY) throw new Error("RECALL_API_KEY is not configured");
  return {
    Authorization: `Token ${RECALL_API_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

app.get("/health", (_req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

/**
 * ===================================================================
 * 1) JOIN MEETING (ONLINE - TEAMS URL)
 * Called by n8n Workflow 1 at schedule time.
 * This creates a Recall bot that REALLY joins the Teams meeting URL.
 * ===================================================================
 */
app.post("/joinMeeting", requireApiKey, async (req, res) => {

  try {
    const { meetingId, joinUrl, startTime, endTime, subject } = req.body || {};
    if (!meetingId || !joinUrl) {
      return res.status(400).json({ error: "meetingId and joinUrl are required" });
    }

    // Create Recall bot
    const createPayload = {
      meeting_url: joinUrl,
      // Save your meetingId in metadata so it comes back in webhooks
      metadata: {
        meetingId,
        subject: subject || "",
        startTime: startTime || "",
        endTime: endTime || "",
      },
      // Ask Recall to generate a transcript (provider can be recallai or a 3rd party configured in Recall)
      recording_config: {
        "transcript": {
          "provider": {
            "recallai_streaming": {
              "mode": "prioritize_low_latency",
              "language_code": "en"
            }
          }
        }
      },
      
      
      // Optional: request a recording artifact too (you can remove if you only need transcript)
      // recording_config: { "format": "mp4" }
    };

    const botResp = await axios.post(`${RECALL_BASE_URL}/bot/`, createPayload, {
      headers: recallHeaders(),
    });

    const recallBot = botResp.data;
    const recallBotId = recallBot.id;

    // Store mapping in MongoDB
    await Meeting.findOneAndUpdate(
      { meetingId },
      {
        meetingId,
        subject,
        joinUrl,
        startTime,
        endTime,
        recallBotId,
        status: "join_requested",
        createdAt: new Date().toISOString(),
      },
      { upsert: true, new: true }
    );

    // console.log("[joinMeeting] Created Recall bot:", { meetingId, recallBotId });

    // IMPORTANT:
    // Recall will actually join the meeting asynchronously.
    // When it does, Recall will call your /recall/webhook with a status change event.
    return res.json({ ok: true, meetingId, recallBotId });
  } catch (err) {
    // console.error("[joinMeeting] Error:", err?.response?.data || err.message);
    // console.error("[joinMeeting] Recall status:", err?.response?.status);
    // console.error("[joinMeeting] Recall headers:", err?.response?.headers);
    // console.error("[joinMeeting] Recall data:", err?.response?.data);
    // console.error("[joinMeeting] Raw error:", err.message);

    return res.status(500).json({ error: "Failed to create Recall bot", details: err?.response?.data || err.message });
  }
});

/**
 * ===================================================================
 * 2) JOIN MEETING VIA PHONE (optional)
 * Recall primarily joins via meeting URL. Phone dial-in is usually done via telephony provider.
 * If you still want to keep /joinPhone for future telephony, keep it as a stub.
 * ===================================================================
 */
app.post("/joinPhone", requireApiKey, async (req, res) => {
  const { meetingId, phoneNumber, conferenceId } = req.body || {};
  if (!meetingId || !phoneNumber || !conferenceId) {
    return res.status(400).json({ error: "meetingId, phoneNumber, conferenceId are required" });
  }
  // Implement your telephony provider here (Twilio/Azure ACS/etc.)
  return res.status(501).json({ error: "joinPhone not implemented. Use Teams joinUrl + Recall whenever possible." });
});

/**
 * ===================================================================
 * 3) RECALL WEBHOOK RECEIVER
 * Configure Recall dashboard (or Create Bot options if you use per-bot webhook) to send events here.
 * This endpoint forwards join/leave timestamps to n8n Workflow 2 (Bot Status Webhook).
 * ===================================================================
 */
app.post("/recall/webhook", async (req, res) => {
  
  // Always acknowledge quickly
  res.status(200).json({ ok: true });

  try {
    const event = req.body;

    // Recall webhooks include an event type + payload; exact shape depends on Recall config/version.
    // We'll handle the common ones in a tolerant way.
    const eventType =
      event.type ||
      event.event ||
      event.name ||
      event?.data?.type ||
      event?.data?.event ||
      "unknown";

    const payload = event.data || event.payload || event;

    // Try to get bot id & metadata.meetingId
    const recallBotId = payload.bot_id || payload.botId || payload?.bot?.id || payload?.data?.bot_id;
    const metadata = payload.metadata || payload?.bot?.metadata || {};
    const meetingId = metadata.meetingId;

    // A timestamp may be present; otherwise use "now"
    const timestamp =
      payload.data.timestamp ||
      payload.data.occurred_at ||
      payload.data.created_at ||
      payload.data.updated_at ||
      new Date().toISOString();

    // console.log("[recallWebhook]", { eventType, meetingId, recallBotId });

    if (!meetingId) {
      console.warn("[recallWebhook] No meetingId found in webhook metadata; cannot map to n8n.");
      return;
    }

    // Update our MongoDB store
    let m = await Meeting.findOne({ meetingId });
    if (!m) {
      m = new Meeting({ meetingId });
    }

    const updateData = {};
    if (recallBotId && !m.recallBotId) updateData.recallBotId = recallBotId;

    // Interpret bot lifecycle:
    // Common pattern: "bot.status_change" with status in payload.status
    const statusValue =
      payload.data.code ||
      payload.data.status ||
      payload.data.bot_status ||
      payload?.data?.bot?.status;

    // Heuristics to decide joined/left
    const normalizedType = String(eventType).toLowerCase();
    const normalizedStatus = String(statusValue || "").toLowerCase();

    let shouldNotify = false;
    let n8nStatus = null;

    if (normalizedType) {
      if (normalizedStatus.includes("in_call") || normalizedStatus.includes("in_meeting") || normalizedStatus.includes("in_waiting_room")) {
        n8nStatus = "joined";
        if (!m.joinTs) updateData.joinTs = timestamp;
        updateData.status = "in_meeting";
        shouldNotify = true;
      }
      if (normalizedStatus.includes("done") || normalizedStatus.includes("left") || normalizedStatus.includes("call_ended")) {
        n8nStatus = "left";
        if (!m.leaveTs) updateData.leaveTs = timestamp;
        updateData.status = "left";
        shouldNotify = true;
      }
    }

    // Transcript readiness: store transcript id if provided
    // Some Recall events include transcript id; we capture whatever looks like it.
    const transcriptId =
      payload.transcript_id ||
      payload.transcriptId ||
      payload?.transcript?.id ||
      payload?.data?.transcript_id;

    if (transcriptId) {
      updateData.transcriptId = transcriptId;
      // don't notify n8n here unless you want; Workflow 3 Cron can poll.
      // console.log("[recallWebhook] Captured transcriptId:", transcriptId);
    }

    // Update the meeting document
    Object.assign(m, updateData);
    await m.save();
    console.log(shouldNotify, N8N_BOT_STATUS_WEBHOOK_URL);

    // Forward join/leave to n8n Workflow 2
    if (shouldNotify && N8N_BOT_STATUS_WEBHOOK_URL) {
      await axios.post(
        N8N_BOT_STATUS_WEBHOOK_URL,
        { meetingId, status: n8nStatus, timestamp }
        // {
        //   headers: {
        //     "Content-Type": "application/json",
        //     "x-api-key": SHARED_SECRET,
        //   },
        // }
      );
      console.log("[recallWebhook] Forwarded to n8n:", { meetingId, status: n8nStatus, timestamp });
    }
  } catch (err) {
    console.error("[recallWebhook] Error:", err?.response?.data || err.message);
  }
});

/**
 * ===================================================================
 * 4) GET TRANSCRIPT
 * Called by n8n Workflow 3 with meetingId + join/leave timestamps.
 * This fetches transcript from Recall.
 *
 * Note: Recall has:
 * - GET /bot/{BOT_ID}/transcript/  (returns transcript so far)
 * - GET /transcript/{ID}/          (retrieve transcript by transcript id)
 *
 * We'll try bot transcript first. If you captured transcriptId, use it.
 * ===================================================================
 */
app.post("/getTranscript", requireApiKey, async (req, res) => {
  try {
    const { meetingId } = req.body || {};
    if (!meetingId) return res.status(400).json({ error: "meetingId is required" });

    const m = await Meeting.findOne({ meetingId });
    if (!m?.recallBotId) {
      return res.status(404).json({ error: "No Recall bot mapped for this meetingId yet" });
    }

    // Step 1: Retrieve bot details to get transcript download URL
    const botResp = await axios.get(`${RECALL_BASE_URL}/bot/${m.recallBotId}/`, {
      headers: recallHeaders(),
    });

    const botData = botResp.data;
    // console.log("[getTranscript] Bot data retrieved:", { botId: m.recallBotId });

    // Step 2: Extract transcript download URL from recordings
    let downloadUrl = null;
    let transcriptId = null;

    if (botData?.recordings && Array.isArray(botData.recordings) && botData.recordings.length > 0) {
      const recording = botData.recordings[0];
      if (recording?.media_shortcuts?.transcript?.data?.download_url) {
        downloadUrl = recording.media_shortcuts.transcript.data.download_url;
        transcriptId = recording.media_shortcuts.transcript.id || m.transcriptId;
      }
    }

    if (!downloadUrl) {
      return res.status(404).json({
        error: "Transcript not available yet. The meeting may still be in progress or transcript processing is not complete.",
        recallBotId: m.recallBotId,
      });
    }

    // Step 3: Fetch the full transcript JSON from the download URL
    // Note: downloadUrl is a pre-signed S3 URL - don't send any headers as they invalidate the signature
    // console.log("downloadUrl", downloadUrl);
    const transcriptResp = await axios.get(downloadUrl);

    // console.log("transcriptResp", transcriptResp.data);

    const transcriptData = transcriptResp.data;
    // console.log("[getTranscript] Transcript data retrieved from download URL");

    // Step 4: Normalize transcript to text
    const transcriptText = normalizeTranscriptToText(transcriptData);

    // Update stored transcriptId if we found one
    if (transcriptId && transcriptId !== m.transcriptId) {
      m.transcriptId = transcriptId;
      await m.save();
    }

    // You can optionally mark quality if empty/short
    const quality = transcriptText && transcriptText.trim().length > 40 ? "ok" : "poor";

    return res.json({
      meetingId,
      transcriptText,
      quality,
      recallBotId: m.recallBotId,
      transcriptId: transcriptId || m.transcriptId || null,
    });
  } catch (err) {
    console.error("[getTranscript] Error:", err?.response?.data || err.message);
    return res.status(500).json({ error: "Failed to retrieve transcript", details: err?.response?.data || err.message });
  }
});

// Try to flatten common Recall transcript response formats into plain text
function normalizeTranscriptToText(transcriptData) {
  if (!transcriptData) return "";

  // If it already has a "text" field
  if (typeof transcriptData.text === "string") return transcriptData.text;

  // Common: items/segments with speaker + text
  const items = transcriptData.items || transcriptData.segments || transcriptData.results || transcriptData.data;
  if (Array.isArray(items)) {
    return items
      .map((it) => {
        const speaker = it.speaker || it.speaker_name || it.participant || it.name || "";
        const text = it.text || it.transcript || it.content || "";
        if (!text) return "";
        return speaker ? `${speaker}: ${text}` : text;
      })
      .filter(Boolean)
      .join("\n");
  }

  // Fallback: JSON stringify
  return JSON.stringify(transcriptData, null, 2);
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Katie bot backend (Recall.ai) listening on port ${PORT}`);
  if (!RECALL_API_KEY) console.warn("⚠️ RECALL_API_KEY not set");
  if (!N8N_BOT_STATUS_WEBHOOK_URL) console.warn("⚠️ N8N_BOT_STATUS_WEBHOOK_URL not set (join/leave won't reach n8n)");
});
