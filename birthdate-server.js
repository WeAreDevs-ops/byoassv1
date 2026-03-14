// birthdate-server.js - Node.js Backend for Roblox Birthdate Changer
// Install dependencies: npm install express cors
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
    if (browser && browserPage) return browserPage;
    console.log("[Browser] Launching...");
    browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    browserPage = await browser.newPage();
    await browserPage.setUserAgent(
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36"
    );
    console.log("[Browser] Loading roblox.com for ChefScript...");
    await browserPage.goto("https://www.roblox.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    console.log("[Browser] Ready.");
    return browserPage;
}

async function setupBrowserForRequest(cookie) {
    const page = await getBrowser();
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
    await page.goto("https://www.roblox.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    return page;
}

getBrowser().catch(e => console.error("[Browser] Startup error:", e));

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

        await delay(1000, 2000);

        // STEPS 2+3: Run inside browser so ChefScript handles proof-of-work automatically
        logs.push("🔄 Steps 2+3: Triggering challenge via browser (ChefScript)...");

        const page = await setupBrowserForRequest(cookie);

        const steps23Result = await page.evaluate(async (csrfToken, birthMonth, birthDay, birthYear) => {
            try {
                // Step 2: trigger birthdate — ChefScript auto-fires fetch+submit after 403
                const bdResp = await fetch("https://users.roblox.com/v1/birthdate", {
                    method: "POST",
                    credentials: "include",
                    headers: {
                        "content-type": "application/json",
                        "x-csrf-token": csrfToken,
                        "accept": "application/json, text/plain, */*",
                        "accept-language": "en-US,en;q=0.9",
                        "sec-fetch-dest": "empty",
                        "sec-fetch-mode": "cors",
                        "sec-fetch-site": "same-site",
                    },
                    body: JSON.stringify({ birthMonth, birthDay, birthYear }),
                });

                if (bdResp.status === 200) return { noChallenge: true };
                if (bdResp.status !== 403) return { error: `Unexpected status ${bdResp.status}` };

                const challengeId = bdResp.headers.get("rblx-challenge-id");
                const challengeType = bdResp.headers.get("rblx-challenge-type");
                const challengeMetadataB64 = bdResp.headers.get("rblx-challenge-metadata");
                if (!challengeId) return { error: "No challenge headers" };

                const step2Meta = JSON.parse(atob(challengeMetadataB64));
                const userId = step2Meta.userId;
                const browserTrackerId = step2Meta.browserTrackerId || "1759714938428001";

                // Wait for ChefScript to fire submit calls automatically
                await new Promise(r => setTimeout(r, 3000));

                // Step 3: continue chef challenge
                const cont1Resp = await fetch("https://apis.roblox.com/challenge/v1/continue", {
                    method: "POST",
                    credentials: "include",
                    headers: {
                        "content-type": "application/json",
                        "x-csrf-token": csrfToken,
                        "accept": "application/json, text/plain, */*",
                        "accept-language": "en-US,en;q=0.9",
                        "sec-fetch-dest": "empty",
                        "sec-fetch-mode": "cors",
                        "sec-fetch-site": "same-site",
                    },
                    body: JSON.stringify({
                        challengeID: challengeId,
                        challengeType,
                        challengeMetadata: JSON.stringify({ userId, challengeId, browserTrackerId }),
                    }),
                });

                const cont1Text = await cont1Resp.text();
                if (cont1Resp.status !== 200) return { error: `Step 3 failed: ${cont1Resp.status}`, details: cont1Text };

                return { challengeId, challengeType, challengeMetadataB64, cont1Text };
            } catch(e) { return { error: e.message }; }
        }, csrfToken, parseInt(birthMonth), parseInt(birthDay), parseInt(birthYear));

        if (steps23Result.error) {
            console.error(`[Error] Steps 2+3: ${steps23Result.error}`);
            return res.status(500).json({ success: false, error: steps23Result.error, details: steps23Result.details, logs });
        }

        if (steps23Result.noChallenge) {
            logs.push("✅ Step 2: Birthdate changed without challenge!");
            return res.json({ success: true, message: "Birthdate changed successfully!", newBirthdate: { month: birthMonth, day: birthDay, year: birthYear }, logs });
        }

        const { challengeId, challengeType } = steps23Result;
        const challenge1Data = JSON.parse(steps23Result.cont1Text);
        const step2Meta = JSON.parse(Buffer.from(steps23Result.challengeMetadataB64, "base64").toString("utf8"));
        const metadata = JSON.parse(challenge1Data.challengeMetadata);
        const userId = metadata.userId;
        const innerChallengeId = metadata.challengeId;

        logs.push("✅ Steps 2+3: Challenge triggered and continued");
        logs.push(`   Challenge ID: ${challengeId}`);
        logs.push(`   Inner Challenge ID: ${innerChallengeId}`);
        console.log(`[Step 3 Parsed Metadata] ${JSON.stringify(metadata)}`);

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

        // STEP 5: Complete twostepverification — via browser so ChefScript handles proof
        logs.push("🔄 Step 5: Completing twostepverification challenge (via browser)...");

        const step5MetadataObj = {
            verificationToken: verificationToken,
            rememberDevice: false,
            challengeId: innerChallengeId,
            actionType: "Generic",
        };

        const step5Result = await page.evaluate(async (csrfToken, challengeId, step5MetadataObj) => {
            try {
                // Wait for any pending ChefScript calls to complete
                await new Promise(r => setTimeout(r, 2000));

                const resp = await fetch("https://apis.roblox.com/challenge/v1/continue", {
                    method: "POST",
                    credentials: "include",
                    headers: {
                        "content-type": "application/json",
                        "x-csrf-token": csrfToken,
                        "accept": "application/json, text/plain, */*",
                        "accept-language": "en-US,en;q=0.9",
                        "sec-fetch-dest": "empty",
                        "sec-fetch-mode": "cors",
                        "sec-fetch-site": "same-site",
                    },
                    body: JSON.stringify({
                        challengeId,
                        challengeType: "twostepverification",
                        challengeMetadata: JSON.stringify(step5MetadataObj),
                    }),
                });
                const text = await resp.text();
                return { status: resp.status, text };
            } catch(e) { return { error: e.message }; }
        }, csrfToken, challengeId, step5MetadataObj);

        if (step5Result.error) throw new Error(`Step 5 browser error: ${step5Result.error}`);
        if (step5Result.status !== 200) {
            console.error(`[Error] Step 5 failed: ${step5Result.status} - ${step5Result.text}`);
            return res.status(500).json({ success: false, error: `Step 5 failed: ${step5Result.status}`, details: step5Result.text, logs });
        }

        const finalChallengeData = JSON.parse(step5Result.text);
        console.log(`[Step 5 Response] ${JSON.stringify(finalChallengeData)}`);
        logs.push("✅ Step 5: Challenge completed!");

        await delay(1000, 1500);

        // STEP 6: Retry birthdate request with verification proof
        logs.push("🔄 Step 6: Retrying birthdate change after verification...");

        // Same metadata as step 5 — base64 encoded
        const step6ChallengeMetadata = Buffer.from(JSON.stringify(step5MetadataObj)).toString("base64");
        logs.push(`   Step 6 Challenge Metadata: ${JSON.stringify(step5MetadataObj)}`);

        const retryBirthdate = await robloxRequest(
            "https://users.roblox.com/v1/birthdate",
            {
                method: "POST",
                headers: {
                    Cookie: roblosecurity,
                    "x-csrf-token": csrfToken,
                    "rblx-challenge-id": challenge1Data.challengeId,
                    "rblx-challenge-type": "chef",
                    "rblx-challenge-metadata": step6ChallengeMetadata,
                    "x-retry-attempt": "1",
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
