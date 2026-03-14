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

// Run both challenge/v1/continue calls inside the browser in one continuous session
// This keeps ChefScript's session state alive between both calls
async function browserChallengeFlow(cookie, csrfToken, step3Body, step5BodyFn) {
    const { page } = await getBrowser();

    // Inject cookie
    await page.setCookie({
        name: ".ROBLOSECURITY",
        value: cookie.replace(".ROBLOSECURITY=", ""),
        domain: ".roblox.com",
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "None",
    });

    const result = await page.evaluate(async (csrfToken, step3Body) => {
        const doFetch = async (url, body) => {
            const resp = await fetch(url, {
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
                body: JSON.stringify(body),
            });
            const text = await resp.text();
            return { status: resp.status, text };
        };

        // Step 3: chef challenge continue
        const r3 = await doFetch("https://apis.roblox.com/challenge/v1/continue", step3Body);
        if (r3.status !== 200) return { error: "step3", status: r3.status, text: r3.text };

        return { step3: r3 };
    }, csrfToken, step3Body);

    if (result.error) return result;

    // Parse step 3 result in Node.js to get challengeId for step 5
    const step3Data = JSON.parse(result.step3.text);
    const step5Body = step5BodyFn(step3Data);

    // Now run step 5 in the same browser page (session still alive)
    const result2 = await page.evaluate(async (csrfToken, step5Body) => {
        const doFetch = async (url, body) => {
            const resp = await fetch(url, {
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
                body: JSON.stringify(body),
            });
            const text = await resp.text();
            return { status: resp.status, text };
        };

        const r5 = await doFetch("https://apis.roblox.com/challenge/v1/continue", step5Body);
        if (r5.status !== 200) return { error: "step5", status: r5.status, text: r5.text };

        return { step5: r5 };
    }, csrfToken, step5Body);

    return { step3: result.step3, step5: result2.step5, error: result2.error, status: result2.status, text: result2.text };
}

