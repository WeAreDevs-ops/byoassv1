// birthdate-server.js - Node.js Backend for Roblox Birthdate Changer
// Install dependencies: npm install express cors
// Run: node birthdate-server.js

const express = require("express");
const cors = require("cors");
const { webcrypto: crypto } = require("crypto");
const { execFile } = require("child_process");

// curl-impersonate binary — use android version to match our User-Agent
const CURL_BIN = process.env.CURL_BIN || "curl_chrome131_android";
const app = express();

// HBA (Hardware Bound Auth) token generation
// Reverse engineered from Roblox's CoreUtilities.js
let hbaKeyPair = null;

async function generateAndRegisterHBAKey(csrfToken, cookie) {
    console.log("[HBA] Generating ECDSA P-256 key pair...");
    const keyPair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"]
    );

    // Export public key as base64
    const pubKeyBuffer = await crypto.subtle.exportKey("spki", keyPair.publicKey);
    const pubKeyBase64 = Buffer.from(pubKeyBuffer).toString("base64");
    const identifier = crypto.randomUUID();

    console.log(`[HBA] Registering public key with identifier: ${identifier}`);

    // Register with Roblox
    const resp = await fetch("https://apis.roblox.com/rotating-client-service/v1/register", {
        method: "POST",
        headers: {
            ...BROWSER_HEADERS,
            "content-type": "application/json-patch+json",
            "x-csrf-token": csrfToken,
            Cookie: cookie,
        },
        body: JSON.stringify({ identifier, key: pubKeyBase64 }),
    });

    const data = await resp.json();
    console.log(`[HBA] Register response: ${resp.status} ${JSON.stringify(data)}`);

    if (resp.status !== 200 || !data.robloxApiKeyBase64) {
        console.error("[HBA] Registration failed");
        return null;
    }

    hbaKeyPair = { privateKey: keyPair.privateKey, identifier };
    console.log("[HBA] Key pair registered successfully");
    return hbaKeyPair;
}

async function generateBoundAuthToken(url, method, body) {
    if (!hbaKeyPair) return null;
    try {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        const upperMethod = method.toUpperCase();
        const enc = new TextEncoder();
        const algo = { name: "ECDSA", hash: { name: "SHA-256" } };

        // Compute SHA-256 hash of body, base64 encoded (s in the source)
        let bodyHash = "";
        if (body) {
            const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
            const hashBuf = await crypto.subtle.digest("SHA-256", enc.encode(bodyStr));
            bodyHash = Buffer.from(hashBuf).toString("base64");
        }

        // p = [bodyHash, timestamp, url, method].join("|")
        // h = ["", timestamp, pathname, method].join("|")
        const p = [bodyHash, timestamp, url, upperMethod].join("|");
        const h = ["", timestamp, pathname, upperMethod].join("|");

        const [sigP, sigH] = await Promise.all([
            crypto.subtle.sign(algo, hbaKeyPair.privateKey, enc.encode(p)),
            crypto.subtle.sign(algo, hbaKeyPair.privateKey, enc.encode(h)),
        ]);

        const v = Buffer.from(sigP).toString("base64");
        const y = Buffer.from(sigH).toString("base64");

        // token = ["v1", bodyHash, timestamp, v, y].join("|")
        const token = ["v1", bodyHash, timestamp, v, y].join("|");
        console.log(`[HBA] Generated token for ${method} ${pathname}: v1|${bodyHash.substring(0,8)}...|${timestamp}|...`);
        return token;
    } catch(e) {
        console.error(`[HBA] Token generation error: ${e.message}`);
        return null;
    }
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
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "sec-ch-ua-platform": '"Android"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "Connection": "keep-alive",
};

