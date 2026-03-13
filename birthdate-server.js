// birthdate-server.js - Node.js Backend for Roblox Birthdate Changer
// Install dependencies: npm install express cors puppeteer-extra puppeteer-extra-plugin-stealth
// Run: node birthdate-server.js

const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const app = express();

// --- Browser singleton ---
let browser = null;
let browserPage = null;

async function getBrowser() {
    if (browser && browserPage) return { browser, page: browserPage };

    console.log("[Browser] Launching...");
    browser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
        ],
    });
    browserPage = await browser.newPage();
    await browserPage.setUserAgent(
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36"
    );
    // Load roblox.com so ChefScript registers
    console.log("[Browser] Loading roblox.com for ChefScript...");
    await browserPage.goto("https://www.roblox.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    // Wait for ChefScript to register
    await new Promise(r => setTimeout(r, 3000));
    console.log("[Browser] Ready.");
    return { browser, page: browserPage };
}

// Run a fetch inside the real browser (so ChefScript proof-of-work is handled)
async function browserFetch(cookie, url, options = {}) {
    const { page } = await getBrowser();

    // Inject cookie fresh for each request
    await page.setCookie({
        name: ".ROBLOSECURITY",
        value: cookie.replace(".ROBLOSECURITY=", ""),
        domain: ".roblox.com",
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "None",
    });

    const result = await page.evaluate(async (url, options) => {
        try {
            const resp = await fetch(url, {
                ...options,
                credentials: "include",
            });
            const text = await resp.text();
            const headers = {};
            resp.headers.forEach((v, k) => { headers[k] = v; });
            return { status: resp.status, text, headers };
        } catch (e) {
            return { error: e.message };
        }
    }, url, options);

    if (result.error) throw new Error(`browserFetch error: ${result.error}`);
    return result;
}

// Warm up browser on startup
getBrowser().catch(e => console.error("[Browser] Startup error:", e));

app.use(cors());
app.use(express.json());
app.use(express.static("public")); // Serve index.html from public folder

const BROWSER_HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Origin": "https://www.roblox.com",
    "Referer": "https://www.roblox.com/",
    "sec-ch-ua": '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "Connection": "keep-alive",
};

