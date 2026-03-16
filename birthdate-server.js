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
        ["sign", "verify"],
    );

    // Export public key as base64
    const pubKeyBuffer = await crypto.subtle.exportKey(
        "spki",
        keyPair.publicKey,
    );
    const pubKeyBase64 = Buffer.from(pubKeyBuffer).toString("base64");
    const identifier = crypto.randomUUID();

    console.log(`[HBA] Registering public key with identifier: ${identifier}`);

    // Register with Roblox
    const resp = await fetch(
        "https://apis.roblox.com/rotating-client-service/v1/register",
        {
            method: "POST",
            headers: {
                ...BROWSER_HEADERS,
                "content-type": "application/json-patch+json",
                "x-csrf-token": csrfToken,
                Cookie: cookie,
            },
            body: JSON.stringify({ identifier, key: pubKeyBase64 }),
        },
    );

    const data = await resp.json();
    console.log(
        `[HBA] Register response: ${resp.status} ${JSON.stringify(data)}`,
    );

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
            const bodyStr =
                typeof body === "string" ? body : JSON.stringify(body);
            const hashBuf = await crypto.subtle.digest(
                "SHA-256",
                enc.encode(bodyStr),
            );
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
        console.log(
            `[HBA] Generated token for ${method} ${pathname}: v1|${bodyHash.substring(0, 8)}...|${timestamp}|...`,
        );
        return token;
    } catch (e) {
        console.error(`[HBA] Token generation error: ${e.message}`);
        return null;
    }
}

app.use(cors());
app.use(express.json());
app.use(express.static("public")); // Serve index.html from public folder

const BROWSER_HEADERS = {
    "Content-Type": "application/json",
    "User-Agent":
        "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Origin: "https://www.roblox.com",
    Referer: "https://www.roblox.com/",
    "sec-ch-ua": '"Chromium";v="137", "Not/A)Brand";v="24"',
    "sec-ch-ua-mobile": "?1",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "sec-ch-ua-platform": '"Android"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    Connection: "keep-alive",
};

// All requests via plain Node.js fetch
async function robloxRequest(url, options = {}) {
    console.log(`[Roblox Request] ${options.method || "GET"} ${url}`);
    // Debug: log if cookie is present
    const hasCookie =
        options.headers &&
        Object.keys(options.headers).some((k) => k.toLowerCase() === "cookie");
    console.log(
        `[Debug] Has cookie: ${hasCookie}, headers: ${JSON.stringify(Object.keys(options.headers || {}))}`,
    );

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
        execFile(
            CURL_BIN,
            args,
            { maxBuffer: 10 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err && !stdout) return reject(err);
                resolve(stdout);
            },
        );
    });

    // Parse response — with proxy, curl returns multiple HTTP responses
    // We need the LAST one (actual server response, not proxy response)
    const httpBlocks = stdout.split(/(?=HTTP\/[\d.]+ \d+)/);
    const lastBlock = httpBlocks[httpBlocks.length - 1] || stdout;

    const crlfSplit = lastBlock.indexOf("\r\n\r\n");
    const lfSplit = lastBlock.indexOf("\n\n");
    const splitIdx = crlfSplit >= 0 ? crlfSplit : lfSplit;
    const headerSection =
        splitIdx >= 0 ? lastBlock.substring(0, splitIdx) : lastBlock;
    const body =
        splitIdx >= 0
            ? lastBlock.substring(splitIdx + (crlfSplit >= 0 ? 4 : 2))
            : "";

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

    console.log(
        `[Response] ${status} ${url.replace("https://", "").substring(0, 50)}`,
    );
    console.log(`[Response Headers] ${JSON.stringify(responseHeaders)}`);
    console.log(`[Response Body] ${body.substring(0, 200)}`);

    return {
        status,
        headers: {
            get: (key) => responseHeaders[key.toLowerCase()] || null,
            forEach: (fn) =>
                Object.entries(responseHeaders).forEach(([k, v]) => fn(v, k)),
        },
        text: async () => body,
        json: async () => JSON.parse(body),
    };
}

