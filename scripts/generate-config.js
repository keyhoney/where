const fs = require("fs");
const path = require("path");

const required = [
  "KAKAO_APP_KEY",
  "FIREBASE_API_KEY",
  "FIREBASE_AUTH_DOMAIN",
  "FIREBASE_DATABASE_URL",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_STORAGE_BUCKET",
  "FIREBASE_MESSAGING_SENDER_ID",
  "FIREBASE_APP_ID"
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`[build] Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const configObject = {
  kakaoAppKey: process.env.KAKAO_APP_KEY,
  firebase: {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID
  }
};

const outPath = path.join(process.cwd(), "config.js");
const content = `window.APP_CONFIG = ${JSON.stringify(configObject, null, 2)};\n`;
fs.writeFileSync(outPath, content, "utf8");
console.log(`[build] generated ${outPath}`);
