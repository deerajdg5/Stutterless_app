import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { CohereClient } from "cohere-ai";
import multer from "multer"; 
import axios from "axios"; 
import FormData from "form-data"; 
import fs from "fs"; 

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/" });

const co = new CohereClient({
  token: process.env.COHERE_API_KEY,
});

const PORT = process.env.PORT || 4000;

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Stutter Coach backend running" });
});

// --- IN-MEMORY DATABASES ---
const users = new Map();

// Seed Demo User (Default Password: "123")
users.set("Demo User", {
  username: "Demo User",
  password: "123", // Storing plain text for this demo. Use bcrypt in production.
  xp: 120,
  level: 2,
  streak: 1,
  lastActiveDate: new Date().toISOString().split('T')[0],
  badges: ["First Step"],
  stats: { totalSessions: 5, totalSeconds: 300, dailyMinutes: 5 }
});

const activeChallenges = new Map();

// --- HELPERS ---
function getTodayDate() { return new Date().toISOString().split('T')[0]; }
function calculateLevel(xp) { return Math.floor(xp / 100) + 1; }

function updateGamification(user, sessionDurationSec, fluencyScore) {
  const today = getTodayDate();
  user.stats.totalSessions += 1;
  user.stats.totalSeconds += sessionDurationSec;
  if (user.lastActiveDate !== today) { user.stats.dailyMinutes = 0; }
  user.stats.dailyMinutes += (sessionDurationSec / 60);
  if (user.lastActiveDate !== today) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (user.lastActiveDate === yesterday.toISOString().split('T')[0]) {
      user.streak += 1;
    } else {
      user.streak = 1;
    }
    user.lastActiveDate = today;
  }
  let earnedXp = 10 + Math.floor(sessionDurationSec / 10);
  if (fluencyScore >= 80) earnedXp += 20;
  user.xp += earnedXp;
  user.level = calculateLevel(user.xp);
  const newBadges = [];
  const awardBadge = (name) => { if (!user.badges.includes(name)) { user.badges.push(name); newBadges.push(name); } };
  if (user.stats.totalSessions >= 1) awardBadge("First Step");
  if (user.stats.totalSessions >= 10) awardBadge("Dedicated Speaker");
  if (user.streak >= 3) awardBadge("Consistency Champion");
  if (fluencyScore >= 90) awardBadge("Smooth Speaker");
  if (user.xp >= 500) awardBadge("XP Hunter");
  return { earnedXp, newBadges };
}

function analyzeHeuristics(text) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const fillerWords = new Set(["um", "uh", "erm", "hmm", "like"]);
  let repeats = 0, fillers = 0;
  for (let i = 1; i < words.length; i++) {
    if (words[i] === words[i - 1]) repeats++;
    if (fillerWords.has(words[i])) fillers++;
  }
  let score = 100 - repeats * 10 - fillers * 5;
  if (score < 30) score = 30;
  return { score, repeats, fillers, issues: [] }; 
}

// --- USER ENDPOINTS ---

// Get list of users (names only)
app.get("/users", (req, res) => res.json({ users: Array.from(users.keys()) }));

// Get specific user profile
app.get("/user/:username", (req, res) => {
  const user = users.get(req.params.username);
  if (!user) return res.status(404).json({ error: "User not found" });
  // Don't send password back
  const { password, ...safeUser } = user;
  res.json(safeUser);
});

// Create new user with Password
app.post("/users", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and Password required" });
  
  const clean = username.trim();
  if (users.has(clean)) return res.status(400).json({ error: "User already exists" });

  users.set(clean, { 
    username: clean, 
    password: password,
    xp: 0, 
    level: 1, 
    streak: 0, 
    lastActiveDate: null, 
    badges: [], 
    stats: { totalSessions: 0, totalSeconds: 0, dailyMinutes: 0 } 
  });
  res.json({ success: true, username: clean });
});

// NEW: Login Endpoint
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const user = users.get(username);
  
  if (!user) return res.status(404).json({ error: "User not found" });
  
  if (user.password === password) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: "Wrong password" });
  }
});

// --- CHALLENGE ENDPOINTS ---
app.post("/challenge/start", (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "User ID required" });
  activeChallenges.set(userId, { startTime: Date.now(), lastTranscript: "", lastChangeTime: Date.now(), isSpeaking: false });
  res.json({ status: "started" });
});