// Delay helper - random delay between min and max ms to mimic human behavior
function delay(min, max) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise((resolve) => setTimeout(resolve, ms));
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
        const traceId = Array.from({ length: 32 }, () =>
            Math.floor(Math.random() * 16).toString(16),
        ).join("");
        const spanId = Array.from({ length: 16 }, () =>
            Math.floor(Math.random() * 16).toString(16),
        ).join("");
        const traceparent = `00-${traceId}-${spanId}-00`;
        console.log(`[Traceparent] ${traceparent}`);

        // STEP 1: Get CSRF Token
        logs.push("🔄 Step 1: Getting CSRF token...");

        const csrf1 = await robloxRequest(
            "https://users.roblox.com/v1/description",
            {
                method: "POST",
                headers: {
                    Cookie: roblosecurity,
                },
            },
        );

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
        logs.push(
            hbaKeyPair
                ? "✅ HBA key registered"
                : "⚠️ HBA key registration failed - continuing without",
        );

        // Human-like delay between steps
        await delay(3000, 5000);

        // STEP 2: Trigger Challenge
        logs.push("🔄 Step 2: Sending birthdate change request...");

        const step2Body = JSON.stringify({
            birthMonth: parseInt(birthMonth),
            birthDay: parseInt(birthDay),
            birthYear: parseInt(birthYear),
        });
        const step2BoundToken = await generateBoundAuthToken(
            "https://users.roblox.com/v1/birthdate",
            "POST",
            step2Body,
        );
        logs.push(
            `   Step 2 HBA token: ${step2BoundToken ? "generated ✅" : "not available ⚠️"}`,
        );

        const changeRequest = await robloxRequest(
            "https://users.roblox.com/v1/birthdate",
            {
                method: "POST",
                headers: {
                    Cookie: roblosecurity,
                    "x-csrf-token": csrfToken,
                    Accept: "application/json, text/plain, */*",
                    "Content-Type": "application/json;charset=UTF-8",
                    traceparent: traceparent,
                    ...(step2BoundToken
                        ? { "x-bound-auth-token": step2BoundToken }
                        : {}),
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
        const challengeMetadata = changeRequest.headers.get(
            "rblx-challenge-metadata",
        );

        const step2Headers = {};
        changeRequest.headers.forEach((value, key) => {
            step2Headers[key] = value;
        });
        console.log(
            `[Step 2 Response Headers] ${JSON.stringify(step2Headers)}`,
        );
        logs.push(
            `   Step 2 Response Headers: ${JSON.stringify(step2Headers)}`,
        );

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
        const step2Meta = JSON.parse(
            Buffer.from(challengeMetadata, "base64").toString("utf8"),
        );
        const step2UserId = step2Meta.userId;

        // CHEF CHALLENGE: Use real Roblox settings page UI to trigger birthdate POST
        // The page's interceptor detects the 403 + chef challenge and auto-runs
        // the chef proof-of-work (submitPayloadV2). We capture challengeId from the
        // 403 response headers and wait for the submit to confirm completion, then
        // close the browser immediately to save RAM.
        let realBtid = "0";
        let puppeteerChallengeId = challengeId; // fallback to server's challengeId
        let puppeteerChallengeMetadata = challengeMetadata;
        let pageCsrfToken = csrfToken;

        try {
            const puppeteer = require("puppeteer-core");
            const browser = await puppeteer.launch({
                executablePath: "/usr/bin/google-chrome-stable",
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-gpu",
                    "--disable-dev-shm-usage",
                    "--memory-pressure-off",
                    "--js-flags=--max-old-space-size=256",
                ],
                headless: true,
            });

            const page = await browser.newPage();

            // Reduce RAM: block images, fonts, media
            await page.setRequestInterception(true);
            const blockedTypes = new Set([
                "image",
                "media",
                "font",
                "stylesheet",
            ]);

            // Data captured from the page's automatic network calls
            let capturedChallengeId = null; // outer chef challengeId (from birthdate 403)
            let capturedUserId = null; // from challenge/v1/continue response
            let capturedInnerChallengeId = null; // inner 2SV challengeId (from continue response)
            let capturedOuterChallengeId = null; // outer challengeId echoed back by continue
            let chefSubmitCount = 0;

            // Promises for key milestones
            let resolvePageContinueDone;
            const pageContinueDone = new Promise((r) => {
                resolvePageContinueDone = r;
            });

            page.on("request", (req) => {
                if (blockedTypes.has(req.resourceType())) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            // Intercept responses to capture all needed data from the page's own requests
            page.on("response", async (response) => {
                const url = response.url();
                try {
                    // 1. Capture outer challengeId from birthdate POST 403 headers
                    if (
                        url.includes("users.roblox.com/v1/birthdate") &&
                        response.status() === 403
                    ) {
                        const cid = response.headers()["rblx-challenge-id"];
                        const ctype = response.headers()["rblx-challenge-type"];
                        const cmeta =
                            response.headers()["rblx-challenge-metadata"];
                        if (cid) {
                            capturedChallengeId = cid;
                            puppeteerChallengeId = cid;
                            if (ctype) challengeType = ctype;
                            if (cmeta) puppeteerChallengeMetadata = cmeta;
                            console.log(
                                `[Chef] Captured outer challengeId from birthdate 403: ${cid}`,
                            );
                        }
                    }

                    // 2. Capture fresh CSRF token from any response header
                    const xcsrf = response.headers()["x-csrf-token"];
                    if (xcsrf) pageCsrfToken = xcsrf;

                    // 3. Track chef submitPayloadV2 calls
                    if (url.includes("rotating-client-service/v1/submit")) {
                        chefSubmitCount++;
                        console.log(
                            `[Chef] submitPayloadV2 #${chefSubmitCount} fired (status ${response.status()})`,
                        );
                    }

                    // 4. Capture challenge/v1/continue response — the page calls this
                    //    automatically after chef completes. The response body contains
                    //    the inner 2SV challengeId needed for password verification.
                    if (
                        url.includes("apis.roblox.com/challenge/v1/continue") &&
                        response.status() === 200
                    ) {
                        const body = await response.json().catch(() => null);
                        if (body) {
                            capturedOuterChallengeId = body.challengeId;
                            const meta = JSON.parse(
                                body.challengeMetadata || "{}",
                            );
                            capturedUserId = meta.userId || null;
                            capturedInnerChallengeId = meta.challengeId || null;
                            console.log(
                                `[Chef] Page called challenge/v1/continue — inner 2SV challengeId: ${capturedInnerChallengeId}, userId: ${capturedUserId}`,
                            );
                            resolvePageContinueDone({
                                outerChallengeId: body.challengeId,
                                userId: meta.userId,
                                innerChallengeId: meta.challengeId,
                            });
                        }
                    }
                } catch (e) {}
            });

            page.on("console", (msg) =>
                console.log(`[Chef Page] ${msg.text()}`),
            );

            // Navigate: set cookie on roblox.com first, then go to Settings page
            logs.push(
                "🔄 Chef: Launching browser and navigating to Settings...",
            );
            await page
                .goto("https://www.roblox.com", {
                    waitUntil: "domcontentloaded",
                    timeout: 20000,
                })
                .catch(() => {});
            const cookieValue = roblosecurity.replace(".ROBLOSECURITY=", "");
            await page.setCookie({
                name: ".ROBLOSECURITY",
                value: cookieValue,
                domain: ".roblox.com",
                path: "/",
            });

            // Go directly to Settings page (loads the birthday section + chef environment)
            await page
                .goto("https://www.roblox.com/my/account#!/info", {
                    waitUntil: "domcontentloaded",
                    timeout: 30000,
                })
                .catch(() => {});
            await new Promise((r) => setTimeout(r, 3000));

            // Get btid from page cookies (set by Roblox after page load)
            const allCookies = await page.cookies("https://www.roblox.com");
            const trackerCookie = allCookies.find(
                (c) => c.name === "RBXEventTrackerV2",
            );
            if (trackerCookie) {
                const btidMatch = trackerCookie.value.match(/browserid=(\d+)/);
                if (btidMatch) realBtid = btidMatch[1];
            }
            console.log(`[Chef] btid: ${realBtid}`);
            logs.push(`   btid: ${realBtid}`);

            // Run UI automation script inside the page — same script as the Roblox
            // settings page console version, but without the password injection step
            // (password verification is handled server-side in Step 4 via node fetch).
            await page.evaluate(
                async (targetMonth, targetDay, targetYear) => {
                    const forceClick = (el) => {
                        ["mouseover", "mousedown", "mouseup", "click"].forEach(
                            (type) => {
                                el.dispatchEvent(
                                    new MouseEvent(type, {
                                        bubbles: true,
                                        cancelable: true,
                                        view: window,
                                    }),
                                );
                            },
                        );
                    };

                    const setSelectVal = (el, val) => {
                        const setter = Object.getOwnPropertyDescriptor(
                            window.HTMLSelectElement.prototype,
                            "value",
                        ).set;
                        setter.call(el, val);
                        el.dispatchEvent(
                            new Event("change", { bubbles: true }),
                        );
                    };

                    const findVisibleByText = (text) =>
                        Array.from(
                            document.querySelectorAll(
                                'button, a, [role="button"]',
                            ),
                        ).filter(
                            (el) =>
                                el.innerText &&
                                el.innerText.trim().toLowerCase() ===
                                    text.toLowerCase() &&
                                el.offsetParent !== null,
                        );

                    // --- STEP 1: Open the birthday edit section ---
                    const labels = Array.from(
                        document.querySelectorAll("*"),
                    ).filter(
                        (el) =>
                            el.textContent &&
                            el.textContent.trim() === "Birthday" &&
                            el.children.length === 0,
                    );
                    if (labels.length > 0) {
                        const row =
                            labels[labels.length - 1].closest(
                                '[class*="row"], [class*="section"]',
                            ) ||
                            labels[labels.length - 1].parentElement
                                ?.parentElement;
                        const editTarget = row?.querySelector(
                            'button, [role="button"], svg',
                        );
                        if (editTarget) {
                            forceClick(
                                editTarget.closest("button") ||
                                    editTarget.closest('[role="button"]') ||
                                    editTarget,
                            );
                            console.log("Opened birthday edit");
                        }
                    }
                    await new Promise((r) => setTimeout(r, 1000));

                    // --- STEP 2: Change the date selects ---
                    const selects = Array.from(
                        document.querySelectorAll("select"),
                    );
                    let monthSel, daySel, yearSel;
                    selects.forEach((s) => {
                        const opts = Array.from(s.options)
                            .map((o) => o.text)
                            .join(" ");
                        if (opts.includes("Jan") || opts.includes("Feb"))
                            monthSel = s;
                        else if (opts.includes("31") && !opts.includes("2000"))
                            daySel = s;
                        else if (opts.includes("2010") || s.options.length > 50)
                            yearSel = s;
                    });
                    if (monthSel) setSelectVal(monthSel, String(targetMonth));
                    if (daySel) setSelectVal(daySel, String(targetDay));
                    if (yearSel) setSelectVal(yearSel, String(targetYear));
                    console.log(
                        `Set birthday to ${targetMonth}/${targetDay}/${targetYear}`,
                    );
                    await new Promise((r) => setTimeout(r, 500));

                    // --- STEP 3: Click Save ---
                    // Clicking Save opens the first confirmation modal (does NOT fire the birthdate POST yet).
                    const saveBtns = findVisibleByText("save");
                    if (saveBtns.length > 0) {
                        forceClick(saveBtns[saveBtns.length - 1]);
                        console.log(
                            "Clicked Save — waiting for first Continue modal",
                        );
                    } else {
                        console.warn("Save button not found");
                        return;
                    }

                    // --- STEP 4: Wait for and click first Continue modal ---
                    console.log("Waiting for first Continue modal...");
                    let firstContinueBtn;
                    for (let i = 0; i < 40; i++) {
                        const btns = findVisibleByText("continue");
                        if (btns.length > 0) {
                            firstContinueBtn = btns[btns.length - 1];
                            break;
                        }
                        await new Promise((r) => setTimeout(r, 500));
                    }
                    if (firstContinueBtn) {
                        console.log("Clicking first Continue...");
                        forceClick(firstContinueBtn);
                        // Wait for this modal to close before looking for the next one
                        for (let i = 0; i < 20; i++) {
                            if (firstContinueBtn.offsetParent === null) break;
                            await new Promise((r) => setTimeout(r, 250));
                        }
                        await new Promise((r) => setTimeout(r, 500));
                    }

                    // --- STEP 4.5: Wait for and click second Continue modal ---
                    // THIS click is what fires the actual birthdate POST.
                    // The page's interceptor detects the 403 + chef challenge and
                    // automatically runs the chef proof-of-work (submitPayloadV2).
                    console.log("Waiting for second Continue modal...");
                    let secondContinueBtn;
                    for (let i = 0; i < 40; i++) {
                        const btns = findVisibleByText("continue");
                        if (btns.length > 0) {
                            secondContinueBtn = btns[btns.length - 1];
                            break;
                        }
                        await new Promise((r) => setTimeout(r, 500));
                    }
                    if (secondContinueBtn) {
                        console.log(
                            "Clicking second Continue — birthdate POST firing now, chef scripts auto-running",
                        );
                        forceClick(secondContinueBtn);
                    }

                    // Password modal will appear after chef completes — we stop here.
                    // Password verification is handled server-side via node fetch (Step 4).
                    console.log(
                        "UI script done — handing off to server for password verification",
                    );
                },
                parseInt(birthMonth),
                parseInt(birthDay),
                parseInt(birthYear),
            );

            logs.push(
                "   UI script executed — waiting for page to complete chef + challenge/v1/continue...",
            );
            console.log(
                `[Chef] Waiting for page's automatic challenge/v1/continue call...`,
            );

            // Wait for the page to auto-call challenge/v1/continue (after chef completes).
            // That response gives us the inner 2SV challengeId — we then close immediately.
            await Promise.race([
                pageContinueDone,
                new Promise((r) => setTimeout(r, 60000)), // 60s safety timeout
            ]);

            console.log(
                `[Chef] Page done (${chefSubmitCount} submit(s), continue captured). Closing browser.`,
            );
            logs.push(
                `✅ Chef: proof-of-work completed (${chefSubmitCount} submit(s))`,
            );
            logs.push(
                `✅ Chef: page auto-called challenge/v1/continue — inner challengeId: ${capturedInnerChallengeId}`,
            );

            await browser.close();
            console.log(
                `[Chef] Browser closed. outerChallengeId: ${capturedOuterChallengeId}, innerChallengeId: ${capturedInnerChallengeId}, userId: ${capturedUserId}, btid: ${realBtid}`,
            );
        } catch (e) {
            console.error(`[Chef] Puppeteer error: ${e.message}`);
            logs.push(`⚠️ Chef: Puppeteer error — ${e.message}`);
        }

        // Use the freshest CSRF token (from Puppeteer page if available, else original)
        const activeCsrf = pageCsrfToken || csrfToken;

        // The page already called challenge/v1/continue automatically after chef completed.
        // We captured the response — use those values directly. No need to call it again.
        const userId = capturedUserId || step2UserId;
        const innerChallengeId = capturedInnerChallengeId;
        const challenge1Data = {
            challengeId: capturedOuterChallengeId || puppeteerChallengeId,
        };

        logs.push(
            `✅ Step 3 (page-handled): challenge/v1/continue already called by page`,
        );
        logs.push(`   Outer Challenge ID: ${challenge1Data.challengeId}`);
        logs.push(`   Inner (2SV) Challenge ID: ${innerChallengeId}`);
        logs.push(`   User ID: ${userId}`);
        logs.push(`   Using CSRF: ${activeCsrf.substring(0, 8)}...`);

        if (!innerChallengeId) {
            return res.status(500).json({
                success: false,
                error: "Could not capture inner 2SV challengeId from page. The page may not have reached the continue step.",
                logs,
            });
        }

        await delay(2000, 3000);

        // UI init calls Roblox makes when showing password modal
        // These GET requests need x-bound-auth-token and traceparent
        logs.push("🔄 Initializing 2SV UI...");
        const uiInitBat = await generateBoundAuthToken(
            `https://twostepverification.roblox.com/v1/users/${userId}/configuration`,
            "GET",
            null,
        );
        await robloxRequest(
            `https://twostepverification.roblox.com/v1/users/${userId}/configuration?challengeId=${innerChallengeId}&actionType=Generic`,
            {
                method: "GET",
                headers: {
                    Cookie: roblosecurity,
                    ...(uiInitBat
                        ? {
                              "x-bound-auth-token": uiInitBat,
                              traceparent: `00-${traceId}-${Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}-00`,
                          }
                        : {}),
                },
            },
        );
        const usersBat = await generateBoundAuthToken(
            `https://users.roblox.com/v1/users/${userId}`,
            "GET",
            null,
        );
        await robloxRequest(`https://users.roblox.com/v1/users/${userId}`, {
            method: "GET",
            headers: {
                Cookie: roblosecurity,
                ...(usersBat
                    ? {
                          "x-bound-auth-token": usersBat,
                          traceparent: `00-${traceId}-${Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}-00`,
                      }
                    : {}),
            },
        });
        const metaBat = await generateBoundAuthToken(
            `https://twostepverification.roblox.com/v1/metadata`,
            "GET",
            null,
        );
        await robloxRequest(
            `https://twostepverification.roblox.com/v1/metadata?userId=${userId}&challengeId=${innerChallengeId}&actionType=Generic&mediaType=Password`,
            {
                method: "GET",
                headers: {
                    Cookie: roblosecurity,
                    ...(metaBat
                        ? {
                              "x-bound-auth-token": metaBat,
                              traceparent: `00-${traceId}-${Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}-00`,
                          }
                        : {}),
                },
            },
        );
        logs.push("✅ 2SV UI initialized");

        await delay(3000, 5000);

        // STEP 4: Verify Password
        logs.push("🔄 Step 4: Verifying password...");

        const verifyPassword = await robloxRequest(
            `https://twostepverification.roblox.com/v1/users/${userId}/challenges/password/verify`,
            {
                method: "POST",
                headers: {
                    "x-csrf-token": activeCsrf,
                    Cookie: roblosecurity,
                    Accept: "application/json, text/plain, */*",
                    "Content-Type": "application/json;charset=UTF-8",
                    traceparent: `00-${traceId}-${Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}-00`,
                },
                body: JSON.stringify({
                    challengeId: innerChallengeId,
                    actionType: "Generic",
                    code: password,
                }),
            },
        );

        const step4ResponseText = await verifyPassword.text();
        console.log(`[Step 4] ${verifyPassword.status} ${step4ResponseText}`);
        logs.push(`   Step 4 Status: ${verifyPassword.status}`);
        logs.push(`   Step 4 Response: ${step4ResponseText}`);

        if (verifyPassword.status !== 200) {
            const errorData = JSON.parse(step4ResponseText);
            return res
                .status(500)
                .json({
                    success: false,
                    error: `Password verification failed: ${errorData.errors?.[0]?.message || verifyPassword.status}`,
                    logs,
                });
        }

        const verificationToken =
            JSON.parse(step4ResponseText).verificationToken;
        if (!verificationToken)
            return res
                .status(500)
                .json({ success: false, error: "No verification token", logs });

        logs.push("✅ Step 4: Password verified");
        logs.push(
            `   Verification Token: ${verificationToken.substring(0, 20)}...`,
        );

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
        const step5Body = JSON.stringify({
            challengeId: challenge1Data.challengeId,
            challengeType: "twostepverification",
            challengeMetadata: JSON.stringify(step5MetadataObj),
        });
        const step5BoundToken = await generateBoundAuthToken(
            step5Url,
            "POST",
            step5Body,
        );
        logs.push(
            `   HBA token: ${step5BoundToken ? "generated ✅" : "not available ⚠️"}`,
        );

        const finalChallenge = await robloxRequest(step5Url, {
            method: "POST",
            headers: {
                "x-csrf-token": activeCsrf,
                Cookie: roblosecurity,
                Accept: "application/json, text/plain, */*",
                "Content-Type": "application/json;charset=UTF-8",
                traceparent: `00-${traceId}-${Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}-00`,
                ...(step5BoundToken
                    ? { "x-bound-auth-token": step5BoundToken }
                    : {}),
            },
            body: step5Body,
        });

        const step5Text = await finalChallenge.text();
        console.log(`[Step 5] ${finalChallenge.status} ${step5Text}`);
        logs.push(`   Step 5 Status: ${finalChallenge.status}`);
        logs.push(`   Step 5 Response: ${step5Text}`);

        if (finalChallenge.status !== 200) {
            return res
                .status(500)
                .json({
                    success: false,
                    error: `Step 5 failed: ${finalChallenge.status}`,
                    details: step5Text,
                    logs,
                });
        }
        if (step5Text.includes("blocksession")) {
            return res
                .status(500)
                .json({
                    success: false,
                    error: "Step 5 blocked",
                    details: step5Text,
                    logs,
                });
        }

        logs.push("✅ Step 5: Challenge completed!");

        await delay(3000, 5000);

        // STEP 6: Retry birthdate
        logs.push("🔄 Step 6: Retrying birthdate change...");

        const step6ChallengeMetadata = Buffer.from(
            JSON.stringify(step5MetadataObj),
        ).toString("base64");
        // Reuse step 2 token for step 6 (same URL, same token in real browser capture)
        const step6BoundToken = step2BoundToken;
        logs.push(
            `   Step 6 HBA token: ${step6BoundToken ? "reused from step 2 ✅" : "not available ⚠️"}`,
        );

        const retryBirthdate = await robloxRequest(
            "https://users.roblox.com/v1/birthdate",
            {
                method: "POST",
                headers: {
                    Cookie: roblosecurity,
                    "x-csrf-token": activeCsrf,
                    Accept: "application/json, text/plain, */*",
                    "Content-Type": "application/json;charset=UTF-8",
                    "rblx-challenge-id": challenge1Data.challengeId,
                    "rblx-challenge-type": "chef",
                    "rblx-challenge-metadata": step6ChallengeMetadata,
                    "x-retry-attempt": "1",
                    traceparent: traceparent,
                    ...(step6BoundToken
                        ? { "x-bound-auth-token": step6BoundToken }
                        : {}),
                },
                body: JSON.stringify({
                    birthMonth: parseInt(birthMonth),
                    birthDay: parseInt(birthDay),
                    birthYear: parseInt(birthYear),
                }),
            },
        );

        if (retryBirthdate.status !== 200) {
            const errorText = await retryBirthdate.text();
            const step6Headers = {};
            retryBirthdate.headers.forEach((value, key) => {
                step6Headers[key] = value;
            });
            console.error(
                `[Error] Step 6 failed: ${retryBirthdate.status} - ${errorText}`,
            );
            console.log(
                `[Step 6 Response Headers] ${JSON.stringify(step6Headers)}`,
            );
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
