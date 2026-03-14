// birthdate-server.js - Node.js Backend for Roblox Birthdate Changer
// Install dependencies: npm install express cors
// Run: node birthdate-server.js

const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const app = express();

// Browser singleton — only used for step 5
let browser = null;
let browserPage = null;

async function getBrowser() {
    if (browser && browserPage) return browserPage;
    console.log("[Browser] Launching for step 5...");
    browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    browserPage = await browser.newPage();
    await browserPage.setUserAgent("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36");
    await browserPage.goto("https://www.roblox.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    console.log("[Browser] Ready.");
    return browserPage;
}

getBrowser().catch(e => console.error("[Browser] Startup error:", e));

async function setupPageForStep5(page, cookie) {
    // Log browser console messages
    page.on('console', msg => console.log(`[Browser Console] ${msg.text()}`));
    // Clear cookies and inject fresh one
    const client = await page.createCDPSession();
    await client.send("Network.clearBrowserCookies");
    await page.setCookie({
        name: ".ROBLOSECURITY",
        value: cookie.replace(".ROBLOSECURITY=", ""),
        domain: ".roblox.com",
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "None",
    });
    // Navigate to account settings so Angular initializes its XHR interceptors
    console.log("[Browser] Navigating to account settings for Angular init...");
    await page.goto("https://www.roblox.com/my/account#!/info", { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));
    console.log("[Browser] Angular initialized");
}

app.use(cors());
app.use(express.json());
app.use(express.static("public")); // Serve index.html from public folder

const BROWSER_HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Origin": "https://www.roblox.com",
    "Referer": "https://www.roblox.com/",
    "sec-ch-ua": '"Chromium";v="137", "Not/A)Brand";v="24"',
    "sec-ch-ua-mobile": "?1",
    "sec-ch-ua-platform": '"Android"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "Connection": "keep-alive",
};

// All requests via plain Node.js fetch
async function robloxRequest(url, options = {}) {
    console.log(`[Roblox Request] ${options.method || "GET"} ${url}`);
    const response = await fetch(url, {
        ...options,
        headers: { ...BROWSER_HEADERS, ...options.headers },
    });
    return response;
}