app.post("/challenge/tick", (req, res) => {
  const { userId, transcript } = req.body;
  const challenge = activeChallenges.get(userId);
  if (!challenge) return res.status(404).json({ error: "No active challenge" });

  const now = Date.now();
  const cleanText = (transcript || "").trim();
  
  if (!challenge.isSpeaking && cleanText.length > 0) {
    challenge.isSpeaking = true;
    challenge.lastChangeTime = now;
    challenge.lastTranscript = cleanText;
  }

  if (cleanText.length > 0) {
    const words = cleanText.toLowerCase().split(/\s+/).filter(Boolean);
    const fillers = ["um", "uh", "like", "hmm", "erm", "aa", "er"];
    for (const word of words) if (fillers.includes(word)) { activeChallenges.delete(userId); return res.json({ status: "fail", reason: `Stuttered: "${word}"` }); }
    for (let i = 1; i < words.length; i++) if (words[i] === words[i - 1]) { activeChallenges.delete(userId); return res.json({ status: "fail", reason: `Repetition: "${words[i]} ${words[i]}"` }); }
  }

  if (challenge.isSpeaking) {
    if (cleanText !== challenge.lastTranscript) {
      challenge.lastChangeTime = now;
      challenge.lastTranscript = cleanText;
    } else {
      if (now - challenge.lastChangeTime > 3000) {
        activeChallenges.delete(userId);
        return res.json({ status: "fail", reason: "Silence detected (> 3s)" });
      }
    }
  }
  res.json({ status: "ok" });
});

// --- COACHING ---
let sessions = [];
let sessionCounter = 1;

app.post("/coach", async (req, res) => {
  try {
    const { transcript, mode = "free_talk", userId = "Demo User", duration = 0, language = "en" } = req.body;
    let user = users.get(userId);
    if (!user) { 
        // Fallback for demo stability if server restarts but client keeps user
        user = { username: userId, xp: 0, level: 1, streak: 0, lastActiveDate: null, badges: [], stats: { totalSessions: 0, totalSeconds: 0, dailyMinutes: 0 }}; 
        users.set(userId, user); 
    }
    
    const heuristics = analyzeHeuristics(transcript);
    
    const langMap = { en: "English", hi: "Hindi", te: "Telugu", kn: "Kannada" };
    const targetLang = langMap[language] || "English";

    const prompt = `
You are a gentle, encouraging speaking coach.
CRITICAL: You must reply in ${targetLang}.
Return ONLY valid JSON:
{
  "fluentSentence": "rewritten smoother version in ${targetLang}",
  "tips": "1–2 short tips in ${targetLang}",
  "coachTone": "supportive",
  "confidenceScore": number (0-100 estimate)
}
User mode: ${mode}
User said: "${transcript}"
Heuristic score: ${heuristics.score}/100
`;

    const response = await co.chat({
      model: "command-r-plus-08-2024",
      message: prompt,
      temperature: 0.2,
    });

    let ai;
    try { ai = JSON.parse(response.text); } catch { ai = { fluentSentence: transcript, tips: "Keep going!", coachTone: "supportive", confidenceScore: heuristics.score }; }

    const gamification = updateGamification(user, duration, heuristics.score);
    const session = {
      id: sessionCounter++, userId, mode, transcript, score: heuristics.score,
      confidenceScore: ai.confidenceScore || heuristics.score,
      fluentSentence: ai.fluentSentence, tips: ai.tips, coachTone: ai.coachTone,
      createdAt: new Date().toISOString(), duration
    };
    sessions.push(session);
    res.json({ session, userProfile: user, gamification });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Cohere API error" });
  }
});

// --- REPAIR ---
app.post("/repair", upload.single("audio"), async (req, res) => {
  try {
    const { fluentText } = req.body;
    const audioFile = req.file;
    if (!process.env.ELEVENLABS_API_KEY) return res.status(500).json({ error: "Server missing ElevenLabs API Key" });
    if (!audioFile || !fluentText) return res.status(400).json({ error: "Missing audio/text" });

    const formData = new FormData();
    formData.append("name", "User Temp Clone");
    formData.append("files", fs.createReadStream(audioFile.path));
    formData.append("description", "Temp clone");

    const addVoiceRes = await axios.post("https://api.elevenlabs.io/v1/voices/add", formData, { headers: { ...formData.getHeaders(), "xi-api-key": process.env.ELEVENLABS_API_KEY } });
    const voiceId = addVoiceRes.data.voice_id;

    const ttsRes = await axios.post(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, 
      { text: fluentText, model_id: "eleven_monolingual_v1", voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
      { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" }, responseType: "arraybuffer" }
    );

    await axios.delete(`https://api.elevenlabs.io/v1/voices/${voiceId}`, { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } });
    fs.unlinkSync(audioFile.path);

    res.set("Content-Type", "audio/mpeg");
    res.send(ttsRes.data);
  } catch (err) {
    console.error("Repair Error:", err.message);
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: "Failed to repair" });
  }
});

app.get("/sessions/:userId", (req, res) => {
  const userSessions = sessions.filter((s) => s.userId === req.params.userId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ sessions: userSessions });
});

app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));