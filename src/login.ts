#!/usr/bin/env node
// One-time setup: opens the isolated Flow Music Chrome profile so the user can sign in with Google.
import { CDP_PORT, PROFILE_DIR, getMusicPage } from "./chrome.js";

const page = await getMusicPage();
await page.bringToFront();
console.log(`Chrome is open on ${page.url()}`);
console.log(`CDP port: ${CDP_PORT}`);
console.log(`Profile: ${PROFILE_DIR}`);
console.log("Sign in with Google in that window if needed. The session will persist for future runs.");
process.exit(0);