// All requests go direct (residential IP from localhost/VPS)
async function robloxRequest(url, options = {}) {
    console.log(`[Roblox Request] ${options.method || "GET"} ${url}`);
    const response = await fetch(url, {
        ...options,
        headers: {
            ...BROWSER_HEADERS,
            ...options.headers,
        },
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

        // STEP 1: Get CSRF Token
        logs.push("🔄 Step 1: Getting CSRF token...");

        const csrf1 = await robloxRequest("https://users.roblox.com/v1/description", {
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
        await delay(1000, 2000);

        // STEP 2: Trigger Challenge
        logs.push("🔄 Step 2: Sending birthdate change request...");

        const changeRequest = await robloxRequest(
            "https://users.roblox.com/v1/birthdate",
            {
                method: "POST",
                headers: {
                    Cookie: roblosecurity,
                    "x-csrf-token": csrfToken,
                },
                body: JSON.stringify({
                    birthMonth: parseInt(birthMonth),
                    birthDay: parseInt(birthDay),
                    birthYear: parseInt(birthYear),
                    password: password,
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

        await delay(1500, 2500);

        // STEP 3: Continue chef challenge — runs inside browser so ChefScript handles proof
        logs.push("🔄 Step 3: Continuing chef challenge (via browser)...");

        const continue1Result = await browserFetch(
            cookie,
            "https://apis.roblox.com/challenge/v1/continue",
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-csrf-token": csrfToken,
                },
                body: JSON.stringify({
                    challengeId,
                    challengeType,
                    challengeMetadata,
                }),
            },
        );

        if (continue1Result.status !== 200) {
            console.error(`[Error] Step 3 failed: ${continue1Result.status} - ${continue1Result.text}`);
            return res.status(500).json({
                success: false,
                error: `Challenge continue (chef) failed: ${continue1Result.status}`,
                details: continue1Result.text,
                logs,
            });
        }

        const challenge1Data = JSON.parse(continue1Result.text);

        logs.push("✅ Step 3: Challenge continued");
        logs.push(`   New Challenge ID: ${challenge1Data.challengeId}`);
        logs.push(`   New Challenge Type: ${challenge1Data.challengeType}`);

        // Parse metadata to get userId and inner challengeId
        const metadata = JSON.parse(challenge1Data.challengeMetadata);
        const userId = metadata.userId;
        const innerChallengeId = metadata.challengeId;

        logs.push(`   User ID: ${userId}`);
        logs.push(`   Inner Challenge ID: ${innerChallengeId}`);
        console.log(`[Step 3 Parsed Metadata] ${JSON.stringify(metadata)}`);
        logs.push(`   Full Metadata: ${JSON.stringify(metadata)}`);

        await delay(2000, 3500);

        // STEP 4: Verify Password
        logs.push("🔄 Step 4: Verifying password...");

        const step4Body = JSON.stringify({
            challengeId: innerChallengeId,
            actionType: "Generic",
            code: password,
        });
        console.log(`[Step 4 Request Body] ${step4Body}`);
        logs.push(`   Step 4 Request Body: ${step4Body}`);

        const verifyPassword = await robloxRequest(
            `https://twostepverification.roblox.com/v1/users/${userId}/challenges/password/verify`,
            {
                method: "POST",
                headers: {
                    "x-csrf-token": csrfToken,
                    Cookie: roblosecurity,
                },
                body: step4Body,
            },
        );

        const step4ResponseText = await verifyPassword.text();
        const step4Headers = {};
        verifyPassword.headers.forEach((value, key) => { step4Headers[key] = value; });
        console.log(`[Step 4 Response Status] ${verifyPassword.status}`);
        console.log(`[Step 4 Response Body] ${step4ResponseText}`);
        console.log(`[Step 4 Response Headers] ${JSON.stringify(step4Headers)}`);
        logs.push(`   Step 4 Status: ${verifyPassword.status}`);
        logs.push(`   Step 4 Response: ${step4ResponseText}`);
        logs.push(`   Step 4 Headers: ${JSON.stringify(step4Headers)}`);

        if (verifyPassword.status !== 200) {
            const errorData = JSON.parse(step4ResponseText);
            console.error(
                `[Error] Step 4 failed: ${verifyPassword.status} - ${step4ResponseText}`,
            );
            return res.status(500).json({
                success: false,
                error: `Password verification failed: ${errorData.errors?.[0]?.message || verifyPassword.status}`,
                logs,
            });
        }

        const verifyData = JSON.parse(step4ResponseText);
        const verificationToken = verifyData.verificationToken;

        if (!verificationToken) {
            return res.status(500).json({
                success: false,
                error: "No verification token received",
                logs,
            });
        }

        logs.push("✅ Step 4: Password verified");
        logs.push(
            `   Verification Token: ${verificationToken.substring(0, 20)}...`,
        );

        await delay(1500, 2500);

        // STEP 5. Complete Challenge with Verification Token — via browser so ChefScript handles proof
        logs.push("🔄 Step 5: Completing twostepverification challenge (via browser)...");

        const step5Metadata = {
            rememberDevice: false,
            actionType: metadata.actionType || "Generic",
            verificationToken: verificationToken,
            challengeId: innerChallengeId,
        };

        logs.push(`   Step 5 Metadata: ${JSON.stringify(step5Metadata)}`);

        const continue2Result = await browserFetch(
            cookie,
            "https://apis.roblox.com/challenge/v1/continue",
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-csrf-token": csrfToken,
                },
                body: JSON.stringify({
                    challengeId: challenge1Data.challengeId,
                    challengeType: "twostepverification",
                    challengeMetadata: JSON.stringify(step5Metadata),
                }),
            },
        );

        if (continue2Result.status !== 200) {
            console.error(`[Error] Step 5 failed: ${continue2Result.status} - ${continue2Result.text}`);
            return res.status(500).json({
                success: false,
                error: `Final challenge failed: ${continue2Result.status}`,
                details: continue2Result.text,
                logs,
            });
        }

        const finalChallengeData = JSON.parse(continue2Result.text);
        console.log(`[Step 5 Response Body] ${JSON.stringify(finalChallengeData)}`);
        logs.push(`   Step 5 Response Body: ${JSON.stringify(finalChallengeData)}`);
        logs.push("✅ Step 5: Challenge completed successfully!");

        await delay(2000, 3000);

        // STEP 6: Retry birthdate request
        logs.push("🔄 Step 6: Retrying birthdate change after verification...");

        // Build base64 encoded challenge metadata as per Roblox's expected format
        const step6ChallengeMetadata = Buffer.from(JSON.stringify({
            rememberDevice: false,
            actionType: "Generic",
            verificationToken: verificationToken,
            challengeId: innerChallengeId,
        })).toString("base64");

        logs.push(`   Step 6 Challenge Metadata (base64): ${step6ChallengeMetadata}`);

        const retryBirthdate = await robloxRequest(
            "https://users.roblox.com/v1/birthdate",
            {
                method: "POST",
                headers: {
                    Cookie: roblosecurity,
                    "x-csrf-token": csrfToken,
                    "rblx-challenge-id": challenge1Data.challengeId,
                    "rblx-challenge-type": "twostepverification",
                    "rblx-challenge-metadata": step6ChallengeMetadata,
                },
                body: JSON.stringify({
                    birthMonth: parseInt(birthMonth),
                    birthDay: parseInt(birthDay),
                    birthYear: parseInt(birthYear),
                    password: password,
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
