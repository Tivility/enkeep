import { randomUUID } from "node:crypto";

const BASE_URL = "http://127.0.0.1:59061";

async function getAuthHeaders() {
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
  const { data: { csrfToken } } = await csrfRes.json();

  const shadowPassword = process.env.SHADOW_ADMIN_PASSWORD || "";
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": BASE_URL,
      "X-Enkeep-CSRF": csrfToken,
    },
    body: JSON.stringify({ username: "hpc_admin_shadow", password: shadowPassword }),
  });
  if (!loginRes.ok) throw new Error(`Login failed: ${loginRes.status} ${await loginRes.text()}`);
  const cookie = loginRes.headers.get("set-cookie");

  return { cookie, csrfToken };
}

async function runSessionTest(sessionId, testName, timeoutMs = 60000) {
  console.log(`\n========================================`);
  console.log(`Starting test for ${testName} session: ${sessionId}`);
  console.log(`========================================`);

  const { cookie, csrfToken } = await getAuthHeaders();

  // 1. Check messages list before sending
  const beforeRes = await fetch(`${BASE_URL}/api/sessions/${sessionId}/messages?limit=50`, {
    headers: { Cookie: cookie, Origin: BASE_URL },
  });
  const beforeData = await beforeRes.json();
  const initialMsgs = Array.isArray(beforeData.data) ? beforeData.data : (beforeData.data?.messages || []);
  console.log(`Current message count in session: ${initialMsgs.length}`);

  // 2. Dispatch prompt
  const uniquePrompt = `[Verification-${testName}-${Date.now()}-${randomUUID().slice(0, 8)}] Hello, please report your current status in 1 sentence.`;
  const idempotencyKey = randomUUID();
  console.log(`Dispatching prompt: "${uniquePrompt}"`);
  console.log(`Idempotency Key: ${idempotencyKey}`);

  const postRes = await fetch(`${BASE_URL}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: BASE_URL,
      "X-Enkeep-CSRF": csrfToken,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ content: uniquePrompt }),
  });

  if (!postRes.ok) {
    const errText = await postRes.text();
    throw new Error(`POST message failed with status ${postRes.status}: ${errText}`);
  }
  const postResult = await postRes.json();
  console.log(`POST response accepted:`, JSON.stringify(postResult));

  // 3. Poll for turn completion
  const startTime = Date.now();
  const deadline = startTime + timeoutMs;
  let assistantReply = null;
  let lastTurnStatus = null;

  while (Date.now() < deadline) {
    const turnRes = await fetch(`${BASE_URL}/api/sessions/${sessionId}/turn/current`, {
      headers: { Cookie: cookie, Origin: BASE_URL },
    });
    if (turnRes.ok) {
      const turnJson = await turnRes.json();
      lastTurnStatus = turnJson.data;
    }

    const msgsRes = await fetch(`${BASE_URL}/api/sessions/${sessionId}/messages?limit=50`, {
      headers: { Cookie: cookie, Origin: BASE_URL },
    });
    if (msgsRes.ok) {
      const msgsJson = await msgsRes.json();
      const msgs = Array.isArray(msgsJson.data) ? msgsJson.data : (msgsJson.data?.messages || []);
      
      // Find our user message
      const sentMsgIdx = msgs.findIndex(m => m.content === uniquePrompt);
      if (sentMsgIdx >= 0) {
        const sentMsg = msgs[sentMsgIdx];
        // In the array (chronological order), assistant reply comes after sentMsg
        const replies = msgs.slice(sentMsgIdx + 1).filter(m => 
          m.role === "assistant" && 
          m.status === "delivered" &&
          m.content && m.content.trim().length > 0
        );
        if (replies.length > 0) {
          assistantReply = replies[0];
          console.log(`Assistant reply received in ${((Date.now() - startTime)/1000).toFixed(1)}s!`);
          console.log(`Assistant Message ID: ${assistantReply.id}`);
          console.log(`Assistant Message Status: ${assistantReply.status}`);
          console.log(`Assistant Content: ${assistantReply.content}`);
          break;
        }
      }
    }

    const elapsed = ((Date.now() - startTime)/1000).toFixed(0);
    console.log(`[${elapsed}s] Waiting... turn: ${JSON.stringify(lastTurnStatus)}`);
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!assistantReply) {
    throw new Error(`FAIL: Timeout after ${timeoutMs}ms waiting for assistant reply in ${sessionId}. Last turnStatus: ${JSON.stringify(lastTurnStatus)}`);
  }

  console.log(`PASSED: ${testName} (${sessionId})\n`);
  return { sessionId, testName, assistantReply, elapsedMs: Date.now() - startTime };
}

export async function testAll() {
  console.log("=== RUNNING SHADOW SESSIONS VERIFICATION ===");
  
  // 1. Short session
  const shortSessionId = process.env.SHORT_SESSION_ID || "ses_00000000000000000000000000000001";
  const shortResult = await runSessionTest(shortSessionId, "short", 60000);

  // 2. Long session (allow up to 120s)
  const longSessionId = process.env.LONG_SESSION_ID || "ses_00000000000000000000000000000002";
  const longResult = await runSessionTest(longSessionId, "long", 120000);

  // 3. New session
  const newSessionId = process.env.NEW_SESSION_ID || "ses_00000000000000000000000000000003";
  const newResult = await runSessionTest(newSessionId, "new", 60000);

  console.log("\n========================================");
  console.log("ALL 3 SESSIONS PASSED SUCCESSFULLY!");
  console.log("========================================");
  console.log({
    short: { id: shortResult.sessionId, time: `${(shortResult.elapsedMs/1000).toFixed(1)}s`, status: shortResult.assistantReply.status },
    long: { id: longResult.sessionId, time: `${(longResult.elapsedMs/1000).toFixed(1)}s`, status: longResult.assistantReply.status },
    new: { id: newResult.sessionId, time: `${(newResult.elapsedMs/1000).toFixed(1)}s`, status: newResult.assistantReply.status },
  });
}

if (process.argv[1]?.endsWith("verify-shadow-sessions.mjs")) {
  testAll().catch(err => {
    console.error("FATAL ERROR IN TEST:", err);
    process.exit(1);
  });
}