// Warm up browser on startup
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

        // STEPS 1+2: Get CSRF from page meta tag + trigger birthdate — all inside browser
        logs.push("🔄 Steps 1+2: Loading Roblox and triggering challenge (via browser)...");

        const { page } = await getBrowser();

        // Clear all existing cookies first to avoid session conflict from warmup load
        const client = await page.createCDPSession();
        await client.send("Network.clearBrowserCookies");

        // Inject cookie then load roblox.com so ChefScript registers
        await page.setCookie({
            name: ".ROBLOSECURITY",
            value: cookie.replace(".ROBLOSECURITY=", ""),
            domain: ".roblox.com",
            path: "/",
            httpOnly: false,
            secure: true,
            sameSite: "None",
        });
        await page.goto("https://www.roblox.com/", { waitUntil: "domcontentloaded", timeout: 20000 });
        await new Promise(r => setTimeout(r, 2000));
        console.log("[Browser] Page loaded, ChefScript registered");

        const steps12Result = await page.evaluate(async (birthMonth, birthDay, birthYear, password) => {
            try {
                // Step 1: read CSRF token from page meta tag
                const metaTag = document.querySelector('meta[name="csrf-token"]');
                const csrfToken = metaTag ? metaTag.getAttribute('data-token') || metaTag.getAttribute('content') : null;
                if (!csrfToken) return { error: "No CSRF token in page meta", csrfToken: null };

                // Debug: check if cookie is visible
                const cookieStr = document.cookie;
                const hasRobloCookie = cookieStr.includes('.ROBLOSECURITY') || cookieStr.includes('ROBLOSECURITY');
                const cookieDebug = `cookies_visible=${hasRobloCookie}, cookie_count=${cookieStr.split(';').length}, url=${window.location.href}`;

                // Step 2: trigger birthdate change

                // Step 2: trigger birthdate change
                // Pass cookie explicitly since credentials:include may not work cross-subdomain
                const robloCookie = document.cookie;
                const bdResp = await fetch("https://users.roblox.com/v1/birthdate", {
                    method: "POST",
                    credentials: "include",
                    headers: {
                        "content-type": "application/json",
                        "x-csrf-token": csrfToken,
                        "cookie": robloCookie,
                        "accept": "application/json, text/plain, */*",
                        "accept-language": "en-US,en;q=0.9",
                        "sec-fetch-dest": "empty",
                        "sec-fetch-mode": "cors",
                        "sec-fetch-site": "same-site",
                    },
                    body: JSON.stringify({ birthMonth, birthDay, birthYear, password }),
                });

                const bdText = await bdResp.text();
                const bdHeaders = {};
                bdResp.headers.forEach((v, k) => { bdHeaders[k] = v; });

                return { csrfToken, bdStatus: bdResp.status, bdText, bdHeaders, cookieDebug };
            } catch(e) { return { error: e.message }; }
        }, parseInt(birthMonth), parseInt(birthDay), parseInt(birthYear), password);

        if (steps12Result.error) {
            return res.status(500).json({ success: false, error: `Browser step 2 error: ${steps12Result.error}`, logs });
        }

        const csrfToken = steps12Result.csrfToken;
        if (!csrfToken) {
            return res.status(403).json({ success: false, error: "Failed to get CSRF token from page.", logs });
        }
        logs.push("✅ Step 1: CSRF token obtained");
        console.log(`[Cookie Debug] ${steps12Result.cookieDebug}`);
        logs.push(`   Cookie Debug: ${steps12Result.cookieDebug}`);

        if (steps12Result.bdStatus === 200) {
            logs.push("✅ Step 2: Birthdate changed without challenge!");
            return res.json({ success: true, message: "Birthdate changed successfully!", newBirthdate: { month: birthMonth, day: birthDay, year: birthYear }, logs });
        }

        if (steps12Result.bdStatus !== 403) {
            console.error(`[Error] Change request failed with status ${steps12Result.bdStatus}: ${steps12Result.bdText}`);
            return res.status(500).json({ success: false, error: `Unexpected response from Roblox: ${steps12Result.bdStatus}`, logs });
        }

        const challengeId = steps12Result.bdHeaders["rblx-challenge-id"];
        const challengeType = steps12Result.bdHeaders["rblx-challenge-type"];
        const challengeMetadata = steps12Result.bdHeaders["rblx-challenge-metadata"];

        console.log(`[Step 2 Response Headers] ${JSON.stringify(steps12Result.bdHeaders)}`);

        if (!challengeId || !challengeType || !challengeMetadata) {
            return res.status(500).json({ success: false, error: "Challenge headers not found.", logs });
        }

        logs.push("✅ Step 2: Challenge triggered");
        logs.push(`   Challenge ID: ${challengeId}`);
        logs.push(`   Challenge Type: ${challengeType}`);

        await delay(1500, 2500);

        // STEP 3: chef challenge continue — same browser page, ChefScript already registered
        logs.push("🔄 Step 3: Continuing chef challenge (via browser)...");

        const step3Body = { challengeId, challengeType, challengeMetadata };

        const step3Result = await page.evaluate(async (csrfToken, body) => {
            try {
                const resp = await fetch("https://apis.roblox.com/challenge/v1/continue", {
                    method: "POST",
                    credentials: "include",
                    headers: {
                        "content-type": "application/json",
                        "x-csrf-token": csrfToken,
                        "cookie": document.cookie,
                        "accept": "application/json, text/plain, */*",
                        "accept-language": "en-US,en;q=0.9",
                        "sec-fetch-dest": "empty",
                        "sec-fetch-mode": "cors",
                        "sec-fetch-site": "same-site",
                    },
                    body: JSON.stringify(body),
                });
                const text = await resp.text();
                return { status: resp.status, text };
            } catch(e) { return { error: e.message }; }
        }, csrfToken, step3Body);

        if (step3Result.error) throw new Error(`Step 3 browser error: ${step3Result.error}`);
        if (step3Result.status !== 200) {
            console.error(`[Error] Step 3 failed: ${step3Result.status} - ${step3Result.text}`);
            return res.status(500).json({
                success: false,
                error: `Challenge continue (chef) failed: ${step3Result.status}`,
                details: step3Result.text,
                logs,
            });
        }

        const challenge1Data = JSON.parse(step3Result.text);

        logs.push("✅ Step 3: Chef challenge continued");
        logs.push(`   New Challenge ID: ${challenge1Data.challengeId}`);
        logs.push(`   New Challenge Type: ${challenge1Data.challengeType}`);

        const metadata = JSON.parse(challenge1Data.challengeMetadata);
        const userId = metadata.userId;
        const innerChallengeId = metadata.challengeId;

        logs.push(`   User ID: ${userId}`);
        logs.push(`   Inner Challenge ID: ${innerChallengeId}`);
        console.log(`[Step 3 Parsed Metadata] ${JSON.stringify(metadata)}`);

        await delay(2000, 3500);

        // STEP 4: Verify Password — inside browser so cookie uses browser IP
        logs.push("🔄 Step 4: Verifying password (via browser)...");

        const step4Result = await page.evaluate(async (csrfToken, userId, innerChallengeId, password) => {
            try {
                const resp = await fetch(`https://twostepverification.roblox.com/v1/users/${userId}/challenges/password/verify`, {
                    method: "POST",
                    credentials: "include",
                    headers: {
                        "content-type": "application/json;charset=UTF-8",
                        "x-csrf-token": csrfToken,
                        "cookie": document.cookie,
                        "accept": "application/json, text/plain, */*",
                        "accept-language": "en-US,en;q=0.9",
                        "sec-fetch-dest": "empty",
                        "sec-fetch-mode": "cors",
                        "sec-fetch-site": "same-site",
                    },
                    body: JSON.stringify({ challengeId: innerChallengeId, actionType: "Generic", code: password }),
                });
                const text = await resp.text();
                return { status: resp.status, text };
            } catch(e) { return { error: e.message }; }
        }, csrfToken, userId, innerChallengeId, password);

        if (step4Result.error) throw new Error(`Step 4 browser error: ${step4Result.error}`);

        console.log(`[Step 4 Response Status] ${step4Result.status}`);
        console.log(`[Step 4 Response Body] ${step4Result.text}`);
        logs.push(`   Step 4 Status: ${step4Result.status}`);
        logs.push(`   Step 4 Response: ${step4Result.text}`);

        if (step4Result.status !== 200) {
            const errorData = JSON.parse(step4Result.text);
            return res.status(500).json({
                success: false,
                error: `Password verification failed: ${errorData.errors?.[0]?.message || step4Result.status}`,
                logs,
            });
        }

        const verifyData = JSON.parse(step4Result.text);
        const verificationToken = verifyData.verificationToken;

        if (!verificationToken) {
            return res.status(500).json({ success: false, error: "No verification token received", logs });
        }

        logs.push("✅ Step 4: Password verified");
        logs.push(`   Verification Token: ${verificationToken.substring(0, 20)}...`);

        await delay(1500, 2500);

        // STEP 5: Skipped — password verify (step 4) already unlocks the session server-side
        // Going directly to step 6 with verificationToken in the challenge headers
        logs.push("✅ Step 5: Skipped — password verified, proceeding to birthdate change...");

        await delay(1000, 1500);

        // STEP 6: Retry birthdate request — inside browser so cookie uses browser IP not Railway
        logs.push("🔄 Step 6: Retrying birthdate change after verification (via browser)...");

        const step6Meta = {
            rememberDevice: false,
            actionType: "Generic",
            verificationToken: verificationToken,
            challengeId: innerChallengeId,
        };
        const step6ChallengeMetadata = btoa ? btoa(JSON.stringify(step6Meta)) : Buffer.from(JSON.stringify(step6Meta)).toString("base64");
        logs.push(`   Step 6 Challenge Metadata: ${JSON.stringify(step6Meta)}`);

        const step6Result = await page.evaluate(async (csrfToken, outerChallengeId, step6ChallengeMetadata, birthMonth, birthDay, birthYear, password) => {
            // btoa is available in browser
            try {
                const resp = await fetch("https://users.roblox.com/v1/birthdate", {
                    method: "POST",
                    credentials: "include",
                    headers: {
                        "content-type": "application/json",
                        "x-csrf-token": csrfToken,
                        "cookie": document.cookie,
                        "rblx-challenge-id": outerChallengeId,
                        "rblx-challenge-type": "twostepverification",
                        "rblx-challenge-metadata": step6ChallengeMetadata,
                        "accept": "application/json, text/plain, */*",
                        "accept-language": "en-US,en;q=0.9",
                        "sec-fetch-dest": "empty",
                        "sec-fetch-mode": "cors",
                        "sec-fetch-site": "same-site",
                    },
                    body: JSON.stringify({ birthMonth, birthDay, birthYear, password }),
                });
                const text = await resp.text();
                const headers = {};
                resp.headers.forEach((v, k) => { headers[k] = v; });
                return { status: resp.status, text, headers };
            } catch(e) { return { error: e.message }; }
        }, csrfToken, challenge1Data.challengeId, btoa(JSON.stringify(step6Meta)), parseInt(birthMonth), parseInt(birthDay), parseInt(birthYear), password);

        if (step6Result.error) throw new Error(`Step 6 browser error: ${step6Result.error}`);

        if (step6Result.status !== 200) {
            console.error(`[Error] Step 6 failed: ${step6Result.status} - ${step6Result.text}`);
            console.log(`[Step 6 Response Headers] ${JSON.stringify(step6Result.headers)}`);
            logs.push("❌ Step 6 failed");
            logs.push(`   Status: ${step6Result.status}`);
            logs.push(`   Response: ${step6Result.text}`);
            logs.push(`   Headers: ${JSON.stringify(step6Result.headers)}`);
            return res.status(500).json({
                success: false,
                error: "Birthdate change failed after verification",
                details: step6Result.text,
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