// All requests via plain Node.js fetch
async function robloxRequest(url, options = {}) {
    console.log(`[Roblox Request] ${options.method || "GET"} ${url}`);
    // Debug: log if cookie is present
    const hasCookie = options.headers && Object.keys(options.headers).some(k => k.toLowerCase() === 'cookie');
    console.log(`[Debug] Has cookie: ${hasCookie}, headers: ${JSON.stringify(Object.keys(options.headers || {}))}`);

    const headers = { ...BROWSER_HEADERS, ...options.headers };
    const method = options.method || "GET";

    // Build curl-impersonate args
    const args = ["-s", "-i", "--compressed", "-X", method];

    // Add proxy if configured
    const proxyUrl = process.env.PROXY_URL;
    const proxyUser = process.env.PROXY_USER;
    const proxyPass = process.env.PROXY_PASS;
    if (proxyUrl && proxyUser && proxyPass) {
        args.push("--proxy", proxyUrl);
        args.push("--proxy-user", `${proxyUser}:${proxyPass}`);
    }

    // Add headers
    for (const [k, v] of Object.entries(headers)) {
        const kl = k.toLowerCase();
        if (kl === "accept-encoding") continue; // curl handles this
        if (kl === "cookie") {
            args.push("--cookie", v); // use --cookie flag for proper handling
        } else {
            args.push("-H", `${k}: ${v}`);
        }
    }

    // Add body
    if (options.body) {
        args.push("--data-raw", options.body);
    }

    args.push(url);

    const stdout = await new Promise((resolve, reject) => {
        execFile(CURL_BIN, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err && !stdout) return reject(err);
            resolve(stdout);
        });
    });

    // Parse response — with proxy, curl returns multiple HTTP responses
    // We need the LAST one (actual server response, not proxy response)
    const httpBlocks = stdout.split(/(?=HTTP\/[\d.]+ \d+)/);
    const lastBlock = httpBlocks[httpBlocks.length - 1] || stdout;
    
    const crlfSplit = lastBlock.indexOf("\r\n\r\n");
    const lfSplit = lastBlock.indexOf("\n\n");
    const splitIdx = crlfSplit >= 0 ? crlfSplit : lfSplit;
    const headerSection = splitIdx >= 0 ? lastBlock.substring(0, splitIdx) : lastBlock;
    const body = splitIdx >= 0 ? lastBlock.substring(splitIdx + (crlfSplit >= 0 ? 4 : 2)) : "";

    // Parse status
    const statusMatch = headerSection.match(/^HTTP\/[\d.]+ (\d+)/);
    const status = statusMatch ? parseInt(statusMatch[1]) : 0;

    // Parse headers
    const responseHeaders = {};
    for (const line of headerSection.split("\n").slice(1)) {
        const idx = line.indexOf(":");
        if (idx > 0) {
            const k = line.substring(0, idx).trim().toLowerCase();
            const v = line.substring(idx + 1).trim();
            responseHeaders[k] = v;
        }
    }

    console.log(`[Response] ${status} ${url.replace("https://","").substring(0,50)}`);
    console.log(`[Response Headers] ${JSON.stringify(responseHeaders)}`);
    console.log(`[Response Body] ${body.substring(0, 200)}`);

    return {
        status,
        headers: {
            get: (key) => responseHeaders[key.toLowerCase()] || null,
            forEach: (fn) => Object.entries(responseHeaders).forEach(([k, v]) => fn(v, k)),
        },
        text: async () => body,
        json: async () => JSON.parse(body),
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

        // Register HBA key pair with Roblox
        logs.push("🔄 Registering HBA key pair...");
        await generateAndRegisterHBAKey(csrfToken, roblosecurity);
        logs.push(hbaKeyPair ? "✅ HBA key registered" : "⚠️ HBA key registration failed - continuing without");

        // Human-like delay between steps
        await delay(3000, 5000);

        // STEP 2: Trigger Challenge
        logs.push("🔄 Step 2: Sending birthdate change request...");

        const step2Body = JSON.stringify({ birthMonth: parseInt(birthMonth), birthDay: parseInt(birthDay), birthYear: parseInt(birthYear) });
        const step2BoundToken = await generateBoundAuthToken("https://users.roblox.com/v1/birthdate", "POST", step2Body);
        logs.push(`   Step 2 HBA token: ${step2BoundToken ? "generated ✅" : "not available ⚠️"}`);

        const changeRequest = await robloxRequest(
            "https://users.roblox.com/v1/birthdate",
            {
                method: "POST",
                headers: {
                    Cookie: roblosecurity,
                    "x-csrf-token": csrfToken,
                    "Accept": "application/json, text/plain, */*",
                    "Content-Type": "application/json;charset=UTF-8",
                    "traceparent": traceparent,
                    ...(step2BoundToken ? { "x-bound-auth-token": step2BoundToken } : {}),
                },
                body: step2Body,
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

        await delay(3000, 5000);

        // Decode step 2 metadata to get userId and browserTrackerId
        const step2Meta = JSON.parse(Buffer.from(challengeMetadata, "base64").toString("utf8"));
        const step2UserId = step2Meta.userId;


        // CHEF CHALLENGE: Puppeteer triggers birthdate POST inside real Roblox page
        // Chef scripts run naturally, both submits go through, we just capture challengeId
        let realBtid = "0";
        let puppeteerChallengeId = challengeId; // fallback to server's challengeId
        let puppeteerChallengeMetadata = null;

        try {
            const puppeteer = require("puppeteer-core");
            const browser = await puppeteer.launch({
                executablePath: "/usr/bin/google-chrome-stable",
                args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
                headless: true,
            });

            const page = await browser.newPage();
            page.on("console", msg => console.log(`[Chef Page] ${msg.type()}: ${msg.text()}`));

            // Track submit calls - let them ALL pass through naturally
            let submitCount = 0;
            await page.setRequestInterception(true);
            page.on("request", async (req) => {
                const url = req.url();
                if (url.includes("rotating-client-service/v1/submit")) {
                    submitCount++;
                    console.log(`[Chef] Submit #${submitCount} passing through naturally`);
                }
                req.continue();
            });

            // Navigate to /my/account - loads raven + ChefScript environment
            await page.goto("https://www.roblox.com", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
            const cookieValue = roblosecurity.replace(".ROBLOSECURITY=", "");
            await page.setCookie({ name: ".ROBLOSECURITY", value: cookieValue, domain: ".roblox.com", path: "/" });
            await page.goto("https://www.roblox.com/my/account", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 3000));

            // Get btid from cookies
            const cookies = await page.cookies("https://www.roblox.com");
            const trackerCookie = cookies.find(c => c.name === "RBXEventTrackerV2");
            if (trackerCookie) {
                const btidMatch = trackerCookie.value.match(/browserid=(\d+)/);
                if (btidMatch) realBtid = btidMatch[1];
            }
            console.log(`[Chef] btid: ${realBtid}`);

            // Get CSRF token from inside the page
            const pageCsrf = await page.evaluate(async () => {
                try {
                    const r = await fetch("https://users.roblox.com/v1/description", {
                        method: "POST",
                        credentials: "include"
                    });
                    return r.headers.get("x-csrf-token") || "";
                } catch(e) { return ""; }
            });
            console.log(`[Chef] Page CSRF: ${pageCsrf ? "got" : "empty"}`);

            // Trigger birthdate POST via Angular $http - this goes through Roblox's interceptor
            // which detects the 403 + chef challenge and auto-triggers chef scripts
            const capturedChallenge = await page.evaluate(async (month, day, year, csrf) => {
                console.log("Triggering birthdate POST via Angular $http...");
                try {
                    // Try Angular $http first (goes through interceptor that triggers chef)
                    const injector = angular.element(document.body).injector();
                    if (injector) {
                        const $http = injector.get("$http");
                        const $rootScope = injector.get("$rootScope");
                        return new Promise((resolve) => {
                            $http({
                                method: "POST",
                                url: "https://users.roblox.com/v1/birthdate",
                                data: { birthMonth: month, birthDay: day, birthYear: year },
                                headers: { "Content-Type": "application/json;charset=UTF-8", "X-CSRF-TOKEN": csrf }
                            }).then(resp => {
                                console.log("Birthdate POST success:", resp.status);
                                resolve(null);
                            }).catch(err => {
                                console.log("Birthdate POST error status:", err.status);
                                // 403 is expected - chef scripts auto-trigger from here
                                resolve({
                                    challengeId: err.headers("rblx-challenge-id"),
                                    challengeType: err.headers("rblx-challenge-type"),
                                    challengeMetadata: err.headers("rblx-challenge-metadata")
                                });
                            });
                            $rootScope.$apply();
                        });
                    }
                } catch(e) {
                    console.error("Angular $http error:", e.message);
                }
                return null;
            }, birthMonth, birthDay, birthYear, pageCsrf || csrfToken);

            if (capturedChallenge && capturedChallenge.challengeId) {
                puppeteerChallengeId = capturedChallenge.challengeId;
                puppeteerChallengeMetadata = capturedChallenge.challengeMetadata;
                console.log(`[Chef] Captured challengeId: ${puppeteerChallengeId}`);
            } else {
                console.log(`[Chef] No challenge captured, using server challengeId`);
            }

            // Wait for both chef submits to complete naturally
            await new Promise(r => setTimeout(r, 15000));
            console.log(`[Chef] Total submits through: ${submitCount}`);
            await browser.close();

        } catch(e) {
            console.error(`[Chef] Puppeteer error: ${e.message}`);
        }

        // Update challengeId and metadata for the rest of the flow
        const effectiveChallengeId = puppeteerChallengeId;
        let effectiveMeta = null;
        if (puppeteerChallengeMetadata) {
            try {
                effectiveMeta = JSON.parse(Buffer.from(puppeteerChallengeMetadata, "base64").toString("utf8"));
            } catch(e) {}
        }
        const innerChallengeIdOverride = effectiveMeta?.challengeId || null;

        // STEP 3: Continue chef challenge
        logs.push("🔄 Step 3: Continuing chef challenge...");

        const continueChallenge1 = await robloxRequest(
            "https://apis.roblox.com/challenge/v1/continue",
            {
                method: "POST",
                headers: {
                    "x-csrf-token": csrfToken,
                    Cookie: roblosecurity,
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/plain, */*",
                },
                body: JSON.stringify({
                    challengeID: effectiveChallengeId,
                    challengeType,
                    challengeMetadata: JSON.stringify({
                        userId: step2UserId,
                        challengeId: effectiveChallengeId,
                        browserTrackerId: realBtid,
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

        await delay(1000, 2000);

        await delay(2000, 3000);

        // UI init calls Roblox makes when showing password modal
        // These GET requests need x-bound-auth-token and traceparent
        logs.push("🔄 Initializing 2SV UI...");
        const uiInitBat = await generateBoundAuthToken(`https://twostepverification.roblox.com/v1/users/${userId}/configuration`, "GET", null);
        await robloxRequest(`https://twostepverification.roblox.com/v1/users/${userId}/configuration?challengeId=${innerChallengeId}&actionType=Generic`, {
            method: "GET", headers: { Cookie: roblosecurity, ...(uiInitBat ? { "x-bound-auth-token": uiInitBat, "traceparent": `00-${traceId}-${Array.from({length:16},()=>Math.floor(Math.random()*16).toString(16)).join('')}-00` } : {}) },
        });
        const usersBat = await generateBoundAuthToken(`https://users.roblox.com/v1/users/${userId}`, "GET", null);
        await robloxRequest(`https://users.roblox.com/v1/users/${userId}`, {
            method: "GET", headers: { Cookie: roblosecurity, ...(usersBat ? { "x-bound-auth-token": usersBat, "traceparent": `00-${traceId}-${Array.from({length:16},()=>Math.floor(Math.random()*16).toString(16)).join('')}-00` } : {}) },
        });
        const metaBat = await generateBoundAuthToken(`https://twostepverification.roblox.com/v1/metadata`, "GET", null);
        await robloxRequest(`https://twostepverification.roblox.com/v1/metadata?userId=${userId}&challengeId=${innerChallengeId}&actionType=Generic&mediaType=Password`, {
            method: "GET", headers: { Cookie: roblosecurity, ...(metaBat ? { "x-bound-auth-token": metaBat, "traceparent": `00-${traceId}-${Array.from({length:16},()=>Math.floor(Math.random()*16).toString(16)).join('')}-00` } : {}) },
        });
        logs.push("✅ 2SV UI initialized");

        await delay(3000, 5000);

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
                    "Content-Type": "application/json;charset=UTF-8",
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

        await delay(3000, 5000);

        // STEP 5: Complete twostepverification with HBA token
        logs.push("🔄 Step 5: Completing twostepverification...");

        const step5MetadataObj = {
            verificationToken: verificationToken,
            rememberDevice: false,
            challengeId: innerChallengeId,
            actionType: "Generic",
        };

        const step5Url = "https://apis.roblox.com/challenge/v1/continue";
        const step5Body = JSON.stringify({ challengeId: challenge1Data.challengeId, challengeType: "twostepverification", challengeMetadata: JSON.stringify(step5MetadataObj) });
        const step5BoundToken = await generateBoundAuthToken(step5Url, "POST", step5Body);
        logs.push(`   HBA token: ${step5BoundToken ? "generated ✅" : "not available ⚠️"}`);

        const finalChallenge = await robloxRequest(
            step5Url,
            {
                method: "POST",
                headers: {
                    "x-csrf-token": csrfToken,
                    Cookie: roblosecurity,
                    "Accept": "application/json, text/plain, */*",
                    "Content-Type": "application/json;charset=UTF-8",
                    "traceparent": `00-${traceId}-${Array.from({length:16},()=>Math.floor(Math.random()*16).toString(16)).join('')}-00`,
                    ...(step5BoundToken ? { "x-bound-auth-token": step5BoundToken } : {}),
                },
                body: step5Body,
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

        await delay(3000, 5000);

        // STEP 6: Retry birthdate
        logs.push("🔄 Step 6: Retrying birthdate change...");

        const step6ChallengeMetadata = Buffer.from(JSON.stringify(step5MetadataObj)).toString("base64");
        // Reuse step 2 token for step 6 (same URL, same token in real browser capture)
        const step6BoundToken = step2BoundToken;
        logs.push(`   Step 6 HBA token: ${step6BoundToken ? "reused from step 2 ✅" : "not available ⚠️"}`);

        const retryBirthdate = await robloxRequest(
            "https://users.roblox.com/v1/birthdate",
            {
                method: "POST",
                headers: {
                    Cookie: roblosecurity,
                    "x-csrf-token": csrfToken,
                    "Accept": "application/json, text/plain, */*",
                    "Content-Type": "application/json;charset=UTF-8",
                    "rblx-challenge-id": challenge1Data.challengeId,
                    "rblx-challenge-type": "chef",
                    "rblx-challenge-metadata": step6ChallengeMetadata,
                    "x-retry-attempt": "1",
                    "traceparent": traceparent,
                    ...(step6BoundToken ? { "x-bound-auth-token": step6BoundToken } : {}),
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
