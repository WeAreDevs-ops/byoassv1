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

    // Log all rotating-client-service calls during warmup
    browserPage.on('request', req => {
        if (req.url().includes('rotating-client-service')) {
            console.log(`[ChefScript Warmup] ${req.method()} ${req.url().replace('https://apis.roblox.com','')}`);
        }
    });
    browserPage.on('response', resp => {
        if (resp.url().includes('rotating-client-service')) {
            console.log(`[ChefScript Warmup Response] ${resp.status()} ${resp.url().replace('https://apis.roblox.com','').substring(0,60)}`);
        }
    });

    await browserPage.goto("https://www.roblox.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    console.log("[Browser] Ready.");
    return browserPage;
}

async function setupBrowserForRequest(cookie) {
    const page = await getBrowser();
    // Clear cookies first
    const client = await page.createCDPSession();
    await client.send("Network.clearBrowserCookies");
    // Navigate first so the proxy context is established
    await page.goto("https://www.roblox.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    // Then inject cookie AFTER page loads through proxy
    await page.setCookie({
        name: ".ROBLOSECURITY",
        value: cookie.replace(".ROBLOSECURITY=", ""),
        domain: ".roblox.com",
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "None",
    });
    // Verify cookie was set
    const cookies = await page.cookies("https://www.roblox.com/");
    const robloCookie = cookies.find(c => c.name === ".ROBLOSECURITY");
    console.log(`[Browser] Cookie set: ${robloCookie ? "YES len=" + robloCookie.value.length : "NO"}`);
    await new Promise(r => setTimeout(r, 2000));
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

        // STEP 2: Trigger challenge (Node.js — no ChefScript needed)
        logs.push("🔄 Step 2: Sending birthdate change request...");

        const changeRequest = await robloxRequest("https://users.roblox.com/v1/birthdate", {
            method: "POST",
            headers: { Cookie: roblosecurity, "x-csrf-token": csrfToken },
            body: JSON.stringify({
                birthMonth: parseInt(birthMonth),
                birthDay: parseInt(birthDay),
                birthYear: parseInt(birthYear),
            }),
        });

        if (changeRequest.status === 200) {
            logs.push("✅ Birthdate changed without challenge!");
            return res.json({ success: true, message: "Birthdate changed successfully!", newBirthdate: { month: birthMonth, day: birthDay, year: birthYear }, logs });
        }
        if (changeRequest.status !== 403) {
            const errText = await changeRequest.text();
            return res.status(500).json({ success: false, error: `Unexpected response: ${changeRequest.status} - ${errText}`, logs });
        }

        const challengeId = changeRequest.headers.get("rblx-challenge-id");
        const challengeType = changeRequest.headers.get("rblx-challenge-type");
        const challengeMetadataB64 = changeRequest.headers.get("rblx-challenge-metadata");

        if (!challengeId || !challengeType || !challengeMetadataB64) {
            return res.status(500).json({ success: false, error: "Challenge headers not found.", logs });
        }

        const step2Meta = JSON.parse(Buffer.from(challengeMetadataB64, "base64").toString("utf8"));
        const step2UserId = step2Meta.userId;
        const browserTrackerId = step2Meta.browserTrackerId || "1759714938428001";

        logs.push("✅ Step 2: Challenge triggered");
        logs.push(`   Challenge ID: ${challengeId}`);
        logs.push(`   Challenge Type: ${challengeType}`);

        await delay(1000, 1500);

        // STEPS 3-6: Inside browser so ChefScript handles proof-of-work
        logs.push("🔄 Steps 3-6: Running inside browser (ChefScript)...");

        const page = await setupBrowserForRequest(cookie);

        const result = await page.evaluate(async (csrfToken, password, birthMonth, birthDay, birthYear, challengeId, challengeType, step2UserId, browserTrackerId) => {
            const doFetch = async (url, options) => {
                const resp = await fetch(url, {
                    credentials: "include",
                    ...options,
                    headers: {
                        "accept": "application/json, text/plain, */*",
                        "accept-language": "en-US,en;q=0.9",
                        "content-type": "application/json",
                        "x-csrf-token": csrfToken,
                        "sec-fetch-dest": "empty",
                        "sec-fetch-mode": "cors",
                        "sec-fetch-site": "same-site",
                        ...(options.headers || {}),
                    },
                });
                const text = await resp.text();
                const headers = {};
                resp.headers.forEach((v, k) => { headers[k] = v; });
                return { status: resp.status, text, headers };
            };

            const browserLogs = [];
            const bLog = (msg) => { browserLogs.push(`[${new Date().toISOString()}] ${msg}`); };

            const origFetch = window.fetch;
            window.fetch = async function(...args) {
                const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
                if (url.includes('rotating-client-service')) {
                    bLog(`ChefScript: ${args[1]?.method || 'GET'} ${url.replace('https://apis.roblox.com','')}`);
                }
                const resp = await origFetch.apply(this, args);
                if (url.includes('rotating-client-service')) {
                    bLog(`ChefScript response: ${resp.status} ${url.replace('https://apis.roblox.com','').substring(0,50)}`);
                }
                return resp;
            };

            try {
                bLog(`Cookie check: has_cookie=${document.cookie.includes('ROBLOSECURITY')}, url=${window.location.href}`);

                // Wait for ChefScript to auto-fire fetch+submit proof for the 403 from step 2
                bLog("Waiting for ChefScript submit calls...");
                await new Promise(r => setTimeout(r, 4000));
                bLog("Wait done, proceeding to step 3");

                const userId = step2UserId;

                // Step 3: continue chef challenge
                const cont1 = await doFetch("https://apis.roblox.com/challenge/v1/continue", {
                    method: "POST",
                    body: JSON.stringify({
                        challengeID: challengeId,
                        challengeType,
                        challengeMetadata: JSON.stringify({ userId, challengeId, browserTrackerId }),
                    }),
                });
                if (cont1.status !== 200) return { error: `Step 3 failed ${cont1.status}: ${cont1.text}` };

                const cont1Data = JSON.parse(cont1.text);
                const meta3 = JSON.parse(cont1Data.challengeMetadata);
                const innerChallengeId = meta3.challengeId;

                bLog(`Step 3 done: type=${cont1Data.challengeType}`);
                // Wait for ChefScript to react to twostepverification response
                bLog("Waiting for ChefScript to react to twostepverification...");
                await new Promise(r => setTimeout(r, 4000));
                bLog("Wait done, proceeding to step 4");

                // Step 4: verify password
                const pw = await doFetch(`https://twostepverification.roblox.com/v1/users/${userId}/challenges/password/verify`, {
                    method: "POST",
                    body: JSON.stringify({ challengeId: innerChallengeId, actionType: "Generic", code: password }),
                });
                if (pw.status !== 200) {
                    const err = JSON.parse(pw.text);
                    return { error: `Step 4 failed: ${err.errors?.[0]?.message || pw.status}` };
                }
                const verificationToken = JSON.parse(pw.text).verificationToken;
                if (!verificationToken) return { error: "No verification token" };

                const step5MetadataObj = {
                    verificationToken,
                    rememberDevice: false,
                    challengeId: innerChallengeId,
                    actionType: "Generic",
                };

                bLog(`Step 4 done: verificationToken=${verificationToken.substring(0,10)}...`);
                // Step 5: complete twostepverification via XHR (same path as real Roblox UI)
                bLog("Step 5: sending via XHR...");
                const cont2 = await new Promise((resolve) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open("POST", "https://apis.roblox.com/challenge/v1/continue");
                    xhr.setRequestHeader("content-type", "application/json;charset=UTF-8");
                    xhr.setRequestHeader("x-csrf-token", csrfToken);
                    xhr.setRequestHeader("accept", "application/json, text/plain, */*");
                    xhr.withCredentials = true;
                    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
                    xhr.onerror = () => resolve({ status: 0, text: "XHR error" });
                    xhr.send(JSON.stringify({
                        challengeId,
                        challengeType: "twostepverification",
                        challengeMetadata: JSON.stringify(step5MetadataObj),
                    }));
                });
                bLog(`Step 5 response: status=${cont2.status}, body=${cont2.text.substring(0,100)}`);
                if (cont2.status !== 200) return { error: `Step 5 failed ${cont2.status}: ${cont2.text}`, browserLogs };
                // Check for blocksession in body even if status is 200
                if (cont2.text.includes("blocksession")) return { error: `Step 5 blocked: ${cont2.text}`, browserLogs };

                // Step 6: retry birthdate with verification proof
                const step6Meta = btoa(JSON.stringify(step5MetadataObj));
                const retry = await doFetch("https://users.roblox.com/v1/birthdate", {
                    method: "POST",
                    headers: {
                        "rblx-challenge-id": challengeId,
                        "rblx-challenge-type": "chef",
                        "rblx-challenge-metadata": step6Meta,
                        "x-retry-attempt": "1",
                    },
                    body: JSON.stringify({ birthMonth, birthDay, birthYear }),
                });

                return {
                    success: retry.status === 200,
                    step6Status: retry.status,
                    step6Body: retry.text,
                    step6Headers: retry.headers,
                    verificationToken,
                    challengeId,
                    browserLogs,
                };
            } catch(e) { return { error: e.message, browserLogs }; }
        }, csrfToken, password, parseInt(birthMonth), parseInt(birthDay), parseInt(birthYear), challengeId, challengeType, step2UserId, browserTrackerId);

        // Log all browser-side logs to Railway console
        if (result.browserLogs) {
            result.browserLogs.forEach(l => console.log(`[Browser] ${l}`));
            result.browserLogs.forEach(l => logs.push(l));
        }

        if (result.error) {
            console.error(`[Error] Browser flow: ${result.error}`);
            return res.status(500).json({ success: false, error: result.error, logs });
        }

        if (result.noChallenge) {
            logs.push("✅ Birthdate changed without challenge!");
            return res.json({ success: true, message: "Birthdate changed successfully!", newBirthdate: { month: birthMonth, day: birthDay, year: birthYear }, logs });
        }

        if (!result.success) {
            console.error(`[Error] Step 6 failed: ${result.step6Status} - ${result.step6Body}`);
            console.log(`[Step 6 Response Headers] ${JSON.stringify(result.step6Headers)}`);
            logs.push("❌ Step 6 failed");
            logs.push(`   Status: ${result.step6Status}`);
            logs.push(`   Response: ${result.step6Body}`);
            return res.status(500).json({ success: false, error: "Birthdate change failed after verification", details: result.step6Body, logs });
        }

        logs.push("✅ Steps 2-6: All completed successfully!");
        logs.push("🎉 Birthdate changed!");

        res.json({
            success: true,
            message: "Birthdate changed successfully!",
            newBirthdate: { month: birthMonth, day: birthDay, year: birthYear },
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
