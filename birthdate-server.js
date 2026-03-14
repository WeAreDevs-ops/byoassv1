// birthdate-server.js - Node.js Backend for Roblox Birthdate Changer
// Install dependencies: npm install express cors
// Run: node birthdate-server.js

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");

const app = express();

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

// All requests go through proxy if configured
function getProxyAgent() {
    const proxyUrl = process.env.PROXY_URL;
    const proxyUser = process.env.PROXY_USER;
    const proxyPass = process.env.PROXY_PASS;
    if (proxyUrl && proxyUser && proxyPass) {
        const proxyAuth = `http://${proxyUser}:${proxyPass}@${proxyUrl.replace('http://', '')}`;
        console.log(`[Proxy] Using ${proxyAuth.split('@')[1]}`);
        return new HttpsProxyAgent(proxyAuth);
    }
    return null;
}

async function robloxRequest(url, options = {}) {
    console.log(`[Roblox Request] ${options.method || "GET"} ${url}`);

    const headers = { ...BROWSER_HEADERS, ...options.headers };
    const agent = getProxyAgent();

    const axiosOptions = {
        method: options.method || "GET",
        url,
        headers,
        data: options.body || undefined,
        httpsAgent: agent,
        httpAgent: agent,
        validateStatus: () => true, // don't throw on any status
        responseType: "text",
        decompress: true,
    };

    const response = await axios(axiosOptions);

    // Return a fetch-like response object
    return {
        status: response.status,
        headers: {
            get: (key) => response.headers[key.toLowerCase()] || null,
            forEach: (fn) => Object.entries(response.headers).forEach(([k, v]) => fn(v, k)),
        },
        text: async () => typeof response.data === "string" ? response.data : JSON.stringify(response.data),
        json: async () => typeof response.data === "string" ? JSON.parse(response.data) : response.data,
    };
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

        // STEP 5: Complete twostepverification
        logs.push("🔄 Step 5: Completing twostepverification...");

        const step5MetadataObj = {
            verificationToken: verificationToken,
            rememberDevice: false,
            challengeId: innerChallengeId,
            actionType: "Generic",
        };

        const finalChallenge = await robloxRequest(
            "https://apis.roblox.com/challenge/v1/continue",
            {
                method: "POST",
                headers: {
                    "x-csrf-token": csrfToken,
                    Cookie: roblosecurity,
                    "Accept": "application/json, text/plain, */*",
                    "Content-Type": "application/json;charset=utf-8",
                    "traceparent": `00-${traceId}-${Array.from({length:16},()=>Math.floor(Math.random()*16).toString(16)).join('')}-00`,
                },
                body: JSON.stringify({
                    challengeId: challenge1Data.challengeId,
                    challengeType: "twostepverification",
                    challengeMetadata: JSON.stringify(step5MetadataObj),
                }),
            },
        );

        const step5Text = await finalChallenge.text();
        console.log(`[Step 5] ${finalChallenge.status} ${step5Text}`);
        logs.push(`   Step 5 Status: ${finalChallenge.status}`);
        logs.push(`   Step 5 Response: ${step5Text}`);

        if (finalChallenge.status !== 200) {
            return res.status(500).json({ success: false, error: `Step 5 failed: ${finalChallenge.status}`, details: step5Text, logs });
        }
        if (step5Text.includes("blocksession")) {
            return res.status(500).json({ success: false, error: "Step 5 blocked", details: step5Text, logs });
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