// Delay helper - random delay between min and max ms to mimic human behavior
function delay(min, max) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Main endpoint to handle birthdate change
app.post("/api/change-birthdate", async (req, res) => {
    try {
        const { cookie, password, birthMonth, birthDay, birthYear } = req.body;

        if (!cookie || !password || !birthMonth || !birthDay || !birthYear) {
            return res.status(400).json({
                success: false,
                error: "Missing required fields",
            });
        }

        const logs = [];
        const roblosecurity = cookie.startsWith(".ROBLOSECURITY=")
            ? cookie
            : `.ROBLOSECURITY=${cookie}`;

        // Generate a traceparent to link all requests in this session (like a real browser does)
        const traceId = Array.from({length: 32}, () => Math.floor(Math.random() * 16).toString(16)).join('');
        const spanId = Array.from({length: 16}, () => Math.floor(Math.random() * 16).toString(16)).join('');
        const traceparent = `00-${traceId}-${spanId}-00`;
        console.log(`[Traceparent] ${traceparent}`);

        // STEP 1: Get CSRF Token
        logs.push("🔄 Step 1: Getting CSRF token...");

        const csrf1 = await robloxRequest("https://auth.roblox.com/v2/logout", {
            method: "POST",
            headers: {
                Cookie: roblosecurity,
            },
        });

        const csrfToken = csrf1.headers.get("x-csrf-token");

        if (!csrfToken) {
            return res.status(403).json({
                success: false,
                error: "Failed to get CSRF token. Make sure your cookie is valid.",
                logs,
            });
        }

        logs.push("✅ Step 1: CSRF token obtained");

        // Human-like delay between steps
        await delay(10000, 10000);

        // STEP 2: Trigger Challenge
        logs.push("🔄 Step 2: Sending birthdate change request...");

        const changeRequest = await robloxRequest(
            "https://users.roblox.com/v1/birthdate",
            {
                method: "POST",
                headers: {
                    Cookie: roblosecurity,
                    "x-csrf-token": csrfToken,
                    "Accept": "application/json, text/plain, */*",
                    "Content-Type": "application/json;charset=utf-8",
                    "traceparent": traceparent,
                },
                body: JSON.stringify({
                    birthMonth: parseInt(birthMonth),
                    birthDay: parseInt(birthDay),
                    birthYear: parseInt(birthYear),
                }),
            },
        );

        if (changeRequest.status === 200) {
            logs.push("✅ Step 2: Birthdate changed without challenge!");
            return res.json({
                success: true,
                message: "Birthdate changed successfully!",
                newBirthdate: {
                    month: birthMonth,
                    day: birthDay,
                    year: birthYear,
                },
                logs,
            });
        }

        if (changeRequest.status !== 403) {
            const errorText = await changeRequest.text();
            console.error(
                `[Error] Change request failed with status ${changeRequest.status}: ${errorText}`,
            );
            return res.status(500).json({
                success: false,
                error: `Unexpected response from Roblox: ${changeRequest.status}`,
                logs,
            });
        }

        const challengeId = changeRequest.headers.get("rblx-challenge-id");
        const challengeType = changeRequest.headers.get("rblx-challenge-type");
        const challengeMetadata = changeRequest.headers.get("rblx-challenge-metadata");

        const step2Headers = {};
        changeRequest.headers.forEach((value, key) => { step2Headers[key] = value; });
        console.log(`[Step 2 Response Headers] ${JSON.stringify(step2Headers)}`);
        logs.push(`   Step 2 Response Headers: ${JSON.stringify(step2Headers)}`);

        if (!challengeId || !challengeType || !challengeMetadata) {
            const errorText = await changeRequest.text();
            console.error(
                `[Error] Challenge headers missing. Status: ${changeRequest.status}, Body: ${errorText}`,
            );
            return res.status(500).json({
                success: false,
                error: "Challenge headers not found. Roblox might have blocked the request or changed the API.",
                logs,
            });
        }

        logs.push("✅ Step 2: Challenge triggered");
        logs.push(`   Challenge ID: ${challengeId}`);
        logs.push(`   Challenge Type: ${challengeType}`);

        await delay(10000, 10000);

        // Decode step 2 metadata to get userId and browserTrackerId
        const step2Meta = JSON.parse(Buffer.from(challengeMetadata, "base64").toString("utf8"));
        const step2UserId = step2Meta.userId;
        const browserTrackerId = step2Meta.browserTrackerId || "1759714938428001";

        // STEP 3: Continue chef challenge
        logs.push("🔄 Step 3: Continuing chef challenge...");

        const continueChallenge1 = await robloxRequest(
            "https://apis.roblox.com/challenge/v1/continue",
            {
                method: "POST",
                headers: { "x-csrf-token": csrfToken, Cookie: roblosecurity },
                body: JSON.stringify({
                    challengeID: challengeId,
                    challengeType,
                    challengeMetadata: JSON.stringify({
                        userId: step2UserId,
                        challengeId: challengeId,
                        browserTrackerId: browserTrackerId,
                    }),
                }),
            },
        );

        if (continueChallenge1.status !== 200) {
            const errorText = await continueChallenge1.text();
            return res.status(500).json({ success: false, error: `Step 3 failed: ${continueChallenge1.status}`, details: errorText, logs });
        }

        const challenge1Data = await continueChallenge1.json();
        const metadata = JSON.parse(challenge1Data.challengeMetadata);
        const userId = metadata.userId;
        const innerChallengeId = metadata.challengeId;

        logs.push("✅ Step 3: Chef challenge continued");
        logs.push(`   Inner Challenge ID: ${innerChallengeId}`);
        console.log(`[Step 3] ${JSON.stringify(metadata)}`);

        await delay(10000, 10000);

        // UI init calls Roblox makes when showing password modal
        logs.push("🔄 Initializing 2SV UI...");
        await robloxRequest(`https://twostepverification.roblox.com/v1/users/${userId}/configuration?challengeId=${innerChallengeId}&actionType=Generic`, {
            method: "GET", headers: { Cookie: roblosecurity },
        });
        await robloxRequest(`https://users.roblox.com/v1/users/${userId}`, {
            method: "GET", headers: { Cookie: roblosecurity },
        });
        await robloxRequest(`https://twostepverification.roblox.com/v1/metadata?userId=${userId}&challengeId=${innerChallengeId}&actionType=Generic&mediaType=Password`, {
            method: "GET", headers: { Cookie: roblosecurity },
        });
        logs.push("✅ 2SV UI initialized");

        await delay(10000, 10000);

        // STEP 4: Verify Password
        logs.push("🔄 Step 4: Verifying password...");

        const verifyPassword = await robloxRequest(
            `https://twostepverification.roblox.com/v1/users/${userId}/challenges/password/verify`,
            {
                method: "POST",
                headers: {
                    "x-csrf-token": csrfToken,
                    Cookie: roblosecurity,
                    "Accept": "application/json, text/plain, */*",
                    "Content-Type": "application/json;charset=utf-8",
                    "traceparent": `00-${traceId}-${Array.from({length:16},()=>Math.floor(Math.random()*16).toString(16)).join('')}-00`,
                },
                body: JSON.stringify({ challengeId: innerChallengeId, actionType: "Generic", code: password }),
            },
        );

        const step4ResponseText = await verifyPassword.text();
        console.log(`[Step 4] ${verifyPassword.status} ${step4ResponseText}`);
        logs.push(`   Step 4 Status: ${verifyPassword.status}`);
        logs.push(`   Step 4 Response: ${step4ResponseText}`);

        if (verifyPassword.status !== 200) {
            const errorData = JSON.parse(step4ResponseText);
            return res.status(500).json({ success: false, error: `Password verification failed: ${errorData.errors?.[0]?.message || verifyPassword.status}`, logs });
        }

        const verificationToken = JSON.parse(step4ResponseText).verificationToken;
        if (!verificationToken) return res.status(500).json({ success: false, error: "No verification token", logs });

        logs.push("✅ Step 4: Password verified");
        logs.push(`   Verification Token: ${verificationToken.substring(0, 20)}...`);

        await delay(10000, 10000);

        // STEP 5: Complete twostepverification via Puppeteer XHR
        // Angular's XHR interceptor auto-adds x-bound-auth-token
        logs.push("🔄 Step 5: Completing twostepverification (via browser XHR)...");

        const step5MetadataObj = {
            verificationToken: verificationToken,
            rememberDevice: false,
            challengeId: innerChallengeId,
            actionType: "Generic",
        };

        const page = await getBrowser();

        // Setup page with cookie and navigate to account settings for Angular init
        await setupPageForStep5(page, cookie);

        // Use CDP to intercept the actual request headers sent by XHR
        const cdpClient = await page.createCDPSession();
        await cdpClient.send("Network.enable");
        
        let capturedHeaders = null;
        cdpClient.on("Network.requestWillBeSentExtraInfo", (params) => {
            if (params.headers && JSON.stringify(params.headers).includes("challenge/v1/continue")) {
                capturedHeaders = params.headers;
            }
        });
        cdpClient.on("Network.requestWillBeSent", (params) => {
            if (params.request.url.includes("challenge/v1/continue")) {
                capturedHeaders = params.request.headers;
                console.log(`[Step 5 CDP Headers] ${JSON.stringify(params.request.headers)}`);
            }
        });

        const step5Result = await page.evaluate(async (csrfToken, outerChallengeId, step5MetadataObj) => {
            try {
                // Try to get x-bound-auth-token from Roblox's own generateBoundAuthToken function
                let boundAuthToken = null;

                // Find the HBA service in Roblox's Angular/module system
                // It exposes generateBoundAuthToken which uses the meta tag + IndexedDB
                const metaTag = document.querySelector('meta[name="hardware-backed-authentication-data"]');
                console.log('[HBA] meta tag found:', !!metaTag);
                if (metaTag) {
                    console.log('[HBA] meta content:', metaTag.content);
                }

                // Try to find generateBoundAuthToken in the Roblox module system
                // It's exposed via the webpack/require module registry
                try {
                    // Try webpackJsonp or __webpack_require__ approach
                    const allKeys = Object.getOwnPropertyNames(window);
                    for (const key of allKeys) {
                        try {
                            const obj = window[key];
                            if (obj && typeof obj === 'object' && typeof obj.generateBoundAuthToken === 'function') {
                                console.log('[HBA] found on window.' + key);
                                boundAuthToken = await obj.generateBoundAuthToken();
                                break;
                            }
                        } catch(e) {}
                    }
                } catch(e) {
                    console.log('[HBA] window search error:', e.message);
                }

                return await new Promise((resolve) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open("POST", "https://apis.roblox.com/challenge/v1/continue");
                    xhr.setRequestHeader("Content-Type", "application/json;charset=utf-8");
                    xhr.setRequestHeader("Accept", "application/json, text/plain, */*");
                    xhr.setRequestHeader("x-csrf-token", csrfToken);
                    if (boundAuthToken) {
                        xhr.setRequestHeader("x-bound-auth-token", boundAuthToken);
                        console.log('[HBA] x-bound-auth-token set!');
                    }
                    xhr.withCredentials = true;
                    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText, hadBoundToken: !!boundAuthToken });
                    xhr.onerror = () => resolve({ status: 0, text: "XHR error" });
                    xhr.send(JSON.stringify({
                        challengeId: outerChallengeId,
                        challengeType: "twostepverification",
                        challengeMetadata: JSON.stringify(step5MetadataObj),
                    }));
                });
            } catch(e) {
                return { status: 0, text: "evaluate error: " + e.message };
            }
        }, csrfToken, challenge1Data.challengeId, step5MetadataObj);

        console.log(`[Step 5] ${step5Result.status} ${step5Result.text}`);
        logs.push(`   Step 5 Status: ${step5Result.status}`);
        logs.push(`   Step 5 Response: ${step5Result.text}`);

        if (step5Result.status !== 200) {
            return res.status(500).json({ success: false, error: `Step 5 failed: ${step5Result.status}`, details: step5Result.text, logs });
        }
        if (step5Result.text.includes("blocksession")) {
            return res.status(500).json({ success: false, error: "Step 5 blocked", details: step5Result.text, logs });
        }

        logs.push("✅ Step 5: Challenge completed!");

        await delay(10000, 10000);

        // STEP 6: Retry birthdate
        logs.push("🔄 Step 6: Retrying birthdate change...");

        const step6ChallengeMetadata = Buffer.from(JSON.stringify(step5MetadataObj)).toString("base64");

        const retryBirthdate = await robloxRequest(
            "https://users.roblox.com/v1/birthdate",
            {
                method: "POST",
                headers: {
                    Cookie: roblosecurity,
                    "x-csrf-token": csrfToken,
                    "Accept": "application/json, text/plain, */*",
                    "Content-Type": "application/json;charset=utf-8",
                    "rblx-challenge-id": challenge1Data.challengeId,
                    "rblx-challenge-type": "chef",
                    "rblx-challenge-metadata": step6ChallengeMetadata,
                    "x-retry-attempt": "1",
                    "traceparent": traceparent,
                },
                body: JSON.stringify({
                    birthMonth: parseInt(birthMonth),
                    birthDay: parseInt(birthDay),
                    birthYear: parseInt(birthYear),
                }),
            }
        );

        if (retryBirthdate.status !== 200) {
            const errorText = await retryBirthdate.text();
            const step6Headers = {};
            retryBirthdate.headers.forEach((value, key) => { step6Headers[key] = value; });
            console.error(`[Error] Step 6 failed: ${retryBirthdate.status} - ${errorText}`);
            console.log(`[Step 6 Response Headers] ${JSON.stringify(step6Headers)}`);
            logs.push("❌ Step 6 failed");
            logs.push(`   Status: ${retryBirthdate.status}`);
            logs.push(`   Response: ${errorText}`);
            logs.push(`   Headers: ${JSON.stringify(step6Headers)}`);
            return res.status(500).json({
                success: false,
                error: "Birthdate change failed after verification",
                details: errorText,
                logs,
            });
        }

        logs.push("✅ Step 6: Birthdate changed successfully!");
        logs.push("🎉 All steps completed successfully!");

        // Success!
        res.json({
            success: true,
            message: "Birthdate changed successfully!",
            newBirthdate: {
                month: birthMonth,
                day: birthDay,
                year: birthYear,
            },
            logs,
        });
    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({
            success: false,
            error: error.message,
            logs: [error.stack],
        });
    }
});

// Health check endpoint
app.get("/api/health", (req, res) => {
    res.json({ status: "ok", message: "Server is running" });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
    console.log(`📁 Place index.html in a 'public' folder`);
});
