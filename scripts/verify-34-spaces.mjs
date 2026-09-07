import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { HostRuntimeAdapter } from "../packages/runtime-runner/dist/host/adapter.js";

async function verifyAll() {
  console.log("==================================================================");
  console.log("=== COMPREHENSIVE FINAL VERIFICATION FOR 34-SPACE SHADOW REPAIR ===");
  console.log("==================================================================\n");

  const srcDb = new DatabaseSync(".demo-data/real-hpc-admin-shadow/db/messages.db", { readOnly: true });
  const targetDb = new DatabaseSync(".demo-data/platform.db", { readOnly: true });
  const adminId = "1b587104-4f7c-46a9-8964-72ee9bea23bc";
  const targetUserId = "fa9c8c17-1591-49e9-b6ad-dea756958e7c";

  // 1. Verify exact 34 spaces
  const targetSpaces = targetDb.prepare("SELECT id, name, folder, execution_mode FROM spaces WHERE user_id = ? ORDER BY folder ASC").all(targetUserId);
  console.log(`1. Target Spaces Count: ${targetSpaces.length} (Expected: 34)`);
  if (targetSpaces.length !== 34) throw new Error(`Expected 34 spaces, got ${targetSpaces.length}`);
  const hostSpaces = targetSpaces.filter(s => s.execution_mode === "host");
  const contSpaces = targetSpaces.filter(s => s.execution_mode === "container");
  console.log(`   Host Spaces: ${hostSpaces.length} (Expected: 26)`);
  console.log(`   Container Spaces: ${contSpaces.length} (Expected: 8)`);
  if (hostSpaces.length !== 26 || contSpaces.length !== 8) throw new Error("Spaces count breakdown mismatch");

  // 2. Verify exact 58 routes and 0 mismatch with source registered_groups
  const srcRg = srcDb.prepare("SELECT jid, name, folder, execution_mode FROM registered_groups WHERE created_by = ?").all(adminId);
  const srcRgMap = new Map(srcRg.map(r => [r.jid, r]));
  const targetRoutes = targetDb.prepare("SELECT sr.id, sr.space_id, sr.peer_id, sr.execution_mode, sr.title, s.folder as space_folder, s.execution_mode as space_mode FROM session_routes sr JOIN spaces s ON sr.space_id = s.id WHERE sr.user_id = ?").all(targetUserId);
  console.log(`\n2. Target Routes Count: ${targetRoutes.length} (Expected: 58)`);
  if (targetRoutes.length !== 58) throw new Error(`Expected 58 routes, got ${targetRoutes.length}`);

  let mismatches = 0;
  for (const tr of targetRoutes) {
    const src = srcRgMap.get(tr.peer_id);
    const expectedMode = src?.execution_mode || "host";
    if (tr.execution_mode !== expectedMode) {
      console.error(`Route mode mismatch on ${tr.peer_id}: expected ${expectedMode}, got ${tr.execution_mode}`);
      mismatches++;
    }
    if (tr.space_mode !== expectedMode) {
      console.error(`Space mode mismatch on ${tr.peer_id} space ${tr.space_folder}: expected ${expectedMode}, got ${tr.space_mode}`);
      mismatches++;
    }
  }
  console.log(`   Route & Space Mode Mismatches: ${mismatches} (Expected: 0)`);
  if (mismatches !== 0) throw new Error(`Found ${mismatches} route mode mismatches`);

  // 3. Test Container Session Turn (short session in main--container)
  const containerSessionId = process.env.SHORT_SESSION_ID || "ses_00000000000000000000000000000001";
  console.log(`\n3. Testing Short Container Session in main--container (${containerSessionId})...`);
  const containerListOutput = execSync('docker ps --filter "name=hpc_admin_shadow" --format "{{.Names}}"').toString().trim();
  const containerName = containerListOutput.split("\n")[0] || "enkeep-demo-hpc_admin_shadow_42559a95";
  
  const containerTurnScript = `
import net from "node:net";
import crypto from "node:crypto";
import { DaemonRpcDecoder, DaemonRpcEncoder } from "/app/runtime-runner/dist/runtime/daemon-protocol.js";

const socket = net.connect("/tmp/enkeep-runtime.sock");
const encoder = new DaemonRpcEncoder();
const decoder = new DaemonRpcDecoder();
encoder.pipe(socket);
socket.pipe(decoder);

const sessionId = "${containerSessionId}";
const folder = "main--container";
const turnId = "turn_" + crypto.randomBytes(16).toString("hex");

decoder.on("data", msg => {
  if (msg.event === "turn/completed") {
    console.log(JSON.stringify({ ok: true, replyText: msg.result.replyText }));
    socket.end();
  } else if (msg.event === "turn/failed" || msg.ok === false) {
    console.log(JSON.stringify({ ok: false, error: msg.error || msg }));
    socket.end();
  }
});

socket.on("connect", () => {
  encoder.write({
    id: "req_test_cont_verify",
    op: "submitTurn",
    turnId,
    sessionId,
    prompt: "Execute bash command pwd and print only the working directory path.",
    profile: {
      profileId: "prof_5187e4f9366e0bd2bc6d4603e318bf89",
      version: 1,
      promptHash: "0d2e0bb2f89c97dcecb113d80e4319e5bcf8c44b17e52d35af656b2ca6ba814a",
      identity: "",
      soul: "",
      agents: "",
      tools: ""
    },
    workspaceFolder: folder,
    timeoutMs: 60000
  });
});
`;

  const containerOutRaw = execSync(`docker exec -i ${containerName} node --input-type=module -e '${containerTurnScript.replace(/'/g, "'\\''")}'`).toString().trim();
  const containerOut = JSON.parse(containerOutRaw.split("\n").pop());
  console.log(`   Container bash pwd response: "${containerOut.replyText}"`);
  if (!containerOut.replyText.includes("/home/dsh/spaces/main--container")) {
    throw new Error(`Expected container pwd to be /home/dsh/spaces/main--container, got: ${containerOut.replyText}`);
  }
  console.log("   -> PASSED ✔");

  // 4. Test Long Host Session Turn (flow-generic-space-001)
  const hostSessionId = process.env.LONG_SESSION_ID || "ses_00000000000000000000000000000002";
  const hostSpaceFolder = process.env.HOST_SPACE_FOLDER || "flow-generic-space-001";
  console.log(`\n4. Testing Long Host Session in ${hostSpaceFolder} (${hostSessionId})...`);
  const repoRoot = path.resolve(".");
  const dataRoot = path.join(repoRoot, ".demo-data");
  const adapter = new HostRuntimeAdapter();
  const spec = adapter.createDefaultUserSpec({
    userId: "hpc_admin_shadow",
    dataRoot,
    llmEnabled: true,
    llmProvider: "cpa-gemini",
    llmModel: "gemini-3.7-flash-tiered",
  });

  const activeHandle = await adapter.startRuntime(spec, 20000);
  const hostTurnId = `turn_${crypto.randomBytes(16).toString("hex")}`;
  const hostTurnRes = await activeHandle.sendFollowup({
    turnId: hostTurnId,
    sessionId: hostSessionId,
    prompt: "Execute bash command pwd and print only the working directory path.",
    profileSnapshot: {
      profileId: "prof_5187e4f9366e0bd2bc6d4603e318bf89",
      version: 1,
      promptHash: "0d2e0bb2f89c97dcecb113d80e4319e5bcf8c44b17e52d35af656b2ca6ba814a",
      identity: "",
      soul: "",
      agents: "",
      tools: ""
    },
    workspaceFolder: hostSpaceFolder,
    timeoutMs: 60000
  });

  console.log(`   Host bash pwd response: "${hostTurnRes.replyText}"`);
  if (!hostTurnRes.replyText.includes(`/host-runtimes/hpc_admin_shadow/spaces/${hostSpaceFolder}`)) {
    throw new Error(`Expected host pwd to contain host-runtimes/hpc_admin_shadow/spaces/${hostSpaceFolder}, got: ${hostTurnRes.replyText}`);
  }
  console.log("   -> PASSED ✔");

  // 5. Test Reading CLAUDE.md in Host main--host
  const hostReadSessionId = process.env.READ_SESSION_ID || "ses_00000000000000000000000000000003";
  console.log(`\n5. Testing Reading CLAUDE.md in main--host (${hostReadSessionId})...`);
  const hostReadTurnId = `turn_${crypto.randomBytes(16).toString("hex")}`;
  const hostReadRes = await activeHandle.sendFollowup({
    turnId: hostReadTurnId,
    sessionId: hostReadSessionId,
    prompt: "Use the read tool to inspect CLAUDE.md and report the first heading line of the file.",
    profileSnapshot: {
      profileId: "prof_5187e4f9366e0bd2bc6d4603e318bf89",
      version: 1,
      promptHash: "0d2e0bb2f89c97dcecb113d80e4319e5bcf8c44b17e52d35af656b2ca6ba814a",
      identity: "",
      soul: "",
      agents: "",
      tools: ""
    },
    workspaceFolder: "main--host",
    timeoutMs: 60000
  });
  console.log(`   Host CLAUDE.md read response: "${hostReadRes.replyText}"`);
  if (!hostReadRes.replyText.includes("# Main 工作区")) {
    throw new Error(`Expected host to read # Main 工作区, got: ${hostReadRes.replyText}`);
  }
  console.log("   -> PASSED ✔");

  await adapter.stopRuntime(spec);

  // 6. Verify HappyClaw process PID 60574 and Port 3000
  console.log("\n6. Verifying HappyClaw Process (PID 60574, Port 3000)...");
  const psOut = execSync("ps -p 60574 -o pid,command").toString().trim();
  console.log(`   Process check: ${psOut.split("\n")[1]}`);
  const lsofOut = execSync("lsof -i :3000 -sTCP:LISTEN -P -n").toString().trim();
  console.log(`   Port 3000 check: ${lsofOut.split("\n")[1]}`);
  console.log("   -> PASSED (HappyClaw untouched) ✔");

  console.log("\n==================================================================");
  console.log("=== ALL 6 VERIFICATION STAGES PASSED SUCCESSFULLY! ===");
  console.log("==================================================================");
}

verifyAll().catch(err => {
  console.error("FATAL VERIFICATION FAILURE:", err);
  process.exit(1);
});
